/**
 * Direct writes from views (SPEC [UI-1], Appendix C §C.4): validated against the view manifest's
 * `writes`, then applied without an LLM turn.
 *
 *  - db targets: parameterised INSERT / UPDATE / DELETE on a declared table, limited to the declared
 *    columns (when the manifest lists any) and to columns that really exist. update/delete need a
 *    `key` that must match exactly one row. INSERT generates no ids: the row must carry the primary
 *    key unless it is an INTEGER PRIMARY KEY (rowid alias) or has a column default.
 *  - file targets: `{ file: "athlete-input/…", ops: ["write"] }`; `row.content` (string) is written
 *    atomically. The bridge's op for such a write is "insert" or "update" (or "write"); "delete" is refused.
 *
 * Throws ToolError: NOT_ALLOWED (not declared), INVALID_INPUT (bad row/key/constraint), NOT_FOUND
 * (update/delete matched no row).
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import picomatch from 'picomatch';
import { ToolError, type ViewManifest } from '@opencoach/protocol';
import { coachDbPath } from './db';
import { atomicWriteFile, isWithin, realpathLenient } from './fsutil';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type SqlValue = null | bigint | number | string | Uint8Array;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function bindValue(v: unknown, what: string): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ToolError('INVALID_INPUT', `${what} is not a finite number`);
    return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? BigInt(v) : v; // integral numbers bind as INTEGER, not REAL
  }
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v); // JSON columns
  throw new ToolError('INVALID_INPUT', `${what} has an unsupported type (${typeof v})`);
}

function fmtVal(v: unknown): string {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

type Target = { kind: 'db'; table: string } | { kind: 'file'; path: string };

function parseTarget(raw: string): Target {
  if (typeof raw !== 'string' || raw.length === 0) throw new ToolError('INVALID_INPUT', 'write target must be a non-empty string');
  if (/^db:/i.test(raw)) return { kind: 'db', table: raw.slice(3) };
  if (/^file:/i.test(raw)) return { kind: 'file', path: raw.slice(5) };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return { kind: 'db', table: raw };
  return { kind: 'file', path: raw };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden: number;
}

function sqliteToToolError(e: unknown): never {
  if (e instanceof ToolError) throw e;
  const err = e as { code?: string; errcode?: number; message?: string };
  if (err?.code === 'ERR_SQLITE_ERROR') {
    if (err.errcode === 5 || err.errcode === 6) throw new ToolError('INTERNAL', 'coach.db is busy; try again in a moment', true);
    throw new ToolError('INVALID_INPUT', String(err.message ?? e));
  }
  throw e;
}

async function applyDbWrite(workspaceDir: string, manifest: ViewManifest, op: 'insert' | 'update' | 'delete', table: string, row: Record<string, unknown>, key: Record<string, unknown> | undefined): Promise<string> {
  const lower = table.toLowerCase();
  if (lower.startsWith('sqlite_') || lower === '_migrations') throw new ToolError('NOT_ALLOWED', `table "${table}" is internal and cannot be written`);
  const entries = manifest.writes.filter((w): w is Extract<typeof w, { db: string }> => 'db' in w && w.db.toLowerCase() === lower);
  if (entries.length === 0) throw new ToolError('NOT_ALLOWED', `view "${manifest.id}" does not declare writes to table "${table}"`);
  const withOp = entries.filter((w) => (w.ops as string[]).includes(op));
  if (withOp.length === 0) throw new ToolError('NOT_ALLOWED', `view "${manifest.id}" may not ${op} on "${table}" (declared ops: ${[...new Set(entries.flatMap((w) => w.ops))].join(', ')})`);
  const declared: Set<string> | null = withOp.some((w) => !w.columns) ? null : new Set(withOp.flatMap((w) => w.columns!.map((c) => c.toLowerCase())));

  const rowCols = Object.keys(row);
  if (op !== 'delete' && declared) {
    for (const c of rowCols) {
      if (!declared.has(c.toLowerCase())) throw new ToolError('NOT_ALLOWED', `column "${c}" of "${table}" is not declared writable for ${op} in view "${manifest.id}" (declared: ${[...declared].join(', ') || 'none'})`);
    }
  }

  const dbPath = coachDbPath(workspaceDir);
  try {
    await fsp.access(dbPath);
  } catch {
    throw new ToolError('NOT_FOUND', 'coach.db does not exist yet');
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    const info = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as unknown as ColumnInfo[];
    if (info.length === 0) throw new ToolError('INVALID_INPUT', `table "${table}" does not exist`);
    const master = db.prepare('SELECT sql FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type = ?').get(table, 'table') as { sql?: string } | undefined;
    if (!master) throw new ToolError('INVALID_INPUT', `"${table}" is not a table`);
    const actual = new Map(info.filter((c) => c.hidden === 0).map((c) => [c.name.toLowerCase(), c]));
    const real = (name: string, what: string): string => {
      const c = actual.get(name.toLowerCase());
      if (!c) throw new ToolError('INVALID_INPUT', `${what} "${name}" is not a writable column of "${table}"`);
      return c.name;
    };

    let sql: string;
    const values: SqlValue[] = [];
    let desc: string;
    let keyCols: string[] = [];
    if (op !== 'delete') for (const c of rowCols) real(c, 'column');

    if (op === 'insert') {
      const cols = rowCols.map((c) => real(c, 'column'));
      const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      const withoutRowid = /WITHOUT\s+ROWID/i.test(master.sql ?? '');
      const rowidAlias = pk.length === 1 && pk[0]!.type.trim().toUpperCase() === 'INTEGER' && !withoutRowid;
      if (pk.length && !rowidAlias) {
        const lowerRow = new Map(rowCols.map((c) => [c.toLowerCase(), row[c]] as const));
        const missing = pk.filter((c) => {
          const v = lowerRow.get(c.name.toLowerCase());
          return (v === null || v === undefined) && (c.dflt_value === null || c.dflt_value === undefined);
        });
        if (missing.length) throw new ToolError('INVALID_INPUT', `insert into "${table}": the row must include primary key column(s) ${missing.map((c) => c.name).join(', ')} (the harness does not generate ids)`);
      }
      if (cols.length === 0) {
        sql = `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES`;
        desc = `insert into ${table} default values`;
      } else {
        sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        for (const c of rowCols) values.push(bindValue(row[c], `value of "${c}"`));
        desc = `insert into ${table} set ${rowCols.map((c, i) => `${cols[i]}=${fmtVal(row[c])}`).join(', ')}`;
      }
    } else {
      if (!key || !isPlainObject(key) || Object.keys(key).length === 0) throw new ToolError('INVALID_INPUT', `${op} on "${table}" requires a non-empty key (e.g. {"id": "..."})`);
      const keyNames = Object.keys(key);
      keyCols = keyNames.map((k) => real(k, 'key column'));
      const where = keyNames.map((k, i) => (key[k] === null || key[k] === undefined ? `${quoteIdent(keyCols[i]!)} IS NULL` : `${quoteIdent(keyCols[i]!)} = ?`)).join(' AND ');
      const keyValues = keyNames.filter((k) => key[k] !== null && key[k] !== undefined).map((k) => bindValue(key[k], `key "${k}"`));
      const whereDesc = keyNames.map((k, i) => `${keyCols[i]}=${fmtVal(key[k])}`).join(' and ');
      if (op === 'update') {
        if (rowCols.length === 0) throw new ToolError('INVALID_INPUT', `update on "${table}" needs at least one column to change`);
        const cols = rowCols.map((c) => real(c, 'column'));
        sql = `UPDATE ${quoteIdent(table)} SET ${cols.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE ${where}`;
        for (const c of rowCols) values.push(bindValue(row[c], `value of "${c}"`));
        values.push(...keyValues);
        desc = `update ${table} set ${rowCols.map((c, i) => `${cols[i]}=${fmtVal(row[c])}`).join(', ')} where ${whereDesc}`;
      } else {
        sql = `DELETE FROM ${quoteIdent(table)} WHERE ${where}`;
        values.push(...keyValues);
        desc = `delete from ${table} where ${whereDesc}`;
      }
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const res = db.prepare(sql).run(...values);
      const changes = Number(res.changes);
      if (op !== 'insert') {
        if (changes === 0) throw new ToolError('NOT_FOUND', `${op} on "${table}": no row matches the key`);
        if (changes > 1) throw new ToolError('INVALID_INPUT', `${op} on "${table}": the key matches ${changes} rows; it must identify exactly one`);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
    return desc;
  } catch (e) {
    return sqliteToToolError(e);
  } finally {
    db.close();
  }
}

function normalizeAthleteInputPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) throw new ToolError('INVALID_INPUT', 'file path is empty or contains a NUL byte');
  if (raw.startsWith('/') || raw.includes('\\')) throw new ToolError('NOT_ALLOWED', 'file path must be relative to /workspace, under athlete-input/');
  const norm = path.posix.normalize(raw).replace(/^(\.\/)+/, '');
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) throw new ToolError('NOT_ALLOWED', 'file path must not leave athlete-input/');
  if (!norm.startsWith('athlete-input/') || norm === 'athlete-input/' || norm.endsWith('/')) throw new ToolError('NOT_ALLOWED', 'file writes are limited to files under athlete-input/');
  return norm;
}

async function applyFileWrite(workspaceDir: string, manifest: ViewManifest, op: string, rawPath: string, row: Record<string, unknown>): Promise<string> {
  const rel = normalizeAthleteInputPath(rawPath);
  const entries = manifest.writes.filter((w): w is Extract<typeof w, { file: string }> => 'file' in w && picomatch(w.file.replace(/^(\.\/)+/, ''), { dot: true })(rel));
  if (entries.length === 0) throw new ToolError('NOT_ALLOWED', `view "${manifest.id}" does not declare writes to file "${rel}"`);
  if (op === 'delete') throw new ToolError('NOT_ALLOWED', 'files cannot be deleted from views; only written');
  if (!entries.some((w) => (w.ops as string[]).includes('write'))) throw new ToolError('NOT_ALLOWED', `view "${manifest.id}" may not write "${rel}"`);
  const content = row['content'];
  if (typeof content !== 'string') throw new ToolError('INVALID_INPUT', 'a file write needs row.content (a string)');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) throw new ToolError('INVALID_INPUT', `file content is too large (${bytes} bytes; limit ${MAX_FILE_BYTES})`);
  const host = path.join(workspaceDir, rel);
  const realBase = await realpathLenient(path.join(workspaceDir, 'athlete-input'));
  const realWs = await realpathLenient(workspaceDir);
  const realTarget = await realpathLenient(host);
  if (!isWithin(realBase, realTarget) || !isWithin(realWs, realBase)) throw new ToolError('NOT_ALLOWED', 'file path resolves outside athlete-input/');
  const existing = await fsp.lstat(host).catch(() => null);
  if (existing?.isDirectory()) throw new ToolError('INVALID_INPUT', `${rel} is a directory`);
  await atomicWriteFile(host, content);
  return `write ${rel} (${bytes} bytes)`;
}

/**
 * Apply a direct view write (SPEC [UI-1]) after validating it against the manifest's `writes`.
 * Returns a short human description such as `update planned_workouts set status=done where id=pw_1`.
 */
export async function applyViewWrite(opts: {
  workspaceDir: string;
  manifest: ViewManifest;
  write: { target: string; op: 'insert' | 'update' | 'delete'; row: Record<string, unknown>; key?: Record<string, unknown> };
}): Promise<{ description: string }> {
  const { workspaceDir, manifest, write } = opts;
  const op = write.op as string;
  if (!['insert', 'update', 'delete', 'write'].includes(op)) throw new ToolError('INVALID_INPUT', `unknown write op "${op}"`);
  const row = write.row ?? {};
  if (!isPlainObject(row)) throw new ToolError('INVALID_INPUT', 'row must be an object');
  if (write.key !== undefined && !isPlainObject(write.key)) throw new ToolError('INVALID_INPUT', 'key must be an object');
  const target = parseTarget(write.target);
  if (target.kind === 'file') return { description: await applyFileWrite(workspaceDir, manifest, op, target.path, row) };
  if (op === 'write') throw new ToolError('INVALID_INPUT', 'db writes use op insert, update or delete');
  return { description: await applyDbWrite(workspaceDir, manifest, op as 'insert' | 'update' | 'delete', target.table, row, write.key) };
}
