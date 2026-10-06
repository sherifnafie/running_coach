import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { athletePaths } from '@opencoach/protocol';
import { dumpDb, schemaSql, snapshotDb } from '../src';
import { clockAt, makeCoachDb, tmpDir, write } from './helpers';

async function setup() {
  const dataDir = await tmpDir('db-');
  const paths = athletePaths(dataDir, 'ath_db');
  await fsp.mkdir(paths.snapshots, { recursive: true });
  const dbFile = await makeCoachDb(paths.workspace);
  return { paths, dbFile, ws: paths.workspace, clock: clockAt('2026-10-07T08:00:00.000Z') };
}

function exec(file: string, sql: string, ...params: Array<string | number>): void {
  const db = new DatabaseSync(file);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe('snapshotDb', () => {
  it('returns null when there is no database', async () => {
    const dataDir = await tmpDir('db-');
    expect(await snapshotDb(athletePaths(dataDir, 'ath_none'), clockAt())).toBeNull();
  });

  it('snapshots once, skips when unchanged, snapshots again after a change', async () => {
    const { paths, dbFile, clock } = await setup();
    exec(dbFile, "INSERT INTO notes (body) VALUES ('one')");
    const first = await snapshotDb(paths, clock);
    expect(first).toBe(path.join(paths.snapshots, 'coach-20261007T080000.000Z.db'));
    expect(await snapshotDb(paths, clock)).toBeNull();

    clock.advanceBy(5 * 60_000);
    exec(dbFile, "INSERT INTO notes (body) VALUES ('two')");
    const second = await snapshotDb(paths, clock);
    expect(second).toBe(path.join(paths.snapshots, 'coach-20261007T080500.000Z.db'));

    const snap = new DatabaseSync(first!, { readOnly: true });
    try {
      expect((snap.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(1);
    } finally {
      snap.close();
    }
    const snap2 = new DatabaseSync(second!, { readOnly: true });
    try {
      expect((snap2.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(2);
    } finally {
      snap2.close();
    }
    expect((await fsp.readdir(paths.snapshots)).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('notices changes that only reached the -wal file, and includes them in the backup', async () => {
    const { paths, dbFile, clock } = await setup();
    const live = new DatabaseSync(dbFile);
    try {
      live.exec('PRAGMA journal_mode = WAL');
      live.exec("INSERT INTO notes (body) VALUES ('a')");
      const first = await snapshotDb(paths, clock);
      expect(first).not.toBeNull();
      expect(await snapshotDb(paths, clock)).toBeNull();
      clock.advanceBy(1000);
      live.exec("INSERT INTO notes (body) VALUES ('b')"); // stays in the WAL (connection is open)
      const second = await snapshotDb(paths, clock);
      expect(second).not.toBeNull();
      const snap = new DatabaseSync(second!, { readOnly: true });
      try {
        expect((snap.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(2);
      } finally {
        snap.close();
      }
    } finally {
      live.close();
    }
  });

  it('retention: newest 50 plus the newest of each day for 90 days; other files are left alone', async () => {
    const { paths, dbFile, clock } = await setup();
    const compact = (d: Date) => d.toISOString().replace(/[-:]/g, '');
    const now = clock.now().getTime();
    const fakes: string[] = [];
    for (let i = 1; i <= 120; i++) fakes.push(`coach-${compact(new Date(now - i * 6 * 3600_000))}.db`); // 30 days, every 6 h
    for (const days of [100, 150, 400]) fakes.push(`coach-${compact(new Date(now - days * 86_400_000))}.db`);
    for (const f of fakes) await write(path.join(paths.snapshots, f), 'fake');
    await write(path.join(paths.snapshots, 'notes.txt'), 'keep me');
    exec(dbFile, "INSERT INTO notes (body) VALUES ('trigger')");

    const created = await snapshotDb(paths, clock);
    expect(created).not.toBeNull();
    const left = (await fsp.readdir(paths.snapshots)).filter((n) => /^coach-.*\.db$/.test(n)).sort().reverse();
    // the 50 newest are all kept (the new one + 49 fakes)
    const newestFifty = [created!, ...fakes.slice(0, 49).map((f) => path.join(paths.snapshots, f))].map((p) => path.basename(p));
    for (const n of newestFifty) expect(left).toContain(n);
    // every day of the last 30 still has a snapshot
    const days = new Set(left.map((n) => `${n.slice(6, 10)}-${n.slice(10, 12)}-${n.slice(12, 14)}`));
    for (let d = 0; d < 30; d++) expect(days.has(new Date(now - d * 86_400_000).toISOString().slice(0, 10))).toBe(true);
    // beyond 50 only one per day survives
    const older = left.slice(50);
    const olderDays = older.map((n) => n.slice(6, 14));
    expect(new Set(olderDays).size).toBe(olderDays.length);
    expect(left.length).toBeLessThan(50 + 31);
    expect(left.length).toBeGreaterThan(50);
    // snapshots older than 90 days and outside the newest 50 are gone
    for (const days90 of [100, 150, 400]) expect(left).not.toContain(`coach-${compact(new Date(now - days90 * 86_400_000))}.db`);
    expect(await fsp.readFile(path.join(paths.snapshots, 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('avoids name collisions within the same millisecond', async () => {
    const { paths, dbFile, clock } = await setup();
    exec(dbFile, "INSERT INTO notes (body) VALUES ('a')");
    const a = await snapshotDb(paths, clock);
    exec(dbFile, "INSERT INTO notes (body) VALUES ('b')");
    const b = await snapshotDb(paths, clock);
    expect(a).not.toBe(b);
    expect(b).toMatch(/-2\.db$/);
  });
});

describe('dumpDb / schemaSql', () => {
  async function dumpSetup() {
    const s = await setup();
    const db = new DatabaseSync(s.dbFile);
    db.exec(`
      CREATE TABLE misc (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, r REAL, i INTEGER, b BLOB, n);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='n');
      CREATE VIEW v_notes AS SELECT n FROM notes;
      CREATE TRIGGER trg AFTER INSERT ON notes BEGIN SELECT 1; END;
      INSERT INTO notes (n, body) VALUES (1, 'alpha'), (2, 'beta');
      INSERT INTO notes_fts (rowid, body) SELECT n, body FROM notes;
      INSERT INTO kv VALUES ('zebra', '1'), ('apple', '2'), ('mango', '3');
    `);
    db.prepare('INSERT INTO misc (t, r, i, b, n) VALUES (?, ?, ?, ?, ?)').run("it's \"quoted\"\nnew line; --", 5, 9007199254740993n, new Uint8Array([0, 1, 254, 255]), null);
    db.prepare('INSERT INTO misc (t, r, i, b, n) VALUES (?, ?, ?, ?, ?)').run('', 0.1 + 0.2, -42n, new Uint8Array([]), 'x');
    db.prepare('INSERT INTO misc (t, r, i) VALUES (?, ?, ?)').run('héllo 🏃', 1e21, 0n);
    db.close();
    return s;
  }

  it('writes data/dump/coach.sql with CREATE statements and INSERTs, deterministically', async () => {
    const { ws } = await dumpSetup();
    const out = await dumpDb(ws);
    expect(out).toBe(path.join(ws, 'data/dump/coach.sql'));
    const text = await fsp.readFile(out, 'utf8');
    expect(text).toMatch(/^-- OpenCoach coach\.db text dump\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n/);
    expect(text).toMatch(/COMMIT;\n$/);
    expect(text).toContain('CREATE TABLE activities');
    expect(text).toContain('CREATE VIRTUAL TABLE notes_fts');
    expect(text).toContain('CREATE INDEX activities_started');
    expect(text).toContain('CREATE VIEW v_notes');
    expect(text).toContain('CREATE TRIGGER trg');
    expect(text).toContain(`INSERT INTO "misc"("id","t","r","i","b","n") VALUES(1,'it''s "quoted"\nnew line; --',5.0,9007199254740993,X'0001feff',NULL);`);
    expect(text).toContain(`VALUES(2,'',0.30000000000000004,-42,X'','x');`);
    expect(text).toContain("'héllo 🏃',1e+21,0,NULL,NULL");
    expect(text).toContain('INSERT INTO sqlite_sequence VALUES(\'misc\',3);');
    // internals and FTS shadow tables are not dumped
    expect(text).not.toMatch(/notes_fts_(data|idx|content|docsize|config)/);
    expect(text).not.toMatch(/CREATE TABLE sqlite_/);
    // WITHOUT ROWID table rows come out in primary-key order
    expect(text.indexOf("VALUES('apple'")).toBeLessThan(text.indexOf("VALUES('mango'"));
    expect(text.indexOf("VALUES('mango'")).toBeLessThan(text.indexOf("VALUES('zebra'"));
    // virtual table content is not dumped (derived)
    expect(text).not.toMatch(/INSERT INTO "notes_fts"/);
    // deterministic
    expect(await fsp.readFile(await dumpDb(ws), 'utf8')).toBe(text);
  });

  it('the dump restores an equivalent database', async () => {
    const { ws, dbFile } = await dumpSetup();
    const text = await fsp.readFile(await dumpDb(ws), 'utf8');
    const restored = new DatabaseSync(':memory:');
    restored.exec(text);
    const orig = new DatabaseSync(dbFile, { readOnly: true });
    try {
      for (const table of ['activities', 'planned_workouts', 'notes', 'kv', 'misc', 'metrics']) {
        const order = table === 'kv' ? 'k' : 'rowid';
        const sel = table === 'misc' ? 'SELECT id, t, r, i, hex(b) AS b, n, typeof(r) AS tr, typeof(i) AS ti FROM misc ORDER BY id' : `SELECT * FROM ${table} ORDER BY ${order}`;
        const s1 = orig.prepare(sel);
        const s2 = restored.prepare(sel);
        s1.setReadBigInts(true);
        s2.setReadBigInts(true);
        expect(s2.all()).toEqual(s1.all());
      }
      const names = (db: DatabaseSync) => (db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts_%' ORDER BY type, name").all() as unknown[]);
      expect(names(restored)).toEqual(names(orig));
      expect(restored.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'misc'").get()).toEqual({ seq: 3 });
    } finally {
      orig.close();
      restored.close();
    }
  });

  it('schemaSql returns just CREATE statements (no rows, no internals) that build an empty equivalent schema', async () => {
    const { ws } = await dumpSetup();
    const sql = await schemaSql(ws);
    expect(sql).not.toMatch(/INSERT INTO/);
    expect(sql).not.toMatch(/sqlite_sequence|notes_fts_data/);
    expect(sql.trim().split(/;\s*\n\n/).every((s) => /^CREATE /i.test(s.trim()))).toBe(true);
    const fresh = new DatabaseSync(':memory:');
    try {
      fresh.exec(sql);
      expect((fresh.prepare('SELECT count(*) AS n FROM activities').get() as { n: number }).n).toBe(0);
      expect((fresh.prepare('SELECT count(*) AS n FROM misc').get() as { n: number }).n).toBe(0);
      expect((fresh.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('v_notes','trg','notes_fts','activities_started')").get() as { n: number }).n).toBe(4);
    } finally {
      fresh.close();
    }
  });

  it('schemaSql is empty when there is no database', async () => {
    expect(await schemaSql(await tmpDir('empty-'))).toBe('');
  });
});
