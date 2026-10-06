/**
 * Source of the process that executes an (already lexically vetted) view query.
 *
 * Why a child PROCESS and not a worker thread: node:sqlite is synchronous native code.
 * `Worker.terminate()` cannot interrupt a running sqlite3_step() (verified on Node 22.22: a
 * recursive CTE keeps the worker thread alive, `terminate()` never resolves, and the host process
 * cannot even exit). A child process can be SIGKILLed, which gives a hard timeout.
 *
 * The program is embedded as a string and run with `node -e`, so it works unchanged under tsx,
 * vitest and bundlers (no file path to resolve). It is plain CommonJS and uses no template
 * literals. Protocol: the job arrives as one JSON document on stdin. The program prints
 * `{"ready":true}\n` as soon as it has read it (the parent starts the timeout clock then), and
 * finally one JSON line: `{ok:true, rows}` or `{ok:false, code, message}`.
 *
 * Inside the child, on ONE read-only connection:
 *   1. `EXPLAIN` the exact statement that will run and inspect its opcodes (authoritative check):
 *      reject OpenWrite and other write/DDL/pragma opcodes, write transactions, attached/temp
 *      b-trees, any b-tree whose table is not in the allow-list (indexes map to their table via
 *      sqlite_master; sqlite_* internals are never allowed), and any virtual table that is not a
 *      declared (allowed) virtual table or json_each/json_tree (identified by the vtab instance
 *      pointer that EXPLAIN prints, which is stable per connection).
 *   2. run it (`SELECT * FROM (<sql>) LIMIT maxRows`), converting BigInt → number, BLOB → base64.
 */
export const VIEW_QUERY_CHILD_SOURCE = String.raw`
'use strict';
const { DatabaseSync } = require('node:sqlite');

const DENY_OPS = new Set([
  'OpenWrite', 'VUpdate', 'VCreate', 'VDestroy', 'VRename', 'ParseSchema', 'Destroy', 'Clear', 'CreateBtree',
  'DropTable', 'DropIndex', 'DropTrigger', 'Checkpoint', 'JournalMode', 'Vacuum', 'Pragma', 'Savepoint',
  'AutoCommit', 'SetCookie', 'SqlExec', 'LoadAnalysis', 'IntegrityCk', 'Program'
]);
const MAX_RESULT_BYTES = 48 * 1024 * 1024;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n', function () { process.exit(0); });
}
function fail(code, message) {
  send({ ok: false, code: code, message: message });
}
function notAllowed(message) {
  const e = new Error(message);
  e.opencoachCode = 'NOT_ALLOWED';
  throw e;
}
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function vtabPointers(db, name) {
  const out = [];
  try {
    const rows = db.prepare('EXPLAIN SELECT * FROM ' + name).all();
    for (const r of rows) if (r.opcode === 'VOpen' && typeof r.p4 === 'string') out.push(r.p4);
  } catch (e) { /* the table-valued function may not exist in this build */ }
  return out;
}

function check(db, explain, allowedList) {
  const allowed = new Set(allowedList.map(function (s) { return String(s).toLowerCase(); }));
  const master = db.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master').all();
  const rootToTable = new Map();
  rootToTable.set(1, 'sqlite_master');
  const allowedVtabs = new Set();
  for (const m of master) {
    const root = Number(m.rootpage);
    if (root > 0) rootToTable.set(root, String(m.tbl_name).toLowerCase());
    if (m.type === 'table' && root === 0 && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(String(m.sql || '')) && allowed.has(String(m.name).toLowerCase())) {
      for (const p of vtabPointers(db, quoteIdent(m.name))) allowedVtabs.add(p);
    }
  }
  for (const fn of ['json_each', 'json_tree']) {
    for (const p of vtabPointers(db, fn + "('null')")) allowedVtabs.add(p);
  }

  for (const op of explain) {
    const name = String(op.opcode);
    if (DENY_OPS.has(name)) notAllowed('the query uses an operation that is not read-only (' + name + ')');
    if (name === 'Transaction' && Number(op.p2) !== 0) notAllowed('the query would write to the database');
    if (name === 'OpenRead' || name === 'ReopenIdx') {
      if (Number(op.p3) !== 0) notAllowed('attached and temporary databases are not accessible');
      if (Number(op.p5) & 16) notAllowed('the query opens a table by computed root page');
      const table = rootToTable.get(Number(op.p2));
      if (table === undefined) notAllowed('the query reads an unknown table');
      if (table.indexOf('sqlite_') === 0) notAllowed('internal SQLite tables are not accessible (' + table + ')');
      if (!allowed.has(table)) notAllowed('table "' + table + '" is not declared in this view\'s reads (note: tables reached through a SQL view must be declared as well)');
    }
    if (name === 'VOpen') {
      if (!allowedVtabs.has(String(op.p4))) notAllowed('virtual tables and table-valued functions are not accessible, except declared virtual tables and json_each/json_tree');
    }
  }
}

function bindParam(p) {
  if (p === null) return null;
  if (typeof p === 'number') return Number.isInteger(p) && Math.abs(p) <= 9007199254740991 ? BigInt(p) : p;
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object' && typeof p.$bigint === 'string') return BigInt(p.$bigint);
  if (p && typeof p === 'object' && typeof p.$b64 === 'string') return Buffer.from(p.$b64, 'base64');
  throw new Error('unsupported parameter');
}

function convert(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
  return v;
}

function sizeOf(v) {
  if (typeof v === 'string') return v.length + 2;
  return 12;
}

function run(job) {
  process.stdout.write('{"ready":true}\n');
  let db;
  try {
    db = new DatabaseSync(job.dbPath, { readOnly: true });
  } catch (e) {
    return fail('INTERNAL', 'cannot open coach.db read-only: ' + e.message);
  }
  try { db.exec('PRAGMA query_only = ON'); } catch (e) { /* best effort */ }
  try { db.exec('PRAGMA trusted_schema = OFF'); } catch (e) { /* best effort */ }
  const maxRows = Math.max(1, Math.floor(job.maxRows));
  const wrapped = 'SELECT * FROM (\n' + job.sql + '\n) LIMIT ' + maxRows;
  try {
    const explain = db.prepare('EXPLAIN ' + wrapped).all();
    check(db, explain, job.allowed);
    const stmt = db.prepare(wrapped);
    stmt.setReadBigInts(true);
    const params = job.params.map(bindParam);
    const rows = [];
    let approx = 0;
    for (const row of stmt.iterate.apply(stmt, params)) {
      const o = {};
      for (const k of Object.keys(row)) {
        const v = convert(row[k]);
        approx += k.length + sizeOf(v);
        o[k] = v;
      }
      if (approx > MAX_RESULT_BYTES) return fail('INVALID_INPUT', 'query result is too large; select fewer columns or rows');
      rows.push(o);
    }
    send({ ok: true, rows: rows });
  } catch (e) {
    if (e && e.opencoachCode) return fail(e.opencoachCode, e.message);
    if (e && e.code === 'ERR_SQLITE_ERROR') return fail('INVALID_INPUT', String(e.message));
    return fail('INTERNAL', String((e && e.message) || e));
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (c) { input += c; });
process.stdin.on('end', function () {
  let job;
  try { job = JSON.parse(input); } catch (e) { return fail('INTERNAL', 'bad job'); }
  run(job);
});
`;
