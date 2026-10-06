/**
 * Tiny declarative row mapping used by the SQLite store: each record type is described by a list
 * of fields (camelCase key <-> snake_case column, plus how the value is encoded), from which we
 * derive INSERT / UPSERT / UPDATE statements and row decoding.
 */
import type { SQLInputValue, SQLOutputValue } from './sqlite';

export type Kind =
  /** TEXT */
  | 'text'
  /** TEXT holding an RFC 3339 instant; canonicalised to UTC `toISOString()` on write so string comparison is time comparison. */
  | 'iso'
  | 'int'
  | 'real'
  /** INTEGER 0/1 <-> boolean */
  | 'bool'
  /** TEXT holding JSON */
  | 'json';

export interface Field {
  key: string;
  col: string;
  kind: Kind;
  /** NOT NULL column (a missing value is a programming error and fails at the SQL layer). */
  required: boolean;
  /** Decode SQL NULL as `null` (instead of omitting the key). */
  nullable: boolean;
}

export type Row = Record<string, SQLOutputValue>;

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Required field. */
export const req = (key: string, kind: Kind = 'text', col: string = snake(key)): Field => ({ key, col, kind, required: true, nullable: false });
/** Optional field (SQL NULL <-> key omitted). */
export const opt = (key: string, kind: Kind = 'text', col: string = snake(key)): Field => ({ key, col, kind, required: false, nullable: false });
/** Optional field whose absence is represented as `null` (e.g. ScheduleRecord.nextFireAt). */
export const nul = (key: string, kind: Kind = 'text', col: string = snake(key)): Field => ({ key, col, kind, required: false, nullable: true });

/** Normalise an instant to canonical UTC (`2026-10-07T04:58:12.000Z`); unparseable input is returned unchanged. */
export function canonIso(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

export function encode(f: Field, v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  switch (f.kind) {
    case 'bool':
      return v ? 1 : 0;
    case 'json':
      return JSON.stringify(v);
    case 'iso':
      return canonIso(String(v));
    case 'int':
    case 'real':
      return Number(v);
    default:
      return String(v);
  }
}

export function decode(f: Field, raw: SQLOutputValue | undefined): unknown {
  if (raw === null || raw === undefined) return f.nullable ? null : undefined;
  switch (f.kind) {
    case 'bool':
      return Number(raw) !== 0;
    case 'json':
      return JSON.parse(String(raw));
    case 'int':
    case 'real':
      return Number(raw);
    default:
      return raw;
  }
}

/** Decode a row into a record, omitting absent optional keys. */
export function fromRow<T>(fields: readonly Field[], row: Row): T {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = decode(f, row[f.col]);
    if (v !== undefined) out[f.key] = v;
  }
  return out as T;
}

export function toParams(fields: readonly Field[], rec: object): SQLInputValue[] {
  const r = rec as Record<string, unknown>;
  return fields.map((f) => encode(f, r[f.key]));
}

export function insertSql(table: string, fields: readonly Field[], opts: { orReplace?: boolean; upsertOn?: readonly string[] } = {}): string {
  const cols = fields.map((f) => f.col);
  const head = `INSERT${opts.orReplace ? ' OR REPLACE' : ''} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  if (!opts.upsertOn) return head;
  const sets = cols.filter((c) => !opts.upsertOn!.includes(c)).map((c) => `${c} = excluded.${c}`);
  return `${head} ON CONFLICT (${opts.upsertOn.join(', ')}) DO ${sets.length ? `UPDATE SET ${sets.join(', ')}` : 'NOTHING'}`;
}

export function selectList(fields: readonly Field[]): string {
  return fields.map((f) => f.col).join(', ');
}

/**
 * Build `SET col = ?, ...` for the fields present in `patch` (undefined = leave alone, null = clear).
 * Returns undefined when nothing would change.
 */
export function updateSet(fields: readonly Field[], patch: object, exclude: readonly string[] = []): { sql: string; params: SQLInputValue[] } | undefined {
  const p = patch as Record<string, unknown>;
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  for (const f of fields) {
    if (exclude.includes(f.key)) continue;
    const v = p[f.key];
    if (v === undefined) continue;
    sets.push(`${f.col} = ?`);
    params.push(encode(f, v));
  }
  return sets.length ? { sql: sets.join(', '), params } : undefined;
}
