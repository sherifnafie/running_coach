import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolError, ViewManifest } from '@opencoach/protocol';
import { applyViewWrite } from '../src';
import { makeCoachDb, tmpDir, write } from './helpers';

const manifest = ViewManifest.parse({
  id: 'today',
  title: 'Today',
  reads: ['db:planned_workouts'],
  writes: [
    { db: 'planned_workouts', ops: ['update'], columns: ['status', 'date'] },
    { db: 'checkins', ops: ['insert'] },
    { db: 'notes', ops: ['insert', 'update', 'delete'] },
    { db: 'metrics', ops: ['insert', 'delete'], columns: ['date', 'name', 'value', 'source'] },
    { file: 'athlete-input/log.md', ops: ['write'] },
    { file: 'athlete-input/notes/*.md', ops: ['write'] },
  ],
});

let ws: string;
const call = (target: string, op: 'insert' | 'update' | 'delete', row: Record<string, unknown>, key?: Record<string, unknown>, m: ViewManifest = manifest) => applyViewWrite({ workspaceDir: ws, manifest: m, write: { target, op, row, key } });

async function rejects(p: Promise<unknown>, code: string, msg?: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    expect((e as ToolError).code).toBe(code);
    if (msg) expect((e as ToolError).message).toMatch(msg);
    return;
  }
  throw new Error(`expected ToolError ${code}, but the call succeeded`);
}

function rows<T = Record<string, unknown>>(sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(path.join(ws, 'data/coach.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  ws = await tmpDir('vw-');
  await makeCoachDb(ws);
  const db = new DatabaseSync(path.join(ws, 'data/coach.db'));
  db.exec(`INSERT INTO planned_workouts (id, date, type, title, status, updated_at) VALUES
    ('pw_1', '2026-10-08', 'easy', 'Easy 8k', 'planned', 'x'), ('pw_2', '2026-10-09', 'easy', 'Easy 6k', 'planned', 'x'), ('pw_3', '2026-10-10', 'long', 'Long', 'planned', 'x');
    INSERT INTO notes (n, body) VALUES (1, 'first');`);
  db.close();
});

describe('applyViewWrite: db', () => {
  it('updates a declared column by key and describes it', async () => {
    const r = await call('planned_workouts', 'update', { status: 'done' }, { id: 'pw_1' });
    expect(r.description).toBe('update planned_workouts set status=done where id=pw_1');
    expect(rows("SELECT status FROM planned_workouts WHERE id = 'pw_1'")).toEqual([{ status: 'done' }]);
    expect(rows("SELECT status FROM planned_workouts WHERE id = 'pw_2'")).toEqual([{ status: 'planned' }]);
  });

  it('accepts db:-prefixed and case-differing targets', async () => {
    await call('db:planned_workouts', 'update', { status: 'skipped' }, { id: 'pw_1' });
    await call('PLANNED_WORKOUTS', 'update', { Status: 'moved' }, { ID: 'pw_2' });
    expect(rows('SELECT id, status FROM planned_workouts ORDER BY id')).toEqual([
      { id: 'pw_1', status: 'skipped' },
      { id: 'pw_2', status: 'moved' },
      { id: 'pw_3', status: 'planned' },
    ]);
  });

  it('binds integral numbers as INTEGER (not "5.0") and objects as JSON text', async () => {
    await call('checkins', 'insert', { id: 'c1', at: '2026-10-07T08:00:00Z', kind: 'sleep', value: { score: 3 }, source: 'view' });
    expect(rows("SELECT value, typeof(value) AS t FROM checkins WHERE id = 'c1'")).toEqual([{ value: '{"score":3}', t: 'text' }]);
    await call('checkins', 'insert', { id: 'c2', at: 'x', kind: 'note', value: 5, source: 'view' });
    expect(rows("SELECT typeof(at) AS a, value FROM checkins WHERE id = 'c2'")).toEqual([{ a: 'text', value: 5 }]);
    await call('notes', 'insert', { n: 7, body: 5 });
    expect(rows('SELECT body, typeof(body) AS t FROM notes WHERE n = 7')).toEqual([{ body: '5', t: 'text' }]);
  });

  it('inserts, lets INTEGER PRIMARY KEY auto-assign, and requires explicit keys otherwise', async () => {
    const r = await call('notes', 'insert', { body: 'second' });
    expect(r.description).toBe('insert into notes set body=second');
    expect(rows('SELECT n, body FROM notes ORDER BY n')).toEqual([
      { n: 1, body: 'first' },
      { n: 2, body: 'second' },
    ]);
    await rejects(call('checkins', 'insert', { at: 'x', kind: 'note', value: '{}', source: 'view' }), 'INVALID_INPUT', /primary key.*id/);
    await rejects(call('checkins', 'insert', { id: null, at: 'x', kind: 'note', value: '{}', source: 'view' }), 'INVALID_INPUT', /primary key/);
    expect(rows('SELECT count(*) AS n FROM checkins')).toEqual([{ n: 0 }]);
  });

  it('deletes by key and describes it', async () => {
    const r = await call('notes', 'delete', {}, { n: 1 });
    expect(r.description).toBe('delete from notes where n=1');
    expect(rows('SELECT count(*) AS n FROM notes')).toEqual([{ n: 0 }]);
  });

  it('supports composite keys and null key values', async () => {
    await call('metrics', 'insert', { date: '2026-10-07', name: 'hrv', value: 61, source: 'view' });
    await call('metrics', 'delete', {}, { date: '2026-10-07', name: 'hrv', source: 'view' });
    expect(rows('SELECT count(*) AS n FROM metrics')).toEqual([{ n: 0 }]);
    await call('planned_workouts', 'update', { status: 'done' }, { id: 'pw_3', slot: null });
    expect(rows("SELECT status FROM planned_workouts WHERE id = 'pw_3'")).toEqual([{ status: 'done' }]);
  });

  it('enforces declared tables, ops and columns (NOT_ALLOWED)', async () => {
    await rejects(call('activities', 'insert', { id: 'a' }), 'NOT_ALLOWED', /does not declare writes/);
    await rejects(call('planned_workouts', 'insert', { id: 'pw_9', date: 'x', type: 't', title: 't', updated_at: 'x' }), 'NOT_ALLOWED', /may not insert/);
    await rejects(call('planned_workouts', 'delete', {}, { id: 'pw_1' }), 'NOT_ALLOWED', /may not delete/);
    await rejects(call('planned_workouts', 'update', { title: 'hijacked' }, { id: 'pw_1' }), 'NOT_ALLOWED', /column "title".*not declared/);
    await rejects(call('planned_workouts', 'update', { status: 'done', coach_notes: 'x' }, { id: 'pw_1' }), 'NOT_ALLOWED');
    expect(rows("SELECT title, status FROM planned_workouts WHERE id = 'pw_1'")).toEqual([{ title: 'Easy 8k', status: 'planned' }]);
    await rejects(call('_migrations', 'insert', { name: 'x' }), 'NOT_ALLOWED');
    await rejects(call('sqlite_master', 'delete', {}, { name: 'x' }), 'NOT_ALLOWED');
  });

  it('rejects unknown columns, missing/empty keys, missing rows and ambiguous keys', async () => {
    await rejects(call('notes', 'insert', { nope: 1 }), 'INVALID_INPUT', /not a writable column/);
    await rejects(call('notes', 'update', { body: 'x' }), 'INVALID_INPUT', /requires a non-empty key/);
    await rejects(call('notes', 'update', { body: 'x' }, {}), 'INVALID_INPUT', /requires a non-empty key/);
    await rejects(call('notes', 'update', { body: 'x' }, { nope: 1 }), 'INVALID_INPUT', /key column/);
    await rejects(call('notes', 'update', {}, { n: 1 }), 'INVALID_INPUT', /at least one column/);
    await rejects(call('notes', 'update', { body: 'x' }, { n: 999 }), 'NOT_FOUND');
    await rejects(call('notes', 'delete', {}, { n: 999 }), 'NOT_FOUND');
    // key matches two rows: refused and rolled back
    await rejects(call('planned_workouts', 'update', { status: 'done' }, { type: 'easy' }), 'INVALID_INPUT', /matches 2 rows/);
    expect(rows("SELECT count(*) AS n FROM planned_workouts WHERE status = 'done'")).toEqual([{ n: 0 }]);
  });

  it('reports constraint violations as INVALID_INPUT', async () => {
    await rejects(call('notes', 'insert', { n: 1, body: 'dup' }), 'INVALID_INPUT', /UNIQUE|constraint/i);
    const bad = ViewManifest.parse({ id: 'v', title: 'V', writes: [{ db: 'planned_workouts', ops: ['update'] }] });
    await rejects(call('planned_workouts', 'update', { title: null }, { id: 'pw_1' }, bad), 'INVALID_INPUT', /NOT NULL/);
  });

  it('is immune to SQL injection through identifiers and values', async () => {
    const open = ViewManifest.parse({ id: 'v', title: 'V', writes: [{ db: 'notes', ops: ['insert', 'update'] }] });
    await rejects(call('notes', 'insert', { 'body") VALUES (1); DROP TABLE notes; --': 'x' }, undefined, open), 'INVALID_INPUT');
    await rejects(call('notes', 'update', { body: 'x' }, { '1=1 OR n': 1 }, open), 'INVALID_INPUT');
    await rejects(call('notes; DROP TABLE notes', 'insert', { body: 'x' }, undefined, open), 'NOT_ALLOWED');
    await call('notes', 'insert', { body: "x'); DROP TABLE notes; --" }, undefined, open);
    expect(rows('SELECT body FROM notes ORDER BY n DESC LIMIT 1')).toEqual([{ body: "x'); DROP TABLE notes; --" }]);
    expect(rows('SELECT count(*) AS n FROM notes')).toEqual([{ n: 2 }]);
    // a declared-column restriction hides schema details: unknown columns are policy errors
    await rejects(call('metrics', 'insert', { 'secret_col': 1 }), 'NOT_ALLOWED');
  });

  it('validates the write object', async () => {
    await rejects(applyViewWrite({ workspaceDir: ws, manifest, write: { target: 'notes', op: 'upsert' as never, row: {} } }), 'INVALID_INPUT', /unknown write op/);
    await rejects(applyViewWrite({ workspaceDir: ws, manifest, write: { target: 'notes', op: 'insert', row: [] as never } }), 'INVALID_INPUT', /row must be an object/);
    await rejects(applyViewWrite({ workspaceDir: ws, manifest, write: { target: 'notes', op: 'update', row: { body: 'x' }, key: 'n=1' as never } }), 'INVALID_INPUT', /key must be an object/);
    await rejects(applyViewWrite({ workspaceDir: ws, manifest, write: { target: '', op: 'insert', row: {} } }), 'INVALID_INPUT');
    await rejects(applyViewWrite({ workspaceDir: await tmpDir('no-db-'), manifest, write: { target: 'notes', op: 'insert', row: { body: 'x' } } }), 'NOT_FOUND');
    await rejects(call('notes', 'insert', { body: 'x' }, undefined, ViewManifest.parse({ id: 'v', title: 'V', writes: [{ db: 'missing_table', ops: ['insert'] }] })), 'NOT_ALLOWED');
    await rejects(call('missing_table', 'insert', { x: 1 }, undefined, ViewManifest.parse({ id: 'v', title: 'V', writes: [{ db: 'missing_table', ops: ['insert'] }] })), 'INVALID_INPUT', /does not exist/);
  });
});

describe('applyViewWrite: files', () => {
  it('writes a declared file atomically (creating directories)', async () => {
    const r = await call('athlete-input/log.md', 'insert', { content: '# Log\nran 5k\n' });
    expect(r.description).toBe('write athlete-input/log.md (13 bytes)');
    expect(await fsp.readFile(path.join(ws, 'athlete-input/log.md'), 'utf8')).toBe('# Log\nran 5k\n');
    await call('file:athlete-input/log.md', 'update', { content: 'replaced' });
    expect(await fsp.readFile(path.join(ws, 'athlete-input/log.md'), 'utf8')).toBe('replaced');
    await call('athlete-input/notes/2026-10-07.md', 'insert', { content: 'glob match' });
    expect(await fsp.readFile(path.join(ws, 'athlete-input/notes/2026-10-07.md'), 'utf8')).toBe('glob match');
    expect((await fsp.readdir(path.join(ws, 'athlete-input'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects undeclared paths, traversal, absolute paths and non-athlete-input paths', async () => {
    await rejects(call('athlete-input/other.md', 'insert', { content: 'x' }), 'NOT_ALLOWED', /does not declare/);
    await rejects(call('athlete-input/notes/sub/deep.md', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('athlete-input/../AGENTS.md', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('athlete-input/notes/../../AGENTS.md', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('/etc/passwd', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('athlete-input\\log.md', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('AGENTS.md', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('athlete-input/', 'insert', { content: 'x' }), 'NOT_ALLOWED');
    await rejects(call('athlete-input/log.md\u0000.png', 'insert', { content: 'x' }), 'INVALID_INPUT');
  });

  it('validates content, op and size', async () => {
    await rejects(call('athlete-input/log.md', 'insert', {}), 'INVALID_INPUT', /row\.content/);
    await rejects(call('athlete-input/log.md', 'insert', { content: 42 }), 'INVALID_INPUT', /row\.content/);
    await rejects(call('athlete-input/log.md', 'delete', {}, { x: 1 }), 'NOT_ALLOWED', /cannot be deleted/);
    await rejects(call('athlete-input/log.md', 'insert', { content: 'x'.repeat(2 * 1024 * 1024 + 1) }), 'INVALID_INPUT', /too large/);
  });

  it('refuses to write through a symlinked athlete-input directory', async () => {
    const outside = await tmpDir('outside-');
    await fsp.symlink(outside, path.join(ws, 'athlete-input'));
    await rejects(call('athlete-input/log.md', 'insert', { content: 'pwned' }), 'NOT_ALLOWED', /outside/);
    await expect(fsp.stat(path.join(outside, 'log.md'))).rejects.toThrow();
  });

  it('refuses to write through a symlinked file or subdirectory leading out', async () => {
    const outside = await tmpDir('outside-');
    await fsp.mkdir(path.join(ws, 'athlete-input/notes'), { recursive: true });
    await write(path.join(outside, 'victim.md'), 'precious');
    await fsp.symlink(path.join(outside, 'victim.md'), path.join(ws, 'athlete-input/notes/link.md'));
    await rejects(call('athlete-input/notes/link.md', 'insert', { content: 'pwned' }), 'NOT_ALLOWED', /outside/);
    expect(await fsp.readFile(path.join(outside, 'victim.md'), 'utf8')).toBe('precious');
  });

  it('does not let a directory be overwritten', async () => {
    await fsp.mkdir(path.join(ws, 'athlete-input/log.md'), { recursive: true });
    await rejects(call('athlete-input/log.md', 'insert', { content: 'x' }), 'INVALID_INPUT', /directory/);
  });
});
