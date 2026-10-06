/**
 * coach.db helpers (SPEC §6.3 [WS-3]): online-backup snapshots with retention, deterministic SQL
 * text dumps (diffable in git) and schema extraction. All reads use read-only connections so they
 * never checkpoint or otherwise disturb the coach's database.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { AthletePaths, Clock } from '@opencoach/protocol';
import { atomicWriteFile, randomSuffix } from './fsutil';

export const COACH_DB_REL = 'data/coach.db';
export const COACH_DB_DUMP_REL = 'data/dump/coach.sql';

export function coachDbPath(workspaceDir: string): string {
  return path.join(workspaceDir, COACH_DB_REL);
}

/** size:mtime of a file; 'none' if missing (or empty, when `emptyIsNone`: a 0-byte -wal carries no data). */
async function fileSig(p: string, emptyIsNone = false): Promise<string> {
  try {
    const st = await fsp.stat(p);
    if (emptyIsNone && st.size === 0) return 'none';
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

export function compactIso(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '');
}

const SNAP_RE = /^coach-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z(?:-\d+)?\.db$/;

function snapshotTime(name: string): number | null {
  const m = SNAP_RE.exec(name);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7] ? +m[7] : 0);
}

const KEEP_RECENT = 50;
const KEEP_DAILY_DAYS = 90;

/**
 * Snapshot data/coach.db with SQLite's online backup API if it changed since the last snapshot.
 * Change detection: size+mtime of the db and its -wal file, recorded in snapshots/.last.json.
 * Retention: the newest 50 snapshots, plus the newest snapshot of each UTC day for 90 days.
 * Returns the snapshot path, or null (no db, or unchanged).
 */
export async function snapshotDb(paths: AthletePaths, clock: Clock): Promise<string | null> {
  const dbPath = coachDbPath(paths.workspace);
  try {
    await fsp.access(dbPath);
  } catch {
    return null;
  }
  await fsp.mkdir(paths.snapshots, { recursive: true });
  const sig = `${await fileSig(dbPath)}|${await fileSig(dbPath + '-wal', true)}`;
  const lastPath = path.join(paths.snapshots, '.last.json');
  try {
    const last = JSON.parse(await fsp.readFile(lastPath, 'utf8')) as { sig?: string };
    if (last.sig === sig) return null;
  } catch {
    /* no previous snapshot */
  }

  const now = clock.now();
  let name = `coach-${compactIso(now)}.db`;
  for (let n = 2; await fsp.stat(path.join(paths.snapshots, name)).then(() => true, () => false); n++) name = `coach-${compactIso(now)}-${n}.db`;
  const dest = path.join(paths.snapshots, name);
  const tmp = path.join(paths.snapshots, `.tmp-${randomSuffix()}.db`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(src, tmp);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  } finally {
    src.close();
  }
  await fsp.rename(tmp, dest);
  await atomicWriteFile(lastPath, JSON.stringify({ sig, file: name, at: now.toISOString() }) + '\n');
  await applyRetention(paths.snapshots, now.getTime());
  return dest;
}

async function applyRetention(dir: string, nowMs: number): Promise<void> {
  const names = (await fsp.readdir(dir)).filter((n) => SNAP_RE.test(n)).sort().reverse();
  const keep = new Set(names.slice(0, KEEP_RECENT));
  const days = new Set<string>();
  for (const n of names) {
    const t = snapshotTime(n);
    if (t === null || nowMs - t > KEEP_DAILY_DAYS * 86_400_000) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (!days.has(day)) {
      days.add(day);
      keep.add(n);
    }
  }
  for (const n of names) if (!keep.has(n)) await fsp.rm(path.join(dir, n), { force: true });
}

// ---------------------------------------------------------------- schema & dump

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

const SHADOW_SUFFIXES = ['_content', '_docsize', '_config', '_data', '_idx', '_segments', '_segdir', '_stat', '_node', '_rowid', '_parent'];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function readSchema(db: DatabaseSync): { tables: SchemaRow[]; others: SchemaRow[] } {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid').all() as unknown as SchemaRow[];
  const vtabs = rows.filter((r) => r.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? '')).map((r) => r.name);
  const shadow = new Set<string>();
  for (const v of vtabs) for (const s of SHADOW_SUFFIXES) shadow.add(`${v}${s}`);
  const skip = (r: SchemaRow) => r.name.startsWith('sqlite_') || r.sql === null || shadow.has(r.name) || shadow.has(r.tbl_name);
  const kept = rows.filter((r) => !skip(r));
  return { tables: kept.filter((r) => r.type === 'table'), others: kept.filter((r) => r.type !== 'table') };
}

function stmt(sql: string): string {
  return sql.trimEnd().replace(/;+$/, '') + ';';
}

/** Schema SQL of the current coach.db (CREATE statements), used for empty-state preview fixtures. */
export async function schemaSql(workspaceDir: string): Promise<string> {
  const dbPath = coachDbPath(workspaceDir);
  try {
    await fsp.access(dbPath);
  } catch {
    return '';
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const { tables, others } = readSchema(db);
    return [...tables, ...others].map((r) => stmt(r.sql!)).join('\n\n') + '\n';
  } finally {
    db.close();
  }
}

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NULL';
    if (!Number.isFinite(v)) return v > 0 ? '9e999' : '-9e999';
    const s = String(v);
    return Number.isInteger(v) && !/[e.]/.test(s) ? `${s}.0` : s;
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Uint8Array) return `X'${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}'`;
  throw new Error(`cannot render ${typeof v} as an SQL literal`);
}

/**
 * Write a full SQL text dump to <workspace>/data/dump/coach.sql (for diffable history).
 * Deterministic: CREATE TABLEs, then rows in rowid order (primary-key order for WITHOUT ROWID
 * tables), then indexes/views/triggers. sqlite_* internals and virtual-table shadow tables are
 * skipped; virtual tables are dumped as their CREATE statement only (their content is derived).
 */
export async function dumpDb(workspaceDir: string): Promise<string> {
  const dbPath = coachDbPath(workspaceDir);
  const out = path.join(workspaceDir, COACH_DB_DUMP_REL);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const parts: string[] = [];
  try {
    const { tables, others } = readSchema(db);
    parts.push('-- OpenCoach coach.db text dump\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
    for (const t of tables) parts.push(stmt(t.sql!) + '\n');
    for (const t of tables) {
      if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? '')) continue;
      const cols = (db.prepare(`PRAGMA table_xinfo(${quoteIdent(t.name)})`).all() as unknown as Array<{ name: string; pk: number; hidden: number }>).filter((c) => c.hidden === 0);
      if (cols.length === 0) continue;
      const colList = cols.map((c) => quoteIdent(c.name)).join(',');
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      const orderings = [`rowid`, ...(pkCols.length ? [pkCols.map((c) => quoteIdent(c.name)).join(',')] : []), cols.map((c) => quoteIdent(c.name)).join(',')];
      let select: ReturnType<DatabaseSync['prepare']> | undefined;
      for (const ord of orderings) {
        try {
          select = db.prepare(`SELECT ${colList} FROM ${quoteIdent(t.name)} ORDER BY ${ord}`);
          break;
        } catch {
          /* try the next ordering (WITHOUT ROWID tables have no rowid) */
        }
      }
      if (!select) continue;
      select.setReadBigInts(true);
      const prefix = `INSERT INTO ${quoteIdent(t.name)}(${colList}) VALUES(`;
      for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
        parts.push(prefix + cols.map((c) => sqlLiteral(row[c.name])).join(',') + ');\n');
      }
    }
    const hasSeq = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
    if (hasSeq) {
      const seqs = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all() as unknown as Array<{ name: string; seq: number }>;
      if (seqs.length) {
        parts.push('DELETE FROM sqlite_sequence;\n');
        for (const s of seqs) parts.push(`INSERT INTO sqlite_sequence VALUES(${sqlLiteral(s.name)},${sqlLiteral(BigInt(s.seq))});\n`);
      }
    }
    for (const o of others) parts.push(stmt(o.sql!) + '\n');
    parts.push('COMMIT;\n');
  } finally {
    db.close();
  }
  await atomicWriteFile(out, parts.join(''));
  return out;
}

