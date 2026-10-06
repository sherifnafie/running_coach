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

  it('purges freed content from the file (secure_delete)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'system.db');
      const store = await openSqliteStore({ path, clock: makeClock() });
      stores.push(store);
      await store.createAthlete({ id: 'ath_1', displayName: 'x', isAdmin: false, settings: defaultSettings() });
      await store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'UNIQUE-SENTINEL-4f9c1e7a recovery plan' } });
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
