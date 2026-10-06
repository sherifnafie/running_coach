import { readFile, readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolInputs, VOICE_TOOLS, athletePaths, settle, toToolJsonSchema } from '@opencoach/protocol';
import { VoiceError } from '../src';
import { ATHLETE, OTHER_ATHLETE, deferred, makeHarness, type Harness } from './harness';

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const history = (athleteId = ATHLETE) => athletePaths(h.dataDir, athleteId).history;

async function expectVoiceError(p: Promise<unknown>, reason: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VoiceError);
  expect((err as VoiceError).reason).toBe(reason);
}

async function endedEvent() {
  await vi.waitFor(() => expect(h.eventsOf('call.ended')).toHaveLength(1));
  return h.eventsOf('call.ended')[0]!;
}

describe('features()', () => {
  it('reflects which providers are configured', async () => {
    h = await makeHarness({ realtime: true, transcriber: true, synthesizer: true });
    expect(h.service.features()).toEqual({ realtime: true, cascaded: true, voiceNotes: true });
    await h.cleanup();
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: false });
    expect(h.service.features()).toEqual({ realtime: false, cascaded: false, voiceNotes: true });
    await h.cleanup();
    h = await makeHarness({ realtime: true });
    expect(h.service.features()).toEqual({ realtime: true, cascaded: false, voiceNotes: false });
  });
});

describe('start()', () => {
  it('realtime: briefs the voice model, exposes the voice tools and announces call.started', async () => {
    h = await makeHarness({ realtime: true });
    const info = await h.service.start(ATHLETE, { purpose: 'talk through race week' });

    expect(h.calls.briefing).toEqual([{ athleteId: ATHLETE, purpose: 'talk through race week' }]);
    expect(h.realtime.sessions).toHaveLength(1);
    const session = h.realtime.sessions[0]!;
    expect(session.instructions).toBe('BRIEFING for Alex. Purpose: talk through race week.'); // used verbatim
    expect(session.voice).toBe('marin'); // athlete's chosen voice
    expect(session.model).toBe('gpt-realtime-2.1');
    expect(session.tools.map((t) => t.name)).toEqual([...VOICE_TOOLS]);
    for (const t of session.tools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toEqual(toToolJsonSchema(ToolInputs[t.name as keyof typeof ToolInputs]));
    }

    expect(info).toMatchObject({ mode: 'realtime', provider: 'fake-realtime', model: 'gpt-realtime-2.1', maxDurationS: 600 });
    expect(info.callId).toMatch(/^call_[0-9A-Z]{26}$/);
    expect(info.connect).toEqual({ type: 'openai-webrtc', callsUrl: 'https://rt.test/v1/realtime/calls', ephemeralKey: 'ek_fake', expiresAt: '2026-10-06T10:01:00.000Z', model: 'gpt-realtime-2.1' });

    expect(h.events).toEqual([
      { athleteId: ATHLETE, type: 'call.started', actor: 'harness', payload: { callId: info.callId, mode: 'realtime', provider: 'fake-realtime', model: 'gpt-realtime-2.1' } },
    ]);
  });

  it('cascaded: no connect info, no briefing, provider/model describe the STT+TTS pair', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const info = await h.service.start(ATHLETE, {});
    expect(info.mode).toBe('cascaded');
    expect(info.connect).toBeUndefined();
    expect(info.provider).toBe('fake-stt+fake-tts');
    expect(info.model).toBe('gpt-4o-transcribe+gpt-4o-mini-tts');
    expect(info.maxDurationS).toBe(600);
    expect(h.calls.briefing).toEqual([]);
    expect(h.eventsOf('call.started')[0]!.payload).toEqual({ callId: info.callId, mode: 'cascaded', provider: 'fake-stt+fake-tts', model: 'gpt-4o-transcribe+gpt-4o-mini-tts' });
  });

  it("defaults to the athlete's callMode, falls back to the other mode, and refuses when neither exists", async () => {
    h = await makeHarness({ realtime: true, transcriber: true, synthesizer: true, settings: { voice: { callMode: 'cascaded' } } });
    expect((await h.service.start(ATHLETE, {})).mode).toBe('cascaded');
    expect((await h.service.start(ATHLETE, { mode: 'realtime' })).mode).toBe('realtime'); // explicit wins
    await h.cleanup();

    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true, settings: { voice: { callMode: 'realtime' } } });
    expect((await h.service.start(ATHLETE, {})).mode).toBe('cascaded'); // preferred unavailable → other
    await h.cleanup();

    h = await makeHarness({ realtime: true, settings: { voice: { callMode: 'cascaded' } } });
    expect((await h.service.start(ATHLETE, {})).mode).toBe('realtime');
    await expectVoiceError(h.service.start(ATHLETE, { mode: 'cascaded' }), 'calls_unavailable'); // explicit but unavailable
    await h.cleanup();

    h = await makeHarness({ realtime: false });
    await expectVoiceError(h.service.start(ATHLETE, {}), 'calls_unavailable');
    expect(h.events).toEqual([]);
  });

  it('propagates briefing failures without announcing a call', async () => {
    h = await makeHarness({ realtime: true });
    h.impl.briefing = async () => {
      throw new Error('workspace locked');
    };
    await expect(h.service.start(ATHLETE, {})).rejects.toThrow('workspace locked');
    expect(h.events).toEqual([]);
    expect(h.clock.pendingCount()).toBe(0);
  });
});

describe('attach() and ownership', () => {
  it('opens the sideband for the athlete’s own call only', async () => {
    h = await makeHarness({ realtime: true });
    const { callId } = await h.service.start(ATHLETE, {});

    await expectVoiceError(h.service.attach(OTHER_ATHLETE, callId, 'rtc_1'), 'call_not_found');
    await expectVoiceError(h.service.attach(ATHLETE, 'call_unknown', 'rtc_1'), 'call_not_found');
    expect(h.realtime.sidebands).toHaveLength(0);

    await h.service.attach(ATHLETE, callId, 'rtc_1');
    expect(h.realtime.sidebands).toHaveLength(1);
    expect(h.realtime.sidebands[0]!.providerCallId).toBe('rtc_1');
    expect(h.realtime.sidebands[0]!.model).toBe('gpt-realtime-2.1');

    await h.service.attach(ATHLETE, callId, 'rtc_1'); // same id again: no-op
    expect(h.realtime.sidebands).toHaveLength(1);
    await expectVoiceError(h.service.attach(ATHLETE, callId, 'rtc_2'), 'already_attached');
  });

  it('other athletes cannot end, stream into or probe a call', async () => {
    h = await makeHarness({ realtime: true, transcriber: true, synthesizer: true });
    const rt = await h.service.start(ATHLETE, { mode: 'realtime' });
    const cs = await h.service.start(ATHLETE, { mode: 'cascaded' });
    await expectVoiceError(h.service.end(OTHER_ATHLETE, rt.callId, 'athlete'), 'call_not_found');
    await expectVoiceError(h.service.utterance(OTHER_ATHLETE, cs.callId, new TextEncoder().encode('hi'), 'audio/webm'), 'call_not_found');
    expect(h.eventsOf('call.ended')).toHaveLength(0);
    // …and after it ended, still not theirs
    await h.service.end(ATHLETE, rt.callId, 'athlete');
    await expectVoiceError(h.service.end(OTHER_ATHLETE, rt.callId, 'athlete'), 'call_not_found');
  });

  it('refuses mode mismatches and ended calls; a failed attach can be retried', async () => {
    h = await makeHarness({ realtime: true, transcriber: true, synthesizer: true });
    const rt = await h.service.start(ATHLETE, { mode: 'realtime' });
    const cs = await h.service.start(ATHLETE, { mode: 'cascaded' });
    await expectVoiceError(h.service.attach(ATHLETE, cs.callId, 'rtc_x'), 'wrong_mode');
    await expectVoiceError(h.service.utterance(ATHLETE, rt.callId, new Uint8Array([1]), 'audio/webm'), 'wrong_mode');

    h.realtime.failAttach = new Error('provider unreachable');
    await expect(h.service.attach(ATHLETE, rt.callId, 'rtc_1')).rejects.toThrow('provider unreachable');
    h.realtime.failAttach = undefined;
    await h.service.attach(ATHLETE, rt.callId, 'rtc_1'); // retry works, call survived
    expect(h.realtime.sidebands).toHaveLength(1);

    await h.service.end(ATHLETE, rt.callId, 'athlete');
    await expectVoiceError(h.service.attach(ATHLETE, rt.callId, 'rtc_1'), 'call_ended');
  });
});

describe('sideband tools', () => {
  async function attached() {
    h = await makeHarness({ realtime: true });
    const info = await h.service.start(ATHLETE, {});
    await h.service.attach(ATHLETE, info.callId, 'rtc_1');
    const sb = h.realtime.sidebands[0]!;
    const tool = (name: string, args: unknown) => sb.handlers.onToolCall({ id: `tc_${name}`, name, arguments: args });
    return { info, sb, tool };
  }

  it('lookup → runtime.lookup', async () => {
    const { tool } = await attached();
    expect(await tool('lookup', { query: 'thursday' })).toEqual({ result: 'Result for "thursday": Thursday = 10 km tempo.' });
    expect(h.calls.lookup).toEqual([{ athleteId: ATHLETE, query: 'thursday' }]);
  });

  it('consult_coach → runtime.consult (awaited, however long it takes)', async () => {
    const { tool } = await attached();
    const gate = deferred<string>();
    h.impl.consult = () => gate.promise;
    let done = false;
    const p = tool('consult_coach', { question: 'Move the long run?', context: 'Knee felt tight on Tuesday' }).then((r) => ((done = true), r));
    await settle(5);
    expect(done).toBe(false);
    expect(h.calls.consult).toEqual([{ athleteId: ATHLETE, question: 'Move the long run?', context: 'Knee felt tight on Tuesday' }]);
    gate.resolve('Yes, move it to Sunday and keep it easy.');
    expect(await p).toEqual({ answer: 'Yes, move it to Sunday and keep it easy.' });
  });

  it('unknown tools, invalid arguments and runtime failures come back as { error }', async () => {
    const { tool } = await attached();
    expect(await tool('delete_everything', {})).toEqual({ error: 'unknown tool: delete_everything' });
    expect(await tool('lookup', {})).toMatchObject({ error: expect.stringContaining('invalid arguments for lookup') });
    expect(await tool('consult_coach', { question: 42 })).toMatchObject({ error: expect.stringContaining('invalid arguments') });
    h.impl.lookup = async () => {
      throw new Error('index is rebuilding');
    };
    expect(await tool('lookup', { query: 'x' })).toEqual({ error: 'index is rebuilding' });
    expect(h.calls.consult).toEqual([]);
  });

  it('note appends to the call notes; end_call returns ok and ends the call as "coach"', async () => {
    const { info, sb, tool } = await attached();
    expect(await tool('note', { text: 'Athlete flies to Berlin on Friday.' })).toEqual({ ok: true });
    await h.clock.advanceBy(5000);
    expect(await tool('note', { text: 'Promised an easy week after the race.' })).toEqual({ ok: true });
    expect(h.eventsOf('call.ended')).toHaveLength(0);

    expect(await tool('end_call', { reason: 'athlete said goodbye' })).toEqual({ ok: true });
    const ended = await endedEvent();
    expect((ended.payload as { endedBy: string }).endedBy).toBe('coach');
    expect(sb.closes).toBe(1);

    const notes = await readFile(`${history()}/calls/${(ended.payload as { notesPath: string }).notesPath.split('/')[3]}/notes.md`, 'utf8');
    expect(notes).toContain('Athlete flies to Berlin on Friday.');
    expect(notes).toContain('Promised an easy week after the race.');
    expect(notes).toContain('athlete said goodbye');
    expect(info.callId).toBeTruthy();
  });
});

describe('end() write-back', () => {
  it('writes transcript.md and notes.md under history/calls and emits call.ended with virtual paths', async () => {
    h = await makeHarness({ realtime: true });
    const { callId } = await h.service.start(ATHLETE, {});
    await h.service.attach(ATHLETE, callId, 'rtc_1');
    const sb = h.realtime.sidebands[0]!;

    // the coach line arrives first, but the athlete spoke first (late athlete transcripts are normal)
    sb.handlers.onTranscript({ role: 'coach', text: 'Hi Alex, how did the tempo go?', at: '2026-10-06T10:00:05.000Z' });
    sb.handlers.onTranscript({ role: 'athlete', text: 'Brutal, but I finished it.', at: '2026-10-06T10:00:01.000Z' });
    sb.handlers.onTranscript({ role: 'athlete', text: '   ', at: '2026-10-06T10:00:10.000Z' }); // ignored
    await sb.handlers.onToolCall({ id: '1', name: 'note', arguments: { text: 'Tempo felt brutal, completed.' } });
    h.impl.consult = async () => 'Keep Thursday easy.';
    await sb.handlers.onToolCall({ id: '2', name: 'consult_coach', arguments: { question: 'Thursday?', context: 'tired legs' } });
    await h.clock.advanceBy(125_000);

    await h.service.end(ATHLETE, callId, 'athlete');

    const events = h.eventsOf('call.ended');
    expect(events).toHaveLength(1);
    const dir = `2026-10-06-${callId}`;
    expect(events[0]).toEqual({
      athleteId: ATHLETE,
      type: 'call.ended',
      actor: 'harness',
      payload: { callId, durationS: 125, transcriptPath: `/history/calls/${dir}/transcript.md`, notesPath: `/history/calls/${dir}/notes.md`, endedBy: 'athlete' },
    });
    expect(sb.closes).toBe(1);

    expect(await readdir(`${history()}/calls/${dir}`)).toEqual(['notes.md', 'transcript.md']);
    const transcript = await readFile(`${history()}/calls/${dir}/transcript.md`, 'utf8');
    expect(transcript).toContain(callId);
    expect(transcript).toContain('Europe/Amsterdam');
    expect(transcript).toContain('Duration: 2 min 5 s');
    expect(transcript).toContain('Ended by: athlete');
    // chronological order, in the athlete's local time (UTC+2)
    expect(transcript).toContain('**Athlete** (12:00:01): Brutal, but I finished it.');
    expect(transcript).toContain('**Coach** (12:00:05): Hi Alex, how did the tempo go?');
    expect(transcript.indexOf('**Athlete** (12:00:01)')).toBeLessThan(transcript.indexOf('**Coach** (12:00:05)'));
    expect(transcript).not.toContain('12:00:10');

    const notes = await readFile(`${history()}/calls/${dir}/notes.md`, 'utf8');
    expect(notes).toContain('- (12:00:00) Tempo felt brutal, completed.');
    expect(notes).toContain('Question: Thursday?');
    expect(notes).toContain('Context: tired legs');
    expect(notes).toContain('Answer given to the athlete: Keep Thursday easy.');
  });

  it('writes empty-call files too (cascaded, nothing said) and uses the athlete-local date', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true, start: '2026-10-06T23:30:00.000Z' });
    const { callId } = await h.service.start(ATHLETE, {});
    await h.service.end(ATHLETE, callId, 'athlete');
    const ev = (await endedEvent()).payload as { transcriptPath: string; durationS: number };
    expect(ev.transcriptPath).toBe(`/history/calls/2026-10-07-${callId}/transcript.md`); // 01:30 in Amsterdam
    expect(ev.durationS).toBe(0);
    const t = await readFile(`${history()}/calls/2026-10-07-${callId}/transcript.md`, 'utf8');
    expect(t).toContain('_No speech was transcribed._');
    const n = await readFile(`${history()}/calls/2026-10-07-${callId}/notes.md`, 'utf8');
    expect(n).toContain('_No notes were taken._');
  });

  it('is idempotent: repeated and concurrent end() produce one call.ended and one sideband close', async () => {
    h = await makeHarness({ realtime: true });
    const { callId } = await h.service.start(ATHLETE, {});
    await h.service.attach(ATHLETE, callId, 'rtc_1');
    const sb = h.realtime.sidebands[0]!;

    await Promise.all([h.service.end(ATHLETE, callId, 'athlete'), h.service.end(ATHLETE, callId, 'coach'), h.service.end(ATHLETE, callId, 'error')]);
    await h.service.end(ATHLETE, callId, 'athlete');
    sb.handlers.onEnd('athlete'); // provider reports the close we caused / a late one
    await settle(5);

    expect(h.eventsOf('call.ended')).toHaveLength(1);
    expect((h.eventsOf('call.ended')[0]!.payload as { endedBy: string }).endedBy).toBe('athlete'); // first caller wins
    expect(sb.closes).toBe(1);
    expect(h.clock.pendingCount()).toBe(0); // max-duration timer cancelled
  });

  it('sideband onEnd ends the call: athlete hang-up → athlete, timeout → coach, error → error', async () => {
    for (const [reason, expected] of [
      ['athlete', 'athlete'],
      ['timeout', 'coach'],
      ['error', 'error'],
    ] as const) {
      h = await makeHarness({ realtime: true });
      const { callId } = await h.service.start(ATHLETE, {});
      await h.service.attach(ATHLETE, callId, 'rtc_1');
      h.realtime.sidebands[0]!.handlers.onEnd(reason, 'detail');
      const ev = await endedEvent();
      expect((ev.payload as { endedBy: string }).endedBy).toBe(expected);
      await h.cleanup();
    }
  });

  it('still emits call.ended (and clears the call) when the files cannot be written', async () => {
    h = await makeHarness({ realtime: true });
    const { callId } = await h.service.start(ATHLETE, {});
    // make <history> a file so mkdir fails
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(athletePaths(h.dataDir, ATHLETE).root, { recursive: true });
    await writeFile(history(), 'not a directory');
    await h.service.end(ATHLETE, callId, 'athlete');
    expect(h.eventsOf('call.ended')).toHaveLength(1);
    await h.service.end(ATHLETE, callId, 'athlete'); // still a no-op
    expect(h.eventsOf('call.ended')).toHaveLength(1);
  });
});

describe('max call duration', () => {
  it('ends the call through the injected Clock when maxDurationS elapses', async () => {
    h = await makeHarness({ realtime: true, config: { maxDurationS: 600 } });
    const { callId, maxDurationS } = await h.service.start(ATHLETE, {});
    await h.service.attach(ATHLETE, callId, 'rtc_1');
    expect(maxDurationS).toBe(600);
    expect(h.clock.pendingCount()).toBe(1);

    await h.clock.advanceBy(599_999);
    expect(h.eventsOf('call.ended')).toHaveLength(0);

    await h.clock.advanceBy(1);
    const ev = await endedEvent();
    expect(ev.payload).toMatchObject({ callId, durationS: 600, endedBy: 'coach' });
    expect(h.realtime.sidebands[0]!.closes).toBe(1);
    expect(h.clock.pendingCount()).toBe(0);

    // nothing fires twice
    await h.clock.advanceBy(10 * 60_000);
    expect(h.eventsOf('call.ended')).toHaveLength(1);
  });

  it('cascaded calls time out too, and a normal end cancels the timer', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true, config: { maxDurationS: 60 } });
    const a = await h.service.start(ATHLETE, {});
    const b = await h.service.start(ATHLETE, {});
    expect(h.clock.pendingCount()).toBe(2);
    await h.service.end(ATHLETE, b.callId, 'athlete');
    expect(h.clock.pendingCount()).toBe(1);
    await h.clock.advanceBy(60_000);
    await vi.waitFor(() => expect(h.eventsOf('call.ended')).toHaveLength(2));
    const byCall = Object.fromEntries(h.eventsOf('call.ended').map((e) => [(e.payload as { callId: string }).callId, (e.payload as { endedBy: string }).endedBy]));
    expect(byCall).toEqual({ [a.callId]: 'coach', [b.callId]: 'athlete' });
  });
});

describe('cascaded utterances', () => {
  const say = (text: string) => new TextEncoder().encode(text);

  it('STT → coach turn → TTS → blob, and records both sides in the transcript', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    const res = await h.service.utterance(ATHLETE, callId, say('Can we move Thursday?'), 'audio/webm;codecs=opus');

    expect(h.transcriber.calls).toEqual([{ mime: 'audio/webm;codecs=opus', bytes: 21 }]);
    expect(h.calls.callTurn).toEqual([{ athleteId: ATHLETE, callId, utterance: 'Can we move Thursday?' }]);
    expect(h.synthesizer.calls).toEqual([{ text: 'Heard: Can we move Thursday?', voice: 'marin' }]);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0]!.athleteId).toBe(ATHLETE);
    expect(h.puts[0]!.meta).toMatchObject({ mime: 'audio/mpeg', origin: 'call' });
    expect(new TextDecoder().decode(h.puts[0]!.data)).toBe('AUDIO:Heard: Can we move Thursday?');
    expect(res.transcript).toBe('Can we move Thursday?');
    expect(res.replyText).toBe('Heard: Can we move Thursday?');
    expect(res.audioSha256).toMatch(/^[a-f0-9]{64}$/);

    await h.service.end(ATHLETE, callId, 'athlete');
    const ev = (await endedEvent()).payload as { transcriptPath: string };
    const t = await readFile(`${history()}${ev.transcriptPath.replace('/history', '')}`, 'utf8');
    expect(t).toContain('**Athlete** (12:00:00): Can we move Thursday?');
    expect(t).toContain('**Coach** (12:00:00): Heard: Can we move Thursday?');
  });

  it('serializes utterances per call (second one waits for the first coach turn)', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    const gate = deferred();
    const order: string[] = [];
    h.impl.callTurn = async (_a, _c, u) => {
      order.push(`start:${u}`);
      if (u === 'first') await gate.promise;
      order.push(`end:${u}`);
      return { replyText: `re:${u}` };
    };
    const p1 = h.service.utterance(ATHLETE, callId, say('first'), 'audio/webm');
    const p2 = h.service.utterance(ATHLETE, callId, say('second'), 'audio/webm');
    await settle(10);
    expect(order).toEqual(['start:first']);
    gate.resolve();
    expect((await p1).replyText).toBe('re:first');
    expect((await p2).replyText).toBe('re:second');
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('a failed utterance does not block the next one', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    h.transcriber.fail = true;
    await expect(h.service.utterance(ATHLETE, callId, say('lost'), 'audio/webm')).rejects.toThrow('stt down');
    h.transcriber.fail = false;
    expect((await h.service.utterance(ATHLETE, callId, say('again'), 'audio/webm')).replyText).toBe('Heard: again');
  });

  it('silence (empty transcript) does not wake the coach', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    expect(await h.service.utterance(ATHLETE, callId, say('   '), 'audio/webm')).toEqual({ transcript: '', replyText: '' });
    expect(h.calls.callTurn).toEqual([]);
  });

  it('TTS failure degrades to text only', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    h.synthesizer.fail = true;
    const res = await h.service.utterance(ATHLETE, callId, say('hello'), 'audio/webm');
    expect(res).toEqual({ transcript: 'hello', replyText: 'Heard: hello' });
    expect('audioSha256' in res).toBe(false);
    expect(h.puts).toHaveLength(0);
  });

  it('refuses input after the call ended', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    await h.service.end(ATHLETE, callId, 'athlete');
    await expectVoiceError(h.service.utterance(ATHLETE, callId, say('hello?'), 'audio/webm'), 'call_ended');
  });

  it('end() waits for an utterance that is still being processed so it lands in the transcript', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    const gate = deferred();
    h.impl.callTurn = async (_a, _c, u) => {
      await gate.promise;
      return { replyText: `re:${u}` };
    };
    const pending = h.service.utterance(ATHLETE, callId, say('last words'), 'audio/webm');
    await settle(10);
    let ended = false;
    const endP = h.service.end(ATHLETE, callId, 'athlete').then(() => (ended = true));
    await settle(10);
    expect(ended).toBe(false);
    await expectVoiceError(h.service.utterance(ATHLETE, callId, say('more'), 'audio/webm'), 'call_ended');
    gate.resolve();
    await pending;
    await endP;
    const ev = (await endedEvent()).payload as { transcriptPath: string };
    const t = await readFile(`${history()}${ev.transcriptPath.replace('/history', '')}`, 'utf8');
    expect(t).toContain('last words');
    expect(t).toContain('re:last words');
  });

  it('end() gives up waiting on a stuck utterance after the grace period (clock-driven)', async () => {
    h = await makeHarness({ realtime: false, transcriber: true, synthesizer: true });
    const { callId } = await h.service.start(ATHLETE, {});
    h.impl.callTurn = () => new Promise(() => {}); // never answers
    void h.service.utterance(ATHLETE, callId, say('stuck'), 'audio/webm').catch(() => {});
    await settle(10);
    const endP = h.service.end(ATHLETE, callId, 'athlete');
    await settle(10);
    expect(h.eventsOf('call.ended')).toHaveLength(0);
    await h.clock.advanceBy(30_000);
    await endP;
    expect(h.eventsOf('call.ended')).toHaveLength(1);
  });
});

describe('voice notes', () => {
  it('transcribeVoiceNote delegates to the transcriber', async () => {
    h = await makeHarness({ realtime: false, transcriber: true });
    expect(await h.service.transcribeVoiceNote(new TextEncoder().encode('long run done'), 'audio/mp4')).toEqual({ text: 'long run done', model: 'fake-stt-model', durationS: 2 });
    expect(h.transcriber.calls).toEqual([{ mime: 'audio/mp4', bytes: 13 }]);
  });

  it('throws a typed error when voice notes are unavailable', async () => {
    h = await makeHarness({ realtime: true });
    await expectVoiceError(h.service.transcribeVoiceNote(new Uint8Array([1]), 'audio/webm'), 'voice_notes_unavailable');
    const err = (await h.service.transcribeVoiceNote(new Uint8Array([1]), 'audio/webm').catch((e: unknown) => e)) as VoiceError;
    expect(err.code).toBe('NOT_CONFIGURED');
  });
});

describe('dispose()', () => {
  it('ends every active call as "error", cancels timers and refuses new calls', async () => {
    h = await makeHarness({ realtime: true, transcriber: true, synthesizer: true });
    const a = await h.service.start(ATHLETE, { mode: 'realtime' });
    await h.service.attach(ATHLETE, a.callId, 'rtc_1');
    const b = await h.service.start(OTHER_ATHLETE, { mode: 'cascaded' });
    expect(h.clock.pendingCount()).toBe(2);

    await h.service.dispose();

    const ended = h.eventsOf('call.ended');
    expect(ended).toHaveLength(2);
    expect(ended.map((e) => (e.payload as { endedBy: string }).endedBy)).toEqual(['error', 'error']);
    expect(new Set(ended.map((e) => (e.payload as { callId: string }).callId))).toEqual(new Set([a.callId, b.callId]));
    expect(h.realtime.sidebands[0]!.closes).toBe(1);
    expect(h.clock.pendingCount()).toBe(0);
    await expectVoiceError(h.service.start(ATHLETE, {}), 'calls_unavailable');
    await h.service.dispose(); // twice is fine
    expect(h.eventsOf('call.ended')).toHaveLength(2);
  });
});
