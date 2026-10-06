import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEmptyDb, readDbSchema, SqlExecutor, validateReadOnlySql } from '../src/node/sql';

let dir: string, path: string, exec: SqlExecutor;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kit-sql-'));
  path = join(dir, 'coach.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE public_data(id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE private_data(secret TEXT); CREATE VIEW private_view AS SELECT * FROM private_data; INSERT INTO public_data(value) VALUES ('hello'); INSERT INTO private_data VALUES ('private');");
  db.close();
  exec = new SqlExecutor();
});
afterEach(async () => {
  await exec.close();
  await rm(dir, { recursive: true, force: true });
});

describe('[SEC-3] preview read-only database boundary', () => {
  it('recreates a real empty schema and resolves underlying tables with bound parameters', async () => {
    const schema = readDbSchema(path);
    expect(schema?.tables.public_data).toEqual(['id', 'value']);
    const empty = join(dir, 'empty.db');
    createEmptyDb(empty, schema);
    await expect(exec.query(empty, 'SELECT * FROM public_data')).resolves.toMatchObject({ rows: [], tables: ['public_data'] });
    await expect(exec.query(path, 'SELECT value FROM public_data WHERE id = ?', [1], 2000, ['public_data'])).resolves.toMatchObject({ rows: [{ value: 'hello' }] });
  });

  it('rejects undeclared tables through views, metadata, writes, multiple statements and PRAGMAs', async () => {
    await expect(exec.query(path, 'SELECT * FROM private_view', [], 2000, ['public_data'])).rejects.toThrow('undeclared read');
    await expect(exec.query(path, 'SELECT * FROM sqlite_master')).rejects.toThrow('metadata');
    await expect(exec.query(path, "SELECT * FROM pragma_table_info('public_data')")).rejects.toThrow('virtual tables');
    for (const sql of ['DELETE FROM public_data', 'SELECT 1; SELECT 2', 'PRAGMA user_version', 'WITH x AS (SELECT 1) DELETE FROM public_data']) {
      await expect(exec.query(path, sql)).rejects.toThrow();
    }
    expect(validateReadOnlySql("SELECT '; ATTACH' AS value -- PRAGMA\n")).toBeNull();
    await expect(exec.query(path, 'SELECT count(*) AS n FROM public_data')).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });

  it('caps rows, SIGKILLs a runaway synchronous query, and recovers for subsequent requests', async () => {
    const many = 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 6000) SELECT x FROM n';
    const capped = await exec.query(path, many);
    expect(capped.rows).toHaveLength(5000);
    expect(capped.truncated).toBe(true);
    const forever = 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT max(x) FROM n';
    await expect(exec.query(path, forever, [], 50)).rejects.toThrow('timed out');
    await expect(exec.query(path, 'SELECT 42 AS answer')).resolves.toMatchObject({ rows: [{ answer: 42 }] });
  });
});
