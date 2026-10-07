import type { RunTurnResult } from './agent';
import type { AnyEvent, EventEnvelope, EventPayloadInput, NoticeKind, NewEvent } from './events';
import type { SafetyCategory } from './services';
import type { AthleteSettings } from './settings';
import type { AthleteRecord, UiVersionRecord } from './store';
import type { AppInfo } from './views';
import type { Tier } from './common';
import type { TierConfig } from './model';

/**
 * Runtime API consumed by the gateway (apps/server), the voice service and the eval simulator.
 * Implemented by @opencoach/runtime.
 */

export type PresenceState = 'idle' | 'thinking' | 'working' | 'typing';

/** Server → client stream messages (WS /v1/stream), modeled on AG-UI's event vocabulary (SPEC §15). */
export type StreamMessage =
  | { t: 'presence'; state: PresenceState }
  | { t: 'progress'; turnId: string; label: string }
  /** A coach message is being written (reactive/call turns only). `streamId` = tool call id. */
  | { t: 'message.start'; streamId: string; replyTo?: string }
  | { t: 'message.delta'; streamId: string; textDelta: string }
  /** Authoritative final message; replaces the provisional bubble with the same streamId. */
  | { t: 'message.end'; streamId?: string; event: EventEnvelope<'coach.message'> }
  /** Provisional bubble must be removed (message rejected or turn failed before sending). */
  | { t: 'message.cancel'; streamId: string; reason: string }
  /** Any other athlete-visible event (own messages echoed to other devices, uploads, ui_published, calls, notices). */
  | { t: 'event'; event: AnyEvent }
  | { t: 'ui.published'; viewId: string; version: string; summary: string }
  /** Re-fetch this athlete's settings; the signal contains no settings or credentials. */
  | { t: 'settings.changed' }
  | { t: 'notice'; kind: NoticeKind; text: string; detail?: unknown }
  /** Harness-owned safety banner (SPEC [SAFE-2]); the coach cannot hide it. */
  | { t: 'safety'; categories: SafetyCategory[]; acute: boolean; text: string }
  | { t: 'call'; callId: string; state: 'speaking' | 'listening' | 'thinking' | 'ended'; text?: string };

export type StreamListener = (m: StreamMessage) => void;

export interface CreateAthleteInput {
  displayName: string;
  coachName?: string;
  tz: string;
  locale: string;
  units?: 'metric' | 'imperial';
  isAdmin: boolean;
  /** Consents captured at onboarding (ISO timestamps). */
  consents?: Partial<AthleteSettings['consents']>;
}

/** Client-submittable inbound events (validated by the gateway, see CLIENT_SUBMITTABLE_TYPES). */
export type InboundEventInput =
  | { type: 'user.message'; payload: EventPayloadInput<'user.message'> }
  | { type: 'user.upload'; payload: EventPayloadInput<'user.upload'> }
  | { type: 'user.voice_note'; payload: EventPayloadInput<'user.voice_note'> }
  | { type: 'user.ui_action'; payload: EventPayloadInput<'user.ui_action'> }
  | { type: 'user.reaction'; payload: EventPayloadInput<'user.reaction'> }
  | { type: 'user.read'; payload: EventPayloadInput<'user.read'> }
  | { type: 'user.message_deleted'; payload: EventPayloadInput<'user.message_deleted'> }
  | { type: 'device.context'; payload: EventPayloadInput<'device.context'> }
  | { type: 'ui.error'; payload: EventPayloadInput<'ui.error'> };

export interface ChangeEntry {
  commit: string;
  at: string;
  turnId?: string;
  summary: string;
  files: string[];
  kind: 'turn' | 'revert' | 'external' | 'seed' | 'publish';
}

export interface ViewsAPI {
  appInfo(athleteId: string): Promise<AppInfo>;
  /** Read-only SQL limited to the view's declared `db:` reads (SPEC §9.4). */
  query(athleteId: string, viewId: string, sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  /** Read a workspace file matching the view's declared `file:` reads. */
  readFile(athleteId: string, viewId: string, path: string): Promise<string>;
  /** Direct write to a declared target (SPEC [UI-1]); emits user.ui_write. */
  write(athleteId: string, viewId: string, input: { target: string; op: 'insert' | 'update' | 'delete'; row: Record<string, unknown>; key?: Record<string, unknown> }): Promise<AnyEvent>;
  /** Emits user.ui_action (wakes the coach when wake=true). Validates `name` against manifest.actions. */
  act(athleteId: string, viewId: string, input: { name: string; payload?: unknown; wake?: boolean }): Promise<AnyEvent>;
  versions(athleteId: string, viewId: string): Promise<UiVersionRecord[]>;
  /** Athlete-initiated revert (SPEC [WS-5]); emits user.view_reverted. */
  revert(athleteId: string, viewId: string, toVersion?: string): Promise<UiVersionRecord>;
}

export interface CoachRuntimeAPI {
  start(): Promise<void>;
  stop(): Promise<void>;

  createAthlete(input: CreateAthleteInput): Promise<AthleteRecord>;
  /** Hard delete: rows, workspace, blobs, snapshots (SPEC [SEC-6]). */
  deleteAthlete(athleteId: string): Promise<void>;
  /** Start over: a fresh coach (workspace, conversation, views) on the same account; account, role, sign-ins and keys stay. */
  resetAthlete(athleteId: string): Promise<void>;
  updateSettings(athleteId: string, patch: unknown): Promise<AthleteSettings>;

  /** Validate + append a client-submitted event and wake the athlete's mind if needed. */
  ingest(athleteId: string, input: InboundEventInput): Promise<AnyEvent>;
  /** Trusted server-side producers (voice service, channel adapters). */
  appendSystemEvent(e: NewEvent): Promise<AnyEvent>;

  subscribe(athleteId: string, listener: StreamListener): () => void;
  presence(athleteId: string): PresenceState;

  readonly views: ViewsAPI;
  listChanges(athleteId: string, opts?: { before?: string; limit?: number }): Promise<ChangeEntry[]>;
  /** Contents of workspace/exports/calendar.ics if present. */
  calendarIcs(athleteId: string): Promise<string | undefined>;

  /** Voice: ask the main coach a question mid-call (SPEC §11.2 consult_coach). */
  consult(athleteId: string, question: string, context?: string): Promise<string>;
  /** Voice: read-only lookup over the workspace for the voice front-end. */
  lookup(athleteId: string, query: string): Promise<string>;
  /** Voice: compile the call briefing (SPEC §11.2 step 1). */
  callBriefing(athleteId: string, purpose?: string): Promise<string>;
  /** Cascaded calls: run a `call` turn for one athlete utterance; returns what the coach says. */
  callTurn(athleteId: string, callId: string, utterance: string): Promise<{ replyText: string }>;

  /** Admin. */
  forceEpoch(athleteId: string): Promise<void>;
  replayTurn(turnId: string, opts?: { tier?: Tier; override?: TierConfig }): Promise<RunTurnResult>;
}

/**
 * Delivery hook (implemented by the gateway): called for every coach message that is SENT (not held),
 * including held messages when released. The gateway pushes to connected WS clients itself via
 * subscribe(); this hook is for out-of-band delivery (Web Push, Telegram, ...).
 */
export type DeliveryHook = (athleteId: string, message: EventEnvelope<'coach.message'>, ctx: { connectedClients: number }) => Promise<void>;
