import { z } from 'zod';
import { Actor, BlobRef, Channel, IsoDateTime, Tier, TriggerClass } from './common';
import { MicroUI } from './microui';
import { ScheduleSpec } from './schedule';

/**
 * Events (SPEC §5.1, Appendix C §C.1). Everything that happens is an event appended to the
 * athlete's durable, append-only event log. The runtime consumes inbound events and runs turns.
 * Payloads are camelCase (micro-UI inside coach.message stays snake_case: it is model-authored).
 */

export const Attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blob'), blob: BlobRef }),
  /** A workspace file snapshotted into the blob store at send time (so history never changes). */
  z.object({ kind: z.literal('file'), path: z.string(), blob: BlobRef }),
  z.object({ kind: z.literal('view_card'), viewId: z.string(), params: z.record(z.string(), z.string()).optional() }),
]);
export type Attachment = z.infer<typeof Attachment>;

export const DeliveryState = z.enum(['sent', 'held']);
export type DeliveryState = z.infer<typeof DeliveryState>;

export const NotifyLevel = z.enum(['none', 'silent', 'normal']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

export const NoticeKind = z.enum([
  'budget_warning',
  'budget_exhausted',
  'held_quiet_hours',
  'delivery_failed',
  'safety_flag',
  'fallback_used',
  'reply_fallback',
  'turn_failed',
  'message_released',
]);
export type NoticeKind = z.infer<typeof NoticeKind>;

/** Payload schemas keyed by event type. */
export const EventPayloads = {
  // ---- inbound: athlete
  'user.message': z.object({
    text: z.string().max(20_000),
    attachments: z.array(BlobRef).default([]),
    replyTo: z.string().optional(),
    channel: Channel.default('app'),
    clientId: z.string().max(100).optional(),
  }),
  'user.upload': z.object({ blobs: z.array(BlobRef).min(1).max(20), caption: z.string().max(4000).optional() }),
  'user.voice_note': z.object({
    blob: BlobRef,
    durationS: z.number().nonnegative(),
    transcript: z.string(),
    transcriptModel: z.string(),
  }),
  'user.ui_action': z.object({
    source: z.object({ messageId: z.string().optional(), viewId: z.string().optional() }),
    action: z.string().min(1).max(64),
    payload: z.unknown().optional(),
    wake: z.boolean(),
  }),
  'user.ui_write': z.object({
    viewId: z.string(),
    target: z.string(),
    op: z.enum(['insert', 'update', 'delete']),
    row: z.record(z.string(), z.unknown()),
    key: z.record(z.string(), z.unknown()).optional(),
  }),
  'user.reaction': z.object({ messageId: z.string(), reaction: z.string().max(32) }),
  'user.read': z.object({ messageIds: z.array(z.string()).max(500) }),
  'user.settings_changed': z.object({ diff: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })) }),
  'user.message_deleted': z.object({ messageId: z.string() }),
  'user.view_reverted': z.object({ viewId: z.string(), fromVersion: z.string(), toVersion: z.string() }),
  'device.context': z.object({
    tz: z.string(),
    locale: z.string(),
    coarseLocation: z.object({ city: z.string().optional(), country: z.string().optional() }).optional(),
  }),
  // ---- calls
  'call.started': z.object({ callId: z.string(), mode: z.enum(['realtime', 'cascaded']), provider: z.string(), model: z.string() }),
  'call.ended': z.object({
    callId: z.string(),
    durationS: z.number().nonnegative(),
    transcriptPath: z.string(),
    notesPath: z.string(),
    endedBy: z.enum(['athlete', 'coach', 'error']),
  }),
  // ---- system / harness triggers
  'schedule.fired': z.object({
    scheduleId: z.string(),
    purpose: z.string(),
    payload: z.unknown().optional(),
    scheduledFor: IsoDateTime,
    createdAt: IsoDateTime,
  }),
  'system.heartbeat': z.object({}),
  'system.consolidate': z.object({ epochId: z.string().optional() }),
  'task.completed': z.object({
    taskId: z.string(),
    profile: z.string().optional(),
    summary: z.string(),
    outputs: z.array(z.string()).default([]),
    originEventId: z.string().optional(),
  }),
  'task.failed': z.object({
    taskId: z.string(),
    profile: z.string().optional(),
    summary: z.string(),
    error: z.string(),
    originEventId: z.string().optional(),
  }),
  'ui.error': z.object({
    viewId: z.string(),
    version: z.string(),
    message: z.string().max(4000),
    stack: z.string().max(20_000).optional(),
    device: z.object({ ua: z.string().max(500), viewport: z.string().max(40) }),
  }),
  'workspace.external_change': z.object({ commits: z.array(z.string()), filesChanged: z.number().int(), summary: z.string() }),
  'harness.upgraded': z.object({ from: z.string(), to: z.string(), changelogPath: z.string() }),
  'data.synced': z.object({
    source: z.enum(['health_connect', 'healthkit']),
    blobs: z.array(BlobRef),
    range: z.tuple([IsoDateTime, IsoDateTime]),
  }),
  // ---- outbound / trace
  'coach.message': z.object({
    messageId: z.string(),
    text: z.string(),
    attachments: z.array(Attachment).default([]),
    ui: MicroUI.optional(),
    voiceNote: BlobRef.optional(),
    notify: NotifyLevel,
    delivery: DeliveryState,
    heldUntil: IsoDateTime.optional(),
    proactive: z.boolean(),
    channel: Channel.default('app'),
    replyTo: z.string().optional(),
  }),
  'coach.ui_published': z.object({ viewId: z.string(), version: z.string(), commit: z.string(), summary: z.string() }),
  'coach.schedule_changed': z.object({
    scheduleId: z.string(),
    op: z.enum(['create', 'update', 'cancel']),
    spec: ScheduleSpec.optional(),
    purpose: z.string().optional(),
  }),
  'coach.turn': z.object({
    turnId: z.string(),
    triggerClass: TriggerClass,
    triggerEventIds: z.array(z.string()),
    tier: Tier,
    provider: z.string(),
    model: z.string(),
    steps: z.number().int(),
    tokens: z.object({ input: z.number(), cached: z.number(), cacheWrite: z.number(), output: z.number() }),
    costUsd: z.number(),
    durationMs: z.number(),
    commit: z.string().optional(),
    fallbacks: z.array(z.string()).default([]),
    note: z.string().default(''),
    status: z.enum(['ok', 'error', 'limit', 'aborted']),
    error: z.string().optional(),
  }),
  'harness.notice': z.object({ kind: NoticeKind, detail: z.unknown().optional(), athleteVisible: z.boolean(), text: z.string().optional() }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;
/** Input type (before defaults are applied). */
export type EventPayloadInput<T extends EventType> = z.input<(typeof EventPayloads)[T]>;

export interface EventEnvelope<T extends EventType = EventType> {
  id: string;
  athleteId: string;
  /** From the injectable Clock. */
  ts: string;
  type: T;
  actor: Actor;
  turnId?: string;
  causationId?: string;
  payload: EventPayload<T>;
}

/** Discriminated union over all event types (use with `switch (e.type)`). */
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

export interface NewEvent<T extends EventType = EventType> {
  athleteId: string;
  type: T;
  actor: Actor;
  payload: EventPayloadInput<T>;
  turnId?: string;
  causationId?: string;
  /** Optional explicit id (e.g. message ids allocated before append). */
  id?: string;
  /** Optional explicit ts (defaults to clock.now()). */
  ts?: string;
}

export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  const schema = EventPayloads[type] as unknown as z.ZodType<EventPayload<T>>;
  return schema.parse(payload);
}

/** Inbound event types that start or steer turns (see SPEC §5.2 trigger classes). */
export const REACTIVE_TYPES = ['user.message', 'user.upload', 'user.voice_note'] as const satisfies readonly EventType[];
export const FOLLOWUP_TYPES = [
  'task.completed',
  'task.failed',
  'call.ended',
  'ui.error',
  'harness.upgraded',
  'workspace.external_change',
  'user.view_reverted',
  'data.synced',
] as const satisfies readonly EventType[];
export const SCHEDULED_TYPES = ['schedule.fired', 'system.heartbeat'] as const satisfies readonly EventType[];

/** Event types an athlete can see in their chat history (GET /v1/events). */
export const ATHLETE_VISIBLE_TYPES = [
  'user.message',
  'user.upload',
  'user.voice_note',
  'user.ui_action',
  'user.message_deleted',
  'coach.message',
  'coach.ui_published',
  'call.started',
  'call.ended',
  'harness.notice', // filtered further by payload.athleteVisible
] as const satisfies readonly EventType[];

/** Event types the athlete (client) may submit through the gateway. */
export const CLIENT_SUBMITTABLE_TYPES = [
  'user.message',
  'user.upload',
  'user.voice_note',
  'user.ui_action',
  'user.ui_write',
  'user.reaction',
  'user.read',
  'user.message_deleted',
  'device.context',
  'ui.error',
] as const satisfies readonly EventType[];
