/**
 * SQLite helpers for the preview renderer: schema reading, the empty-state fixture DB and a
 * read-only query executor that runs in a worker thread so a runaway query can be terminated
 * (node:sqlite is synchronous; a recursive CTE must never block the server's event loop).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { VIEW_QUERY_LIMITS } from '@opencoach/protocol';

export interface DbSchema {
  /** table name -> column names */
  tables: Record<string, string[]>;
  /** CREATE statements (tables first, then indexes and views) for the empty fixture. */
  create: string[];
}

/** Read table/column names and CREATE statements from a SQLite file (read-only). Null if unreadable. */
export function readDbSchema(path: string): DbSchema | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const objs = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Array<{ type: string; name: string; sql: string }>;
    const tables: Record<string, string[]> = {};
    for (const o of objs) {
      if (o.type !== 'table') continue;
      const cols = db.prepare(`PRAGMA table_info("${o.name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>;
      tables[o.name] = cols.map((c) => c.name);
    }
    const rank = (t: string) => (t === 'table' ? 0 : t === 'index' ? 1 : 2);
    const create = [...objs].filter((o) => o.type === 'table' || o.type === 'index' || o.type === 'view').sort((a, b) => rank(a.type) - rank(b.type)).map((o) => o.sql);
    return { tables, create };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Create an empty database with the same schema (tables, indexes, views) as `schema`. */
export function createEmptyDb(destPath: string, schema: DbSchema | null): void {
  const db = new DatabaseSync(destPath);
  try {
    for (const stmt of schema?.create ?? []) {
      try {
        db.exec(stmt);
      } catch {
        /* skip objects that cannot be recreated (virtual tables, missing modules) */
      }
    }
  } finally {
    db.close();
  }
}

// ----------------------------------------------------------------------------- query validation

/** Remove comments and string literals so keyword checks cannot be fooled. */
export function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** SELECT/WITH only, single statement, no ATTACH/PRAGMA/extension loading. Returns an error string or null. */
export function validateReadOnlySql(sql: string): string | null {
  const s = stripSql(sql).trim();
  if (!s) return 'empty query';
  if (!/^(select|with)\b/i.test(s)) return 'only SELECT / WITH queries are allowed';
  const body = s.replace(/;\s*$/, '');
  if (body.includes(';')) return 'only a single statement is allowed';
  if (/\b(attach|detach|pragma|load_extension|vacuum|reindex)\b/i.test(body)) return 'ATTACH / PRAGMA / extensions are not allowed in view queries';
  return null;
}

// ----------------------------------------------------------------------------- executor

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  /** Real tables read by the query (resolved via EXPLAIN), lower-case-insensitive names as in sqlite_master. */
  tables: string[];
  truncated: boolean;
}

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const dbs = new Map();
function open(path) {
  let db = dbs.get(path);
  if (!db) { db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA query_only = ON'); dbs.set(path, db); }
  return db;
}
function tablesUsed(db, sql) {
  const names = new Set();
  const master = db.prepare('SELECT name, tbl_name, rootpage FROM sqlite_master').all();
  const byRoot = new Map(master.map((m) => [Number(m.rootpage), m.tbl_name]));
  try {
    for (const op of db.prepare('EXPLAIN ' + sql).all()) {
      if ((op.opcode === 'OpenRead' || op.opcode === 'ReopenIdx') && Number(op.p3) === 0) {
        const t = Number(op.p2) === 1 ? 'sqlite_master' : byRoot.get(Number(op.p2));
        if (t) names.add(t);
      }
    }
  } catch (e) { /* fall through to regex */ }
  const re = /\\b(?:from|join)\\s+["\\x60\\[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  const known = new Set(master.map((x) => x.tbl_name.toLowerCase()));
  while ((m = re.exec(sql))) if (known.has(m[1].toLowerCase())) names.add(master.find((x) => x.tbl_name.toLowerCase() === m[1].toLowerCase()).tbl_name);
  return [...names];
}
function plain(v) {
  if (v instanceof Uint8Array) return '<blob ' + v.length + ' bytes>';
  if (typeof v === 'bigint') return Number(v);
  return v;
}
parentPort.on('message', (m) => {
  try {
    const db = open(m.path);
    const tables = tablesUsed(db, m.sql);
    const stmt = db.prepare(m.sql);
    const rows = [];
    let truncated = false;
    for (const r of stmt.iterate(...m.params)) {
      if (rows.length >= m.maxRows) { truncated = true; break; }
      const o = {};
      for (const k of Object.keys(r)) o[k] = plain(r[k]);
      rows.push(o);
    }
    parentPort.postMessage({ id: m.id, ok: true, rows, tables, truncated });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e && e.message || e) });
  }
});
`;

/** node:sqlite only binds null/number/bigint/string/Uint8Array. */
function bindable(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  return JSON.stringify(v);
}

type Pending = { resolve: (r: QueryResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class SqlExecutor {
  private worker?: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_SRC, { eval: true, execArgv: ['--disable-warning=ExperimentalWarning'] });
    w.on('message', (m: { id: number; ok: boolean; error?: string } & Partial<QueryResult>) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve({ rows: m.rows ?? [], tables: m.tables ?? [], truncated: !!m.truncated });
      else p.reject(new Error(m.error ?? 'query failed'));
    });
    const dead = (err: Error) => {
      if (this.worker === w) this.worker = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
        this.pending.delete(id);
      }
    };
    w.on('error', (e) => dead(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', () => dead(new Error('query worker exited')));
    this.worker = w;
    return w;
  }

  /** Run a validated read-only query. Rejects on SQL errors and after `timeoutMs` (the worker is killed). */
  query(dbPath: string, sql: string, params: unknown[] = [], timeoutMs: number = VIEW_QUERY_LIMITS.timeoutMs): Promise<QueryResult> {
    const bad = validateReadOnlySql(sql);
    if (bad) return Promise.reject(new Error(bad));
    const w = this.ensure();
    const id = ++this.seq;
    return new Promise<QueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`query timed out after ${timeoutMs} ms`));
        const dying = this.worker;
        this.worker = undefined;
        void dying?.terminate();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, path: dbPath, sql, params: params.map(bindable), maxRows: VIEW_QUERY_LIMITS.maxRows });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('executor closed'));
      this.pending.delete(id);
    }
    await w?.terminate();
  }
}
