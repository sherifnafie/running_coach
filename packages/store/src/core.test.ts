import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Store } from '@opencoach/protocol';
import { openSqliteStore } from './index';
import { loadSqlite } from './sqlite';
import { MIGRATIONS } from './migrations';
import { T0, addAthlete, makeClock, memStore, tmpDir } from './test-helpers';

const stores: Store[] = [];
async function open(...args: Parameters<typeof memStore>): ReturnType<typeof memStore> {
  const r = await memStore(...args);
  stores.push(r.store);
  return r;
}
afterEach(async () => {
  while (stores.length) await stores.pop()!.close();
});

describe('lifecycle', () => {
  it('migrates a file database, persists across reopen, uses WAL and 0600', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'nested', 'system.db');
      const clock = makeClock();
      const a = await openSqliteStore({ path, clock });
      await a.createAthlete({ id: 'ath_1', displayName: 'Ana', isAdmin: true, settings: defaultSettings() });
      await a.setKv('k', 'v');
      await a.close();
      await a.close(); // idempotent
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const b = await openSqliteStore({ path, clock });
      expect((await b.getAthlete('ath_1'))?.displayName).toBe('Ana');
      expect(await b.getKv('k')).toBe('v');
      await b.migrate(); // idempotent
      await b.close();

      const { DatabaseSync } = loadSqlite();
      const raw = new DatabaseSync(path, { readOnly: true });
      expect(Object.values(raw.prepare('PRAGMA journal_mode').get() ?? {})[0]).toBe('wal');
      expect(Object.values(raw.prepare('PRAGMA user_version').get() ?? {})[0]).toBe(MIGRATIONS.length);
      raw.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('refuses a database written by a newer schema', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'new.db');
      const { DatabaseSync } = loadSqlite();
      const raw = new DatabaseSync(path);
      raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
      raw.close();
      await expect(openSqliteStore({ path, clock: makeClock() })).rejects.toThrow(/newer than this build/);
    } finally {
      cleanup();
    }
  });

  it('rejects calls after close', async () => {
    const { store } = await memStore();
    await store.close();
    await expect(store.getKv('x')).rejects.toThrow(/closed/);
  });

  it('loads node:sqlite without printing the ExperimentalWarning', () => {
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const script = `import(${JSON.stringify(entry)}).then(async (m) => {
      const clock = { now: () => new Date('2026-01-01T00:00:00Z'), sleepUntil: async () => {} };
      const s = await m.openSqliteStore({ path: ':memory:', clock });
      await s.setKv('a', 'b');
      console.log('OK:' + (await s.getKv('a')));
      await s.close();
    });`;
    const res = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8', cwd: repoRoot });
    expect(res.stdout).toContain('OK:b');
    expect(res.stderr).not.toMatch(/ExperimentalWarning/);
  });
});

describe('athletes and settings', () => {
  it('creates, reads, lists and updates athletes', async () => {
    const { store, clock } = await open();
    expect(await store.hasAnyAthlete()).toBe(false);
    const a = await store.createAthlete({ displayName: 'Ana', isAdmin: true, settings: defaultSettings() });
    expect(a.id).toMatch(/^ath_[0-9A-Z]{26}$/);
    expect(a).toMatchObject({ displayName: 'Ana', isAdmin: true, status: 'active', createdAt: T0 });
    await clock.advanceBy(1000);
    const b = await store.createAthlete({ id: 'ath_fixed', displayName: 'Bo', isAdmin: false, settings: defaultSettings() });
    expect(b.createdAt).toBe('2026-10-07T06:00:01.000Z');
    expect(await store.hasAnyAthlete()).toBe(true);
    expect(await store.getAthlete(a.id)).toEqual(a);
    expect(await store.getAthlete('nope')).toBeUndefined();
    expect((await store.listAthletes()).map((x) => x.id)).toEqual([a.id, 'ath_fixed']);

    await store.updateAthlete('ath_fixed', { displayName: 'Bobby', isAdmin: true, status: 'deleted' });
    expect(await store.getAthlete('ath_fixed')).toMatchObject({ displayName: 'Bobby', isAdmin: true, status: 'deleted', createdAt: b.createdAt });
    await store.updateAthlete('ath_fixed', {}); // no-op on existing row
    await store.updateAthlete('ath_fixed', { suspendedAt: '2026-10-07T10:00:00.000Z' });
    expect((await store.getAthlete('ath_fixed'))?.suspendedAt).toBe('2026-10-07T10:00:00.000Z');
    await store.updateAthlete('ath_fixed', { suspendedAt: null });
    expect((await store.getAthlete('ath_fixed'))?.suspendedAt ?? null).toBeNull();
    await expect(store.updateAthlete('ghost', { displayName: 'x' })).rejects.toThrow(/athlete not found/);
  });

  it('rejects a duplicate athlete id', async () => {
    const { store } = await open();
    await addAthlete(store, 'ath_1');
    await expect(addAthlete(store, 'ath_1')).rejects.toThrow();
  });

  it('returns defaults for missing settings and merges patches with a diff', async () => {
    const { store } = await open();
    expect(await store.getSettings('unknown')).toEqual(defaultSettings());
    await addAthlete(store, 'ath_1');
    expect(await store.getSettings('ath_1')).toEqual(defaultSettings());

    const r = await store.updateSettings('ath_1', { notifications: { proactivePerDay: 1 }, profile: { tz: 'Europe/Amsterdam' } });
    expect(r.settings.notifications.proactivePerDay).toBe(1);
    expect(r.settings.notifications.minGapMinutes).toBe(120); // untouched siblings survive the deep merge
    expect(r.diff).toEqual({
      'notifications.proactivePerDay': { from: 3, to: 1 },
      'profile.tz': { from: 'UTC', to: 'Europe/Amsterdam' },
    });
    expect(await store.getSettings('ath_1')).toEqual(r.settings);

    // a second patch builds on the first
    const r2 = await store.updateSettings('ath_1', { notifications: { quietHours: null } });
    expect(r2.settings.notifications.proactivePerDay).toBe(1);
    expect(r2.settings.notifications.quietHours).toBeNull();
    expect(r2.diff['notifications.quietHours']).toEqual({ from: { start: '22:00', end: '07:00' }, to: null });
  });

  it('rejects invalid settings patches without changing anything', async () => {
    const { store } = await open();
    await addAthlete(store, 'ath_1');
    await expect(store.updateSettings('ath_1', { notifications: { proactivePerDay: 99 } })).rejects.toThrow();
    expect(await store.getSettings('ath_1')).toEqual(defaultSettings());
    await expect(store.updateSettings('ghost', { profile: { name: 'x' } })).rejects.toThrow(/athlete not found/);
  });
});

describe('auth', () => {
  const code = (over: Partial<Parameters<Store['createPairingCode']>[0]> = {}) => ({
    code: 'K7QM-3XPD',
    purpose: 'link_device' as const,
    athleteId: 'ath_1',
    createdBy: 'ath_admin',
    isAdmin: false,
    expiresAt: '2026-10-07T06:10:00.000Z',
    ...over,
  });

  it('consumes a pairing code exactly once', async () => {
    const { store } = await open();
    await store.createPairingCode(code());
    const got = await store.consumePairingCode('K7QM-3XPD', '2026-10-07T06:05:00.000Z');
    expect(got).toEqual({ ...code(), consumedAt: '2026-10-07T06:05:00.000Z' });
    expect(await store.consumePairingCode('K7QM-3XPD', '2026-10-07T06:05:01.000Z')).toBeUndefined();
  });

  it('is atomic under concurrent consumers', async () => {
    const { store } = await open();
    await store.createPairingCode(code());
    const results = await Promise.all(Array.from({ length: 20 }, () => store.consumePairingCode('K7QM-3XPD', '2026-10-07T06:01:00.000Z')));
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('is atomic across two connections to the same file', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'shared.db');
      const clock = makeClock();
      const a = await openSqliteStore({ path, clock });
      const b = await openSqliteStore({ path, clock });
      stores.push(a, b);
      await a.createPairingCode(code());
      const results = await Promise.all([a.consumePairingCode('K7QM-3XPD', T0), b.consumePairingCode('K7QM-3XPD', T0), a.consumePairingCode('K7QM-3XPD', T0), b.consumePairingCode('K7QM-3XPD', T0)]);
      expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('refuses expired, unknown and exactly-expiring codes', async () => {
    const { store } = await open();
    await store.createPairingCode(code({ code: 'AAAA-AAAA' }));
    expect(await store.consumePairingCode('AAAA-AAAA', '2026-10-07T06:10:00.000Z')).toBeUndefined(); // expires_at > now is strict
    expect(await store.consumePairingCode('AAAA-AAAA', '2026-10-07T07:00:00.000Z')).toBeUndefined();
    expect(await store.consumePairingCode('ZZZZ-ZZZZ', T0)).toBeUndefined();
    // still consumable before expiry: the failed attempts did not burn it
    expect((await store.consumePairingCode('AAAA-AAAA', '2026-10-07T06:09:59.000Z'))?.code).toBe('AAAA-AAAA');
  });

  it('compares instants, not strings, when callers pass offsets', async () => {
    const { store } = await open();
    await store.createPairingCode(code({ code: 'OFFS-0001', expiresAt: '2026-10-07T08:10:00+02:00' })); // = 06:10Z
    expect(await store.consumePairingCode('OFFS-0001', '2026-10-07T08:11:00+02:00')).toBeUndefined();
    expect(await store.consumePairingCode('OFFS-0001', '2026-10-07T08:09:00+02:00')).toBeDefined();
  });

  it('round-trips optional pairing fields (setup code without athlete)', async () => {
    const { store } = await open();
    await store.createPairingCode({ code: 'SETU-P000', purpose: 'setup', expiresAt: '2026-10-07T07:00:00.000Z' });
    const got = await store.consumePairingCode('SETU-P000', T0);
    expect(got).toEqual({ code: 'SETU-P000', purpose: 'setup', expiresAt: '2026-10-07T07:00:00.000Z', consumedAt: T0 });
    expect(got).not.toHaveProperty('athleteId');
  });

  it('manages sessions', async () => {
    const { store } = await open();
    const s = {
      id: 'ses_1',
      athleteId: 'ath_1',
      tokenHash: 'h1',
      kind: 'cookie' as const,
      deviceName: 'iPhone',
      createdAt: '2026-10-07T06:00:00.000Z',
      lastSeenAt: '2026-10-07T06:00:00.000Z',
      expiresAt: '2026-11-07T06:00:00.000Z',
    };
    await store.createSession(s);
    await store.createSession({ ...s, id: 'ses_2', tokenHash: 'h2', kind: 'bearer', deviceName: undefined, createdAt: '2026-10-07T07:00:00.000Z' });
    await store.createSession({ ...s, id: 'ses_3', tokenHash: 'h3', athleteId: 'ath_other' });
    expect(await store.getSessionByTokenHash('h1')).toEqual(s);
    expect(await store.getSessionByTokenHash('nope')).toBeUndefined();
    expect(await store.getSessionByTokenHash('h2')).not.toHaveProperty('deviceName');
    await expect(store.createSession({ ...s, id: 'ses_dup' })).rejects.toThrow(); // token_hash unique
    await store.touchSession('ses_1', '2026-10-07T09:00:00.000Z');
    expect((await store.getSessionByTokenHash('h1'))?.lastSeenAt).toBe('2026-10-07T09:00:00.000Z');
    await store.touchSession('ses_1', '2026-10-07T10:00:00.000Z', '2027-01-05T10:00:00.000Z');
    expect(await store.getSessionByTokenHash('h1')).toMatchObject({ lastSeenAt: '2026-10-07T10:00:00.000Z', expiresAt: '2027-01-05T10:00:00.000Z' });
    expect((await store.listSessions('ath_1')).map((x) => x.id)).toEqual(['ses_2', 'ses_1']); // newest first
    await store.deleteSession('ses_1');
    expect(await store.getSessionByTokenHash('h1')).toBeUndefined();
    expect((await store.listSessions('ath_1')).map((x) => x.id)).toEqual(['ses_2']);
  });

  it('manages passkeys', async () => {
    const { store } = await open();
    const p = { credentialId: 'cred_1', athleteId: 'ath_1', publicKey: 'pk', counter: 0, transports: ['internal', 'hybrid'], deviceName: 'Mac', createdAt: T0 };
    await store.addPasskey(p);
    await store.addPasskey({ credentialId: 'cred_2', athleteId: 'ath_1', publicKey: 'pk2', counter: 3, createdAt: '2026-10-07T07:00:00.000Z' });
    expect(await store.getPasskey('cred_1')).toEqual(p);
    expect(await store.getPasskey('none')).toBeUndefined();
    expect((await store.listPasskeys('ath_1')).map((x) => x.credentialId)).toEqual(['cred_1', 'cred_2']);
    await store.updatePasskeyCounter('cred_1', 42);
    expect((await store.getPasskey('cred_1'))?.counter).toBe(42);
    await expect(store.addPasskey(p)).rejects.toThrow();
  });
});

describe('audit, idempotency, kv', () => {
  it('records and lists audit entries newest first, per athlete', async () => {
    const { store } = await open();
    await store.audit({ athleteId: 'ath_1', at: T0, actor: 'coach', action: 'tool.bash', detail: { cmd: 'ls', code: 0 } });
    await store.audit({ athleteId: 'ath_1', at: T0, actor: 'harness', action: 'policy.hold' });
    await store.audit({ athleteId: 'ath_2', at: T0, actor: 'harness', action: 'other' });
    await store.audit({ at: T0, actor: 'system', action: 'global' });
    const rows = await store.listAudit('ath_1');
    expect(rows.map((r) => r.action)).toEqual(['policy.hold', 'tool.bash']);
    expect(rows[1]).toEqual({ athleteId: 'ath_1', at: T0, actor: 'coach', action: 'tool.bash', detail: { cmd: 'ls', code: 0 } });
    expect(rows[0]).not.toHaveProperty('detail');
    expect(await store.listAudit('ath_1', 1)).toHaveLength(1);
  });

  it('expires idempotency entries by the injected clock', async () => {
    const { store, clock } = await open();
    await store.putIdempotent('turn1:call1', { ok: true, messageId: 'evt_1' }, '2026-10-07T06:10:00.000Z');
    await store.putIdempotent('forever', null, '2099-01-01T00:00:00.000Z');
    expect(await store.getIdempotent('turn1:call1')).toEqual({ ok: true, messageId: 'evt_1' });
    expect(await store.getIdempotent('forever')).toBeNull();
    expect(await store.getIdempotent('missing')).toBeUndefined();
    await clock.advanceBy(9 * 60_000 + 59_000);
    expect(await store.getIdempotent('turn1:call1')).toBeDefined();
    await clock.advanceBy(1000); // reaches expires_at exactly: expired
    expect(await store.getIdempotent('turn1:call1')).toBeUndefined();
    expect(await store.getIdempotent('forever')).toBeNull();
    // overwrite extends the lifetime
    await store.putIdempotent('turn1:call1', 'again', '2026-10-07T07:00:00.000Z');
    expect(await store.getIdempotent('turn1:call1')).toBe('again');
  });

  it('stores kv values', async () => {
    const { store } = await open();
    expect(await store.getKv('a')).toBeUndefined();
    await store.setKv('a', '1');
    await store.setKv('a', '2');
    await store.setKv('b', '');
    expect(await store.getKv('a')).toBe('2');
    expect(await store.getKv('b')).toBe('');
  });
});
