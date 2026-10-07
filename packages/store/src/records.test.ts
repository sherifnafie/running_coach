import { afterEach, describe, expect, it } from 'vitest';
import { ZERO_USAGE, type EpochRecord, type ScheduleRecord, type Store, type TaskRecord, type TurnRecord, type UiVersionRecord } from '@opencoach/protocol';
import { SHA_A, SHA_B, SHA_C, T0, addAthlete, memStore } from './test-helpers';

const stores: Store[] = [];
async function open(...args: Parameters<typeof memStore>): ReturnType<typeof memStore> {
  const r = await memStore(...args);
  stores.push(r.store);
  return r;
}
afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
});

describe('blobs', () => {
  const blob = (sha: string, over: Record<string, unknown> = {}) => ({
    athleteId: 'ath_1',
    sha256: sha,
    mime: 'image/png',
    bytes: 1234,
    name: 'screenshot.png',
    origin: 'athlete' as const,
    createdAt: '2026-10-07T06:00:00.000Z',
    relPath: `${sha}.png`,
    meta: { width: 100, exif: { stripped: true } },
    ...over,
  });

  it('puts, gets, upserts, lists (newest first, filters) and deletes', async () => {
    const { store } = await open();
    await store.putBlob(blob(SHA_A));
    await store.putBlob(blob(SHA_B, { origin: 'coach', createdAt: '2026-10-07T07:00:00.000Z', name: undefined, meta: undefined }));
    await store.putBlob(blob(SHA_C, { origin: 'athlete', createdAt: '2026-10-07T08:00:00.000Z' }));
    await store.putBlob(blob(SHA_A, { athleteId: 'ath_2' }));

    expect(await store.getBlob('ath_1', SHA_A)).toEqual(blob(SHA_A));
    const b = await store.getBlob('ath_1', SHA_B);
    expect(b).not.toHaveProperty('name');
    expect(b).not.toHaveProperty('meta');
    expect(await store.getBlob('ath_1', 'f'.repeat(64))).toBeUndefined();

    expect((await store.listBlobs('ath_1')).map((x) => x.sha256)).toEqual([SHA_C, SHA_B, SHA_A]);
    expect((await store.listBlobs('ath_1', { origin: 'athlete' })).map((x) => x.sha256)).toEqual([SHA_C, SHA_A]);
    expect((await store.listBlobs('ath_1', { limit: 1 })).map((x) => x.sha256)).toEqual([SHA_C]);

    // upsert replaces the metadata
    await store.putBlob(blob(SHA_A, { bytes: 99, meta: { v: 2 } }));
    expect(await store.getBlob('ath_1', SHA_A)).toMatchObject({ bytes: 99, meta: { v: 2 } });
    expect(await store.listBlobs('ath_1')).toHaveLength(3);

    await store.deleteBlob('ath_1', SHA_A);
    expect(await store.getBlob('ath_1', SHA_A)).toBeUndefined();
    expect(await store.getBlob('ath_2', SHA_A)).toBeDefined(); // other athlete's identical content untouched
  });
});

describe('schedules', () => {
  const sched = (id: string, nextFireAt: string | null, over: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
    id,
    athleteId: 'ath_1',
    kind: 'coach',
    spec: { at: nextFireAt ?? T0 },
    purpose: `purpose ${id}`,
    duringPause: false,
    nextFireAt,
    status: 'active',
    createdAt: T0,
    ...over,
  });

  it('round-trips records including recurring specs and payloads', async () => {
    const { store } = await open();
    const s = sched('sch_1', '2026-10-11T16:00:00.000Z', {
      spec: { rrule: 'FREQ=WEEKLY;BYDAY=SU', time: '18:00', tz: 'Europe/Amsterdam', until: '2027-01-01T00:00:00.000Z' },
      payload: { plan: 'long run', n: 3 },
      duringPause: true,
      createdInTurn: 'turn_1',
      lastFiredAt: '2026-10-04T16:00:00.000Z',
      kind: 'heartbeat',
    });
    await store.upsertSchedule(s);
    expect(await store.getSchedule('sch_1')).toEqual(s);
    expect(await store.getSchedule('nope')).toBeUndefined();

    const plain = sched('sch_2', null, { spec: { at: '2026-10-07T10:00:00.000Z' }, status: 'done' });
    await store.upsertSchedule(plain);
    const got = await store.getSchedule('sch_2');
    expect(got).toEqual(plain);
    expect(got?.nextFireAt).toBeNull();
    expect(got).not.toHaveProperty('payload');
    expect(got).not.toHaveProperty('createdInTurn');
  });

  it('upsert replaces an existing schedule', async () => {
    const { store } = await open();
    await store.upsertSchedule(sched('sch_1', '2026-10-07T10:00:00.000Z'));
    await store.upsertSchedule(sched('sch_1', '2026-10-08T10:00:00.000Z', { purpose: 'changed', status: 'cancelled' }));
    expect(await store.getSchedule('sch_1')).toMatchObject({ purpose: 'changed', status: 'cancelled', nextFireAt: '2026-10-08T10:00:00.000Z' });
    expect(await store.listSchedules('ath_1')).toHaveLength(1);
  });

  it('lists per athlete with status/kind filters, soonest first', async () => {
    const { store } = await open();
    await store.upsertSchedule(sched('late', '2026-10-09T10:00:00.000Z'));
    await store.upsertSchedule(sched('soon', '2026-10-07T10:00:00.000Z', { kind: 'heartbeat' }));
    await store.upsertSchedule(sched('done', null, { status: 'done' }));
    await store.upsertSchedule(sched('cancelled', '2026-10-08T10:00:00.000Z', { status: 'cancelled' }));
    await store.upsertSchedule(sched('theirs', '2026-10-07T09:00:00.000Z', { athleteId: 'ath_2' }));
    expect((await store.listSchedules('ath_1')).map((s) => s.id)).toEqual(['soon', 'cancelled', 'late', 'done']);
    expect((await store.listSchedules('ath_1', { status: 'active' })).map((s) => s.id)).toEqual(['soon', 'late']);
    expect((await store.listSchedules('ath_1', { kind: 'heartbeat' })).map((s) => s.id)).toEqual(['soon']);
    expect((await store.listSchedules('ath_1', { status: 'active', kind: 'coach' })).map((s) => s.id)).toEqual(['late']);
  });

  it('returns due schedules oldest first, across athletes, active only', async () => {
    const { store } = await open();
    await store.upsertSchedule(sched('c', '2026-10-07T07:00:00.000Z'));
    await store.upsertSchedule(sched('a', '2026-10-07T05:00:00.000Z', { athleteId: 'ath_2' }));
    await store.upsertSchedule(sched('b', '2026-10-07T06:00:00.000Z'));
    await store.upsertSchedule(sched('b2', '2026-10-07T06:00:00.000Z', { athleteId: 'ath_2' }));
    await store.upsertSchedule(sched('future', '2026-10-07T12:00:00.000Z'));
    await store.upsertSchedule(sched('cancelled', '2026-10-07T01:00:00.000Z', { status: 'cancelled' }));
    await store.upsertSchedule(sched('done', '2026-10-07T01:00:00.000Z', { status: 'done' }));
    await store.upsertSchedule(sched('exhausted', null));

    expect((await store.dueSchedules('2026-10-07T07:00:00.000Z')).map((s) => s.id)).toEqual(['a', 'b', 'b2', 'c']); // <= is inclusive; ties by id
    expect((await store.dueSchedules('2026-10-07T05:59:59.999Z')).map((s) => s.id)).toEqual(['a']);
    expect((await store.dueSchedules('2026-10-07T04:00:00.000Z')).map((s) => s.id)).toEqual([]);
    expect((await store.dueSchedules('2026-10-08T00:00:00.000Z', 2)).map((s) => s.id)).toEqual(['a', 'b']);
    // offset form is the same instant: 09:00+02:00 == 07:00Z
    expect((await store.dueSchedules('2026-10-07T09:00:00+02:00')).map((s) => s.id)).toEqual(['a', 'b', 'b2', 'c']);
  });

  it('reports the earliest next fire time among active schedules', async () => {
    const { store } = await open();
    expect(await store.nextScheduleAt()).toBeUndefined();
    await store.upsertSchedule(sched('x', '2026-10-09T10:00:00.000Z'));
    await store.upsertSchedule(sched('y', '2026-10-08T10:00:00.000Z'));
    await store.upsertSchedule(sched('z', '2026-10-01T10:00:00.000Z', { status: 'cancelled' }));
    await store.upsertSchedule(sched('n', null));
    expect(await store.nextScheduleAt()).toBe('2026-10-08T10:00:00.000Z');
    await store.upsertSchedule(sched('y', '2026-10-08T10:00:00.000Z', { status: 'done' }));
    expect(await store.nextScheduleAt()).toBe('2026-10-09T10:00:00.000Z');
  });

  it('normalises offset-form nextFireAt so ordering is by instant', async () => {
    const { store } = await open();
    await store.upsertSchedule(sched('plus2', '2026-10-07T09:00:00+02:00')); // 07:00Z
    await store.upsertSchedule(sched('utc', '2026-10-07T06:30:00.000Z'));
    expect((await store.dueSchedules('2026-10-07T23:00:00.000Z')).map((s) => s.id)).toEqual(['utc', 'plus2']);
    expect((await store.getSchedule('plus2'))?.nextFireAt).toBe('2026-10-07T07:00:00.000Z');
  });
});

describe('epochs', () => {
  const epoch = (id: string, openedAt: string, over: Partial<EpochRecord> = {}): EpochRecord => ({
    id,
    athleteId: 'ath_1',
    localDate: '2026-10-07',
    seq: 1,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    openedAt,
    ...over,
  });

  it('creates, opens, closes and lists epochs', async () => {
    const { store } = await open();
    expect(await store.getOpenEpoch('ath_1')).toBeUndefined();
    const e1 = epoch('ep_1', '2026-10-06T06:00:00.000Z', { localDate: '2026-10-06' });
    await store.createEpoch(e1);
    expect(await store.getEpoch('ep_1')).toEqual(e1);
    expect(await store.getOpenEpoch('ath_1')).toEqual(e1);

    await store.closeEpoch('ep_1', 'day_boundary', '2026-10-07T02:00:00.000Z', 'carry me');
    expect(await store.getEpoch('ep_1')).toEqual({ ...e1, closedAt: '2026-10-07T02:00:00.000Z', closeReason: 'day_boundary', carryover: 'carry me' });
    expect(await store.getOpenEpoch('ath_1')).toBeUndefined();

    await store.createEpoch(epoch('ep_2', '2026-10-07T06:00:00.000Z'));
    await store.createEpoch(epoch('ep_3', '2026-10-07T09:00:00.000Z', { seq: 2 }));
    await store.createEpoch(epoch('other', '2026-10-07T10:00:00.000Z', { athleteId: 'ath_2' }));
    // when several are open the latest wins
    expect((await store.getOpenEpoch('ath_1'))?.id).toBe('ep_3');
    await store.closeEpoch('ep_3', 'compaction', '2026-10-07T09:30:00.000Z'); // no carryover keeps the existing (none)
    expect((await store.getEpoch('ep_3'))?.carryover).toBeUndefined();
    expect((await store.getOpenEpoch('ath_1'))?.id).toBe('ep_2');

    expect((await store.listEpochs('ath_1')).map((e) => e.id)).toEqual(['ep_3', 'ep_2', 'ep_1']); // newest first
    expect((await store.listEpochs('ath_1', 2)).map((e) => e.id)).toEqual(['ep_3', 'ep_2']);
    await expect(store.closeEpoch('ghost', 'forced', T0)).rejects.toThrow(/epoch not found/);
  });

  it('appends and lists epoch items in sequence order', async () => {
    const { store } = await open();
    await store.createEpoch(epoch('ep_1', T0));
    await store.appendEpochItems([]); // no-op
    await store.appendEpochItems([
      { epochId: 'ep_1', seq: 1, turnId: 'turn_1', item: { kind: 'user', parts: [{ type: 'text', text: 'hello 😅' }] }, tokens: 5, createdAt: T0 },
      { epochId: 'ep_1', seq: 2, item: { kind: 'harness', text: '<situation>…</situation>' }, tokens: 7, createdAt: T0 },
    ]);
    await store.appendEpochItems([
      {
        epochId: 'ep_1',
        seq: 3,
        turnId: 'turn_1',
        item: { kind: 'assistant', parts: [{ type: 'text', text: 'hi' }, { type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'ls' } }], provider: 'anthropic', model: 'm', raw: { blocks: [1, 2] } },
        tokens: 9,
        createdAt: T0,
      },
    ]);
    const items = await store.listEpochItems('ep_1');
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(items[0]).toEqual({ epochId: 'ep_1', seq: 1, turnId: 'turn_1', item: { kind: 'user', parts: [{ type: 'text', text: 'hello 😅' }] }, tokens: 5, createdAt: T0 });
    expect(items[1]).not.toHaveProperty('turnId');
    expect(items[2]!.item).toMatchObject({ kind: 'assistant', raw: { blocks: [1, 2] } });
    expect(await store.listEpochItems('ep_none')).toEqual([]);
  });

  it('appends a batch atomically (a duplicate seq rolls the whole batch back)', async () => {
    const { store } = await open();
    await store.createEpoch(epoch('ep_1', T0));
    await store.appendEpochItems([{ epochId: 'ep_1', seq: 1, item: { kind: 'harness', text: 'a' }, tokens: 1, createdAt: T0 }]);
    await expect(
      store.appendEpochItems([
        { epochId: 'ep_1', seq: 2, item: { kind: 'harness', text: 'b' }, tokens: 1, createdAt: T0 },
        { epochId: 'ep_1', seq: 1, item: { kind: 'harness', text: 'dup' }, tokens: 1, createdAt: T0 },
      ]),
    ).rejects.toThrow();
    expect((await store.listEpochItems('ep_1')).map((i) => i.seq)).toEqual([1]);
    // and the store is still usable afterwards (the failed transaction was rolled back)
    await store.appendEpochItems([{ epochId: 'ep_1', seq: 2, item: { kind: 'harness', text: 'b' }, tokens: 1, createdAt: T0 }]);
    expect((await store.listEpochItems('ep_1')).map((i) => i.seq)).toEqual([1, 2]);
  });

  it('refuses items for an unknown epoch (foreign key)', async () => {
    const { store } = await open();
    await expect(store.appendEpochItems([{ epochId: 'ghost', seq: 1, item: { kind: 'harness', text: 'a' }, tokens: 1, createdAt: T0 }])).rejects.toThrow();
  });
});

describe('turns, turn contexts and tasks', () => {
  const turn = (id: string, over: Partial<TurnRecord> = {}): TurnRecord => ({
    id,
    athleteId: 'ath_1',
    agent: 'coach',
    triggerClass: 'reactive',
    triggerEventIds: ['evt_1', 'evt_2'],
    tier: 'coach',
    status: 'running',
    startedAt: T0,
    steps: 0,
    usage: { ...ZERO_USAGE },
    costUsd: 0,
    fallbacks: [],
    ...over,
  });

  it('inserts, reads and updates turns', async () => {
    const { store } = await open();
    const t = turn('turn_1');
    await store.insertTurn(t);
    expect(await store.getTurn('turn_1')).toEqual(t);
    expect(await store.getTurn('nope')).toBeUndefined();

    await store.updateTurn('turn_1', {
      status: 'ok',
      endedAt: '2026-10-07T06:00:09.000Z',
      steps: 4,
      usage: { inputTokens: 100, cachedInputTokens: 900, cacheWriteTokens: 10, outputTokens: 50 },
      costUsd: 0.0123,
      commit: 'abc123',
      note: 'did the thing',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      epochId: 'ep_1',
      fallbacks: ['deepseek/x'],
    });
    expect(await store.getTurn('turn_1')).toEqual({
      ...t,
      status: 'ok',
      endedAt: '2026-10-07T06:00:09.000Z',
      steps: 4,
      usage: { inputTokens: 100, cachedInputTokens: 900, cacheWriteTokens: 10, outputTokens: 50 },
      costUsd: 0.0123,
      commit: 'abc123',
      note: 'did the thing',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      epochId: 'ep_1',
      fallbacks: ['deepseek/x'],
    });
    await store.updateTurn('turn_1', { error: 'late error' });
    expect((await store.getTurn('turn_1'))?.error).toBe('late error');
    await store.updateTurn('turn_1', {}); // nothing to change
    await expect(store.updateTurn('ghost', { steps: 1 })).rejects.toThrow(/turn not found/);
  });

  it('lists turns newest first with filters and paging', async () => {
    const { store } = await open();
    for (let i = 1; i <= 7; i++) await store.insertTurn(turn(`turn_${i}`, { agent: i % 3 === 0 ? 'helper' : 'coach' }));
    await store.insertTurn(turn('turn_x', { athleteId: 'ath_2' }));
    expect((await store.listTurns({ athleteId: 'ath_1', limit: 3 })).map((t) => t.id)).toEqual(['turn_7', 'turn_6', 'turn_5']);
    expect((await store.listTurns({ athleteId: 'ath_1', beforeId: 'turn_5', limit: 2 })).map((t) => t.id)).toEqual(['turn_4', 'turn_3']);
    expect((await store.listTurns({ athleteId: 'ath_1', agent: 'helper' })).map((t) => t.id)).toEqual(['turn_6', 'turn_3']);
    expect((await store.listTurns({ limit: 100 })).map((t) => t.id)).toEqual(['turn_x', 'turn_7', 'turn_6', 'turn_5', 'turn_4', 'turn_3', 'turn_2', 'turn_1']);
    expect(await store.listTurns({ athleteId: 'nobody' })).toEqual([]);
  });

  it('saves, overwrites and reads turn contexts', async () => {
    const { store } = await open();
    expect(await store.getTurnContext('turn_1')).toBeUndefined();
    const ctx = { system: [{ text: 'constitution', cache: true }], items: [{ kind: 'user', parts: [{ type: 'text', text: 'hi' }] }], nested: { n: [1, 2, { x: null }] } };
    await store.saveTurnContext('turn_1', ctx);
    expect(await store.getTurnContext('turn_1')).toEqual(ctx);
    await store.saveTurnContext('turn_1', { replaced: true });
    expect(await store.getTurnContext('turn_1')).toEqual({ replaced: true });
    await store.saveTurnContext('turn_2', null);
    expect(await store.getTurnContext('turn_2')).toBeNull();
  });

  it('manages helper tasks', async () => {
    const { store } = await open();
    const task = (id: string, createdAt: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
      id,
      athleteId: 'ath_1',
      parentTurnId: 'turn_1',
      task: `do ${id}`,
      state: 'running',
      background: true,
      createdAt,
      outputs: [],
      costUsd: 0,
      ...over,
    });
    const t1 = task('tsk_1', '2026-10-07T06:00:00.000Z', { profile: 'planner', originEventId: 'evt_1' });
    await store.insertTask(t1);
    await store.insertTask(task('tsk_2', '2026-10-07T06:01:00.000Z', { background: false }));
    await store.insertTask(task('tsk_3', '2026-10-07T06:02:00.000Z', { athleteId: 'ath_2' }));
    expect(await store.getTask('tsk_1')).toEqual(t1);
    expect(await store.getTask('nope')).toBeUndefined();

    await store.updateTask('tsk_1', { state: 'done', endedAt: '2026-10-07T06:05:00.000Z', summary: 'plan drafted', outputs: ['plan/draft.md'], costUsd: 0.4 });
    expect(await store.getTask('tsk_1')).toEqual({ ...t1, state: 'done', endedAt: '2026-10-07T06:05:00.000Z', summary: 'plan drafted', outputs: ['plan/draft.md'], costUsd: 0.4 });
    await store.updateTask('tsk_2', { state: 'failed', error: 'boom' });
    expect((await store.getTask('tsk_2'))?.background).toBe(false);

    expect((await store.listTasks('ath_1')).map((t) => t.id)).toEqual(['tsk_1', 'tsk_2']);
    expect((await store.listTasks('ath_1', { state: 'done' })).map((t) => t.id)).toEqual(['tsk_1']);
    expect((await store.listTasks('ath_1', { state: 'running' })).map((t) => t.id)).toEqual([]);
    await expect(store.updateTask('ghost', { state: 'done' })).rejects.toThrow(/task not found/);
  });
});

describe('usage', () => {
  const use = (at: string, costUsd: number, over: Record<string, unknown> = {}) => ({
    athleteId: 'ath_1',
    at,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    kind: 'turn' as const,
    usage: { inputTokens: 100, cachedInputTokens: 1000, cacheWriteTokens: 5, outputTokens: 40 },
    costUsd,
    ...over,
  });

  it('sums usage since a time', async () => {
    const { store } = await open();
    expect(await store.sumUsage('ath_1', '2026-01-01T00:00:00.000Z')).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    await store.recordUsage(use('2026-10-06T23:00:00.000Z', 1));
    await store.recordUsage(use('2026-10-07T01:00:00.000Z', 0.25, { turnId: 'turn_1', tier: 'coach' }));
    await store.recordUsage(use('2026-10-07T02:00:00.000Z', 0.5, { usage: { inputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4 } }));
    await store.recordUsage(use('2026-10-07T02:00:00.000Z', 9, { athleteId: 'ath_2' }));
    const s = await store.sumUsage('ath_1', '2026-10-07T00:00:00.000Z');
    expect(s.costUsd).toBeCloseTo(0.75, 10);
    expect(s).toMatchObject({ inputTokens: 101, outputTokens: 44, cachedInputTokens: 1002 });
    expect((await store.sumUsage('ath_1', '2026-10-07T02:00:00.000Z')).costUsd).toBeCloseTo(0.5, 10); // inclusive
    expect((await store.sumUsage('ath_1', '2026-10-07T04:00:00+02:00')).costUsd).toBeCloseTo(0.5, 10); // offset == 02:00Z
    expect((await store.sumUsage('ath_1', '2026-01-01T00:00:00.000Z')).costUsd).toBeCloseTo(1.75, 10);
  });

  it('groups usage by UTC day', async () => {
    const { store } = await open();
    await store.recordUsage(use('2026-10-06T23:59:00.000Z', 1));
    await store.recordUsage(use('2026-10-07T00:00:00.000Z', 2));
    await store.recordUsage(use('2026-10-07T12:00:00.000Z', 3));
    await store.recordUsage(use('2026-10-07T13:00:00.000Z', 4, { athleteId: 'ath_2' }));
    await store.recordUsage(use('2026-10-08T01:00:00.000Z', 5));
    const all = await store.usageByDay(undefined, '2026-10-06T00:00:00.000Z');
    expect(all).toEqual([
      { day: '2026-10-06', athleteId: 'ath_1', costUsd: 1 },
      { day: '2026-10-07', athleteId: 'ath_1', costUsd: 5 },
      { day: '2026-10-07', athleteId: 'ath_2', costUsd: 4 },
      { day: '2026-10-08', athleteId: 'ath_1', costUsd: 5 },
    ]);
    expect(await store.usageByDay('ath_1', '2026-10-07T00:00:00.000Z')).toEqual([
      { day: '2026-10-07', athleteId: 'ath_1', costUsd: 5 },
      { day: '2026-10-08', athleteId: 'ath_1', costUsd: 5 },
    ]);
    expect(await store.usageByDay('nobody', '2026-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('push subscriptions', () => {
  const sub = (id: string, endpoint: string, over: Record<string, unknown> = {}) => ({
    id,
    athleteId: 'ath_1',
    kind: 'webpush' as const,
    endpoint,
    keys: { p256dh: 'k', auth: 'a' },
    userAgent: 'Mozilla',
    createdAt: T0,
    ...over,
  });

  it('adds, lists and deletes; re-subscribing an endpoint replaces the old row', async () => {
    const { store } = await open();
    await store.addPushSubscription(sub('p1', 'https://push/1'));
    await store.addPushSubscription(sub('p2', 'https://push/2', { keys: undefined, userAgent: undefined, createdAt: '2026-10-07T07:00:00.000Z' }));
    await store.addPushSubscription(sub('p3', 'https://push/1', { athleteId: 'ath_2' }));
    expect((await store.listPushSubscriptions('ath_1')).map((s) => s.id)).toEqual(['p1', 'p2']);
    expect(await store.listPushSubscriptions('ath_1')).toEqual([sub('p1', 'https://push/1'), { id: 'p2', athleteId: 'ath_1', kind: 'webpush', endpoint: 'https://push/2', createdAt: '2026-10-07T07:00:00.000Z' }]);

    await store.addPushSubscription(sub('p4', 'https://push/1', { createdAt: '2026-10-07T08:00:00.000Z' }));
    expect((await store.listPushSubscriptions('ath_1')).map((s) => s.id)).toEqual(['p2', 'p4']);
    await store.addPushSubscription(sub('p4', 'https://push/1', { userAgent: 'changed', createdAt: '2026-10-07T08:00:00.000Z' })); // same id: update
    expect((await store.listPushSubscriptions('ath_1')).find((s) => s.id === 'p4')?.userAgent).toBe('changed');

    await store.deletePushSubscription('p2');
    expect((await store.listPushSubscriptions('ath_1')).map((s) => s.id)).toEqual(['p4']);
    expect((await store.listPushSubscriptions('ath_2')).map((s) => s.id)).toEqual(['p3']);
  });
});

describe('published ui versions', () => {
  const manifest = { id: 'today', title: 'Today', icon: 'sun', placement: { hidden: true }, entry: 'index.html', kit: '1', reads: [], writes: [], actions: [], refresh: 'on-change' } as unknown as UiVersionRecord['manifest'];
  const ver = (viewId: string, version: string, over: Partial<UiVersionRecord> = {}): UiVersionRecord => ({
    athleteId: 'ath_1',
    viewId,
    version,
    commit: `c${version}`,
    summary: `v${version}`,
    publishedAt: T0,
    publishedBy: 'coach',
    manifest,
    dir: `/data/published/${viewId}/${version}`,
    ...over,
  });

  it('adds immutable versions and lists them newest first with numeric ordering', async () => {
    const { store } = await open();
    for (let v = 1; v <= 11; v++) await store.addUiVersion(ver('today', String(v)));
    await store.addUiVersion(ver('plan', '1', { publishedBy: 'seed' }));
    await store.addUiVersion(ver('today', '1', { athleteId: 'ath_2' }));
    expect(await store.getUiVersion('ath_1', 'today', '3')).toEqual(ver('today', '3'));
    expect(await store.getUiVersion('ath_1', 'today', '99')).toBeUndefined();
    expect((await store.listUiVersions('ath_1', 'today')).map((v) => v.version)).toEqual(['11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1']);
    const everything = await store.listUiVersions('ath_1');
    expect(everything).toHaveLength(12);
    expect(everything[0]!.viewId).toBe('plan'); // grouped by view id
    await expect(store.addUiVersion(ver('today', '3', { summary: 'overwrite' }))).rejects.toThrow();
    expect((await store.getUiVersion('ath_1', 'today', '3'))?.summary).toBe('v3');
  });

  it('tracks the current version per view', async () => {
    const { store } = await open();
    expect(await store.getCurrentUiVersions('ath_1')).toEqual([]);
    await store.addUiVersion(ver('today', '1'));
    await store.addUiVersion(ver('today', '2'));
    await store.addUiVersion(ver('plan', '1'));
    await expect(store.setCurrentUiVersion('ath_1', 'today', '9')).rejects.toThrow(/ui version not found/);
    await store.setCurrentUiVersion('ath_1', 'today', '2');
    await store.setCurrentUiVersion('ath_1', 'plan', '1');
    expect((await store.getCurrentUiVersions('ath_1')).map((v) => `${v.viewId}@${v.version}`)).toEqual(['plan@1', 'today@2']);
    await store.setCurrentUiVersion('ath_1', 'today', '1'); // rollback
    expect((await store.getCurrentUiVersions('ath_1')).map((v) => `${v.viewId}@${v.version}`)).toEqual(['plan@1', 'today@1']);
    await store.clearCurrentUiVersion('ath_1', 'plan');
    expect((await store.getCurrentUiVersions('ath_1')).map((v) => v.viewId)).toEqual(['today']);
    expect(await store.getCurrentUiVersions('ath_2')).toEqual([]);
    // history is kept after clearing
    expect(await store.getUiVersion('ath_1', 'plan', '1')).toBeDefined();
  });
});

describe('credentials [SEC-1]', () => {
  it('upserts per athlete and provider, lists and deletes', async () => {
    const { store } = await open();
    await addAthlete(store, 'ath_1');
    await addAthlete(store, 'ath_2');
    const rec = { athleteId: 'ath_1', provider: 'openrouter' as const, owner: 'admin' as const, ciphertext: 'v1:a', hint: 'sk-or-…aaaa', updatedAt: T0 };
    await store.setCredential(rec);
    await store.setCredential({ ...rec, owner: 'athlete', ciphertext: 'v1:b', hint: 'sk-or-…bbbb' });
    await store.setCredential({ ...rec, athleteId: 'ath_2' });
    expect(await store.listCredentials('ath_1')).toEqual([{ ...rec, owner: 'athlete', ciphertext: 'v1:b', hint: 'sk-or-…bbbb' }]);
    expect((await store.listCredentials()).map((c) => c.athleteId)).toEqual(['ath_1', 'ath_2']);
    await store.deleteCredential('ath_1', 'openrouter');
    expect(await store.listCredentials('ath_1')).toEqual([]);
  });
});
