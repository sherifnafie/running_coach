/**
 * Read-only SQL for coach-authored views (SPEC §9.4, Appendix C §C.4, [SEC-3]).
 *
 * This is security-relevant: the SQL is written by a model and runs next to the athlete's data.
 * Defence in depth, outermost first:
 *   1. Lexical (here): exactly one statement, which must start with SELECT or WITH; no DML/DDL
 *      keywords anywhere; no PRAGMA/ATTACH/VACUUM; no sqlite_* internals, pragma_* functions,
 *      dbstat, load_extension, ...
 *   2. Parser layer (here, advisory): node-sql-parser (sqlite dialect) must parse it as a single
 *      `select`, and every table it names must be declared. The parser does not understand all
 *      SQLite syntax (MATCH, GLOB, window functions, ...), so a parse failure just falls through.
 *   3. EXPLAIN layer (authoritative, in the child process): the opcodes of the exact statement are
 *      inspected on a read-only connection — see view-query-child.ts.
 *   4. The connection itself is read-only (+ query_only, trusted_schema off), and the query runs in a
 *      separate process that is SIGKILLed after `timeoutMs` (worker threads cannot interrupt SQLite).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import sqlParser from 'node-sql-parser/build/sqlite';
import type { Parser } from 'node-sql-parser';
import { ToolError } from '@opencoach/protocol';
import { coachDbPath } from './db';
import { lexSql, maxParenDepth, splitStatements, type Token } from './sql-lex';
import { VIEW_QUERY_CHILD_SOURCE } from './view-query-child';

const MAX_SQL_CHARS = 100_000;
const MAX_PARAMS = 1000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const START_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_QUERIES = 4;

const DML_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE']);
const DENIED_NAME = /^(sqlite_(master|schema|temp_master|temp_schema|sequence|stat\d|dbpage|stmt)|pragma_\w+|dbstat|load_extension|readfile|writefile|fts3_tokenizer)$/i;

// ---------------------------------------------------------------- lexical layer

function normalizeAllowed(allowedTables: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of allowedTables) {
    const n = String(t)
      .replace(/^db:/i, '')
      .replace(/^main\./i, '')
      .trim()
      .toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

function lexicalCheck(stmt: Token[]): void {
  const first = stmt[0]!;
  const kw = first.kind === 'word' ? first.value.toUpperCase() : first.text;
  if (kw !== 'SELECT' && kw !== 'WITH') {
    throw new ToolError('NOT_ALLOWED', `only a single read-only SELECT (or WITH ... SELECT) statement is allowed; got ${kw}`);
  }
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i]!;
    if (t.kind === 'word') {
      const up = t.value.toUpperCase();
      if (DML_WORDS.has(up)) throw new ToolError('NOT_ALLOWED', `${up} is not allowed: view queries are read-only`);
      if (up === 'REPLACE' && !(stmt[i + 1]?.kind === 'punct' && stmt[i + 1]!.text === '(')) {
        throw new ToolError('NOT_ALLOWED', 'REPLACE statements are not allowed: view queries are read-only');
      }
    }
    if (t.kind === 'word' || t.kind === 'qident' || t.kind === 'string') {
      if (DENIED_NAME.test(t.value)) throw new ToolError('NOT_ALLOWED', `"${t.value}" is not accessible from views`);
    }
  }
}

/** Unbalanced parentheses could escape the `SELECT * FROM (<sql>) LIMIT n` wrapper; refuse them. */
function checkBalancedParens(stmt: Token[]): void {
  let depth = 0;
  for (const t of stmt) {
    if (t.kind !== 'punct') continue;
    if (t.text === '(') depth++;
    else if (t.text === ')' && --depth < 0) throw new ToolError('INVALID_INPUT', 'SQL syntax error: unbalanced parentheses (unexpected ")")');
  }
  if (depth !== 0) throw new ToolError('INVALID_INPUT', 'SQL syntax error: unbalanced parentheses (missing ")")');
}

// ---------------------------------------------------------------- parser layer (advisory)

let parserSingleton: Parser | undefined;
const PARSE_OPT = { database: 'sqlite' } as const;

function collectCtes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 200 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectCtes(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const w = obj['with'];
  if (Array.isArray(w)) {
    for (const item of w) {
      const name = (item as { name?: unknown } | null)?.name;
      if (typeof name === 'string') out.add(name.toLowerCase());
      else if (name && typeof name === 'object' && typeof (name as { value?: unknown }).value === 'string') out.add(String((name as { value: string }).value).toLowerCase());
    }
  }
  for (const v of Object.values(obj)) collectCtes(v, out, depth + 1);
}

function parserCheck(stmtText: string, stmt: Token[], allowed: Set<string>): void {
  if (stmtText.length > 20_000 || maxParenDepth(stmt) > 40) return;
  parserSingleton ??= new sqlParser.Parser();
  let ast: unknown;
  let tables: string[];
  try {
    ast = parserSingleton.astify(stmtText, PARSE_OPT);
    tables = parserSingleton.tableList(stmtText, PARSE_OPT);
  } catch {
    return; // unsupported syntax → the EXPLAIN layer decides
  }
  const roots = Array.isArray(ast) ? ast : [ast];
  if (roots.length !== 1) throw new ToolError('NOT_ALLOWED', 'only a single statement is allowed');
  if ((roots[0] as { type?: string }).type !== 'select') throw new ToolError('NOT_ALLOWED', 'only SELECT statements are allowed');
  const ctes = new Set<string>();
  collectCtes(roots[0], ctes);
  for (const entry of tables) {
    const m = /^([^:]*)::([^:]*)::([\s\S]*)$/.exec(entry);
    if (!m) continue;
    const [, authority, db, rawName] = m;
    if (authority !== 'select') throw new ToolError('NOT_ALLOWED', `only SELECT statements are allowed (${authority})`);
    if (db && db !== 'null' && db.toLowerCase() !== 'main') throw new ToolError('NOT_ALLOWED', `database "${db}" is not accessible; only the main database can be queried`);
    const name = rawName!.toLowerCase();
    if (ctes.has(name)) continue;
    if (!allowed.has(name)) {
      throw new ToolError('NOT_ALLOWED', `table "${rawName}" is not declared in this view's reads${allowed.size ? ` (declared: ${[...allowed].sort().join(', ')})` : ' (the view declares no db reads)'}`);
    }
  }
}

// ---------------------------------------------------------------- child process

let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_QUERIES) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}
function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

function encodeParam(p: unknown, index: number): unknown {
  if (p === null || p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (typeof p === 'number') {
    if (!Number.isFinite(p)) throw new ToolError('INVALID_INPUT', `query parameter ${index + 1} is not a finite number`);
    return p;
  }
  if (typeof p === 'string') return p;
  if (typeof p === 'bigint') return { $bigint: p.toString() };
  if (p instanceof Uint8Array) return { $b64: Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString('base64') };
  throw new ToolError('INVALID_INPUT', `query parameter ${index + 1} must be null, a number, a string or a boolean`);
}

interface ChildJob {
  dbPath: string;
  sql: string;
  params: unknown[];
  allowed: string[];
  maxRows: number;
}

type ChildResult = { ok: true; rows: Array<Record<string, unknown>> } | { ok: false; code: string; message: string };

function runChild(job: ChildJob, timeoutMs: number): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    const env: Record<string, string> = { NODE_OPTIONS: '' };
    for (const k of ['LD_LIBRARY_PATH', 'SYSTEMROOT']) if (process.env[k]) env[k] = process.env[k]!;
    const child = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=384', '-e', VIEW_QUERY_CHILD_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    let settled = false;
    let ready = false;
    let out = '';
    let outBytes = 0;
    let err = '';
    let bootTimer: NodeJS.Timeout | undefined = setTimeout(() => finish(() => reject(new ToolError('INTERNAL', 'the query worker did not start in time', true))), START_TIMEOUT_MS);
    let deadline: NodeJS.Timeout | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (bootTimer) clearTimeout(bootTimer);
      if (deadline) clearTimeout(deadline);
      bootTimer = deadline = undefined;
      child.kill('SIGKILL');
      fn();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        finish(() => reject(new ToolError('INVALID_INPUT', 'query result is too large; select fewer columns or rows')));
        return;
      }
      if (!ready && out.includes('\n')) {
        ready = true;
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = undefined;
        deadline = setTimeout(
          () => finish(() => reject(new ToolError('TIMEOUT', `the query took longer than ${timeoutMs} ms and was cancelled; add a WHERE clause or LIMIT, or simplify the query`))),
          timeoutMs,
        );
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (err.length < 4000) err += chunk;
    });
    child.on('error', (e) => finish(() => reject(new ToolError('INTERNAL', `could not start the query worker: ${e.message}`))));
    child.on('close', (code, signal) => {
      finish(() => {
        const nl = out.indexOf('\n');
        const rest = nl === -1 ? '' : out.slice(nl + 1).trim();
        if (!rest) {
          reject(new ToolError('INTERNAL', `the query worker exited without a result (code ${code ?? signal}): ${err.trim().slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(rest) as ChildResult);
        } catch {
          reject(new ToolError('INTERNAL', 'the query worker returned an unreadable result'));
        }
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job));
  });
}

// ---------------------------------------------------------------- public API

/**
 * Read-only query for views (SPEC §9.4): exactly one SELECT/WITH statement, every table it reads must
 * be in `allowedTables` (case-insensitive; indexes count as their table), opened read-only on
 * <workspaceDir>/data/coach.db, wrapped as `SELECT * FROM (<sql>) LIMIT maxRows`, run in a child
 * process killed after `timeoutMs`. Positional `?` parameters; BigInt → number, BLOB → base64 string.
 * Throws ToolError('NOT_ALLOWED' | 'INVALID_INPUT' | 'TIMEOUT'); NOT_FOUND if there is no coach.db.
 */
export async function runViewQuery(opts: { workspaceDir: string; sql: string; params?: unknown[]; allowedTables: string[]; maxRows: number; timeoutMs: number }): Promise<Array<Record<string, unknown>>> {
  const { workspaceDir, sql, allowedTables } = opts;
  const params = opts.params ?? [];
  if (typeof sql !== 'string' || sql.trim() === '') throw new ToolError('INVALID_INPUT', 'the query is empty');
  if (sql.length > MAX_SQL_CHARS) throw new ToolError('INVALID_INPUT', `the query is too long (${sql.length} > ${MAX_SQL_CHARS} characters)`);
  if (sql.includes('\0')) throw new ToolError('INVALID_INPUT', 'the query contains a NUL character');
  if (!Array.isArray(params) || params.length > MAX_PARAMS) throw new ToolError('INVALID_INPUT', `params must be an array of at most ${MAX_PARAMS} values`);
  const maxRows = Math.max(1, Math.min(1_000_000, Math.floor(Number(opts.maxRows)) || 1));
  const timeoutMs = Math.max(1, Math.floor(Number(opts.timeoutMs)) || 1);

  const toks = lexSql(sql);
  const stmts = splitStatements(toks);
  if (stmts.length === 0) throw new ToolError('INVALID_INPUT', 'the query is empty');
  if (stmts.length > 1) throw new ToolError('NOT_ALLOWED', 'only a single statement is allowed (found several separated by ";")');
  const stmt = stmts[0]!;
  lexicalCheck(stmt);
  checkBalancedParens(stmt);
  const allowed = normalizeAllowed(allowedTables);
  const stmtText = sql.slice(stmt[0]!.start, stmt[stmt.length - 1]!.end);
  parserCheck(stmtText, stmt, allowed);

  const dbPath = coachDbPath(workspaceDir);
  try {
    await fsp.access(dbPath);
  } catch {
    throw new ToolError('NOT_FOUND', 'coach.db does not exist yet');
  }

  await acquire();
  let result: ChildResult;
  try {
    result = await runChild({ dbPath, sql: stmtText, params: params.map(encodeParam), allowed: [...allowed], maxRows }, timeoutMs);
  } finally {
    release();
  }
  if (!result.ok) {
    const code = result.code === 'NOT_ALLOWED' || result.code === 'INVALID_INPUT' || result.code === 'TIMEOUT' ? result.code : 'INTERNAL';
    throw new ToolError(code, result.message);
  }
  return result.rows;
}
