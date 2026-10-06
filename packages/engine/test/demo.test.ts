import { describe, expect, it } from 'vitest';
import { ToolInputs, toolResultText, type AssistantItem, type ConvItem, type ToolCallPart } from '@opencoach/protocol';
import { createAgentLoop, createScriptedProvider, demoCoachHandler, type ScriptedStep } from '../src';
import { baseInput, fakeTools, req, resolved, user } from './helpers';

// ---- rendering helpers (docs/implementation.md "Context rendering")
const header = (local: string, type: string, id?: string) => `[${local} · ${type}${id ? ` · ${id}` : ''}]`;
const TUE = '2026-10-07 06:58 Tue';
const msg = (text: string, id = 'evt_msg1', local = TUE) => user(`${header(local, 'user.message', id)}\nAthlete: ${text}`);
const tap = (value: string, id = 'evt_tap1', local = '2026-10-07 07:01 Tue') =>
  user(`${header(local, 'user.ui_action', id)}\nAthlete tapped quick reply "${value}" on message evt_prev`);
const upload = (id = 'evt_up1', mime = 'image/png', local = TUE) => user(`${header(local, 'user.upload', id)}\nAttachments: /raw/3f2a.png (${mime})`);
const sched = (purpose: string, local = '2026-10-07 20:30 Tue') =>
  user(`${header(local, 'schedule.fired', 'sch_01')}\nWake-up you scheduled on 2026-10-05: ${purpose}`);
const beat = (local = '2026-10-08 07:30 Wed') => user(`${header(local, 'system.heartbeat')}\nDaily heartbeat. Work through HEARTBEAT.md.`);
const situation = (extra = '', required = 'yes'): ConvItem => ({
  kind: 'harness',
  text: `<situation>\nnow: 2026-10-07T06:58:12+02:00 (Tuesday) · athlete tz: Europe/Amsterdam\ntrigger: reactive (user.message)\nreply required: ${required}\n${extra}</situation>`,
});
const asst = (calls: Array<{ name: string; input: unknown }> = [], text = ''): AssistantItem => ({
  kind: 'assistant',
  provider: 'scripted',
  model: 'demo',
  parts: [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((c, i) => ({ type: 'tool_call' as const, id: `t${i}`, name: c.name, input: c.input }))],
});
const prior: ConvItem[] = [user(`${header('2026-10-06 18:00 Mon', 'user.message', 'evt_old')}\nAthlete: hi`), asst([{ name: 'send_message', input: { text: 'hello' } }])];

const handler = demoCoachHandler();
const decide = async (items: ConvItem[]): Promise<ScriptedStep> => await handler(req({ model: 'demo', items }), { call: 0 });
const calls = (s: ScriptedStep) => s.toolCalls ?? [];
const call = (s: ScriptedStep, name: string) => calls(s).find((c) => c.name === name);
type SendInput = { text: string; reply_to?: string; ui?: { quick_replies?: Array<{ label: string; value: string }> } };
const sent = (s: ScriptedStep): SendInput => call(s, 'send_message')!.input as SendInput;
const labels = (s: ScriptedStep) => sent(s).ui?.quick_replies?.map((q) => q.label) ?? [];
const values = (s: ScriptedStep) => sent(s).ui?.quick_replies?.map((q) => q.value) ?? [];

function expectValidTools(step: ScriptedStep) {
  for (const c of calls(step)) {
    if (c.name === 'send_message' || c.name === 'write' || c.name === 'schedule' || c.name === 'no_reply') {
      const parsed = ToolInputs[c.name].safeParse(c.input);
      expect(parsed.success, `${c.name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  }
}

describe('demo coach: first conversation', () => {
  it('introduces itself as a scripted demo coach and asks about goals with quick replies', async () => {
    const step = await decide([msg('hi', 'evt_first'), situation('athlete: new\n')]);
    expect(calls(step)).toHaveLength(1);
    const s = sent(step);
    expect(s.text).toMatch(/demo/i);
    expect(s.text).toMatch(/API key/i);
    expect(s.text).toMatch(/training for|goal/i);
    expect(s.reply_to).toBe('evt_first');
    expect(labels(step)).toEqual(['First 5K', 'Half marathon', 'Marathon', 'Just get fit']);
    expectValidTools(step);
  });

  it('also treats "no previous assistant item" as first-ever', async () => {
    const step = await decide([msg('hello there', 'evt_x')]);
    expect(sent(step).text).toMatch(/demo/i);
    expect(sent(step).reply_to).toBe('evt_x');
  });

  it('does not re-introduce once the coach has spoken', async () => {
    const step = await decide([...prior, msg('hello again'), situation()]);
    expect(sent(step).text).not.toMatch(/API key/i);
  });

  it('safety beats the introduction', async () => {
    const step = await decide([msg('my knee really hurts', 'evt_k'), situation('athlete: new\n')]);
    expect(sent(step).text).toMatch(/stop running|doctor|physio/i);
    expect(sent(step).text).not.toMatch(/API key/i);
  });
});

describe('demo coach: reactive replies [RT-4]', () => {
  const after = (...items: ConvItem[]) => [...prior, ...items, situation()];

  it('pain / hurt / injury -> careful, safety-first reply (no schedule, no cheerleading)', async () => {
    for (const text of ['my knee hurts', 'I think I have an injury', 'sharp pain in my achilles', 'Ankle is hurting after the run']) {
      const step = await decide(after(msg(text, 'evt_p')));
      expect(calls(step).map((c) => c.name)).toEqual(['send_message']);
      expect(sent(step).text).toMatch(/stop running|doctor|physio/i);
      expect(sent(step).reply_to).toBe('evt_p');
      expectValidTools(step);
    }
  });

  it('urgent symptoms get an emergency-care message', async () => {
    const step = await decide(after(msg('I have chest pain and feel dizzy', 'evt_u')));
    expect(sent(step).text).toMatch(/medical help|emergency/i);
    expect(sent(step).text).not.toMatch(/scheduled/i);
  });

  it('mentioning a run asks for effort 1-10 with quick replies', async () => {
    for (const text of ['Tempo done, brutal 😅', 'I ran 5k this morning', 'finished my workout', 'I just ran today']) {
      const step = await decide(after(msg(text, 'evt_r')));
      expect(sent(step).text).toMatch(/1 .*10/);
      expect(values(step)).toContain('8');
      expect(values(step).every((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10)).toBe(true);
      expect(sent(step).reply_to).toBe('evt_r');
      expectValidTools(step);
    }
  });

  it('a numeric 1-10 reply writes a journal note and acknowledges (in one parallel step)', async () => {
    const step = await decide(after(msg('8', 'evt_8')));
    expect(calls(step).map((c) => c.name)).toEqual(['write', 'send_message']);
    const w = call(step, 'write')!.input as { path: string; content: string };
    expect(w.path).toBe('journal/2026-10-07.md');
    expect(w.content).toContain('8/10');
    expect(sent(step).text).toContain('8/10');
    expect(sent(step).reply_to).toBe('evt_8');
    expectValidTools(step);
    for (const t of ['1', '10', '7/10', ' 5 ']) {
      const s = await decide(after(msg(t, 'evt_n')));
      expect(calls(s).map((c) => c.name)).toEqual(['write', 'send_message']);
    }
    // not numeric ratings
    for (const t of ['0', '11', '8 km']) {
      const s = await decide(after(msg(t, 'evt_n')));
      expect(call(s, 'write')).toBeUndefined();
    }
  });

  it('"plan" / "schedule" schedules a one-shot check-in tomorrow 08:00 in the athlete offset and confirms', async () => {
    for (const text of ['can you make me a plan?', 'schedule something']) {
      const step = await decide(after(msg(text, 'evt_pl')));
      expect(calls(step).map((c) => c.name)).toEqual(['schedule', 'send_message']);
      const sc = call(step, 'schedule')!.input as { id: string; spec: { at: string }; purpose: string };
      expect(sc.spec.at).toBe('2026-10-08T08:00:00+02:00');
      expect(sc.purpose.length).toBeGreaterThan(10);
      expect(sent(step).text).toMatch(/08:00/);
      expect(sent(step).reply_to).toBe('evt_pl');
      expectValidTools(step);
    }
  });

  it('computes "tomorrow" across month and year boundaries', async () => {
    const at = async (local: string) => {
      const step = await decide([...prior, msg('plan', 'evt_d', local), situation()]);
      return (call(step, 'schedule')!.input as { spec: { at: string } }).spec.at;
    };
    expect(await at('2026-10-31 21:00 Sat')).toBe('2026-11-01T08:00:00+02:00');
    expect(await at('2026-12-31 21:00 Thu')).toBe('2027-01-01T08:00:00+02:00');
    expect(await at('2028-02-28 21:00 Mon')).toBe('2028-02-29T08:00:00+02:00');
  });

  it('uses Z when the situation report carries no offset', async () => {
    const step = await decide([...prior, msg('plan', 'evt_z')]);
    expect((call(step, 'schedule')!.input as { spec: { at: string } }).spec.at).toBe('2026-10-08T08:00:00Z');
  });

  it('otherwise sends a friendly generic reply with a way forward', async () => {
    const step = await decide(after(msg('what is the weather like', 'evt_g')));
    expect(calls(step).map((c) => c.name)).toEqual(['send_message']);
    expect(sent(step).text).toMatch(/demo/i);
    expect(labels(step).length).toBeGreaterThan(0);
    expect(sent(step).reply_to).toBe('evt_g');
    expectValidTools(step);
  });

  it('answers rest days kindly', async () => {
    const step = await decide(after(msg('taking a rest day', 'evt_rd')));
    expect(sent(step).text).toMatch(/rest/i);
  });

  it('acknowledges tapped quick replies', async () => {
    // an effort tap behaves like a numeric reply (journal + ack)
    const eight = await decide(after(tap('8', 'evt_t8')));
    expect(calls(eight).map((c) => c.name)).toEqual(['write', 'send_message']);
    expect(sent(eight).reply_to).toBe('evt_t8');
    expect(sent(eight).text).toContain('8/10');
    // goals
    const half = await decide(after(tap('Half marathon', 'evt_hm')));
    expect(sent(half).text).toMatch(/half marathon/i);
    expect(sent(half).reply_to).toBe('evt_hm');
    for (const [goal, pattern] of [['First 5K', /5k/i], ['Marathon', /marathon/i], ['Just get fit', /get fit/i]] as const) {
      const s = await decide(after(tap(goal)));
      expect(calls(s)).toHaveLength(1);
      expect(sent(s).text).toMatch(pattern);
      expect(sent(s).text).toMatch(/great goal/i);
    }
    // our own quick-reply values route sensibly
    expect(call(await decide(after(tap('Make me a plan'))), 'schedule')).toBeDefined();
    expect(sent(await decide(after(tap('I just ran today')))).text).toMatch(/1 .*10/);
    // unknown value: acknowledged
    expect(sent(await decide(after(tap('Banana')))).text).toContain('Banana');
  });

  it('uploads with images: cannot read them in demo mode, asks for distance and time', async () => {
    const step = await decide(after(upload('evt_img')));
    expect(sent(step).text).toMatch(/can't read images/i);
    expect(sent(step).text).toMatch(/distance/i);
    expect(sent(step).reply_to).toBe('evt_img');
    // image content parts attached directly
    const withPart = await decide(after({ kind: 'user', parts: [{ type: 'text', text: `${header(TUE, 'user.upload', 'evt_p')}\nAttachments: x` }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }));
    expect(sent(withPart).text).toMatch(/can't read images/i);
    // non-image file
    const gpx = await decide(after(upload('evt_gpx', 'application/gpx+xml')));
    expect(sent(gpx).text).toMatch(/file/i);
  });

  it('replies to the LAST athlete event of a batched item', async () => {
    const batched = user(
      `${header(TUE, 'user.upload', 'evt_u1')}\nAttachments: /raw/a.png (image/png)\n\n${header('2026-10-07 06:58 Tue', 'user.upload', 'evt_u2')}\nAttachments: /raw/b.png (image/png)\n\n${header('2026-10-07 06:59 Tue', 'user.message', 'evt_m3')}\nAthlete: tempo done, brutal`,
    );
    const step = await decide(after(batched));
    expect(sent(step).reply_to).toBe('evt_m3');
    expect(sent(step).text).toMatch(/can't read images/i);
  });

  it('a steering item that arrives mid-turn is answered after the tool results', async () => {
    const step = await decide([...prior, msg('I ran', 'evt_a'), situation(), asst([{ name: 'send_message', input: { text: 'effort?' } }]), { kind: 'tool_results', results: [toolResultText('t0', 'send_message', 'sent')] }, tap('8', 'evt_steer')]);
    expect(calls(step).map((c) => c.name)).toEqual(['write', 'send_message']);
    expect(sent(step).reply_to).toBe('evt_steer');
  });
});

describe('demo coach: tool results and proactive turns', () => {
  it('after tool results it ends the turn with a short private note and no tool calls', async () => {
    const step = await decide([...prior, msg('8', 'evt_8'), situation(), asst([{ name: 'send_message', input: {} }]), { kind: 'tool_results', results: [toolResultText('t0', 'send_message', 'sent')] }]);
    expect(calls(step)).toEqual([]);
    expect(step.text).toBeTruthy();
    expect(step.text!.length).toBeLessThan(200);
  });

  it('schedule.fired: at most one short proactive message per local day, without reply_to', async () => {
    const first = await decide([...prior, sched('Check whether today\'s tempo was logged.'), situation('', 'no')]);
    expect(calls(first).map((c) => c.name)).toEqual(['send_message']);
    expect(sent(first).reply_to).toBeUndefined();
    expect(sent(first).text).toContain("today's tempo was logged");
    expectValidTools(first);

    // the turn happened; later the same day another wake fires
    const history: ConvItem[] = [...prior, sched('Check tempo.'), situation('', 'no'), asst([{ name: 'send_message', input: first.toolCalls![0]!.input }])];
    const second = await decide([...history, sched('Evening nudge', '2026-10-07 21:00 Tue'), situation('', 'no')]);
    expect(calls(second)).toEqual([]);
    expect(second.text).toMatch(/already|quiet/i);

    // next local day: allowed again
    const nextDay = await decide([...history, beat('2026-10-08 07:30 Wed'), situation('', 'no')]);
    expect(calls(nextDay).map((c) => c.name)).toEqual(['send_message']);
  });

  it('system.heartbeat: one proactive message, then silence for the rest of the day', async () => {
    const first = await decide([...prior, beat(), situation('', 'no')]);
    expect(calls(first).map((c) => c.name)).toEqual(['send_message']);
    expect(sent(first).reply_to).toBeUndefined();
    const second = await decide([...prior, beat(), situation('', 'no'), asst([{ name: 'send_message', input: first.toolCalls![0]!.input }]), beat('2026-10-08 19:00 Wed'), situation('', 'no')]);
    expect(calls(second)).toEqual([]);
  });

  it('a reply to the athlete earlier today does not count as the proactive message', async () => {
    const history: ConvItem[] = [...prior, msg('hi', 'evt_h', '2026-10-08 06:00 Wed'), asst([{ name: 'send_message', input: { text: 'hello!' } }])];
    const step = await decide([...history, beat('2026-10-08 07:30 Wed'), situation('', 'no')]);
    expect(calls(step).map((c) => c.name)).toEqual(['send_message']);
  });

  it('other triggers: silent unless a reply is required, in which case no_reply', async () => {
    const task = user(`${header(TUE, 'task.completed', 'tsk_1')}\nHelper finished.`);
    const quiet = await decide([...prior, task, situation('', 'no')]);
    expect(calls(quiet)).toEqual([]);
    const required = await decide([...prior, task, situation('', 'yes')]);
    expect(calls(required).map((c) => c.name)).toEqual(['no_reply']);
    expectValidTools(required);
  });
});

describe('demo coach: robustness and determinism', () => {
  it('never throws on malformed input', async () => {
    const weird: unknown[] = [
      undefined,
      {},
      { items: undefined },
      { items: [] },
      { items: [{ kind: 'user' }] },
      { items: [{ kind: 'user', parts: null }] },
      { items: [{ kind: 'user', parts: [{ type: 'text' }] }] },
      { items: [{ kind: 'harness' }, { kind: 'assistant' }, { kind: 'tool_results' }] },
      { items: [null, 5, 'x'] },
      { items: [user('[bad header · · ]\n\n[]')] },
      { items: [user('[2026-13-45 99:99 Zzz · user.message · evt_1]\nAthlete: 8')] },
    ];
    for (const w of weird) {
      let step: ScriptedStep | undefined;
      await expect((async () => (step = await handler(w as never, { call: 0 })))()).resolves.toBeDefined();
      expect(step).toBeTypeOf('object');
    }
  });

  it('treats a header-less user item as an athlete message', async () => {
    const step = await decide([...prior, user('Athlete: I ran today')]);
    expect(sent(step).text).toMatch(/1 .*10/);
    expect(sent(step).reply_to).toBeUndefined();
  });

  it('is deterministic', async () => {
    const items = [...prior, msg('plan please', 'evt_d'), situation()];
    expect(JSON.stringify(await decide(items))).toBe(JSON.stringify(await decide(items)));
  });

  it('all quick replies respect the micro-UI limits', async () => {
    const all = [msg('hi', 'a'), msg('I ran', 'b'), msg('pain', 'c'), msg('banana', 'd'), tap('First 5K'), upload()];
    for (const m of all) {
      const step = await decide([...prior, m, situation()]);
      expectValidTools(step);
      for (const q of sent(step).ui?.quick_replies ?? []) expect(q.label.length).toBeLessThanOrEqual(24);
      expect((sent(step).ui?.quick_replies ?? []).length).toBeLessThanOrEqual(6);
    }
  });
});

describe('demo coach: end to end through the agent loop', () => {
  it('walks intro -> run -> effort tap with real tool execution', async () => {
    const provider = createScriptedProvider({ id: 'demo', handler: demoCoachHandler() });
    const sentMessages: SendInput[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const scheduled: unknown[] = [];
    const tools = fakeTools(
      {
        send_message: (i) => {
          sentMessages.push(i as SendInput);
          return 'sent';
        },
        write: (i) => {
          writes.push(i as { path: string; content: string });
          return 'written';
        },
        schedule: (i) => {
          scheduled.push(i);
          return 'scheduled';
        },
      },
      ['send_message', 'write', 'schedule'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    );
    const loop = createAgentLoop();
    let transcript: ConvItem[] = [];
    const turn = async (items: ConvItem[]) => {
      const r = await loop.runTurn(baseInput({ route: [resolved(provider, 'demo')], tools, items: [...transcript, ...items] }));
      transcript = [...transcript, ...items, ...r.newItems];
      return r;
    };

    const t1 = await turn([msg('hi', 'evt_1'), situation('athlete: new\n')]);
    expect(t1.stopReason).toBe('end_turn');
    expect(t1.steps).toBe(2);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toMatch(/demo/i);

    const t2 = await turn([msg('Just did a tempo run', 'evt_2', '2026-10-07 07:10 Tue'), situation()]);
    expect(t2.stopReason).toBe('end_turn');
    expect(sentMessages.at(-1)?.text).toMatch(/1 .*10/);
    expect(sentMessages.at(-1)?.reply_to).toBe('evt_2');

    const t3 = await turn([tap('8', 'evt_3'), situation()]);
    expect(t3.stopReason).toBe('end_turn');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('journal/2026-10-07.md');
    expect(sentMessages.at(-1)?.text).toContain('8/10');

    const t4 = await turn([msg('can you plan my week', 'evt_4', '2026-10-07 07:20 Tue'), situation()]);
    expect(t4.stopReason).toBe('end_turn');
    expect(scheduled).toHaveLength(1);
    const asToolCall = (t4.newItems[0] as AssistantItem).parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
    expect(asToolCall.map((p) => p.name)).toEqual(['schedule', 'send_message']);
  });
});
