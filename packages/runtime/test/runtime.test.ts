import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnyEvent } from '@opencoach/protocol';
import { lastItemKind, lastUserText, makeHarness, send, situationText, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const base = { displayName: 'Sam', coachName: 'Kip', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: true };

async function newAthlete(harness: Harness) {
  const a = await harness.runtime.createAthlete(base);
  return a.id;
}

/** Run the first-contact turn with a coach that just greets. */
async function greet(harness: Harness, athleteId: string) {
  harness.setHandler((req) => (lastItemKind(req) === 'tool_results' ? { text: 'greeted' } : send('Hi Sam, I am Kip. What are you training for?')));
  await harness.runtime.tickScheduler();
  await harness.settle(athleteId);
}

describe('runtime: onboarding & reactive turns', () => {
  it('creates a workspace, publishes seed views and greets on first contact', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    const ws = h.runtime.core.paths(id).workspace;
    const agents = await readFile(join(ws, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('pinned');
    const app = await h.runtime.views.appInfo(id);
    expect(app.views.length).toBeGreaterThanOrEqual(1);
    expect(app.views[0]!.url).toMatch(/\/v\/[A-Za-z0-9_-]+\/[a-z0-9-]+@1\//);

    await greet(h, id);
    const req = h.requests.at(-2)!;
    expect(situationText(req)).toContain('FIRST CONTACT');
    expect(req.system[0]!.text).toContain('Kip');
    const msgs = (await h.events(id, ['coach.message'])) as Array<Extract<AnyEvent, { type: 'coach.message' }>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload.proactive).toBe(false);
    expect(msgs[0]!.payload.delivery).toBe('sent');
  });

  it('replies to athlete messages with streaming and quick replies', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    h.setHandler((req) =>
      lastItemKind(req) === 'tool_results'
        ? { text: 'asked for rpe' }
        : send('Nice work! How hard did it feel?', { ui: { quick_replies: [{ label: 'Easy', value: '3' }, { label: 'Hard', value: '8' }] } }),
    );
    h.stream.length = 0;
    const e = await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'Did my 8k easy run', clientId: 'c1' } });
    await h.settle(id);
    const req = h.requests.find((r) => lastUserText(r).includes('Did my 8k easy run'))!;
    expect(lastUserText(req)).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} \w{3} · user\.message · evt_/);
    expect(situationText(req)).toContain('reply required: yes');
    const kinds = h.stream.map((m) => m.t);
    expect(kinds).toContain('message.start');
    expect(kinds).toContain('message.delta');
    expect(kinds).toContain('message.end');
    const end = h.stream.find((m) => m.t === 'message.end') as Extract<typeof h.stream[number], { t: 'message.end' }>;
    expect(end.event.payload.ui?.quick_replies).toHaveLength(2);
    expect(end.event.payload.replyTo).toBe(e.id);
  });

  it('re-prompts once and then falls back when the coach does not reply [RT-4]', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    h.setHandler(() => ({ text: 'thinking quietly' }));
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'hello?', clientId: 'c2' } });
    await h.settle(id);
    const reminder = h.requests.at(-1)!.items.some((i) => i.kind === 'harness' && i.text.includes("haven't replied"));
    expect(reminder).toBe(true);
    const notices = (await h.events(id, ['harness.notice'])) as Array<Extract<AnyEvent, { type: 'harness.notice' }>>;
    expect(notices.some((n) => n.payload.kind === 'reply_fallback' && n.payload.athleteVisible)).toBe(true);
    const schedules = await h.runtime.core.store.listSchedules(id, { status: 'active', kind: 'coach' });
    expect(schedules.some((s) => s.purpose.includes('without replying'))).toBe(true);
  });

  it('accepts no_reply as a valid outcome', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    h.setHandler((req) => (lastItemKind(req) === 'tool_results' ? { text: '' } : { toolCalls: [{ name: 'no_reply', input: { reason: 'just a thumbs up' } }] }));
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: '👍', clientId: 'c3' } });
    await h.settle(id);
    const notices = (await h.events(id, ['harness.notice'])) as Array<Extract<AnyEvent, { type: 'harness.notice' }>>;
    expect(notices.some((n) => n.payload.kind === 'reply_fallback')).toBe(false);
  });
});

describe('runtime: proactivity policies', () => {
  it('holds proactive messages during quiet hours and releases them after [MSG-4]', async () => {
    // 23:00 local (CEST = UTC+2)
    h = await makeHarness({ start: '2026-10-07T21:00:00Z' });
    const id = await newAthlete(h);
    await greet(h, id);
    // coach schedules a wake in 30 minutes (still quiet hours)
    h.setHandler((req) => {
      if (lastItemKind(req) === 'tool_results') return { text: 'ok' };
      const t = lastUserText(req);
      if (t.includes('schedule.fired')) return send('Quick check: did the tempo happen?');
      return { toolCalls: [
        { name: 'schedule', input: { spec: { at: '2026-10-07T21:30:00Z' }, purpose: 'check tempo' } },
        { name: 'send_message', input: { text: 'I will check in later.' } },
      ] };
    });
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'remind me later', clientId: 'c4' } });
    await h.settle(id);
    await h.clock.advanceTo('2026-10-07T21:31:00Z');
    await h.runtime.tickScheduler();
    await h.settle(id);
    const msgs = (await h.events(id, ['coach.message'])) as Array<Extract<AnyEvent, { type: 'coach.message' }>>;
    const proactive = msgs.filter((m) => m.payload.proactive);
    expect(proactive).toHaveLength(1);
    expect(proactive[0]!.payload.delivery).toBe('held');
    expect(proactive[0]!.payload.heldUntil).toBe('2026-10-08T05:00:00.000Z');
    // release at 07:00 local
    await h.clock.advanceTo('2026-10-08T05:00:30Z');
    await h.runtime.tickScheduler();
    await h.settle(id);
    const after = (await h.events(id, ['coach.message'])) as Array<Extract<AnyEvent, { type: 'coach.message' }>>;
    const released = after.filter((m) => m.payload.messageId === proactive[0]!.payload.messageId && m.payload.delivery === 'sent');
    expect(released).toHaveLength(1);
  });

  it('enforces the daily proactive budget', async () => {
    h = await makeHarness({ start: '2026-10-07T08:00:00Z' });
    const id = await newAthlete(h);
    await greet(h, id);
    await h.runtime.updateSettings(id, { notifications: { proactivePerDay: 1, minGapMinutes: 0, quietHours: null } });
    const results: string[] = [];
    h.setHandler((req) => {
      if (lastItemKind(req) === 'tool_results') {
        const tr = req.items.at(-1)!;
        if (tr.kind === 'tool_results') results.push(tr.results.map((r) => (r.content[0]?.type === 'text' ? r.content[0].text : '')).join(''));
        return { text: 'ok' };
      }
      return send('Proactive nudge');
    });
    await h.runtime.core.scheduler.harnessWake(id, new Date('2026-10-07T09:00:00Z'), 'nudge 1');
    await h.runtime.core.scheduler.harnessWake(id, new Date('2026-10-07T10:00:00Z'), 'nudge 2');
    await h.clock.advanceTo('2026-10-07T09:00:01Z');
    await h.runtime.tickScheduler();
    await h.settle(id);
    await h.clock.advanceTo('2026-10-07T10:00:01Z');
    await h.runtime.tickScheduler();
    await h.settle(id);
    expect(results.some((r) => r.includes('PROACTIVE_BUDGET_EXHAUSTED'))).toBe(true);
  });

  it('flags safety signals and tells the coach [SAFE-2]', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    h.setHandler((req) => (lastItemKind(req) === 'tool_results' ? { text: '' } : send('Please stop and seek medical care now.')));
    h.stream.length = 0;
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'I had chest pain and nearly fainted during intervals today', clientId: 'c5' } });
    await h.settle(id);
    expect(h.stream.some((m) => m.t === 'safety')).toBe(true);
    const req = h.requests.find((r) => lastUserText(r).includes('chest pain'))!;
    expect(situationText(req)).toContain('SAFETY');
  });
});

describe('runtime: steering, schedules, helpers, views', () => {
  it('injects athlete messages that arrive mid-turn at the next tool boundary [RT-3]', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    let sawSteer = false;
    let injected = false;
    h.setHandler(async (req) => {
      const text = lastUserText(req);
      if (text.includes('while you were working')) sawSteer = true;
      if (lastItemKind(req) !== 'tool_results' && !sawSteer && text.includes('first message')) {
        if (!injected) {
          injected = true;
          await h!.runtime.ingest(id, { type: 'user.message', payload: { text: 'oh and my knee hurts', clientId: 'c7' } });
        }
        return { toolCalls: [{ name: 'read', input: { path: 'AGENTS.md' } }] };
      }
      if (lastItemKind(req) === 'tool_results' && !sawSteer) return { text: 'done' };
      if (lastItemKind(req) === 'tool_results') return { text: 'replied' };
      return send('Thanks — noted about the knee.');
    });
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'first message', clientId: 'c6' } });
    await h.settle(id);
    expect(injected).toBe(true);
    expect(sawSteer).toBe(true);
    const turns = await h.runtime.core.store.listTurns({ athleteId: id, limit: 20 });
    expect(turns.filter((t) => t.agent === 'coach' && t.triggerClass === 'reactive')).toHaveLength(1);
    const epoch = await h.runtime.core.store.getOpenEpoch(id);
    const items = await h.runtime.core.store.listEpochItems(epoch!.id);
    expect(items.some(({ item }) => item.kind === 'user' && item.parts.some((p) => p.type === 'text' && p.text.includes('while you were working')))).toBe(true);
  });

  it('lets the coach schedule wakes that fire as scheduled turns', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    h.setHandler((req) => {
      if (lastItemKind(req) === 'tool_results') return { text: 'scheduled' };
      if (lastUserText(req).includes('schedule.fired')) return { text: 'nothing to say' };
      return { toolCalls: [{ name: 'schedule', input: { id: 'tempo-check', spec: { rrule: 'FREQ=DAILY', time: '20:30' }, purpose: 'check if the tempo was logged' } }, { name: 'send_message', input: { text: 'Will check in tonight.' } }] };
    });
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'tempo tonight', clientId: 'c8' } });
    await h.settle(id);
    const list = await h.runtime.core.scheduler.list(id);
    const s = list.find((x) => x.id.endsWith('tempo-check'))!;
    expect(s.nextFireAt).toBe('2026-10-07T18:30:00.000Z');
    await h.clock.advanceTo('2026-10-07T18:30:05Z');
    await h.runtime.tickScheduler();
    await h.settle(id);
    const fired = await h.events(id, ['schedule.fired']);
    expect(fired.some((e) => e.type === 'schedule.fired' && e.payload.purpose.includes('tempo'))).toBe(true);
  });

  it('runs helpers in an isolated worktree and keeps only in-scope changes [SUB-3]', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    const ws = h.runtime.core.paths(id).workspace;
    let helperResult = '';
    h.setHandler((req) => {
      const sys = req.system.map((b) => b.text).join('\n');
      const isHelper = sys.includes('Task from the coach') || lastUserText(req).includes('Task from the coach');
      if (isHelper) {
        if (lastItemKind(req) === 'tool_results') return { text: 'Drafted the plan.' };
        return {
          toolCalls: [
            { name: 'write', input: { path: 'plan/drafts/block.md', content: '# draft' } },
            { name: 'write', input: { path: 'athlete/profile.md', content: 'HIJACKED' } },
            { name: 'bash', input: { command: 'echo HIJACKED > athlete/preferences.md' } },
          ],
        };
      }
      if (lastItemKind(req) === 'tool_results') {
        const tr = req.items.at(-1)!;
        if (tr.kind === 'tool_results' && tr.results.some((r) => r.name === 'send_message')) return { text: 'done' };
        if (tr.kind === 'tool_results') helperResult = tr.results.map((r) => (r.content[0]?.type === 'text' ? r.content[0].text : '')).join('');
        return send('Plan drafted.');
      }
      return { toolCalls: [{ name: 'spawn_agent', input: { task: 'Draft a block', write_scope: ['plan/drafts/**'], tools: ['read', 'write', 'bash'] } }] };
    });
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'make me a plan', clientId: 'c9' } });
    await h.settle(id);
    expect(await readFile(join(ws, 'plan/drafts/block.md'), 'utf8')).toBe('# draft');
    expect(await readFile(join(ws, 'athlete/profile.md'), 'utf8')).not.toBe('HIJACKED');
    expect(await readFile(join(ws, 'athlete/preferences.md'), 'utf8')).not.toContain('HIJACKED');
    expect(helperResult).toContain('Discarded');
    expect(helperResult).toContain('athlete/preferences.md');
  });

  it('publishes coach-edited views and lets the athlete revert [WS-5]', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    const ws = h.runtime.core.paths(id).workspace;
    const app = await h.runtime.views.appInfo(id);
    const viewId = app.views[0]!.manifest.id;
    h.setHandler((req) => {
      if (lastItemKind(req) === 'tool_results') {
        const tr = req.items.at(-1)!;
        if (tr.kind === 'tool_results' && tr.results.some((r) => r.name === 'send_message')) return { text: 'done' };
        return lastUserText(req).includes('user.view_reverted') ? { text: 'ok' } : send('Updated your view.');
      }
      if (lastUserText(req).includes('user.view_reverted')) return { text: 'noted' };
      return { toolCalls: [{ name: 'publish_ui', input: { views: [viewId], summary: 'Bigger numbers' } }] };
    });
    const indexPath = join(ws, 'ui', 'views', viewId, app.views[0]!.manifest.entry);
    const original = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, original.replace('</body>', '<!-- v2 --></body>'));
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'make numbers bigger', clientId: 'c10' } });
    await h.settle(id);
    const after = await h.runtime.views.appInfo(id);
    const v = after.views.find((x) => x.manifest.id === viewId)!;
    expect(v.version).toBe('2');
    expect(v.previousVersion).toBe('1');
    await h.runtime.views.revert(id, viewId);
    await h.settle(id);
    expect(await readFile(indexPath, 'utf8')).toBe(original);
    const reverted = await h.events(id, ['user.view_reverted']);
    expect(reverted).toHaveLength(1);
    const changes = await h.runtime.listChanges(id);
    expect(changes.some((c) => c.kind === 'revert')).toBe(true);
    expect(changes.some((c) => c.kind === 'publish')).toBe(true);
  });

  it('enforces view manifests for data access [UI-1]', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    const app = await h.runtime.views.appInfo(id);
    const view = app.views.find((v) => v.manifest.reads.some((r) => r === 'db:planned_workouts'));
    expect(view).toBeDefined();
    if (!view) throw new Error('Seed view with planned_workouts access is required.');
    const rows = await h.runtime.views.query(id, view.manifest.id, 'SELECT COUNT(*) AS n FROM planned_workouts');
    expect(rows[0]!.n).toBe(0);
    await expect(h.runtime.views.query(id, view.manifest.id, 'SELECT * FROM sqlite_master')).rejects.toThrow();
  });
});

describe('runtime: epochs, consolidation and voice bridge', () => {
  it('opens a new epoch after the day boundary and closes it on consolidation', async () => {
    h = await makeHarness({ start: '2026-10-07T08:00:00Z' });
    const id = await newAthlete(h);
    await greet(h, id);
    const store = h.runtime.core.store;
    const first = await store.getOpenEpoch(id);
    expect(first?.localDate).toBe('2026-10-07');
    // consolidation at 03:00 local on the 8th (01:00Z)
    h.setHandler((req) => {
      if (lastItemKind(req) === 'tool_results') return { text: 'consolidated' };
      if (lastUserText(req).includes('system.consolidate')) {
        expect(req.tools.some((t) => t.name === 'send_message')).toBe(false);
        return { toolCalls: [{ name: 'write', input: { path: 'briefing.md', content: 'Tomorrow: easy run. Ask about the calf.' } }] };
      }
      return send('ok');
    });
    await h.clock.advanceTo('2026-10-08T01:00:10Z');
    await h.runtime.tickScheduler();
    await h.settle(id);
    expect(await store.getOpenEpoch(id)).toBeUndefined();
    h.setHandler((req) => (lastItemKind(req) === 'tool_results' ? { text: '' } : send('Morning!')));
    await h.clock.advanceTo('2026-10-08T06:00:00Z');
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'morning', clientId: 'c11' } });
    await h.settle(id);
    const second = await store.getOpenEpoch(id);
    expect(second?.localDate).toBe('2026-10-08');
    const req = h.requests.at(-2)!;
    expect(req.system.map((b) => b.text).join('\n')).toContain('Ask about the calf');
  });

  it('answers consults and runs cascaded call turns', async () => {
    h = await makeHarness();
    const id = await newAthlete(h);
    await greet(h, id);
    h.setHandler((req) => {
      const t = lastUserText(req);
      if (t.includes('voice.consult')) return { text: 'Move the long run to Sunday.' };
      if (lastItemKind(req) === 'tool_results') return { text: '' };
      if (t.includes('call.utterance')) return send('Sounds good, see you Sunday!');
      return { text: '' };
    });
    expect(await h.runtime.consult(id, 'Can we move the long run?')).toContain('Sunday');
    const r = await h.runtime.callTurn(id, 'call_1', 'Can we talk about my long run?');
    expect(r.replyText).toContain('Sunday');
    const briefing = await h.runtime.callBriefing(id, 'race plan');
    expect(briefing).toContain('race plan');
    const look = await h.runtime.lookup(id, 'goals training');
    expect(typeof look).toBe('string');
  });

  it('exposes harness-built /system with the constitution', async () => {
    h = await makeHarness();
    const sys = h.runtime.core.systemDir;
    const c = await readFile(join(sys, 'constitution.md'), 'utf8');
    expect(c.length).toBeGreaterThan(1000);
    expect(c).not.toContain('{{pack_coaching}}');
    await mkdir(join(h.dataDir, 'x'), { recursive: true });
  });
});
