import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '@opencoach/protocol';
import { runViewQuery } from '../src';
import { lexSql, splitStatements } from '../src/sql-lex';
import { STARTER_SQL, makeCoachDb, tmpDir } from './helpers';

const EXTRA_SQL = `
CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='n');
CREATE TABLE secrets (id INTEGER PRIMARY KEY, token TEXT);
CREATE INDEX secrets_token ON secrets(token);
CREATE VIEW v_acts AS SELECT id, title FROM activities;
CREATE VIEW v_leak AS SELECT token FROM secrets;
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
INSERT INTO activities (id, started_at, title, distance_m, laps, source, created_at, updated_at) VALUES
  ('a1', '2026-10-01T07:00:00+02:00', 'Easy run', 8000, '[{"d":1000},{"d":2000}]', 'manual', 'x', 'x'),
  ('a2', '2026-10-02T07:00:00+02:00', 'Tempo', 10000, '[{"d":5000}]', 'manual', 'x', 'x'),
  ('a3', '2026-10-03T07:00:00+02:00', 'sqlite_master talk', 5000, NULL, 'manual', 'x', 'x');
INSERT INTO planned_workouts (id, date, type, title, status, updated_at) VALUES ('p1', '2026-10-04', 'easy', 'Easy 8k', 'planned', 'x'), ('p2', '2026-10-05', 'long', 'Long 20k', 'planned', 'x');
INSERT INTO secrets (token) VALUES ('hunter2'), ('s3cret');
INSERT INTO notes (n, body) VALUES (1, 'achilles felt tight today'), (2, 'great tempo session');
INSERT INTO notes_fts (rowid, body) SELECT n, body FROM notes;
INSERT INTO kv VALUES ('k1', 'v1');
INSERT INTO metrics (date, name, value, source) VALUES ('2026-10-01', 'resting_hr', 48, 'watch');
`;

let ws: string;
const ALLOWED = ['activities', 'planned_workouts', 'notes', 'notes_fts', 'kv', 'metrics'];

const q = (sql: string, extra: { params?: unknown[]; allowed?: string[]; maxRows?: number; timeoutMs?: number } = {}) =>
  runViewQuery({ workspaceDir: ws, sql, params: extra.params, allowedTables: extra.allowed ?? ALLOWED, maxRows: extra.maxRows ?? 5000, timeoutMs: extra.timeoutMs ?? 3000 });

async function codeOf(sql: string, extra?: Parameters<typeof q>[1]): Promise<{ code: string; message: string } | 'ok'> {
  try {
    await q(sql, extra);
    return 'ok';
  } catch (e) {
    if (e instanceof ToolError) return { code: e.code, message: e.message };
    throw e;
  }
}

beforeAll(async () => {
  ws = await tmpDir('vq-');
  await makeCoachDb(ws, STARTER_SQL + EXTRA_SQL);
});

describe('runViewQuery: allowed queries', () => {
  it('runs a simple select with positional params (integers bind as INTEGER)', async () => {
    expect(await q('SELECT id, title FROM activities WHERE id = ?', { params: ['a1'] })).toEqual([{ id: 'a1', title: 'Easy run' }]);
    expect(await q('SELECT typeof(?) AS t, ? + 1 AS n', { params: [5, 41] })).toEqual([{ t: 'integer', n: 42 }]);
    expect(await q('SELECT ? AS a, ? AS b, ? AS c', { params: [true, null, 1.5] })).toEqual([{ a: 1, b: null, c: 1.5 }]);
  });

  it('allows the shapes a view realistically uses', async () => {
    const cases: Array<[string, unknown[]?]> = [
      ['SELECT date, count(*) AS n FROM planned_workouts GROUP BY date ORDER BY date'],
      ['WITH w AS (SELECT * FROM planned_workouts WHERE status = ?) SELECT count(*) AS n FROM w', ['planned']],
      ['SELECT a.id, p.title FROM activities a LEFT JOIN planned_workouts p ON p.id = a.planned_id'],
      ['SELECT * FROM activities WHERE id IN (SELECT id FROM activities WHERE distance_m > ?)', [6000]],
      ['SELECT (SELECT count(*) FROM planned_workouts) AS n, (SELECT max(distance_m) FROM activities) AS m'],
      ['SELECT j.value FROM activities a, json_each(a.laps) j WHERE a.id = ?', ['a1']],
      ["SELECT json_extract(laps, '$[0].d') AS d FROM activities WHERE laps IS NOT NULL"],
      ["SELECT id FROM activities WHERE title GLOB 'E*'"],
      ['SELECT id, sum(distance_m) OVER (ORDER BY started_at ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS roll FROM activities'],
      ["SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'achilles'"],
      ["SELECT rowid, snippet(notes_fts, 0, '[', ']', '…', 5) AS s FROM notes_fts WHERE notes_fts MATCH ?", ['tempo']],
      ['SELECT id FROM activities UNION ALL SELECT id FROM planned_workouts'],
      ["SELECT strftime('%Y-%W', started_at) AS wk, sum(distance_m) FROM activities GROUP BY wk"],
      ['SELECT k, v FROM kv WHERE k = ?', ['k1']],
      ['SELECT 1 + 1 AS two, sqlite_version() AS v'],
      ['SELECT * FROM main.activities LIMIT 1'],
      ['SELECT * FROM "activities" LIMIT 1'],
      ['SELECT * FROM `activities` LIMIT 1'],
      ['SELECT * FROM [activities] LIMIT 1'],
      ['SELECT * FROM ACTIVITIES LIMIT 1'],
      ['  /* leading comment */ select * from activities limit 1 ; -- trailing'],
      ["SELECT 'a;b' AS s, 'DROP TABLE x' AS t -- DELETE FROM activities;"],
      ["SELECT * FROM activities WHERE title LIKE '%pragma%'"],
      ['WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT sum(x) AS s FROM c'],
    ];
    const results = await Promise.all(cases.map(([sql, params]) => codeOf(sql, { params })));
    results.forEach((r, i) => expect(r, cases[i]![0]).toBe('ok'));
  });

  it('accepts db:-prefixed and differently-cased allowed names', async () => {
    expect(await q('SELECT count(*) AS n FROM Activities', { allowed: ['db:ACTIVITIES'] })).toEqual([{ n: 3 }]);
  });

  it('converts BigInt to number and BLOB to base64, keeps null/real/text', async () => {
    const rows = await q("SELECT 9007199254740993 AS big, 12 AS small, x'00ff10' AS b, NULL AS nul, 2.5 AS r, 'é' AS t");
    expect(rows).toEqual([{ big: 9007199254740992, small: 12, b: Buffer.from([0, 255, 16]).toString('base64'), nul: null, r: 2.5, t: 'é' }]);
  });

  it('caps rows, including for endless queries', async () => {
    expect(await q('SELECT * FROM planned_workouts', { maxRows: 1 })).toHaveLength(1);
    const endless = await q('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c', { maxRows: 7 });
    expect(endless.map((r) => r['x'])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps ORDER BY of the inner query', async () => {
    expect((await q('SELECT id FROM activities ORDER BY distance_m DESC')).map((r) => r['id'])).toEqual(['a2', 'a1', 'a3']);
  });

  it('a trailing line comment does not swallow the row-cap wrapper', async () => {
    expect(await q('SELECT 1 AS x -- comment')).toEqual([{ x: 1 }]);
  });

  it('handles duplicate result column names', async () => {
    const rows = await q('SELECT a.id, p.id FROM activities a, planned_workouts p LIMIT 1');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).length).toBeGreaterThanOrEqual(1);
  });
});

describe('runViewQuery: denied by table access (NOT_ALLOWED)', () => {
  const deny: Array<[string, string]> = [
    ['undeclared table', 'SELECT * FROM secrets'],
    ['undeclared table, covering index', "SELECT token FROM secrets WHERE token = 'hunter2'"],
    ['count on undeclared table', 'SELECT count(*) FROM secrets'],
    ['rowid of undeclared table', 'SELECT rowid FROM secrets'],
    ['join to undeclared table', 'SELECT a.id, s.token FROM activities a JOIN secrets s ON 1'],
    ['comma join to undeclared table', 'SELECT * FROM activities, secrets'],
    ['subquery in WHERE', 'SELECT * FROM activities WHERE id IN (SELECT token FROM secrets)'],
    ['scalar subquery in select list', 'SELECT (SELECT token FROM secrets LIMIT 1) AS t'],
    ['subquery in FROM', 'SELECT * FROM (SELECT token FROM secrets) s'],
    ['EXISTS subquery', 'SELECT 1 WHERE EXISTS (SELECT 1 FROM secrets)'],
    ['CTE over undeclared table', 'WITH x AS (SELECT * FROM secrets) SELECT * FROM x'],
    ['recursive CTE touching undeclared table', 'WITH RECURSIVE c(t) AS (SELECT token FROM secrets UNION ALL SELECT t FROM c WHERE 0) SELECT * FROM c'],
    ['compound select', 'SELECT id FROM activities UNION SELECT token FROM secrets'],
    ['table named by schema', 'SELECT * FROM main.secrets'],
    ['other schema', 'SELECT * FROM temp.activities'],
    ['attached schema name', 'SELECT * FROM other.activities'],
    ['bracket-quoted (parser cannot parse)', 'SELECT * FROM [secrets]'],
    ['GLOB (parser cannot parse)', "SELECT * FROM secrets WHERE token GLOB 'h*'"],
    ['window function (parser cannot parse)', 'SELECT sum(id) OVER (ORDER BY id) FROM secrets'],
    ['NATURAL JOIN (parser cannot parse)', 'SELECT * FROM activities NATURAL JOIN secrets'],
    ['INDEXED BY (parser cannot parse)', 'SELECT * FROM secrets INDEXED BY secrets_token WHERE token = 1'],
    ['view over an undeclared table', 'SELECT * FROM v_leak'],
    ['sqlite_master', 'SELECT * FROM sqlite_master'],
    ['sqlite_schema', 'SELECT name FROM sqlite_schema'],
    ['sqlite_master quoted', 'SELECT * FROM "sqlite_master"'],
    ['sqlite_master bracketed', 'SELECT * FROM [sqlite_master]'],
    ['sqlite_master single-quoted', "SELECT * FROM 'sqlite_master'"],
    ['sqlite_master schema-qualified', 'SELECT * FROM main.sqlite_master'],
    ['sqlite_temp_master', 'SELECT * FROM sqlite_temp_master'],
    ['sqlite_sequence', 'SELECT * FROM sqlite_sequence'],
    ['mixed case internals', 'SELECT * FROM SQLITE_MASTER'],
    ['pragma table-valued function', "SELECT * FROM pragma_table_info('secrets')"],
    ['pragma function list', 'SELECT * FROM pragma_function_list'],
    ['dbstat virtual table', 'SELECT * FROM dbstat'],
    ['load_extension', "SELECT load_extension('/tmp/x.so')"],
    ['fts3_tokenizer', "SELECT fts3_tokenizer('x')"],
  ];

  it.each(deny)('%s', async (_name, sql) => {
    const r = await codeOf(sql);
    expect(r).not.toBe('ok');
    if (r !== 'ok') expect(['NOT_ALLOWED', 'INVALID_INPUT']).toContain(r.code);
    // everything in this table except unknown-schema errors must be a policy rejection
    if (r !== 'ok' && !/other\.activities|temp\.activities/.test(sql)) expect(r.code).toBe('NOT_ALLOWED');
  });

  it('a declared view still needs its base tables declared', async () => {
    expect(await codeOf('SELECT * FROM v_acts', { allowed: ['v_acts'] })).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(await codeOf('SELECT * FROM v_acts', { allowed: ['v_acts', 'activities'] })).toBe('ok');
  });

  it('declaring only a view does not make its base table readable directly', async () => {
    expect(await codeOf('SELECT * FROM secrets', { allowed: ['v_leak'] })).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('declared virtual tables work; an undeclared one stays blocked even next to a declared one', async () => {
    expect(await codeOf("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'tempo'", { allowed: ['notes_fts'] })).toBe('ok');
    expect(await codeOf("SELECT * FROM notes_fts WHERE notes_fts MATCH 'tempo'", { allowed: ['notes'] })).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(await codeOf('SELECT * FROM pragma_table_info(?)', { allowed: ['notes', 'notes_fts'], params: ['secrets'] })).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('empty allow-list only permits table-less queries', async () => {
    expect(await q('SELECT 1 AS x', { allowed: [] })).toEqual([{ x: 1 }]);
    expect(await codeOf('SELECT * FROM activities', { allowed: [] })).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('the EXPLAIN layer alone catches what the parser cannot parse', async () => {
    const r = await codeOf("SELECT * FROM secrets WHERE token GLOB 'h*'");
    expect(r).toMatchObject({ code: 'NOT_ALLOWED' });
    if (r !== 'ok') expect(r.message).toMatch(/secrets/);
  });

  it('does not leak the secrets in error messages', async () => {
    const r = await codeOf('SELECT token FROM secrets');
    if (r !== 'ok') expect(JSON.stringify(r)).not.toMatch(/hunter2|s3cret/);
  });
});

describe('runViewQuery: denied by statement type (NOT_ALLOWED)', () => {
  const deny: string[] = [
    'PRAGMA table_info(activities)',
    'PRAGMA journal_mode = DELETE',
    'pragma writable_schema = 1',
    "ATTACH DATABASE '/tmp/evil.db' AS evil",
    'DETACH DATABASE main',
    'VACUUM',
    "VACUUM INTO '/tmp/copy.db'",
    "INSERT INTO activities (id, started_at, source, created_at, updated_at) VALUES ('z', 'x', 'x', 'x', 'x')",
    "UPDATE activities SET title = 'pwned'",
    'DELETE FROM activities',
    'REPLACE INTO kv VALUES (1, 2)',
    'INSERT OR REPLACE INTO kv VALUES (1, 2)',
    'DROP TABLE activities',
    'CREATE TABLE evil (x)',
    'CREATE TEMP TABLE evil AS SELECT * FROM activities',
    'ALTER TABLE activities ADD COLUMN evil TEXT',
    'REINDEX',
    'ANALYZE',
    'BEGIN',
    'COMMIT',
    'SAVEPOINT s',
    'EXPLAIN SELECT 1',
    'EXPLAIN QUERY PLAN SELECT * FROM activities',
    'VALUES (1), (2)',
    "WITH x AS (SELECT 1) DELETE FROM activities",
    "WITH x AS (SELECT 1) INSERT INTO kv VALUES ('a', 'b')",
    "WITH x AS (SELECT 1 AS v) UPDATE kv SET v = (SELECT v FROM x)",
    "/* sneaky */ DELETE FROM activities",
    '-- comment\nDROP TABLE activities',
    'select 1; select 2',
    'SELECT 1; DROP TABLE activities',
    'SELECT 1;;; DELETE FROM activities',
    "SELECT 1; /* ; */ PRAGMA writable_schema = 1; --",
    'SELECT * FROM activities; SELECT * FROM activities',
    "SELECT 'x'; DELETE FROM activities",
  ];

  it('rejects every one of them', async () => {
    const results = await Promise.all(deny.map((sql) => codeOf(sql)));
    results.forEach((r, i) => {
      expect(r, deny[i]).not.toBe('ok');
      if (r !== 'ok') expect(r.code, deny[i]).toBe('NOT_ALLOWED');
    });
  });

  it('left the database untouched', async () => {
    const db = new DatabaseSync(path.join(ws, 'data/coach.db'), { readOnly: true });
    try {
      expect((db.prepare('SELECT count(*) AS n FROM activities').get() as { n: number }).n).toBe(3);
      expect((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('evil')").get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT count(*) AS n FROM kv').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
    await expect(fsp.stat('/tmp/evil.db')).rejects.toThrow();
    await expect(fsp.stat('/tmp/copy.db')).rejects.toThrow();
  });

  it('semicolons inside strings, quoted identifiers and comments are not statement breaks', async () => {
    expect(await q("SELECT 'a;b' AS \"x;y\" /* ; */")).toEqual([{ 'x;y': 'a;b' }]);
  });
});

describe('runViewQuery: other errors', () => {
  it('INVALID_INPUT for syntax errors, bad columns, bad params, empty input', async () => {
    expect(await codeOf('SELECT FROM')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT nope FROM activities')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf("SELECT 'unterminated")).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT "unterminated')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('   \n\t ')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('-- only a comment')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf(';')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT 1', { params: [1] })).toMatchObject({ code: 'INVALID_INPUT' }); // too many params
    expect(await codeOf('SELECT ?', { params: [{ a: 1 }] })).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT ?', { params: [Number.NaN] })).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT 1\u0000')).toMatchObject({ code: 'INVALID_INPUT' });
    // unbalanced parentheses could escape the row-cap wrapper
    expect(await codeOf('SELECT 1) UNION ALL SELECT token FROM secrets WHERE 1 OR (1')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT (1')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT 1) --')).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await codeOf('SELECT 1 ' + 'x'.repeat(100_001))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('NOT_FOUND when there is no coach.db', async () => {
    const empty = await tmpDir('vq-empty-');
    await expect(runViewQuery({ workspaceDir: empty, sql: 'SELECT 1', allowedTables: [], maxRows: 10, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('works while another connection writes (WAL)', async () => {
    const db = new DatabaseSync(path.join(ws, 'data/coach.db'));
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('BEGIN');
      db.exec("INSERT INTO metrics (date, name, value, source) VALUES ('2026-10-09', 'hrv', 61, 'watch')");
      const rows = await q("SELECT count(*) AS n FROM metrics WHERE name = 'hrv'");
      expect(rows).toEqual([{ n: 0 }]); // uncommitted writes are not visible
      db.exec('COMMIT');
      expect(await q("SELECT count(*) AS n FROM metrics WHERE name = 'hrv'")).toEqual([{ n: 1 }]);
      db.exec("DELETE FROM metrics WHERE name = 'hrv'");
    } finally {
      db.close();
    }
  });
});

describe('runViewQuery: timeout', () => {
  it('kills a runaway recursive CTE and reports TIMEOUT promptly', async () => {
    const t0 = performance.now();
    const r = await codeOf('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000000) SELECT count(*) FROM c', { timeoutMs: 400 });
    const elapsed = performance.now() - t0;
    expect(r).toMatchObject({ code: 'TIMEOUT' });
    expect(elapsed).toBeLessThan(5000);
  });

  it('the host stays usable afterwards (the child was really killed)', async () => {
    await codeOf('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000000) SELECT count(*) FROM c', { timeoutMs: 200 });
    expect(await q('SELECT count(*) AS n FROM activities')).toEqual([{ n: 3 }]);
  });

  it('a cartesian-product explosion is also stopped', async () => {
    const r = await codeOf('SELECT count(*) FROM planned_workouts a, planned_workouts b, planned_workouts c, (WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x < 100000000) SELECT x FROM r) d', { timeoutMs: 300 });
    expect(r).toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('sql-lex', () => {
  it('splits on top-level semicolons only', () => {
    const split = (s: string) => splitStatements(lexSql(s)).map((t) => s.slice(t[0]!.start, t[t.length - 1]!.end));
    expect(split("SELECT 'a;b'; SELECT \"c;d\"; SELECT [e;f]; SELECT `g;h` -- ; x\n; /* ; */ SELECT 1")).toEqual(["SELECT 'a;b'", 'SELECT "c;d"', 'SELECT [e;f]', 'SELECT `g;h`', 'SELECT 1']);
    expect(split("SELECT 'it''s;'")).toEqual(["SELECT 'it''s;'"]);
    expect(split('')).toEqual([]);
    expect(split(' ; ; ')).toEqual([]);
  });

  it('rejects unterminated quotes', () => {
    expect(() => lexSql("SELECT 'x")).toThrow(/unterminated/);
    expect(() => lexSql('SELECT [x')).toThrow(/unterminated/);
  });
});
