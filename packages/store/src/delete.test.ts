import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZERO_USAGE, defaultSettings, type Store } from '@opencoach/protocol';
import { openSqliteStore } from './index';
import { loadSqlite } from './sqlite';
import { SHA_A, SHA_B, T0, makeClock, memStore, tmpDir } from './test-helpers';

const stores: Store[] = [];
afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
});

/** Fill every table for one athlete. */
async function populate(store: Store, a: string, tag = ''): Promise<{ eventIds: string[] }> {
  await store.createAthlete({ id: a, displayName: a, isAdmin: false, settings: defaultSettings() });
  await store.updateSettings(a, { profile: { name: `Name of ${a}` } });
  await store.createPairingCode({ code: `PAIR-${a}`, purpose: 'link_device', athleteId: a, createdBy: a, expiresAt: '2099-01-01T00:00:00.000Z' });
  await store.createPairingCode({ code: `INVT-${a}${tag}`, purpose: 'invite', createdBy: a, expiresAt: '2099-01-01T00:00:00.000Z' }); // created by the athlete for someone else
  await store.createSession({ id: `ses_${a}`, athleteId: a, tokenHash: `hash_${a}`, kind: 'cookie', createdAt: T0, lastSeenAt: T0, expiresAt: '2099-01-01T00:00:00.000Z' });
  await store.addPasskey({ credentialId: `cred_${a}`, athleteId: a, publicKey: 'pk', counter: 1, createdAt: T0 });
  await store.setCredential({ athleteId: a, provider: 'openrouter', owner: 'athlete', ciphertext: `v1:${a}`, hint: 'sk-or-…abcd', updatedAt: T0 });
  const e1 = await store.appendEvent({ athleteId: a, type: 'user.message', actor: 'athlete', payload: { text: `searchable zebra ${a}` } });
  const e2 = await store.appendEvent({
    athleteId: a,
    type: 'coach.message',
    actor: 'coach',
    payload: { messageId: `m_${a}`, text: `coach zebra ${a}`, notify: 'normal', delivery: 'sent', proactive: true },
  });
  await store.putMessageState({ messageId: `m_${a}`, athleteId: a, delivery: 'sent', sentAt: T0, proactive: true });
  await store.putBlob({ athleteId: a, sha256: SHA_A, mime: 'image/png', bytes: 1, origin: 'athlete', createdAt: T0, relPath: 'x.png' });
  await store.upsertSchedule({ id: `sch_${a}`, athleteId: a, kind: 'coach', spec: { at: '2026-10-08T00:00:00.000Z' }, purpose: 'p', duringPause: false, nextFireAt: '2026-10-08T00:00:00.000Z', status: 'active', createdAt: T0 });
  await store.createEpoch({ id: `ep_${a}`, athleteId: a, localDate: '2026-10-07', seq: 1, provider: 'p', model: 'm', openedAt: T0 });
  await store.appendEpochItems([{ epochId: `ep_${a}`, seq: 1, item: { kind: 'harness', text: 'h' }, tokens: 1, createdAt: T0 }]);
  await store.insertTurn({
    id: `turn_${a}`,
    athleteId: a,
    agent: 'coach',
    triggerClass: 'reactive',
    triggerEventIds: [e1.id],
    tier: 'coach',
    status: 'ok',
    startedAt: T0,
    steps: 1,
    usage: { ...ZERO_USAGE },
    costUsd: 0.1,
    fallbacks: [],
  });
  await store.saveTurnContext(`turn_${a}`, { secret: `context of ${a}` });
  await store.saveTurnContext(`orphan_${a}`, { secret: 'saved before its turn row exists' }); // cannot be attributed
  await store.insertTask({ id: `tsk_${a}`, athleteId: a, parentTurnId: `turn_${a}`, task: 't', state: 'done', background: false, createdAt: T0, outputs: [], costUsd: 0 });
  await store.recordUsage({ athleteId: a, at: T0, provider: 'p', model: 'm', kind: 'turn', usage: { ...ZERO_USAGE, inputTokens: 5 }, costUsd: 0.2 });
  await store.addPushSubscription({ id: `push_${a}`, athleteId: a, kind: 'webpush', endpoint: `https://push/${a}`, createdAt: T0 });
  const manifest = { id: 'today', title: 'Today' } as never;
  await store.addUiVersion({ athleteId: a, viewId: 'today', version: '1', commit: 'c', summary: 's', publishedAt: T0, publishedBy: 'coach', manifest, dir: '/d' });
  await store.setCurrentUiVersion(a, 'today', '1');
  await store.audit({ athleteId: a, at: T0, actor: 'coach', action: 'x' });
  return { eventIds: [e1.id, e2.id] };
}

describe('deleteAthlete', () => {
  it('removes every row of the athlete in every table, and only theirs', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'system.db');
      const store = await openSqliteStore({ path, clock: makeClock() });
      stores.push(store);
      const gone = await populate(store, 'ath_gone');
      const kept = await populate(store, 'ath_kept');

      await store.deleteAthlete('ath_gone');

      // public API view
      expect(await store.getAthlete('ath_gone')).toBeUndefined();
      expect((await store.listAthletes()).map((a) => a.id)).toEqual(['ath_kept']);
      expect(await store.getSettings('ath_gone')).toEqual(defaultSettings());
      expect(await store.getSettings('ath_kept')).toMatchObject({ profile: { name: 'Name of ath_kept' } });
      expect(await store.listEvents({ athleteId: 'ath_gone' })).toEqual([]);
      expect(await store.getEvent(gone.eventIds[0]!)).toBeUndefined();
      expect(await store.searchEvents({ athleteId: 'ath_gone', query: 'zebra' })).toEqual([]);
      expect((await store.searchEvents({ athleteId: 'ath_kept', query: 'zebra' })).map((h) => h.event.id).sort()).toEqual([...kept.eventIds].sort());
      expect(await store.getMessageState('m_ath_gone')).toBeUndefined();
      expect(await store.getBlob('ath_gone', SHA_A)).toBeUndefined();
      expect(await store.listSchedules('ath_gone')).toEqual([]);
      expect(await store.getEpoch('ep_ath_gone')).toBeUndefined();
      expect(await store.listEpochItems('ep_ath_gone')).toEqual([]);
      expect(await store.getTurn('turn_ath_gone')).toBeUndefined();
      expect(await store.getTurnContext('turn_ath_gone')).toBeUndefined();
      expect(await store.getTask('tsk_ath_gone')).toBeUndefined();
      expect(await store.sumUsage('ath_gone', '2000-01-01T00:00:00.000Z')).toMatchObject({ costUsd: 0 });
      expect(await store.listPushSubscriptions('ath_gone')).toEqual([]);
      expect(await store.listUiVersions('ath_gone')).toEqual([]);
      expect(await store.getCurrentUiVersions('ath_gone')).toEqual([]);
      expect(await store.listAudit('ath_gone')).toEqual([]);
      expect(await store.listSessions('ath_gone')).toEqual([]);
      expect(await store.getSessionByTokenHash('hash_ath_gone')).toBeUndefined();
      expect(await store.listPasskeys('ath_gone')).toEqual([]);
      expect(await store.listCredentials('ath_gone')).toEqual([]);
      expect(await store.listCredentials('ath_kept')).toHaveLength(1);
      expect(await store.consumePairingCode('PAIR-ath_gone', T0)).toBeUndefined();

      // the other athlete is untouched
      expect(await store.listEvents({ athleteId: 'ath_kept' })).toHaveLength(2);
      expect(await store.getMessageState('m_ath_kept')).toBeDefined();
      expect(await store.getTurnContext('turn_ath_kept')).toEqual({ secret: 'context of ath_kept' });
      expect(await store.listEpochItems('ep_ath_kept')).toHaveLength(1);
      expect(await store.getCurrentUiVersions('ath_kept')).toHaveLength(1);
      expect(await store.listPushSubscriptions('ath_kept')).toHaveLength(1);
      expect(await store.getBlob('ath_kept', SHA_A)).toBeDefined();
      expect((await store.consumePairingCode('PAIR-ath_kept', T0))?.code).toBe('PAIR-ath_kept');

      // raw SQL: nothing is left behind anywhere, including FTS shadow tables and child tables
      const { DatabaseSync } = loadSqlite();
      const raw = new DatabaseSync(path, { readOnly: true });
      const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'events_fts_%'`).all() as Array<{ name: string }>;
      for (const { name } of tables) {
        const cols = (raw.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => c.name);
        if (cols.includes('athlete_id')) {
          const n = (raw.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE athlete_id = ?`).get('ath_gone') as { n: number }).n;
          expect({ table: name, rows: n }).toEqual({ table: name, rows: 0 });
        }
      }
      const count = (sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);
      expect(count(`SELECT COUNT(*) AS n FROM epoch_items WHERE epoch_id = 'ep_ath_gone'`)).toBe(0);
      expect(count(`SELECT COUNT(*) AS n FROM turn_contexts WHERE turn_id = 'turn_ath_gone'`)).toBe(0);
      expect(count(`SELECT COUNT(*) AS n FROM events_fts`)).toBe(2); // only the kept athlete's two indexed events
      expect(count(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'ath_gone'`)).toBe(0);
      expect(count(`SELECT COUNT(*) AS n FROM pairing_codes WHERE created_by = 'ath_gone'`)).toBe(0);
      expect(count(`SELECT COUNT(*) AS n FROM pairing_codes WHERE code = 'INVT-ath_gone'`)).toBe(1); // invite survives but is anonymised
      raw.close();
    } finally {
      cleanup();
    }
  });

  it('is a no-op for an unknown athlete and leaves the store usable', async () => {
    const { store } = await memStore();
    stores.push(store);
    await populate(store, 'ath_1');
    await store.deleteAthlete('ath_unknown');
    expect(await store.listEvents({ athleteId: 'ath_1' })).toHaveLength(2);
    await store.deleteAthlete('ath_1');
    await store.deleteAthlete('ath_1'); // idempotent
    expect(await store.hasAnyAthlete()).toBe(false);
    // the id can be reused afterwards
    await populate(store, 'ath_1', '-again');
    expect(await store.listEvents({ athleteId: 'ath_1' })).toHaveLength(2);
  });

  it('removes athlete-owned caches and reverse capabilities without deleting another athlete or deployment state [SEC-6]', async () => {
    const { store } = await memStore();
    stores.push(store);
    await populate(store, 'ath_1');
    // Prefix sibling and SQL LIKE wildcard lookalike must both survive.
    await populate(store, 'ath_10');
    await populate(store, 'athX1');
    const expiry = '2099-01-01T00:00:00.000Z';
    const owned = [
      'view-token:ath_1', 'app-manifest:ath_1', 'harness-version:ath_1', 'last-head:ath_1',
      'turns-since-pinned-write:ath_1', 'notice:budget_exhausted:ath_1', 'telegram-athlete:ath_1',
      'epoch-system:ep_ath_1', 'export:ath_1:job_one', 'upload-drafts:ath_1', 'upload-draft:ath_1:job_one',
      'image-attempt:ath_1:turn:call',
    ];
    for (const key of owned) await store.setKv(key, 'private');
    await store.setKv('view-token-rev:gone_token', 'ath_1');
    await store.setKv('telegram-chat:123', 'ath_1');
    await store.setKv('telegram-link:gone_link', JSON.stringify({ athleteId: 'ath_1', expires: 123 }));
    for (const key of ['message:ath_1:client', 'tool:ath_1:turn_ath_1:tool', 'msg:turn_ath_1:tool']) {
      await store.putIdempotent(key, { text: 'private health message' }, expiry);
    }
    const kept = ['view-token:ath_10', 'app-manifest:athX1', 'epoch-system:ep_ath_10', 'export:ath_10:job', 'notice:budget_exhausted:ath_10', 'telegram-offset', 'image-attempt:ath_10:turn:call'];
    for (const key of kept) await store.setKv(key, 'keep');
    await store.setKv('view-token-rev:kept_token', 'ath_10');
    await store.setKv('telegram-chat:456', 'ath_10');
    await store.setKv('telegram-link:kept_link', JSON.stringify({ athleteId: 'ath_10', expires: 123 }));
    await store.setKv('telegram-link:invalid_json', 'bad-json');
    const keptIdempotency = ['message:ath_10:client', 'message:athX1:client', 'tool:ath_10:turn_ath_10:tool', 'msg:turn_ath_10:tool'];
    for (const key of keptIdempotency) await store.putIdempotent(key, { text: 'keep' }, expiry);
    await store.deleteAthlete('ath_1');
    for (const key of [...owned, 'view-token-rev:gone_token', 'telegram-chat:123', 'telegram-link:gone_link']) expect(await store.getKv(key)).toBeUndefined();
    for (const key of ['message:ath_1:client', 'tool:ath_1:turn_ath_1:tool', 'msg:turn_ath_1:tool']) expect(await store.getIdempotent(key)).toBeUndefined();
    for (const key of kept) expect(await store.getKv(key)).toBe('keep');
    expect(await store.getKv('view-token-rev:kept_token')).toBe('ath_10');
    expect(await store.getKv('telegram-chat:456')).toBe('ath_10');
    expect(await store.getKv('telegram-link:kept_link')).toContain('ath_10');
    expect(await store.getKv('telegram-link:invalid_json')).toBe('bad-json');
    for (const key of keptIdempotency) expect(await store.getIdempotent(key)).toEqual({ text: 'keep' });
  });

  it('purges freed content from the file (secure_delete)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'system.db');
      const store = await openSqliteStore({ path, clock: makeClock() });
      stores.push(store);
      await store.createAthlete({ id: 'ath_1', displayName: 'x', isAdmin: false, settings: defaultSettings() });
      await store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'UNIQUE-SENTINEL-4f9c1e7a recovery plan' } });
      await store.putIdempotent('message:ath_1:client', { text: 'UNIQUE-SENTINEL-4f9c1e7a' }, '2099-01-01T00:00:00.000Z');
      await store.setKv('app-manifest:ath_1', 'UNIQUE-SENTINEL-4f9c1e7a');
      await store.deleteAthlete('ath_1');
      await store.close();
      stores.pop();
      const { readFileSync, existsSync } = await import('node:fs');
      for (const f of [path, `${path}-wal`]) {
        if (existsSync(f)) expect(readFileSync(f).includes('UNIQUE-SENTINEL-4f9c1e7a')).toBe(false);
      }
    } finally {
      cleanup();
    }
  });
});

describe('resetAthleteCoach', () => {
  it('removes the coach (conversation, memory, turns, uploads, views, schedules) but keeps the account, sign-ins, keys and spend', async () => {
    const { store } = await memStore();
    stores.push(store);
    await populate(store, 'ath_me');
    await store.updateAthlete('ath_me', { isAdmin: true });
    await populate(store, 'ath_other');
    await store.resetAthleteCoach('ath_me');

    const me = await store.getAthlete('ath_me');
    expect(me).toMatchObject({ isAdmin: true, status: 'active' });
    expect((await store.getSettings('ath_me')).profile.name).toBe('Name of ath_me');
    expect(await store.listSessions('ath_me')).toHaveLength(1);
    expect(await store.listPasskeys('ath_me')).toHaveLength(1);
    expect(await store.listPushSubscriptions('ath_me')).toHaveLength(1);
    expect((await store.sumUsage('ath_me', '2000-01-01T00:00:00.000Z')).costUsd).toBeCloseTo(0.2);

    expect(await store.listEvents({ athleteId: 'ath_me' })).toEqual([]);
    expect(await store.listSchedules('ath_me')).toEqual([]);
    expect(await store.listTurns({ athleteId: 'ath_me' })).toEqual([]);
    expect(await store.listTasks('ath_me')).toEqual([]);
    expect(await store.listUiVersions('ath_me')).toEqual([]);
    expect(await store.getBlob('ath_me', SHA_A)).toBeUndefined();

    // Someone else's coach is untouched.
    expect((await store.listEvents({ athleteId: 'ath_other' })).length).toBeGreaterThan(0);
    expect(await store.listTurns({ athleteId: 'ath_other' })).not.toEqual([]);
    await expect(store.resetAthleteCoach('ghost')).rejects.toThrow(/not found/);
  });
});

describe('search fallback', () => {
  it('falls back to a LIKE scan if SQLite rejects the FTS expression', async () => {
    vi.resetModules();
    vi.doMock('./fts', async (orig) => {
      const real = await orig<typeof import('./fts')>();
      return { ...real, buildMatch: () => '"unterminated' }; // syntactically invalid MATCH
    });
    try {
      const { openSqliteStore: open } = await import('./index');
      const store = await open({ path: ':memory:', clock: makeClock() });
      stores.push(store);
      const hit = await store.appendEvent({ athleteId: 'a', type: 'user.message', actor: 'athlete', payload: { text: '100% effort on the hill repeats, felt great' } });
      await store.appendEvent({ athleteId: 'a', type: 'user.message', actor: 'athlete', payload: { text: 'rest day' } });
      await store.appendEvent({ athleteId: 'b', type: 'user.message', actor: 'athlete', payload: { text: '100% effort elsewhere' } });
      const hits = await store.searchEvents({ athleteId: 'a', query: '100% effort' });
      expect(hits.map((h) => h.event.id)).toEqual([hit.id]);
      expect(hits[0]!.snippet).toContain('**100%**');
      // LIKE wildcards in the query are escaped, not interpreted
      expect(await store.searchEvents({ athleteId: 'a', query: '_est' })).toEqual([]);
    } finally {
      vi.doUnmock('./fts');
      vi.resetModules();
    }
  });
});
