import type { AgentKind, BlobRef, Tier, TriggerClass } from './common';
import type { ConvItem } from './conversation';
import type { AnyEvent, EventEnvelope, EventType, NewEvent } from './events';
import type { Usage } from './model';
import type { ScheduleRecord } from './schedule';
import type { AthleteSettings } from './settings';
import type { ViewManifest } from './views';

/**
 * System store (harness-owned state, SPEC §4.1). SQLite (node:sqlite, WAL, FTS5) for self-host;
 * Postgres later behind the same interface. All methods are async for that reason.
 */

export interface AthleteRecord {
  id: string;
  displayName: string;
  isAdmin: boolean;
  status: 'active' | 'deleted';
  /** Set while an administrator has suspended the account: no sign-in, no sessions, no coach turns. Data is kept. */
  suspendedAt?: string | null;
  createdAt: string;
}

/** Whether an account may sign in, use sessions and have its coach run (not deleted, not suspended). */
export function accountUsable(a: Pick<AthleteRecord, 'status' | 'suspendedAt'> | undefined | null): boolean {
  return !!a && a.status === 'active' && !a.suspendedAt;
}

export interface SessionRecord {
  id: string;
  athleteId: string;
  /** sha256 hex of the bearer/cookie token; raw tokens are never stored. */
  tokenHash: string;
  kind: 'cookie' | 'bearer';
  deviceName?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface PairingCodeRecord {
  code: string;
  purpose: 'setup' | 'link_device' | 'invite';
  athleteId?: string;
  createdBy?: string;
  isAdmin?: boolean;
  expiresAt: string;
  consumedAt?: string;
}

export interface PasskeyRecord {
  credentialId: string; // base64url
  athleteId: string;
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
  deviceName?: string;
  createdAt: string;
}

/**
 * An athlete's provider API key, encrypted at rest by the gateway [SEC-1]. `owner` says who supplied it:
 * the athlete (bring your own key) or an administrator (a managed per-athlete key).
 */
export interface CredentialRecord {
  athleteId: string;
  provider: 'openrouter' | 'openai';
  owner: 'athlete' | 'admin';
  ciphertext: string;
  /** Masked display form, e.g. "sk-or-…9a1f". Never the key. */
  hint: string;
  updatedAt: string;
}

export type BlobOrigin = 'athlete' | 'coach' | 'sync' | 'call' | 'system';

export interface BlobRecord extends BlobRef {
  athleteId: string;
  origin: BlobOrigin;
  createdAt: string;
  /** Path relative to the athlete's blob directory. */
  relPath: string;
  meta?: Record<string, unknown>;
}

export interface EpochRecord {
  id: string;
  athleteId: string;
  /** Athlete-local date the epoch belongs to (YYYY-MM-DD). */
  localDate: string;
  /** 1-based sequence within the local date (compaction rollovers increment it). */
  seq: number;
  provider: string;
  model: string;
  openedAt: string;
  closedAt?: string;
  closeReason?: 'day_boundary' | 'model_change' | 'compaction' | 'forced' | 'error';
  /** Harness-compaction summary carried into the next epoch's context (if any). */
  carryover?: string;
}

export interface EpochItemRecord {
  epochId: string;
  seq: number;
  turnId?: string;
  item: ConvItem;
  tokens: number;
  createdAt: string;
}

export type TurnStatus = 'running' | 'ok' | 'error' | 'limit' | 'aborted';

export interface TurnRecord {
  id: string;
  athleteId: string;
  epochId?: string;
  agent: AgentKind;
  parentTurnId?: string;
  taskId?: string;
  triggerClass: TriggerClass;
  triggerEventIds: string[];
  tier: Tier;
  provider?: string;
  model?: string;
  status: TurnStatus;
  startedAt: string;
  endedAt?: string;
  steps: number;
  usage: Usage;
  costUsd: number;
  commit?: string;
  note?: string;
  error?: string;
  fallbacks: string[];
}

export interface TaskRecord {
  id: string;
  athleteId: string;
  parentTurnId: string;
  profile?: string;
  task: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  background: boolean;
  createdAt: string;
  endedAt?: string;
  summary?: string;
  outputs: string[];
  costUsd: number;
  error?: string;
  originEventId?: string;
}

export type UsageKind = 'turn' | 'helper' | 'voice' | 'stt' | 'tts' | 'safety' | 'consolidation' | 'image';

export interface UsageRecord {
  athleteId: string;
  turnId?: string;
  at: string;
  provider: string;
  model: string;
  tier?: Tier;
  kind: UsageKind;
  usage: Usage;
  costUsd: number;
}

export interface PushSubscriptionRecord {
  id: string;
  athleteId: string;
  kind: 'webpush' | 'fcm' | 'apns';
  endpoint: string;
  keys?: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: string;
}

export interface UiVersionRecord {
  athleteId: string;
  viewId: string;
  /** Monotonic per view: "1", "2", ... */
  version: string;
  commit: string;
  summary: string;
  publishedAt: string;
  publishedBy: 'coach' | 'athlete_revert' | 'seed' | 'rollback';
  manifest: ViewManifest;
  /** Host dir holding the immutable published files for this version. */
  dir: string;
}

export interface MessageStateRecord {
  messageId: string;
  athleteId: string;
  delivery: 'held' | 'sent';
  heldUntil?: string;
  sentAt?: string;
  readAt?: string;
  proactive: boolean;
}

export interface AuditRecord {
  athleteId?: string;
  at: string;
  actor: string;
  action: string;
  detail?: unknown;
}

export interface EventQuery {
  athleteId: string;
  afterId?: string;
  beforeId?: string;
  types?: readonly EventType[] | readonly string[];
  since?: string;
  until?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;

  // athletes
  createAthlete(input: { id?: string; displayName: string; isAdmin: boolean; settings: AthleteSettings }): Promise<AthleteRecord>;
  getAthlete(id: string): Promise<AthleteRecord | undefined>;
  listAthletes(): Promise<AthleteRecord[]>;
  updateAthlete(id: string, patch: Partial<Pick<AthleteRecord, 'displayName' | 'isAdmin' | 'status' | 'suspendedAt'>>): Promise<void>;
  /** Hard delete of every row belonging to the athlete (SPEC [SEC-6]). */
  deleteAthlete(id: string): Promise<void>;
  getSettings(athleteId: string): Promise<AthleteSettings>;
  /** Deep-merges and validates; returns the new settings and a flat diff. */
  updateSettings(athleteId: string, patch: unknown): Promise<{ settings: AthleteSettings; diff: Record<string, { from: unknown; to: unknown }> }>;

  // auth
  createPairingCode(r: PairingCodeRecord): Promise<void>;
  /** Atomically consumes an unexpired, unconsumed code. */
  consumePairingCode(code: string, nowIso: string): Promise<PairingCodeRecord | undefined>;
  hasAnyAthlete(): Promise<boolean>;
  createSession(r: SessionRecord): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  /** Records activity; with `expiresAt`, also extends the session in place (atomic renewal). */
  touchSession(id: string, nowIso: string, expiresAt?: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  listSessions(athleteId: string): Promise<SessionRecord[]>;
  addPasskey(r: PasskeyRecord): Promise<void>;
  listPasskeys(athleteId: string): Promise<PasskeyRecord[]>;
  getPasskey(credentialId: string): Promise<PasskeyRecord | undefined>;
  updatePasskeyCounter(credentialId: string, counter: number): Promise<void>;

  // provider credentials (encrypted by the caller)
  setCredential(r: CredentialRecord): Promise<void>;
  listCredentials(athleteId?: string): Promise<CredentialRecord[]>;
  deleteCredential(athleteId: string, provider: CredentialRecord['provider']): Promise<void>;

  // events (append-only; FTS5 over text-bearing payloads)
  appendEvent<T extends EventType>(e: NewEvent<T>): Promise<EventEnvelope<T>>;
  getEvent(id: string): Promise<AnyEvent | undefined>;
  listEvents(q: EventQuery): Promise<AnyEvent[]>;
  searchEvents(q: { athleteId: string; query: string; from?: string; to?: string; types?: string[]; limit?: number }): Promise<Array<{ event: AnyEvent; snippet: string }>>;
  /** Replace payload text with a tombstone (privacy deletion) while keeping the row. */
  tombstoneEvent(id: string): Promise<void>;

  // message delivery state
  putMessageState(r: MessageStateRecord): Promise<void>;
  getMessageState(messageId: string): Promise<MessageStateRecord | undefined>;
  listHeldMessages(athleteId?: string): Promise<MessageStateRecord[]>;
  /** Count proactive messages sent (or held-then-sent) for an athlete since `sinceIso`. */
  countProactiveSince(athleteId: string, sinceIso: string): Promise<number>;
  lastProactiveAt(athleteId: string): Promise<string | undefined>;
  markRead(messageIds: string[], atIso: string): Promise<void>;
  countUnreadCoachMessages(athleteId: string): Promise<number>;

  // blobs (metadata; bytes live on disk via BlobStore)
  putBlob(r: BlobRecord): Promise<void>;
  getBlob(athleteId: string, sha256: string): Promise<BlobRecord | undefined>;
  listBlobs(athleteId: string, opts?: { origin?: BlobRecord['origin']; limit?: number }): Promise<BlobRecord[]>;
  deleteBlob(athleteId: string, sha256: string): Promise<void>;

  // schedules
  upsertSchedule(s: ScheduleRecord): Promise<void>;
  getSchedule(id: string): Promise<ScheduleRecord | undefined>;
  listSchedules(athleteId: string, opts?: { status?: ScheduleRecord['status']; kind?: ScheduleRecord['kind'] }): Promise<ScheduleRecord[]>;
  /** Active schedules with nextFireAt <= nowIso, oldest first. */
  dueSchedules(nowIso: string, limit?: number): Promise<ScheduleRecord[]>;
  /** Earliest nextFireAt among active schedules (for the scheduler's sleep). */
  nextScheduleAt(): Promise<string | undefined>;

  // epochs
  createEpoch(e: EpochRecord): Promise<void>;
  getEpoch(id: string): Promise<EpochRecord | undefined>;
  getOpenEpoch(athleteId: string): Promise<EpochRecord | undefined>;
  closeEpoch(id: string, reason: NonNullable<EpochRecord['closeReason']>, atIso: string, carryover?: string): Promise<void>;
  listEpochs(athleteId: string, limit?: number): Promise<EpochRecord[]>;
  appendEpochItems(items: EpochItemRecord[]): Promise<void>;
  listEpochItems(epochId: string): Promise<EpochItemRecord[]>;

  // turns
  insertTurn(t: TurnRecord): Promise<void>;
  updateTurn(id: string, patch: Partial<TurnRecord>): Promise<void>;
  getTurn(id: string): Promise<TurnRecord | undefined>;
  listTurns(q: { athleteId?: string; limit?: number; beforeId?: string; agent?: AgentKind }): Promise<TurnRecord[]>;
  /** Assembled request snapshot for replay (SPEC §18). */
  saveTurnContext(turnId: string, context: unknown): Promise<void>;
  getTurnContext(turnId: string): Promise<unknown | undefined>;

  // helper tasks
  insertTask(t: TaskRecord): Promise<void>;
  updateTask(id: string, patch: Partial<TaskRecord>): Promise<void>;
  getTask(id: string): Promise<TaskRecord | undefined>;
  listTasks(athleteId: string, opts?: { state?: TaskRecord['state'] }): Promise<TaskRecord[]>;

  // usage & budgets
  recordUsage(u: UsageRecord): Promise<void>;
  sumUsage(athleteId: string, sinceIso: string): Promise<{ costUsd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }>;
  usageByDay(athleteId: string | undefined, sinceIso: string): Promise<Array<{ day: string; athleteId: string; costUsd: number }>>;

  // push
  addPushSubscription(r: PushSubscriptionRecord): Promise<void>;
  listPushSubscriptions(athleteId: string): Promise<PushSubscriptionRecord[]>;
  deletePushSubscription(id: string): Promise<void>;

  // published views
  addUiVersion(r: UiVersionRecord): Promise<void>;
  listUiVersions(athleteId: string, viewId?: string): Promise<UiVersionRecord[]>;
  getUiVersion(athleteId: string, viewId: string, version: string): Promise<UiVersionRecord | undefined>;
  /** Current (served) version per view. */
  getCurrentUiVersions(athleteId: string): Promise<UiVersionRecord[]>;
  setCurrentUiVersion(athleteId: string, viewId: string, version: string): Promise<void>;
  /** Remove a view from the served set (e.g. deleted by the coach). */
  clearCurrentUiVersion(athleteId: string, viewId: string): Promise<void>;

  // audit & misc
  audit(r: AuditRecord): Promise<void>;
  listAudit(athleteId: string, limit?: number): Promise<AuditRecord[]>;
  getIdempotent(key: string): Promise<unknown | undefined>;
  putIdempotent(key: string, value: unknown, expiresAtIso: string): Promise<void>;
  getKv(key: string): Promise<string | undefined>;
  setKv(key: string, value: string): Promise<void>;
}
