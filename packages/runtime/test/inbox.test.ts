import { afterEach, describe, expect, it } from 'vitest';
import { createCoachRuntime, type CoachRuntime } from '../src';
import { lastItemKind, lastUserText, makeHarness, send, type Harness } from './harness';

let h: Harness | undefined;
let restarted: CoachRuntime | undefined;
afterEach(async () => { await restarted?.stop(); restarted = undefined; await h?.close(); h = undefined; });
async function setup(options: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(options);
  const a = await h.runtime.createAthlete({ displayName: 'Sam', coachName: 'Miles', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false });
  h.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Hello'));
  await h.runtime.tickScheduler();
  await h.settle(a.id);
  await h.runtime.updateSettings(a.id, { heartbeat: { enabled: false }, consolidation: { enabled: false } });
  return a.id;
}

describe('inbox recovery and outreach freshness [RT-3, RT-4, MSG-4]', () => {
  it.each(['message', 'quick reply'] as const)('new %s cancels a minimum-gap draft; direct replies still arrive immediately', async (kind) => {
    const id = await setup();
    const runtime = h!.runtime;
    await runtime.updateSettings(id, { notifications: { quietHours: null, minGapMinutes: 120 } });
    const delivered: string[] = [];
    runtime.core.deps.delivery = async (_a, event) => { delivered.push(event.payload.text); };
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('First part'));
    await runtime.core.scheduler.harnessWake(id, new Date('2026-10-07T09:00:00Z'), 'check plan');
    await h!.clock.advanceTo('2026-10-07T09:00:00Z');
    await runtime.tickScheduler(); await h!.settle(id);
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Which town? Which days?'));
    await runtime.core.scheduler.harnessWake(id, new Date('2026-10-07T09:01:00Z'), 'second part');
    await h!.clock.advanceTo('2026-10-07T09:01:00Z');
    await runtime.tickScheduler(); await h!.settle(id);
    const [draft] = await runtime.core.store.listHeldMessages(id);
    expect(draft?.heldUntil).toBe('2026-10-07T11:00:00.000Z');
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Noted, The Hague and those days.'));
    const input = kind === 'message'
      ? await runtime.ingest(id, { type: 'user.message', payload: { text: 'The Hague; Mon/Wed/Fri/Sun works', clientId: 'answer' } })
      : await runtime.ingest(id, { type: 'user.ui_action', payload: { source: { messageId: 'previous' }, action: 'quick_reply', payload: 'The Hague; Mon/Wed/Fri/Sun works', wake: true } });
    await h!.settle(id);
    expect(await runtime.core.store.listPendingCoachInputs(id)).toEqual([]);
    expect((await runtime.core.store.getMessageState(draft!.messageId))?.delivery).toBe('cancelled');
    await h!.clock.advanceTo('2026-10-07T11:01:00Z');
    await runtime.tickScheduler(); await h!.settle(id);
    expect(delivered).toEqual(['First part', 'Noted, The Hague and those days.']);
    const events = await h!.events(id);
    expect(events.some((e) => e.type === 'coach.message' && e.payload.replyTo === input.id && !e.payload.proactive && e.payload.delivery === 'sent')).toBe(true);
    expect(events.some((e) => e.type === 'coach.message' && e.payload.messageId === draft!.messageId && e.payload.delivery === 'sent')).toBe(false);
    expect(events.some((e) => e.type === 'harness.notice' && e.payload.kind === 'held_outreach_superseded' && e.payload.athleteVisible === false)).toBe(true);
    expect(await runtime.core.store.countProactiveSince(id, '2026-10-07T00:00:00Z')).toBe(1);
  });

  it('recovers original messages stopped during debounce, batches them, and does not replay answered inputs after another restart', async () => {
    const id = await setup({ config: { limits: { debounceIdleMs: 2500 } } });
    const original = h!.runtime;
    const a = await original.ingest(id, { type: 'user.message', payload: { text: 'I am in The Hague', clientId: 'town' } });
    const b = await original.ingest(id, { type: 'user.ui_action', payload: { source: { messageId: 'days' }, action: 'quick_reply', payload: 'Those days work', wake: true } });
    await original.stop();
    expect((await original.core.store.listPendingCoachInputs(id)).map((e) => e.id)).toEqual([a.id, b.id]);
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Both answers received.'));
    restarted = createCoachRuntime(original.core.deps);
    await restarted.start();
    await h!.clock.advanceBy(2501);
    await restarted.whenIdle(id);
    const request = h!.requests.find((req) => lastUserText(req).includes('I am in The Hague'));
    expect(lastUserText(request!)).toContain(a.id);
    expect(lastUserText(request!)).toContain(b.id);
    expect(await original.core.store.listPendingCoachInputs(id)).toEqual([]);
    const calls = h!.requests.length;
    await restarted.stop();
    restarted = createCoachRuntime(original.core.deps);
    await restarted.start();
    await h!.clock.advanceBy(2501);
    await restarted.whenIdle(id);
    expect(h!.requests.length).toBe(calls);
  });

  it('preserves undrained steering when an active turn stops and lets shutdown finish', async () => {
    const id = await setup();
    const original = h!.runtime;
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    h!.setHandler(async () => { entered(); await blocked; return { toolCalls: [{ name: 'read', input: { path: 'AGENTS.md' } }] }; });
    await original.core.scheduler.harnessWake(id, h!.clock.now(), 'background work');
    await original.tickScheduler();
    await started;
    const input = await original.ingest(id, { type: 'user.message', payload: { text: 'My town is The Hague', clientId: 'during-work' } });
    const stopped = original.stop();
    unblock();
    await stopped;
    expect((await original.core.store.listPendingCoachInputs(id)).map((e) => e.id)).toEqual([input.id]);
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('The Hague, noted.'));
    restarted = createCoachRuntime(original.core.deps);
    await restarted.start(); await restarted.whenIdle(id);
    expect(h!.requests.some((req) => lastUserText(req).includes(input.id) && lastUserText(req).includes('The Hague'))).toBe(true);
    expect(await original.core.store.listPendingCoachInputs(id)).toEqual([]);
  });

  it('acknowledges an explicit no_reply, while a failed reply remains pending for a reactive retry', async () => {
    const id = await setup();
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : { toolCalls: [{ name: 'no_reply', input: { reason: 'acknowledgement only' } }] });
    await h!.runtime.ingest(id, { type: 'user.message', payload: { text: 'Thanks', clientId: 'thanks' } });
    await h!.settle(id);
    expect(await h!.runtime.core.store.listPendingCoachInputs(id)).toEqual([]);
    h!.setHandler(() => ({ text: 'private note without reply' }));
    const input = await h!.runtime.ingest(id, { type: 'user.message', payload: { text: 'Please answer this', clientId: 'question' } });
    await h!.settle(id);
    expect((await h!.runtime.core.store.listPendingCoachInputs(id)).map((e) => e.id)).toEqual([input.id]);
    await h!.runtime.updateSettings(id, { notifications: { proactivePerDay: 0 } });
    h!.setHandler((req) => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Here is your answer.'));
    await h!.clock.advanceBy(10 * 60_000 + 1);
    await h!.runtime.tickScheduler(); await h!.settle(id);
    expect(await h!.runtime.core.store.listPendingCoachInputs(id)).toEqual([]);
    expect((await h!.events(id, ['coach.message'])).some((e) => e.type === 'coach.message' && e.payload.replyTo === input.id && !e.payload.proactive)).toBe(true);
  });
});
