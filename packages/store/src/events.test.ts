import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_TYPES, type Store } from '@opencoach/protocol';
import { extractSearchText, isTombstoned } from './index';
import { SHA_A, T0, makeClock, memStore } from './test-helpers';

const stores: Store[] = [];
async function open(...args: Parameters<typeof memStore>): ReturnType<typeof memStore> {
  const r = await memStore(...args);
  stores.push(r.store);
  return r;
}
afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
});

const msg = (athleteId: string, text: string, extra: Record<string, unknown> = {}) => ({
  athleteId,
  type: 'user.message' as const,
  actor: 'athlete' as const,
  payload: { text },
  ...extra,
});

describe('appendEvent / getEvent', () => {
  it('validates, applies payload defaults and uses the clock for id and ts', async () => {
    const { store, clock } = await open();
    await clock.advanceBy(5_000);
    const e = await store.appendEvent(msg('ath_1', 'Tempo done, brutal'));
    expect(e.id).toMatch(/^evt_[0-9A-Z]{26}$/);
    expect(e.ts).toBe('2026-10-07T06:00:05.000Z');
    expect(e.payload).toEqual({ text: 'Tempo done, brutal', attachments: [], channel: 'app' });
    expect(e).not.toHaveProperty('turnId');
    expect(e).not.toHaveProperty('causationId');
    expect(await store.getEvent(e.id)).toEqual(e);
    expect(await store.getEvent('evt_missing')).toBeUndefined();
  });

  it('honours explicit id, ts, turnId and causationId', async () => {
    const { store } = await open();
    const e = await store.appendEvent({
      athleteId: 'ath_1',
      type: 'coach.message',
      actor: 'coach',
      id: 'evt_PRESET',
      ts: '2026-10-07T12:00:00.000Z',
      turnId: 'turn_1',
      causationId: 'evt_cause',
      payload: { messageId: 'evt_PRESET', text: 'Nice work', notify: 'normal', delivery: 'sent', proactive: false },
    });
    expect(e).toMatchObject({ id: 'evt_PRESET', ts: '2026-10-07T12:00:00.000Z', turnId: 'turn_1', causationId: 'evt_cause' });
    expect(await store.getEvent('evt_PRESET')).toEqual(e);
  });

  it('canonicalises explicit timestamps with offsets to UTC', async () => {
    const { store } = await open();
    const e = await store.appendEvent(msg('ath_1', 'hi', { ts: '2026-10-07T08:00:00+02:00' }));
    expect(e.ts).toBe('2026-10-07T06:00:00.000Z');
  });

  it('rejects invalid payloads and unknown types, inserting nothing', async () => {
    const { store } = await open();
    await expect(store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: {} as never })).rejects.toThrow();
    await expect(store.appendEvent({ athleteId: 'ath_1', type: 'not.a.type' as never, actor: 'athlete', payload: {} as never })).rejects.toThrow(/unknown event type/);
    await expect(store.appendEvent({ athleteId: 'ath_1', type: 'toString' as never, actor: 'athlete', payload: {} as never })).rejects.toThrow(/unknown event type/);
    expect(await store.listEvents({ athleteId: 'ath_1' })).toEqual([]);
  });

  it('rejects a duplicate event id', async () => {
    const { store } = await open();
    await store.appendEvent(msg('ath_1', 'one', { id: 'evt_dup' }));
    await expect(store.appendEvent(msg('ath_1', 'two', { id: 'evt_dup' }))).rejects.toThrow();
    expect(await store.listEvents({ athleteId: 'ath_1' })).toHaveLength(1);
  });

  it('accepts every event type with a minimal valid payload', async () => {
    const { store } = await open();
    const blob = { sha256: SHA_A, mime: 'image/png', bytes: 10 };
    const samples: Record<string, unknown> = {
      'user.message': { text: 'x' },
      'user.upload': { blobs: [blob] },
      'user.voice_note': { blob, durationS: 3, transcript: 't', transcriptModel: 'm' },
      'user.ui_action': { source: {}, action: 'tap', wake: true },
      'user.ui_write': { viewId: 'v', target: 't', op: 'insert', row: {} },
      'user.reaction': { messageId: 'm', reaction: 'up' },
      'user.read': { messageIds: ['m'] },
      'user.settings_changed': { diff: {} },
      'user.message_deleted': { messageId: 'm' },
      'user.view_reverted': { viewId: 'v', fromVersion: '2', toVersion: '1' },
      'device.context': { tz: 'UTC', locale: 'en' },
      'call.started': { callId: 'c', mode: 'realtime', provider: 'p', model: 'm' },
      'call.ended': { callId: 'c', durationS: 1, transcriptPath: 'a', notesPath: 'b', endedBy: 'athlete' },
      'schedule.fired': { scheduleId: 's', purpose: 'p', scheduledFor: T0, createdAt: T0 },
      'system.heartbeat': {},
      'system.consolidate': {},
      'task.completed': { taskId: 't', summary: 's' },
      'task.failed': { taskId: 't', summary: 's', error: 'e' },
      'ui.error': { viewId: 'v', version: '1', message: 'm', device: { ua: 'u', viewport: '1x1' } },
      'workspace.external_change': { commits: [], filesChanged: 0, summary: 's' },
      'harness.upgraded': { from: '1', to: '2', changelogPath: 'p' },
      'data.synced': { source: 'healthkit', blobs: [], range: [T0, T0] },
      'coach.message': { messageId: 'm', text: 't', notify: 'none', delivery: 'sent', proactive: false },
      'coach.ui_published': { viewId: 'v', version: '1', commit: 'abc', summary: 's' },
      'coach.schedule_changed': { scheduleId: 's', op: 'cancel' },
      'coach.turn': {
        turnId: 't',
        triggerClass: 'reactive',
        triggerEventIds: [],
        tier: 'coach',
        provider: 'p',
        model: 'm',
        steps: 1,
        tokens: { input: 1, cached: 0, cacheWrite: 0, output: 1 },
        costUsd: 0.01,
        durationMs: 5,
        status: 'ok',
      },
      'harness.notice': { kind: 'budget_warning', athleteVisible: true },
    };
    expect(Object.keys(samples).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) {
      const e = await store.appendEvent({ athleteId: 'ath_1', type, actor: 'harness', payload: samples[type] as never });
      expect((await store.getEvent(e.id))?.type).toBe(type);
    }
  });

  it('keeps ids and timestamps ordered under a VirtualClock', async () => {
    const { store, clock } = await open(makeClock('2090-01-01T00:00:00.000Z'));
    const made = [];
    for (let i = 0; i < 6; i++) {
      made.push(await store.appendEvent(msg('ath_1', `m${i}`)));
      await clock.advanceBy(i % 2 === 0 ? 0 : 60_000); // same-millisecond bursts and gaps
    }
    const ids = made.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(6);
    expect(made.map((m) => m.ts)).toEqual([
      '2090-01-01T00:00:00.000Z',
      '2090-01-01T00:00:00.000Z',
      '2090-01-01T00:01:00.000Z',
      '2090-01-01T00:01:00.000Z',
      '2090-01-01T00:02:00.000Z',
      '2090-01-01T00:02:00.000Z',
    ]);
    expect((await store.listEvents({ athleteId: 'ath_1' })).map((e) => e.id)).toEqual(ids);
  });
});

describe('listEvents', () => {
  async function seed(store: Store, clock: ReturnType<typeof makeClock>, n: number, athleteId = 'ath_1') {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await store.appendEvent(msg(athleteId, `message ${i}`)));
      await clock.advanceBy(60_000);
    }
    return out;
  }

  it('defaults to oldest-first with limit 100 and isolates athletes', async () => {
    const { store, clock } = await open();
    const mine = await seed(store, clock, 120);
    await seed(store, clock, 3, 'ath_2');
    const page = await store.listEvents({ athleteId: 'ath_1' });
    expect(page).toHaveLength(100);
    expect(page.map((e) => e.id)).toEqual(mine.slice(0, 100).map((e) => e.id));
    expect(await store.listEvents({ athleteId: 'ath_1', limit: 0 })).toEqual([]);
    expect((await store.listEvents({ athleteId: 'ath_2' })).every((e) => e.athleteId === 'ath_2')).toBe(true);
  });

  it('pages forward with afterId', async () => {
    const { store, clock } = await open();
    const all = await seed(store, clock, 25);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await store.listEvents({ athleteId: 'ath_1', afterId: cursor, limit: 10 });
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.id));
      cursor = page[page.length - 1]!.id;
    }
    expect(seen).toEqual(all.map((e) => e.id));
  });

  it('pages backwards with beforeId (previous page, oldest-first within the page)', async () => {
    const { store, clock } = await open();
    const all = await seed(store, clock, 25);
    const ids = all.map((e) => e.id);
    const first = await store.listEvents({ athleteId: 'ath_1', beforeId: ids[25 - 1], limit: 10 });
    expect(first.map((e) => e.id)).toEqual(ids.slice(14, 24)); // the 10 immediately before the cursor
    const second = await store.listEvents({ athleteId: 'ath_1', beforeId: first[0]!.id, limit: 10 });
    expect(second.map((e) => e.id)).toEqual(ids.slice(4, 14));
    const third = await store.listEvents({ athleteId: 'ath_1', beforeId: second[0]!.id, limit: 10 });
    expect(third.map((e) => e.id)).toEqual(ids.slice(0, 4));

    // order: 'desc' returns the same window newest-first
    const desc = await store.listEvents({ athleteId: 'ath_1', beforeId: ids[24], limit: 10, order: 'desc' });
    expect(desc.map((e) => e.id)).toEqual(ids.slice(14, 24).reverse());
  });

  it('supports order desc without a cursor (newest window) and a bounded range', async () => {
    const { store, clock } = await open();
    const all = await seed(store, clock, 10);
    const ids = all.map((e) => e.id);
    expect((await store.listEvents({ athleteId: 'ath_1', order: 'desc', limit: 3 })).map((e) => e.id)).toEqual([ids[9], ids[8], ids[7]]);
    expect((await store.listEvents({ athleteId: 'ath_1', order: 'asc', limit: 3 })).map((e) => e.id)).toEqual([ids[0], ids[1], ids[2]]);
    expect((await store.listEvents({ athleteId: 'ath_1', afterId: ids[2], beforeId: ids[7] })).map((e) => e.id)).toEqual(ids.slice(3, 7));
    expect((await store.listEvents({ athleteId: 'ath_1', afterId: ids[2], beforeId: ids[7], order: 'desc' })).map((e) => e.id)).toEqual(ids.slice(3, 7).reverse());
  });

  it('filters by type, since and until (instants, inclusive)', async () => {
    const { store, clock } = await open();
    const a = await store.appendEvent(msg('ath_1', 'a')); // 06:00
    await clock.advanceBy(3_600_000);
    const b = await store.appendEvent({ athleteId: 'ath_1', type: 'system.heartbeat', actor: 'harness', payload: {} }); // 07:00
    await clock.advanceBy(3_600_000);
    const c = await store.appendEvent(msg('ath_1', 'c')); // 08:00
    const ids = (evs: Array<{ id: string }>) => evs.map((e) => e.id);
    expect(ids(await store.listEvents({ athleteId: 'ath_1', types: ['user.message'] }))).toEqual([a.id, c.id]);
    expect(ids(await store.listEvents({ athleteId: 'ath_1', types: ['system.heartbeat', 'user.message'] }))).toEqual([a.id, b.id, c.id]);
    expect(ids(await store.listEvents({ athleteId: 'ath_1', types: [] }))).toEqual([a.id, b.id, c.id]);
    expect(ids(await store.listEvents({ athleteId: 'ath_1', since: '2026-10-07T07:00:00.000Z' }))).toEqual([b.id, c.id]);
    expect(ids(await store.listEvents({ athleteId: 'ath_1', until: '2026-10-07T07:00:00.000Z' }))).toEqual([a.id, b.id]);
    // an offset-form bound is the same instant: 09:00+02:00 == 07:00Z
    expect(ids(await store.listEvents({ athleteId: 'ath_1', since: '2026-10-07T09:00:00+02:00', until: '2026-10-07T09:00:00+02:00' }))).toEqual([b.id]);
    expect(ids(await store.listEvents({ athleteId: 'ath_1', since: '2026-10-07T07:00:00.001Z', until: '2026-10-07T07:59:59.999Z' }))).toEqual([]);
  });
});

describe('searchEvents', () => {
  async function corpus() {
    const r = await open();
    const { store, clock } = r;
    const ev: Record<string, string> = {};
    const add = async (key: string, text: string, athleteId = 'ath_1') => {
      ev[key] = (await store.appendEvent(msg(athleteId, text))).id;
      await clock.advanceBy(3_600_000);
    };
    await add('knee', 'My left knee hurts after the long run on Sunday');
    await add('tempo', 'Tempo session done, felt strong at 4:30 per km');
    await add('cafe', 'Had a café au lait before the intervals');
    await add('knee2', 'Knee pain is gone, ran 10k pain free');
    await add('other', 'Knee thing for another athlete', 'ath_2');
    ev.coach = (
      await store.appendEvent({
        athleteId: 'ath_1',
        type: 'coach.message',
        actor: 'coach',
        payload: { messageId: 'm1', text: 'Great, keep the knee loaded with calf raises', notify: 'normal', delivery: 'sent', proactive: false },
      })
    ).id;
    return { ...r, ev };
  }

  it('finds messages, ranks by relevance and marks the match in the snippet', async () => {
    const { store, ev } = await corpus();
    const hits = await store.searchEvents({ athleteId: 'ath_1', query: 'knee pain' });
    expect(hits.map((h) => h.event.id)).toEqual([ev.knee2]); // AND of both terms
    expect(hits[0]!.snippet).toMatch(/\*\*Knee\*\*/);
    expect(hits[0]!.snippet).toMatch(/\*\*pain\*\*/);

    const knee = await store.searchEvents({ athleteId: 'ath_1', query: 'knee' });
    expect(new Set(knee.map((h) => h.event.id))).toEqual(new Set([ev.knee, ev.knee2, ev.coach]));
    expect(knee.every((h) => h.event.athleteId === 'ath_1')).toBe(true);
  });

  it('is diacritic- and case-insensitive', async () => {
    const { store, ev } = await corpus();
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'CAFE' })).map((h) => h.event.id)).toEqual([ev.cafe]);
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'café' })).map((h) => h.event.id)).toEqual([ev.cafe]);
  });

  it('supports phrases and prefixes', async () => {
    const { store, ev } = await corpus();
    expect((await store.searchEvents({ athleteId: 'ath_1', query: '"left knee"' })).map((h) => h.event.id)).toEqual([ev.knee]);
    expect(await store.searchEvents({ athleteId: 'ath_1', query: '"knee left"' })).toEqual([]);
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'temp*' })).map((h) => h.event.id)).toEqual([ev.tempo]);
  });

  it('falls back to OR when AND finds nothing', async () => {
    const { store, ev } = await corpus();
    const hits = await store.searchEvents({ athleteId: 'ath_1', query: 'tempo marathon' });
    expect(hits.map((h) => h.event.id)).toEqual([ev.tempo]);
  });

  it('never throws on FTS syntax characters or keywords in user input', async () => {
    const { store, ev } = await corpus();
    for (const q of ['AND', 'OR NOT', 'knee AND', '(knee', 'knee)', '"knee', 'knee"', 'knee*', '^knee', 'a:b', 'NEAR(knee pain)', '-knee', "it's", '\\', '%_', 'ke*ne']) {
      await expect(store.searchEvents({ athleteId: 'ath_1', query: q })).resolves.toBeInstanceOf(Array);
    }
    expect(await store.searchEvents({ athleteId: 'ath_1', query: '   ' })).toEqual([]);
    expect(await store.searchEvents({ athleteId: 'ath_1', query: '!!! ...' })).toEqual([]);
    // keywords are plain words, not operators: "knee OR tempo" is three terms, AND-ed first (no hit),
    // then OR-ed, which finds both the knee and the tempo messages
    const hits = (await store.searchEvents({ athleteId: 'ath_1', query: 'knee OR tempo' })).map((h) => h.event.id);
    expect(hits).toEqual(expect.arrayContaining([ev.tempo, ev.knee, ev.knee2]));
  });

  it('filters by type and date range, honours limit', async () => {
    const { store, ev } = await corpus();
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'knee', types: ['coach.message'] })).map((h) => h.event.id)).toEqual([ev.coach]);
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'knee', types: ['user.message'] })).map((h) => h.event.id).sort()).toEqual([ev.knee, ev.knee2].sort());
    // events are 1h apart starting 06:00: knee=06:00, tempo=07:00, cafe=08:00, knee2=09:00
    const ranged = await store.searchEvents({ athleteId: 'ath_1', query: 'knee', from: '2026-10-07T08:30:00.000Z', to: '2026-10-07T09:30:00.000Z' });
    expect(ranged.map((h) => h.event.id)).toEqual([ev.knee2]);
    const offset = await store.searchEvents({ athleteId: 'ath_1', query: 'knee', from: '2026-10-07T10:30:00+02:00', to: '2026-10-07T11:30:00+02:00' });
    expect(offset.map((h) => h.event.id)).toEqual([ev.knee2]);
    expect(await store.searchEvents({ athleteId: 'ath_1', query: 'knee', limit: 1 })).toHaveLength(1);
  });

  it('indexes every text-bearing event type and nothing else', async () => {
    const { store } = await open();
    const blob = { sha256: SHA_A, mime: 'image/png', bytes: 10 };
    const add = (type: string, payload: unknown) => store.appendEvent({ athleteId: 'a', type: type as never, actor: 'harness', payload: payload as never });
    const ids = {
      upload: (await add('user.upload', { blobs: [blob], caption: 'zebracaption splits' })).id,
      voice: (await add('user.voice_note', { blob, durationS: 2, transcript: 'zebratranscript felt great', transcriptModel: 'm' })).id,
      fired: (await add('schedule.fired', { scheduleId: 's', purpose: 'zebrapurpose check in', scheduledFor: T0, createdAt: T0 })).id,
      changed: (await add('coach.schedule_changed', { scheduleId: 's', op: 'create', purpose: 'zebrachange weekly' })).id,
      published: (await add('coach.ui_published', { viewId: 'v', version: '1', commit: 'c', summary: 'zebrasummary progress view' })).id,
      done: (await add('task.completed', { taskId: 't', summary: 'zebradone analysis' })).id,
      failed: (await add('task.failed', { taskId: 't', summary: 'zebrafail', error: 'zebraerror boom' })).id,
      external: (await add('workspace.external_change', { commits: ['c'], filesChanged: 1, summary: 'zebraexternal edit' })).id,
      notice: (await add('harness.notice', { kind: 'held_quiet_hours', athleteVisible: true, text: 'zebranotice held' })).id,
    };
    await add('user.ui_action', { source: {}, action: 'zebraaction', wake: false });
    await add('system.heartbeat', {});
    const find = async (q: string) => (await store.searchEvents({ athleteId: 'a', query: q })).map((h) => h.event.id);
    expect(await find('zebracaption')).toEqual([ids.upload]);
    expect(await find('zebratranscript')).toEqual([ids.voice]);
    expect(await find('zebrapurpose')).toEqual([ids.fired]);
    expect(await find('zebrachange')).toEqual([ids.changed]);
    expect(await find('zebrasummary')).toEqual([ids.published]);
    expect(await find('zebradone')).toEqual([ids.done]);
    expect(await find('zebrafail')).toEqual([ids.failed]);
    expect(await find('zebraerror')).toEqual([ids.failed]);
    expect(await find('zebraexternal')).toEqual([ids.external]);
    expect(await find('zebranotice')).toEqual([ids.notice]);
    expect(await find('zebraaction')).toEqual([]);
  });

  it('extractSearchText covers the documented fields', () => {
    expect(extractSearchText('user.message', { text: 'hi' })).toBe('hi');
    expect(extractSearchText('user.message', { text: '  ' })).toBeUndefined();
    expect(extractSearchText('task.failed', { summary: 's', error: 'e' })).toBe('s\ne');
    expect(extractSearchText('system.heartbeat', {})).toBeUndefined();
    expect(extractSearchText('user.message', null)).toBeUndefined();
  });
});

describe('tombstoneEvent', () => {
  it('imports validated tombstones without indexing or retaining erased content [SEC-5] [SEC-6]', async () => {
    const { store } = await open();
    const event = await store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { tombstoned: true } as never, tombstoned: true });
    expect((await store.getEvent(event.id))!.payload).toEqual({ tombstoned: true });
    expect(await store.searchEvents({ athleteId: 'ath_1', query: 'tombstoned' })).toEqual([]);
    await expect(store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { tombstoned: true, text: 'secret' } as never, tombstoned: true })).rejects.toThrow(/exactly/);
    await expect(store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { tombstoned: true } as never })).rejects.toThrow();
  });

  it('erases the payload, keeps the row, and removes it from search', async () => {
    const { store } = await open();
    const secret = await store.appendEvent(msg('ath_1', 'my secret diagnosis is zebrafever', { turnId: 't1' }));
    const keep = await store.appendEvent(msg('ath_1', 'ordinary zebrafever mention'));
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'zebrafever' })).length).toBe(2);

    await store.tombstoneEvent(secret.id);
    const got = await store.getEvent(secret.id);
    expect(got).toMatchObject({ id: secret.id, athleteId: 'ath_1', type: 'user.message', actor: 'athlete', turnId: 't1', payload: { tombstoned: true } });
    expect(isTombstoned(got!)).toBe(true);
    expect(isTombstoned(keep)).toBe(false);
    expect(JSON.stringify(got)).not.toContain('diagnosis');

    expect((await store.listEvents({ athleteId: 'ath_1' })).map((e) => e.id)).toEqual([secret.id, keep.id]);
    expect((await store.searchEvents({ athleteId: 'ath_1', query: 'zebrafever' })).map((h) => h.event.id)).toEqual([keep.id]);
    expect(await store.searchEvents({ athleteId: 'ath_1', query: 'diagnosis' })).toEqual([]);

    await store.tombstoneEvent(secret.id); // idempotent
    await store.tombstoneEvent('evt_missing'); // no-op
  });
});

describe('message delivery state', () => {
  const rec = (id: string, over: Record<string, unknown> = {}) => ({ messageId: id, athleteId: 'ath_1', delivery: 'sent' as const, sentAt: '2026-10-07T06:00:00.000Z', proactive: true, ...over });

  it('round-trips records, omitting absent optional fields', async () => {
    const { store } = await open();
    await store.putMessageState(rec('m1'));
    expect(await store.getMessageState('m1')).toEqual(rec('m1'));
    expect(await store.getMessageState('nope')).toBeUndefined();
    await store.putMessageState({ messageId: 'm2', athleteId: 'ath_1', delivery: 'held', heldUntil: '2026-10-07T07:00:00.000Z', proactive: false });
    expect(await store.getMessageState('m2')).toEqual({ messageId: 'm2', athleteId: 'ath_1', delivery: 'held', heldUntil: '2026-10-07T07:00:00.000Z', proactive: false });
  });

  it('counts proactive sends since a time and reports the last one', async () => {
    const { store } = await open();
    await store.putMessageState(rec('p1', { sentAt: '2026-10-07T05:00:00.000Z' }));
    await store.putMessageState(rec('p2', { sentAt: '2026-10-07T06:00:00.000Z' }));
    await store.putMessageState(rec('p3', { sentAt: '2026-10-07T09:30:00.000Z' }));
    await store.putMessageState(rec('reactive', { proactive: false, sentAt: '2026-10-07T10:00:00.000Z' }));
    await store.putMessageState({ messageId: 'held', athleteId: 'ath_1', delivery: 'held', heldUntil: '2026-10-08T07:00:00.000Z', proactive: true });
    await store.putMessageState(rec('other', { athleteId: 'ath_2', sentAt: '2026-10-07T11:00:00.000Z' }));
    expect(await store.countProactiveSince('ath_1', '2026-10-07T00:00:00.000Z')).toBe(3);
    expect(await store.countProactiveSince('ath_1', '2026-10-07T06:00:00.000Z')).toBe(2); // inclusive
    expect(await store.countProactiveSince('ath_1', '2026-10-07T08:00:00+02:00')).toBe(2); // offset == 06:00Z
    expect(await store.countProactiveSince('ath_1', '2026-10-07T09:31:00.000Z')).toBe(0);
    expect(await store.countProactiveSince('nobody', '2026-01-01T00:00:00.000Z')).toBe(0);
    expect(await store.lastProactiveAt('ath_1')).toBe('2026-10-07T09:30:00.000Z');
    expect(await store.lastProactiveAt('nobody')).toBeUndefined();
  });

  it('a held message counts only once it is released (held -> sent)', async () => {
    const { store } = await open();
    await store.putMessageState({ messageId: 'h1', athleteId: 'ath_1', delivery: 'held', heldUntil: '2026-10-07T07:00:00.000Z', proactive: true });
    expect(await store.countProactiveSince('ath_1', '2026-10-07T00:00:00.000Z')).toBe(0);
    expect(await store.lastProactiveAt('ath_1')).toBeUndefined();
    await store.putMessageState({ messageId: 'h1', athleteId: 'ath_1', delivery: 'sent', sentAt: '2026-10-07T07:00:00.000Z', proactive: true });
    expect(await store.countProactiveSince('ath_1', '2026-10-07T00:00:00.000Z')).toBe(1);
    expect(await store.listHeldMessages('ath_1')).toEqual([]);
    expect(await store.getMessageState('h1')).not.toHaveProperty('heldUntil');
  });

  it('lists held messages ordered by release time, optionally per athlete', async () => {
    const { store } = await open();
    const held = (id: string, athleteId: string, until: string) => store.putMessageState({ messageId: id, athleteId, delivery: 'held', heldUntil: until, proactive: true });
    await held('b', 'ath_1', '2026-10-07T08:00:00.000Z');
    await held('a', 'ath_2', '2026-10-07T07:00:00.000Z');
    await held('c', 'ath_1', '2026-10-07T07:30:00.000Z');
    await store.putMessageState(rec('sent'));
    expect((await store.listHeldMessages()).map((m) => m.messageId)).toEqual(['a', 'c', 'b']);
    expect((await store.listHeldMessages('ath_1')).map((m) => m.messageId)).toEqual(['c', 'b']);
  });

  it('tracks reads and unread counts', async () => {
    const { store } = await open();
    await store.putMessageState(rec('m1', { proactive: false }));
    await store.putMessageState(rec('m2', { proactive: false }));
    await store.putMessageState(rec('m3', { proactive: false }));
    await store.putMessageState({ messageId: 'held', athleteId: 'ath_1', delivery: 'held', heldUntil: '2026-10-08T07:00:00.000Z', proactive: false });
    await store.putMessageState(rec('x', { athleteId: 'ath_2' }));
    expect(await store.countUnreadCoachMessages('ath_1')).toBe(3); // held messages are not unread yet
    await store.markRead(['m1', 'm2', 'does-not-exist'], '2026-10-07T07:00:00.000Z');
    expect(await store.countUnreadCoachMessages('ath_1')).toBe(1);
    expect((await store.getMessageState('m1'))?.readAt).toBe('2026-10-07T07:00:00.000Z');
    // an earlier read mark is never overwritten
    await store.markRead(['m1'], '2026-10-07T09:00:00.000Z');
    expect((await store.getMessageState('m1'))?.readAt).toBe('2026-10-07T07:00:00.000Z');
    // re-putting a record without readAt keeps the read mark
    await store.putMessageState(rec('m1', { proactive: false }));
    expect((await store.getMessageState('m1'))?.readAt).toBe('2026-10-07T07:00:00.000Z');
    await store.markRead([], T0); // no-op
    expect(await store.countUnreadCoachMessages('ath_2')).toBe(1);
  });

  it('marks more than 500 messages read in one call', async () => {
    const { store } = await open();
    const ids = Array.from({ length: 1203 }, (_, i) => `m${i}`);
    for (const id of ids) await store.putMessageState(rec(id, { proactive: false }));
    expect(await store.countUnreadCoachMessages('ath_1')).toBe(1203);
    await store.markRead(ids, '2026-10-07T07:00:00.000Z');
    expect(await store.countUnreadCoachMessages('ath_1')).toBe(0);
  });
});
