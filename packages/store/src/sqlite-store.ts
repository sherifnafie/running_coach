/**
 * SqliteStore: the system Store (SPEC §4.1, §4.5) on node:sqlite.
 *
 * Conventions
 *  - Every public method is async (so Postgres can replace this later) but the work is synchronous
 *    inside one tick, which makes each method atomic with respect to other callers on this connection.
 *    Multi-statement writes additionally run in a `BEGIN IMMEDIATE` transaction (safe across processes).
 *  - Instants that are compared in SQL (`events.ts`, `schedules.next_fire_at`, `usage.at`,
 *    `message_state.*_at`, pairing/idempotency expiry) are canonicalised to UTC `toISOString()` on write,
 *    and every instant passed to a query is canonicalised the same way, so string order == time order
 *    even when callers pass offsets such as `+02:00`. Round-tripped values for those fields are therefore
 *    the canonical UTC form.
 *  - "Now" always comes from the injected Clock.
 *  - Optional fields that are absent are omitted from returned records (never `null`), except
 *    `ScheduleRecord.nextFireAt`, which the contract defines as `string | null`.
 */
import { mkdirSync, closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EventPayloads,
  mergeSettings,
  newId,
  parseEventPayload,
  parseSettings,
  type AgentKind,
  type AnyEvent,
  type AthleteRecord,
  type AthleteSettings,
  type AuditRecord,
  type BlobRecord,
  type Clock,
  type EpochItemRecord,
  type EpochRecord,
  type EventEnvelope,
  type EventPayloadInput,
  type EventPayload,
  type EventQuery,
  type EventType,
  type MessageStateRecord,
  type NewEvent,
  type PairingCodeRecord,
  type CredentialRecord,
  type PasskeyRecord,
  type PushSubscriptionRecord,
  type ScheduleRecord,
  type SessionRecord,
  type Store,
  type TaskRecord,
  type TurnRecord,
  type UiVersionRecord,
  type UsageRecord,
} from '@opencoach/protocol';
import { buildMatch, extractSearchText, likeEscape, parseQuery, plainSnippet } from './fts';
import { MIGRATIONS } from './migrations';
import { canonIso, fromRow, insertSql, nul, opt, req, selectList, toParams, updateSet, type Field, type Row } from './rows';
import { loadSqlite, type DatabaseSync, type SQLInputValue, type StatementSync } from './sqlite';

// ------------------------------------------------------------------------------------ field specs

const ATHLETE: Field[] = [req('id'), req('displayName'), req('isAdmin', 'bool'), req('status'), opt('suspendedAt', 'iso'), req('createdAt')];

const PAIRING: Field[] = [req('code'), req('purpose'), opt('athleteId'), opt('createdBy'), opt('isAdmin', 'bool'), req('expiresAt', 'iso'), opt('consumedAt', 'iso')];

const SESSION: Field[] = [req('id'), req('athleteId'), req('tokenHash'), req('kind'), opt('deviceName'), req('createdAt'), req('lastSeenAt'), req('expiresAt')];

const CREDENTIAL: Field[] = [req('athleteId'), req('provider'), req('owner'), req('ciphertext'), req('hint'), req('updatedAt')];
const PASSKEY: Field[] = [req('credentialId'), req('athleteId'), req('publicKey'), req('counter', 'int'), opt('transports', 'json'), opt('deviceName'), req('createdAt')];

const MESSAGE_STATE: Field[] = [
  req('messageId'),
  req('athleteId'),
  req('delivery'),
  opt('heldUntil', 'iso'),
  opt('sentAt', 'iso'),
  opt('readAt', 'iso'),
  req('proactive', 'bool'),
];

const BLOB: Field[] = [
  req('athleteId'),
  req('sha256'),
  req('mime'),
  req('bytes', 'int'),
  opt('name'),
  req('origin'),
  req('createdAt'),
  req('relPath'),
  opt('meta', 'json'),
];

const SCHEDULE: Field[] = [
  req('id'),
  req('athleteId'),
  req('kind'),
  req('spec', 'json'),
  req('purpose'),
  opt('payload', 'json'),
  req('duringPause', 'bool'),
  nul('nextFireAt', 'iso'),
  req('status'),
  req('createdAt'),
  opt('createdInTurn'),
  opt('lastFiredAt'),
];

const EPOCH: Field[] = [
  req('id'),
  req('athleteId'),
  req('localDate'),
  req('seq', 'int'),
  req('provider'),
  req('model'),
  req('openedAt'),
  opt('closedAt'),
  opt('closeReason'),
  opt('carryover'),
];

const EPOCH_ITEM: Field[] = [req('epochId'), req('seq', 'int'), opt('turnId'), req('item', 'json'), req('tokens', 'int'), req('createdAt')];

const TURN: Field[] = [
  req('id'),
  req('athleteId'),
  opt('epochId'),
  req('agent'),
  opt('parentTurnId'),
  opt('taskId'),
  req('triggerClass'),
  req('triggerEventIds', 'json'),
  req('tier'),
  opt('provider'),
  opt('model'),
  req('status'),
  req('startedAt'),
  opt('endedAt'),
  req('steps', 'int'),
  req('usage', 'json'),
  req('costUsd', 'real'),
  opt('commit', 'text', 'commit_hash'),
  opt('note'),
  opt('error'),
  req('fallbacks', 'json'),
];

const TASK: Field[] = [
  req('id'),
  req('athleteId'),
  req('parentTurnId'),
  opt('profile'),
  req('task'),
  req('state'),
  req('background', 'bool'),
  req('createdAt'),
  opt('endedAt'),
  opt('summary'),
  req('outputs', 'json'),
  req('costUsd', 'real'),
  opt('error'),
  opt('originEventId'),
];

const PUSH: Field[] = [req('id'), req('athleteId'), req('kind'), req('endpoint'), opt('keys', 'json'), opt('userAgent'), req('createdAt')];

const UI_VERSION: Field[] = [
  req('athleteId'),
  req('viewId'),
  req('version'),
  req('commit', 'text', 'commit_hash'),
  req('summary'),
  req('publishedAt'),
  req('publishedBy'),
  req('manifest', 'json'),
  req('dir'),
];

const EVENT_COLS = 'id, athlete_id, ts, type, actor, turn_id, causation_id, payload';

/** Payload stored in place of a tombstoned event's content. */
export const TOMBSTONE_PAYLOAD = Object.freeze({ tombstoned: true });

/** True when the event's content was erased by `tombstoneEvent` (its payload is `{ tombstoned: true }`). */
export function isTombstoned(e: { payload: unknown }): boolean {
  const p = e.payload as { tombstoned?: unknown } | null;
  return !!p && typeof p === 'object' && p.tombstoned === true;
}

// ------------------------------------------------------------------------------------------ store

export interface SqliteStoreInit {
  path: string;
  clock: Clock;
}

const lit = (v: string | number | undefined | null): SQLInputValue => (v === undefined ? null : v);

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly isMemory: boolean;
  private readonly stmts = new Map<string, StatementSync>();
  private inTx = false;
  private closed = false;

  constructor(init: SqliteStoreInit) {
    const { DatabaseSync } = loadSqlite();
    this.clock = init.clock;
    this.isMemory = init.path === ':memory:' || init.path === '';
    if (!this.isMemory) {
      mkdirSync(dirname(init.path), { recursive: true });
      // Create the file 0600 up front: SQLite gives the -wal/-shm files the same mode.
      closeSync(openSync(init.path, 'a', 0o600));
    }
    this.db = new DatabaseSync(init.path || ':memory:');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    if (!this.isMemory) this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Hard delete ([SEC-6]): freed pages are zeroed, not just unlinked.
    this.db.exec('PRAGMA secure_delete = ON');
  }

  // ---------------------------------------------------------------------------------- plumbing

  private prep(sql: string): StatementSync {
    this.assertOpen();
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('store is closed');
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.prep(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.prep(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.prep(sql).run(...params).changes);
  }

  /** Run `fn` in a write transaction (joins the outer one when nested). `fn` must be synchronous. */
  private tx<T>(fn: () => T): T {
    this.assertOpen();
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* connection already rolled back */
      }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  private one<T>(table: string, fields: readonly Field[], where: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.get(`SELECT ${selectList(fields)} FROM ${table} WHERE ${where}`, ...params);
    return row ? fromRow<T>(fields, row) : undefined;
  }

  private many<T>(table: string, fields: readonly Field[], tail: string, ...params: SQLInputValue[]): T[] {
    return this.all(`SELECT ${selectList(fields)} FROM ${table} ${tail}`, ...params).map((r) => fromRow<T>(fields, r));
  }

  private patchRow(table: string, fields: readonly Field[], idCol: string, id: string, patch: object, exclude: readonly string[], what: string): void {
    const set = updateSet(fields, patch, exclude);
    if (!set) {
      if (!this.get(`SELECT 1 AS x FROM ${table} WHERE ${idCol} = ?`, id)) throw new Error(`${what} not found: ${id}`);
      return;
    }
    const changes = this.run(`UPDATE ${table} SET ${set.sql} WHERE ${idCol} = ?`, ...set.params, id);
    if (changes === 0) throw new Error(`${what} not found: ${id}`);
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  // ------------------------------------------------------------------------------- lifecycle

  async migrate(): Promise<void> {
    this.assertOpen();
    const current = Number((this.get('PRAGMA user_version') ?? { user_version: 0 }).user_version);
    if (current > MIGRATIONS.length) throw new Error(`database schema v${current} is newer than this build supports (v${MIGRATIONS.length})`);
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v]!;
      this.tx(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.isMemory) {
      try {
        this.db.exec('PRAGMA optimize');
      } catch {
        /* best effort */
      }
    }
    this.stmts.clear();
    this.db.close();
    this.closed = true;
  }

  // ------------------------------------------------------------------------------- athletes

  async createAthlete(input: { id?: string; displayName: string; isAdmin: boolean; settings: AthleteSettings }): Promise<AthleteRecord> {
    const rec: AthleteRecord = {
      id: input.id ?? newId('ath', this.clock),
      displayName: input.displayName,
      isAdmin: input.isAdmin,
      status: 'active',
      createdAt: this.nowIso(),
    };
    const settings = parseSettings(input.settings);
    this.tx(() => {
      this.run(insertSql('athletes', ATHLETE), ...toParams(ATHLETE, rec));
      this.run('INSERT INTO settings (athlete_id, json) VALUES (?, ?)', rec.id, JSON.stringify(settings));
    });
    return rec;
  }

  async getAthlete(id: string): Promise<AthleteRecord | undefined> {
    return this.one<AthleteRecord>('athletes', ATHLETE, 'id = ?', id);
  }

  async listAthletes(): Promise<AthleteRecord[]> {
    return this.many<AthleteRecord>('athletes', ATHLETE, 'ORDER BY created_at, id');
  }

  async updateAthlete(id: string, patch: Partial<Pick<AthleteRecord, 'displayName' | 'isAdmin' | 'status' | 'suspendedAt'>>): Promise<void> {
    const allowed = { displayName: patch.displayName, isAdmin: patch.isAdmin, status: patch.status, suspendedAt: patch.suspendedAt };
    this.patchRow('athletes', ATHLETE, 'id', id, allowed, ['id', 'createdAt'], 'athlete');
  }

  async deleteAthlete(id: string): Promise<void> {
    this.tx(() => {
      // Privacy includes caches and capability mappings, which do not have athlete_id columns.
      // Match namespace boundaries exactly (athlete ids contain '_' and must never be SQL LIKE patterns).
      this.run("DELETE FROM kv WHERE key IN (SELECT 'epoch-system:' || id FROM epochs WHERE athlete_id = ?)", id);
      this.run(`DELETE FROM idempotency WHERE EXISTS (
        SELECT 1 FROM turns WHERE athlete_id = ?
        AND substr(idempotency.key, 1, length('msg:' || turns.id || ':')) = 'msg:' || turns.id || ':'
      )`, id);
      for (const prefix of [`message:${id}:`, `tool:${id}:`, `export:${id}:`, `upload-draft:${id}:`, `image-attempt:${id}:`]) {
        this.run('DELETE FROM idempotency WHERE substr(key, 1, length(?)) = ?', prefix, prefix);
        this.run('DELETE FROM kv WHERE substr(key, 1, length(?)) = ?', prefix, prefix);
      }
      for (const key of [
        `view-token:${id}`, `app-manifest:${id}`, `harness-version:${id}`, `last-head:${id}`,
        `turns-since-pinned-write:${id}`, `telegram-athlete:${id}`, `upload-drafts:${id}`, `oauth-openrouter:${id}`,
      ]) this.run('DELETE FROM kv WHERE key = ?', key);
      this.run("DELETE FROM kv WHERE substr(key, 1, 7) = 'notice:' AND substr(key, -length(?)) = ?", `:${id}`, `:${id}`);
      this.run(`DELETE FROM kv WHERE value = ? AND (
        substr(key, 1, 15) = 'view-token-rev:' OR substr(key, 1, 14) = 'telegram-chat:'
      )`, id);
      this.run(`DELETE FROM kv WHERE substr(key, 1, 14) = 'telegram-link:'
        AND CASE WHEN json_valid(value) THEN json_extract(value, '$.athleteId') ELSE NULL END = ?`, id);
      this.run('DELETE FROM events_fts WHERE rowid IN (SELECT seq FROM events WHERE athlete_id = ?)', id);
      this.run('DELETE FROM events WHERE athlete_id = ?', id);
      this.run('DELETE FROM message_state WHERE athlete_id = ?', id);
      this.run('DELETE FROM blobs WHERE athlete_id = ?', id);
      this.run('DELETE FROM schedules WHERE athlete_id = ?', id);
      this.run('DELETE FROM epoch_items WHERE epoch_id IN (SELECT id FROM epochs WHERE athlete_id = ?)', id);
      this.run('DELETE FROM epochs WHERE athlete_id = ?', id);
      this.run('DELETE FROM turn_contexts WHERE athlete_id = ? OR turn_id IN (SELECT id FROM turns WHERE athlete_id = ?)', id, id);
      this.run('DELETE FROM turns WHERE athlete_id = ?', id);
      this.run('DELETE FROM tasks WHERE athlete_id = ?', id);
      this.run('DELETE FROM usage WHERE athlete_id = ?', id);
      this.run('DELETE FROM push_subscriptions WHERE athlete_id = ?', id);
      this.run('DELETE FROM ui_current WHERE athlete_id = ?', id);
      this.run('DELETE FROM ui_versions WHERE athlete_id = ?', id);
      this.run('DELETE FROM audit WHERE athlete_id = ?', id);
      this.run('DELETE FROM sessions WHERE athlete_id = ?', id);
      this.run('DELETE FROM passkeys WHERE athlete_id = ?', id);
      this.run('DELETE FROM credentials WHERE athlete_id = ?', id);
      this.run('DELETE FROM pairing_codes WHERE athlete_id = ?', id);
      this.run('UPDATE pairing_codes SET created_by = NULL WHERE created_by = ?', id);
      this.run('DELETE FROM idempotency WHERE expires_at <= ?', this.nowIso());
      this.run('DELETE FROM settings WHERE athlete_id = ?', id);
      this.run('DELETE FROM athletes WHERE id = ?', id);
    });
    if (!this.isMemory) {
      try {
        // Fold the WAL back so deleted (zeroed) pages do not linger in -wal history.
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* a concurrent reader can block TRUNCATE; the delete itself already committed */
      }
    }
  }

  async getSettings(athleteId: string): Promise<AthleteSettings> {
    const row = this.get('SELECT json FROM settings WHERE athlete_id = ?', athleteId);
    return parseSettings(row ? JSON.parse(String(row.json)) : undefined);
  }

  async updateSettings(athleteId: string, patch: unknown): Promise<{ settings: AthleteSettings; diff: Record<string, { from: unknown; to: unknown }> }> {
    return this.tx(() => {
      if (!this.get('SELECT 1 AS x FROM athletes WHERE id = ?', athleteId)) throw new Error(`athlete not found: ${athleteId}`);
      const row = this.get('SELECT json FROM settings WHERE athlete_id = ?', athleteId);
      const current = parseSettings(row ? JSON.parse(String(row.json)) : undefined);
      const merged = mergeSettings(current, patch);
      this.run(
        'INSERT INTO settings (athlete_id, json) VALUES (?, ?) ON CONFLICT (athlete_id) DO UPDATE SET json = excluded.json',
        athleteId,
        JSON.stringify(merged.settings),
      );
      return merged;
    });
  }

  // ------------------------------------------------------------------------------------ auth

  async createPairingCode(r: PairingCodeRecord): Promise<void> {
    this.run(insertSql('pairing_codes', PAIRING), ...toParams(PAIRING, r));
  }

  async consumePairingCode(code: string, nowIso: string): Promise<PairingCodeRecord | undefined> {
    const now = canonIso(nowIso);
    // Single UPDATE ... RETURNING: two concurrent consumers can never both win.
    const row = this.get(
      `UPDATE pairing_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL AND expires_at > ? RETURNING ${selectList(PAIRING)}`,
      now,
      code,
      now,
    );
    return row ? fromRow<PairingCodeRecord>(PAIRING, row) : undefined;
  }

  async hasAnyAthlete(): Promise<boolean> {
    return this.get('SELECT 1 AS x FROM athletes LIMIT 1') !== undefined;
  }

  async createSession(r: SessionRecord): Promise<void> {
    this.run(insertSql('sessions', SESSION), ...toParams(SESSION, r));
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | undefined> {
    return this.one<SessionRecord>('sessions', SESSION, 'token_hash = ?', tokenHash);
  }

  async touchSession(id: string, nowIso: string, expiresAt?: string): Promise<void> {
    if (expiresAt) this.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', nowIso, expiresAt, id);
    else this.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso, id);
  }

  async deleteSession(id: string): Promise<void> {
    this.run('DELETE FROM sessions WHERE id = ?', id);
  }

  async listSessions(athleteId: string): Promise<SessionRecord[]> {
    return this.many<SessionRecord>('sessions', SESSION, 'WHERE athlete_id = ? ORDER BY created_at DESC, id DESC', athleteId);
  }

  async addPasskey(r: PasskeyRecord): Promise<void> {
    this.run(insertSql('passkeys', PASSKEY), ...toParams(PASSKEY, r));
  }

  async listPasskeys(athleteId: string): Promise<PasskeyRecord[]> {
    return this.many<PasskeyRecord>('passkeys', PASSKEY, 'WHERE athlete_id = ? ORDER BY created_at, credential_id', athleteId);
  }

  async getPasskey(credentialId: string): Promise<PasskeyRecord | undefined> {
    return this.one<PasskeyRecord>('passkeys', PASSKEY, 'credential_id = ?', credentialId);
  }

  async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
    this.run('UPDATE passkeys SET counter = ? WHERE credential_id = ?', counter, credentialId);
  }

  // ------------------------------------------------------------------------------ credentials

  async setCredential(r: CredentialRecord): Promise<void> {
    this.run(insertSql('credentials', CREDENTIAL, { upsertOn: ['athlete_id', 'provider'] }), ...toParams(CREDENTIAL, r));
  }

  async listCredentials(athleteId?: string): Promise<CredentialRecord[]> {
    return athleteId === undefined
      ? this.many<CredentialRecord>('credentials', CREDENTIAL, 'ORDER BY athlete_id, provider')
      : this.many<CredentialRecord>('credentials', CREDENTIAL, 'WHERE athlete_id = ? ORDER BY provider', athleteId);
  }

  async deleteCredential(athleteId: string, provider: CredentialRecord['provider']): Promise<void> {
    this.run('DELETE FROM credentials WHERE athlete_id = ? AND provider = ?', athleteId, provider);
  }

  // ----------------------------------------------------------------------------------- events

  /**
   * Validates and defaults the payload (`parseEventPayload`), assigns `id` (default `newId('evt', clock)`)
   * and `ts` (default `clock.now()`, canonicalised to UTC), inserts the row and its FTS entry atomically.
   */
  async appendEvent<T extends EventType>(e: NewEvent<T>): Promise<EventEnvelope<T>> {
    if (!Object.hasOwn(EventPayloads, e.type)) throw new Error(`unknown event type: ${String(e.type)}`);
    if (e.tombstoned && (!e.payload || typeof e.payload !== 'object' || Object.keys(e.payload).length !== 1 || (e.payload as { tombstoned?: unknown }).tombstoned !== true)) {
      throw new Error('tombstoned event payload must be exactly { tombstoned: true }');
    }
    const payload = e.tombstoned ? TOMBSTONE_PAYLOAD as unknown as EventPayload<T> : parseEventPayload(e.type, e.payload as EventPayloadInput<T>);
    const id = e.id ?? newId('evt', this.clock);
    const ts = canonIso(e.ts ?? this.nowIso());
    const text = e.tombstoned ? undefined : extractSearchText(e.type, payload);
    this.tx(() => {
      const res = this.prep(
        `INSERT INTO events (id, athlete_id, ts, type, actor, turn_id, causation_id, payload, tombstoned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, e.athleteId, ts, e.type, e.actor, lit(e.turnId), lit(e.causationId), JSON.stringify(payload), e.tombstoned ? 1 : 0);
      if (text !== undefined) this.run('INSERT INTO events_fts (rowid, text) VALUES (?, ?)', res.lastInsertRowid as number, text);
    });
    const env: EventEnvelope<T> = { id, athleteId: e.athleteId, ts, type: e.type, actor: e.actor, payload };
    if (e.turnId !== undefined) env.turnId = e.turnId;
    if (e.causationId !== undefined) env.causationId = e.causationId;
    return env;
  }

  private rowToEvent(row: Row): AnyEvent {
    const ev: Record<string, unknown> = {
      id: row.id,
      athleteId: row.athlete_id,
      ts: row.ts,
      type: row.type,
      actor: row.actor,
    };
    if (row.turn_id !== null && row.turn_id !== undefined) ev.turnId = row.turn_id;
    if (row.causation_id !== null && row.causation_id !== undefined) ev.causationId = row.causation_id;
    ev.payload = JSON.parse(String(row.payload));
    return ev as unknown as AnyEvent;
  }

  async getEvent(id: string): Promise<AnyEvent | undefined> {
    const row = this.get(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`, id);
    return row ? this.rowToEvent(row) : undefined;
  }

  /**
   * List events of one athlete in id (== time) order.
   *
   * Window semantics (so cursor pagination works with the default order):
   *  - `afterId` set: the `limit` events immediately AFTER the cursor (oldest first window).
   *  - only `beforeId` set: the `limit` events immediately BEFORE the cursor (newest-first window).
   *  - no cursor: `order: 'desc'` selects the newest `limit` events, otherwise the oldest `limit`.
   * The selected window is then returned sorted by `order` (default 'asc', i.e. chat order), so a
   * "load older messages" call (`beforeId`, default order) yields the previous page oldest-first.
   * `since`/`until` are inclusive bounds on `ts`. An empty `types` array means "no type filter".
   * Tombstoned events are included (payload `{ tombstoned: true }`, see `isTombstoned`).
   */
  async listEvents(q: EventQuery): Promise<AnyEvent[]> {
    const where = ['athlete_id = ?'];
    const params: SQLInputValue[] = [q.athleteId];
    if (q.afterId) {
      where.push('id > ?');
      params.push(q.afterId);
    }
    if (q.beforeId) {
      where.push('id < ?');
      params.push(q.beforeId);
    }
    if (q.types && q.types.length > 0) {
      where.push(`type IN (${q.types.map(() => '?').join(', ')})`);
      params.push(...q.types);
    }
    if (q.since) {
      where.push('ts >= ?');
      params.push(canonIso(q.since));
    }
    if (q.until) {
      where.push('ts <= ?');
      params.push(canonIso(q.until));
    }
    const limit = Math.max(0, Math.floor(q.limit ?? 100));
    const order = q.order ?? 'asc';
    const newestWindow = q.afterId ? false : q.beforeId ? true : order === 'desc';
    const rows = this.all(
      `SELECT ${EVENT_COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY id ${newestWindow ? 'DESC' : 'ASC'} LIMIT ?`,
      ...params,
      limit,
    );
    if (newestWindow !== (order === 'desc')) rows.reverse();
    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * Full-text search over text-bearing events (tombstoned events excluded), best match first.
   * Terms are AND-ed (retried as OR when that finds nothing), "quoted phrases" and `prefix*` are
   * supported, and all user input is quoted so FTS syntax can never raise an error; if SQLite still
   * rejects the expression we fall back to a LIKE scan. `snippet` marks matches with `**`.
   * `from`/`to` are inclusive bounds on the event `ts`.
   */
  async searchEvents(q: {
    athleteId: string;
    query: string;
    from?: string;
    to?: string;
    types?: string[];
    limit?: number;
  }): Promise<Array<{ event: AnyEvent; snippet: string }>> {
    const { terms } = parseQuery(q.query);
    if (terms.length === 0) return [];
    const limit = Math.max(0, Math.floor(q.limit ?? 20));

    const filters: string[] = ['e.athlete_id = ?', 'e.tombstoned = 0'];
    const filterParams: SQLInputValue[] = [q.athleteId];
    if (q.types && q.types.length > 0) {
      filters.push(`e.type IN (${q.types.map(() => '?').join(', ')})`);
      filterParams.push(...q.types);
    }
    if (q.from) {
      filters.push('e.ts >= ?');
      filterParams.push(canonIso(q.from));
    }
    if (q.to) {
      filters.push('e.ts <= ?');
      filterParams.push(canonIso(q.to));
    }
    const cols = EVENT_COLS.split(', ')
      .map((c) => `e.${c}`)
      .join(', ');

    const ftsQuery = (match: string): Array<{ event: AnyEvent; snippet: string }> =>
      this.all(
        `SELECT ${cols}, snippet(events_fts, 0, '**', '**', '…', 24) AS snip
           FROM events_fts JOIN events e ON e.seq = events_fts.rowid
          WHERE events_fts MATCH ? AND ${filters.join(' AND ')}
          ORDER BY events_fts.rank, e.id DESC
          LIMIT ?`,
        match,
        ...filterParams,
        limit,
      ).map((r) => ({ event: this.rowToEvent(r), snippet: String(r.snip) }));

    try {
      let hits = ftsQuery(buildMatch(terms, 'and'));
      if (hits.length === 0 && terms.length > 1) hits = ftsQuery(buildMatch(terms, 'or'));
      return hits;
    } catch {
      // Defensive LIKE fallback (should be unreachable: every term is quoted).
      const likes = terms.map(() => `events_fts.text LIKE ? ESCAPE '\\'`).join(' AND ');
      return this.all(
        `SELECT ${cols}, events_fts.text AS body
           FROM events_fts JOIN events e ON e.seq = events_fts.rowid
          WHERE ${likes} AND ${filters.join(' AND ')}
          ORDER BY e.id DESC
          LIMIT ?`,
        ...terms.map((t) => `%${likeEscape(t.text)}%`),
        ...filterParams,
        limit,
      ).map((r) => ({ event: this.rowToEvent(r), snippet: plainSnippet(String(r.body), terms) }));
    }
  }

  async tombstoneEvent(id: string): Promise<void> {
    this.tx(() => {
      const row = this.get('SELECT seq FROM events WHERE id = ?', id);
      if (!row) return;
      this.run('DELETE FROM events_fts WHERE rowid = ?', row.seq as number);
      this.run('UPDATE events SET payload = ?, tombstoned = 1 WHERE id = ?', JSON.stringify(TOMBSTONE_PAYLOAD), id);
    });
  }

  // ------------------------------------------------------------------------- message delivery

  async putMessageState(r: MessageStateRecord): Promise<void> {
    // Upsert; a read mark already recorded is never lost when a later put omits readAt.
    const sql = `${insertSql('message_state', MESSAGE_STATE)} ON CONFLICT (message_id) DO UPDATE SET
      athlete_id = excluded.athlete_id, delivery = excluded.delivery, held_until = excluded.held_until,
      sent_at = excluded.sent_at, read_at = COALESCE(excluded.read_at, message_state.read_at), proactive = excluded.proactive`;
    this.run(sql, ...toParams(MESSAGE_STATE, r));
  }

  async getMessageState(messageId: string): Promise<MessageStateRecord | undefined> {
    return this.one<MessageStateRecord>('message_state', MESSAGE_STATE, 'message_id = ?', messageId);
  }

  async listHeldMessages(athleteId?: string): Promise<MessageStateRecord[]> {
    if (athleteId === undefined) return this.many<MessageStateRecord>('message_state', MESSAGE_STATE, `WHERE delivery = 'held' ORDER BY held_until, message_id`);
    return this.many<MessageStateRecord>('message_state', MESSAGE_STATE, `WHERE delivery = 'held' AND athlete_id = ? ORDER BY held_until, message_id`, athleteId);
  }

  async countProactiveSince(athleteId: string, sinceIso: string): Promise<number> {
    const row = this.get(
      `SELECT COUNT(*) AS n FROM message_state WHERE athlete_id = ? AND proactive = 1 AND delivery = 'sent' AND sent_at >= ?`,
      athleteId,
      canonIso(sinceIso),
    );
    return Number(row?.n ?? 0);
  }

  async lastProactiveAt(athleteId: string): Promise<string | undefined> {
    const row = this.get(`SELECT MAX(sent_at) AS at FROM message_state WHERE athlete_id = ? AND proactive = 1 AND delivery = 'sent'`, athleteId);
    return row && row.at !== null && row.at !== undefined ? String(row.at) : undefined;
  }

  async markRead(messageIds: string[], atIso: string): Promise<void> {
    const at = canonIso(atIso);
    this.tx(() => {
      for (let i = 0; i < messageIds.length; i += 500) {
        const chunk = messageIds.slice(i, i + 500);
        this.run(`UPDATE message_state SET read_at = ? WHERE read_at IS NULL AND message_id IN (${chunk.map(() => '?').join(', ')})`, at, ...chunk);
      }
    });
  }

  async countUnreadCoachMessages(athleteId: string): Promise<number> {
    const row = this.get(`SELECT COUNT(*) AS n FROM message_state WHERE athlete_id = ? AND delivery = 'sent' AND read_at IS NULL`, athleteId);
    return Number(row?.n ?? 0);
  }

  // ------------------------------------------------------------------------------------ blobs

  /** Upsert by (athleteId, sha256): a second put replaces the metadata (the bytes are content-addressed). */
  async putBlob(r: BlobRecord): Promise<void> {
    this.run(insertSql('blobs', BLOB, { upsertOn: ['athlete_id', 'sha256'] }), ...toParams(BLOB, r));
  }

  async getBlob(athleteId: string, sha256: string): Promise<BlobRecord | undefined> {
    return this.one<BlobRecord>('blobs', BLOB, 'athlete_id = ? AND sha256 = ?', athleteId, sha256);
  }

  /** Newest first. */
  async listBlobs(athleteId: string, opts?: { origin?: BlobRecord['origin']; limit?: number }): Promise<BlobRecord[]> {
    const where = ['athlete_id = ?'];
    const params: SQLInputValue[] = [athleteId];
    if (opts?.origin) {
      where.push('origin = ?');
      params.push(opts.origin);
    }
    let tail = `WHERE ${where.join(' AND ')} ORDER BY created_at DESC, sha256`;
    if (opts?.limit !== undefined) {
      tail += ' LIMIT ?';
      params.push(Math.max(0, Math.floor(opts.limit)));
    }
    return this.many<BlobRecord>('blobs', BLOB, tail, ...params);
  }

  async deleteBlob(athleteId: string, sha256: string): Promise<void> {
    this.run('DELETE FROM blobs WHERE athlete_id = ? AND sha256 = ?', athleteId, sha256);
  }

  // -------------------------------------------------------------------------------- schedules

  async upsertSchedule(s: ScheduleRecord): Promise<void> {
    this.run(insertSql('schedules', SCHEDULE, { upsertOn: ['id'] }), ...toParams(SCHEDULE, s));
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    return this.one<ScheduleRecord>('schedules', SCHEDULE, 'id = ?', id);
  }

  /** Soonest `nextFireAt` first (exhausted schedules last), then oldest created. */
  async listSchedules(athleteId: string, opts?: { status?: ScheduleRecord['status']; kind?: ScheduleRecord['kind'] }): Promise<ScheduleRecord[]> {
    const where = ['athlete_id = ?'];
    const params: SQLInputValue[] = [athleteId];
    if (opts?.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts?.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    return this.many<ScheduleRecord>('schedules', SCHEDULE, `WHERE ${where.join(' AND ')} ORDER BY next_fire_at IS NULL, next_fire_at, created_at, id`, ...params);
  }

  async dueSchedules(nowIso: string, limit?: number): Promise<ScheduleRecord[]> {
    const params: SQLInputValue[] = [canonIso(nowIso)];
    let tail = `WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at, id`;
    if (limit !== undefined) {
      tail += ' LIMIT ?';
      params.push(Math.max(0, Math.floor(limit)));
    }
    return this.many<ScheduleRecord>('schedules', SCHEDULE, tail, ...params);
  }

  async nextScheduleAt(): Promise<string | undefined> {
    const row = this.get(`SELECT MIN(next_fire_at) AS at FROM schedules WHERE status = 'active' AND next_fire_at IS NOT NULL`);
    return row && row.at !== null && row.at !== undefined ? String(row.at) : undefined;
  }

  // ---------------------------------------------------------------------------------- epochs

  async createEpoch(e: EpochRecord): Promise<void> {
    this.run(insertSql('epochs', EPOCH), ...toParams(EPOCH, e));
  }

  async getEpoch(id: string): Promise<EpochRecord | undefined> {
    return this.one<EpochRecord>('epochs', EPOCH, 'id = ?', id);
  }

  /** The most recently opened epoch with no `closedAt`. */
  async getOpenEpoch(athleteId: string): Promise<EpochRecord | undefined> {
    const rows = this.many<EpochRecord>('epochs', EPOCH, 'WHERE athlete_id = ? AND closed_at IS NULL ORDER BY opened_at DESC, id DESC LIMIT 1', athleteId);
    return rows[0];
  }

  async closeEpoch(id: string, reason: NonNullable<EpochRecord['closeReason']>, atIso: string, carryover?: string): Promise<void> {
    const changes = this.run('UPDATE epochs SET closed_at = ?, close_reason = ?, carryover = COALESCE(?, carryover) WHERE id = ?', atIso, reason, lit(carryover), id);
    if (changes === 0) throw new Error(`epoch not found: ${id}`);
  }

  /** Newest first. */
  async listEpochs(athleteId: string, limit?: number): Promise<EpochRecord[]> {
    const params: SQLInputValue[] = [athleteId];
    let tail = 'WHERE athlete_id = ? ORDER BY opened_at DESC, id DESC';
    if (limit !== undefined) {
      tail += ' LIMIT ?';
      params.push(Math.max(0, Math.floor(limit)));
    }
    return this.many<EpochRecord>('epochs', EPOCH, tail, ...params);
  }

  async appendEpochItems(items: EpochItemRecord[]): Promise<void> {
    if (items.length === 0) return;
    const sql = insertSql('epoch_items', EPOCH_ITEM);
    this.tx(() => {
      for (const it of items) this.run(sql, ...toParams(EPOCH_ITEM, it));
    });
  }

  async listEpochItems(epochId: string): Promise<EpochItemRecord[]> {
    return this.many<EpochItemRecord>('epoch_items', EPOCH_ITEM, 'WHERE epoch_id = ? ORDER BY seq', epochId);
  }

  // ----------------------------------------------------------------------------------- turns

  async insertTurn(t: TurnRecord): Promise<void> {
    this.run(insertSql('turns', TURN), ...toParams(TURN, t));
  }

  async updateTurn(id: string, patch: Partial<TurnRecord>): Promise<void> {
    this.patchRow('turns', TURN, 'id', id, patch, ['id'], 'turn');
  }

  async getTurn(id: string): Promise<TurnRecord | undefined> {
    return this.one<TurnRecord>('turns', TURN, 'id = ?', id);
  }

  /** Newest first (by id; turn ids are time-sortable). `beforeId` pages to older turns. */
  async listTurns(q: { athleteId?: string; limit?: number; beforeId?: string; agent?: AgentKind }): Promise<TurnRecord[]> {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.athleteId) {
      where.push('athlete_id = ?');
      params.push(q.athleteId);
    }
    if (q.beforeId) {
      where.push('id < ?');
      params.push(q.beforeId);
    }
    if (q.agent) {
      where.push('agent = ?');
      params.push(q.agent);
    }
    params.push(Math.max(0, Math.floor(q.limit ?? 50)));
    return this.many<TurnRecord>('turns', TURN, `${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params);
  }

  async saveTurnContext(turnId: string, context: unknown): Promise<void> {
    const owner = this.get('SELECT athlete_id FROM turns WHERE id = ?', turnId);
    this.run(
      `INSERT INTO turn_contexts (turn_id, athlete_id, context) VALUES (?, ?, ?)
       ON CONFLICT (turn_id) DO UPDATE SET athlete_id = COALESCE(excluded.athlete_id, turn_contexts.athlete_id), context = excluded.context`,
      turnId,
      owner ? String(owner.athlete_id) : null,
      JSON.stringify(context ?? null),
    );
  }

  async getTurnContext(turnId: string): Promise<unknown | undefined> {
    const row = this.get('SELECT context FROM turn_contexts WHERE turn_id = ?', turnId);
    return row ? JSON.parse(String(row.context)) : undefined;
  }

  // ----------------------------------------------------------------------------------- tasks

  async insertTask(t: TaskRecord): Promise<void> {
    this.run(insertSql('tasks', TASK), ...toParams(TASK, t));
  }

  async updateTask(id: string, patch: Partial<TaskRecord>): Promise<void> {
    this.patchRow('tasks', TASK, 'id', id, patch, ['id'], 'task');
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    return this.one<TaskRecord>('tasks', TASK, 'id = ?', id);
  }

  /** Oldest first. */
  async listTasks(athleteId: string, opts?: { state?: TaskRecord['state'] }): Promise<TaskRecord[]> {
    if (opts?.state) return this.many<TaskRecord>('tasks', TASK, 'WHERE athlete_id = ? AND state = ? ORDER BY created_at, id', athleteId, opts.state);
    return this.many<TaskRecord>('tasks', TASK, 'WHERE athlete_id = ? ORDER BY created_at, id', athleteId);
  }

  // ----------------------------------------------------------------------------------- usage

  async recordUsage(u: UsageRecord): Promise<void> {
    this.run(
      `INSERT INTO usage (athlete_id, turn_id, at, provider, model, tier, kind, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.athleteId,
      lit(u.turnId),
      canonIso(u.at),
      u.provider,
      u.model,
      lit(u.tier),
      u.kind,
      u.usage.inputTokens,
      u.usage.cachedInputTokens,
      u.usage.cacheWriteTokens,
      u.usage.outputTokens,
      u.costUsd,
    );
  }

  async sumUsage(athleteId: string, sinceIso: string): Promise<{ costUsd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }> {
    const row = this.get(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS outp, COALESCE(SUM(cached_input_tokens), 0) AS cached
         FROM usage WHERE athlete_id = ? AND at >= ?`,
      athleteId,
      canonIso(sinceIso),
    );
    return { costUsd: Number(row?.cost ?? 0), inputTokens: Number(row?.inp ?? 0), outputTokens: Number(row?.outp ?? 0), cachedInputTokens: Number(row?.cached ?? 0) };
  }

  /** Cost per UTC day (`substr(at, 1, 10)`) and athlete since `sinceIso`, oldest day first. */
  async usageByDay(athleteId: string | undefined, sinceIso: string): Promise<Array<{ day: string; athleteId: string; costUsd: number }>> {
    const params: SQLInputValue[] = [canonIso(sinceIso)];
    let where = 'at >= ?';
    if (athleteId !== undefined) {
      where += ' AND athlete_id = ?';
      params.push(athleteId);
    }
    return this.all(
      `SELECT substr(at, 1, 10) AS day, athlete_id, SUM(cost_usd) AS cost FROM usage WHERE ${where} GROUP BY day, athlete_id ORDER BY day, athlete_id`,
      ...params,
    ).map((r) => ({ day: String(r.day), athleteId: String(r.athlete_id), costUsd: Number(r.cost) }));
  }

  // ------------------------------------------------------------------------------------ push

  /** Re-subscribing the same endpoint replaces the previous row for that athlete. */
  async addPushSubscription(r: PushSubscriptionRecord): Promise<void> {
    this.tx(() => {
      this.run('DELETE FROM push_subscriptions WHERE athlete_id = ? AND endpoint = ? AND id <> ?', r.athleteId, r.endpoint, r.id);
      this.run(insertSql('push_subscriptions', PUSH, { upsertOn: ['id'] }), ...toParams(PUSH, r));
    });
  }

  async listPushSubscriptions(athleteId: string): Promise<PushSubscriptionRecord[]> {
    return this.many<PushSubscriptionRecord>('push_subscriptions', PUSH, 'WHERE athlete_id = ? ORDER BY created_at, id', athleteId);
  }

  async deletePushSubscription(id: string): Promise<void> {
    this.run('DELETE FROM push_subscriptions WHERE id = ?', id);
  }

  // ------------------------------------------------------------------------------- ui versions

  /** Versions are immutable: adding an existing (athlete, view, version) throws. */
  async addUiVersion(r: UiVersionRecord): Promise<void> {
    this.run(insertSql('ui_versions', UI_VERSION), ...toParams(UI_VERSION, r));
  }

  /** Newest version first (numeric order of `version`). */
  async listUiVersions(athleteId: string, viewId?: string): Promise<UiVersionRecord[]> {
    const order = 'ORDER BY view_id, CAST(version AS INTEGER) DESC, version DESC';
    if (viewId !== undefined) return this.many<UiVersionRecord>('ui_versions', UI_VERSION, `WHERE athlete_id = ? AND view_id = ? ${order}`, athleteId, viewId);
    return this.many<UiVersionRecord>('ui_versions', UI_VERSION, `WHERE athlete_id = ? ${order}`, athleteId);
  }

  async getUiVersion(athleteId: string, viewId: string, version: string): Promise<UiVersionRecord | undefined> {
    return this.one<UiVersionRecord>('ui_versions', UI_VERSION, 'athlete_id = ? AND view_id = ? AND version = ?', athleteId, viewId, version);
  }

  async getCurrentUiVersions(athleteId: string): Promise<UiVersionRecord[]> {
    const cols = UI_VERSION.map((f) => `v.${f.col}`).join(', ');
    return this.all(
      `SELECT ${cols} FROM ui_current c
         JOIN ui_versions v ON v.athlete_id = c.athlete_id AND v.view_id = c.view_id AND v.version = c.version
        WHERE c.athlete_id = ? ORDER BY c.view_id`,
      athleteId,
    ).map((r) => fromRow<UiVersionRecord>(UI_VERSION, r));
  }

  async setCurrentUiVersion(athleteId: string, viewId: string, version: string): Promise<void> {
    if (!this.get('SELECT 1 AS x FROM ui_versions WHERE athlete_id = ? AND view_id = ? AND version = ?', athleteId, viewId, version)) {
      throw new Error(`ui version not found: ${viewId}@${version}`);
    }
    this.run(
      'INSERT INTO ui_current (athlete_id, view_id, version) VALUES (?, ?, ?) ON CONFLICT (athlete_id, view_id) DO UPDATE SET version = excluded.version',
      athleteId,
      viewId,
      version,
    );
  }

  async clearCurrentUiVersion(athleteId: string, viewId: string): Promise<void> {
    this.run('DELETE FROM ui_current WHERE athlete_id = ? AND view_id = ?', athleteId, viewId);
  }

  // --------------------------------------------------------------------------- audit & misc

  async audit(r: AuditRecord): Promise<void> {
    this.run('INSERT INTO audit (athlete_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)', lit(r.athleteId), r.at, r.actor, r.action, r.detail === undefined ? null : JSON.stringify(r.detail));
  }

  /** Newest first. */
  async listAudit(athleteId: string, limit?: number): Promise<AuditRecord[]> {
    return this.all('SELECT athlete_id, at, actor, action, detail FROM audit WHERE athlete_id = ? ORDER BY id DESC LIMIT ?', athleteId, Math.max(0, Math.floor(limit ?? 100))).map((r) => {
      const rec: AuditRecord = { at: String(r.at), actor: String(r.actor), action: String(r.action) };
      if (r.athlete_id !== null && r.athlete_id !== undefined) rec.athleteId = String(r.athlete_id);
      if (r.detail !== null && r.detail !== undefined) rec.detail = JSON.parse(String(r.detail));
      return rec;
    });
  }

  /** Returns the stored value while unexpired (by the injected Clock); expired entries are purged lazily. */
  async getIdempotent(key: string): Promise<unknown | undefined> {
    const row = this.get('SELECT value, expires_at FROM idempotency WHERE key = ?', key);
    if (!row) return undefined;
    if (String(row.expires_at) <= this.nowIso()) {
      this.run('DELETE FROM idempotency WHERE key = ?', key);
      return undefined;
    }
    return JSON.parse(String(row.value));
  }

  async putIdempotent(key: string, value: unknown, expiresAtIso: string): Promise<void> {
    this.tx(() => {
      this.run('DELETE FROM idempotency WHERE expires_at <= ?', this.nowIso());
      this.run(
        'INSERT INTO idempotency (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
        key,
        JSON.stringify(value ?? null),
        canonIso(expiresAtIso),
      );
    });
  }

  async getKv(key: string): Promise<string | undefined> {
    const row = this.get('SELECT value FROM kv WHERE key = ?', key);
    return row ? String(row.value) : undefined;
  }

  async setKv(key: string, value: string): Promise<void> {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }
}
