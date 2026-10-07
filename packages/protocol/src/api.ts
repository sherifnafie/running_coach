import { z } from 'zod';
import { Channel, IanaTimeZone, Sha256 } from './common';
import { CLIENT_SUBMITTABLE_TYPES, type AnyEvent } from './events';
import type { AthleteSettings } from './settings';
import type { CallSessionInfo } from './voice';

/**
 * Gateway HTTP/WS API DTOs (SPEC §15, Appendix C §C.5). JSON bodies are camelCase.
 * Request bodies have zod schemas (validated server-side); responses are typed interfaces.
 */

// ---- auth ---------------------------------------------------------------------------------

export const SetupRequest = z.object({
  code: z.string().min(4).max(20),
  displayName: z.string().min(1).max(80),
  coachName: z.string().min(1).max(40).optional(),
  tz: IanaTimeZone,
  locale: z.string().min(2).max(20),
  units: z.enum(['metric', 'imperial']).optional(),
  consents: z.object({ healthData: z.literal(true), aiDisclosure: z.literal(true), ageConfirmed18: z.literal(true) }),
  deviceName: z.string().max(80).optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const PairRequest = z.object({ code: z.string().min(4).max(20), deviceName: z.string().max(80).optional() });
export type PairRequest = z.infer<typeof PairRequest>;

export interface AuthResponse {
  athleteId: string;
  /** Bearer token (also set as httpOnly cookie for web). */
  token: string;
  expiresAt: string;
}

export interface MeResponse {
  athlete: { id: string; displayName: string; isAdmin: boolean };
  settings: AthleteSettings;
  viewsOrigin: string;
  kitUrl: string;
  vapidPublicKey?: string;
  features: { voiceNotes: boolean; calls: { realtime: boolean; cascaded: boolean }; passkeys: boolean; push: boolean; webSearch: boolean; imageGeneration?: boolean; models?: boolean; dictation?: boolean };
  /** Who pays for this athlete's model calls (see AiAccessSummary). */
  billing?: 'managed' | 'byok';
  harnessVersion: string;
  /** Present when the server runs the scripted demo coach (no API keys). */
  demoMode: boolean;
}

/**
 * GET /v1/ai and the /admin/athletes/:id/ai family. `managed`: the deployment or an administrator pays and the
 * monthly budget is a hard allowance; `byok`: the athlete's own OpenRouter key. Keys are never returned, only a hint.
 */
export interface AiAccessSummary {
  billing: 'managed' | 'byok';
  openrouterKey: { owner: 'athlete' | 'admin'; hint: string; updatedAt: string } | null;
  model: string;
  defaultModel: string;
  catalog: Array<{ id: string; label: string; description: string; vision: boolean }>;
  budgets: { dailyUsd: number; monthlyUsd: number };
  usage: { todayUsd: number; monthUsd: number };
}

// ---- messaging & events ----------------------------------------------------------------------

export const PostMessageRequest = z.object({
  text: z.string().max(20_000),
  attachments: z.array(Sha256).max(20).optional(),
  replyTo: z.string().optional(),
  clientId: z.string().max(100),
  channel: Channel.optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

/** Optional multipart metadata; recording duration is a playback hint when STT omits it. */
export const VoiceNoteMetadata = z.object({ durationS: z.number().nonnegative().max(86_400).optional() });
export type VoiceNoteMetadata = z.infer<typeof VoiceNoteMetadata>;

export interface PostEventResponse {
  event: AnyEvent;
}

export interface EventsPage {
  events: AnyEvent[];
  hasMore: boolean;
}

export const UiActionRequest = z.object({
  source: z.object({ messageId: z.string().optional(), viewId: z.string().optional() }),
  action: z.string().min(1).max(64),
  payload: z.unknown().optional(),
  wake: z.boolean().default(true),
});

export const ViewQueryRequest = z.object({ sql: z.string().max(20_000), params: z.array(z.unknown()).max(100).optional() });
export const ViewFileRequest = z.object({ path: z.string().max(500) });
export const ViewWriteRequest = z.object({
  target: z.string(),
  op: z.enum(['insert', 'update', 'delete']),
  row: z.record(z.string(), z.unknown()),
  key: z.record(z.string(), z.unknown()).optional(),
});
export const ViewActRequest = z.object({ name: z.string().max(64), payload: z.unknown().optional(), wake: z.boolean().optional() });
export const ViewErrorRequest = z.object({
  version: z.string(),
  message: z.string().max(4000),
  stack: z.string().max(20_000).optional(),
  viewport: z.string().max(40),
});
export const ViewRevertRequest = z.object({ toVersion: z.string().optional() });

export const ReactionRequest = z.object({ messageId: z.string(), reaction: z.string().max(32) });
export const ReadRequest = z.object({ messageIds: z.array(z.string()).max(500) });
export const DeviceContextRequest = z.object({ tz: z.string(), locale: z.string() });

export const PushSubscriptionRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export const CallCreateRequest = z.object({ mode: z.enum(['realtime', 'cascaded']).optional(), purpose: z.string().max(500).optional() });
export const CallAttachRequest = z.object({ providerCallId: z.string().min(3).max(200) });
export type CallCreateResponse = CallSessionInfo;

export interface CascadedUtteranceResponse {
  transcript: string;
  replyText: string;
  /** URL of synthesized reply audio (authenticated GET), if TTS is configured. */
  audioUrl?: string;
}

export { CLIENT_SUBMITTABLE_TYPES };

// ---- WS client → server ------------------------------------------------------------------

export const ClientStreamMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string() }),
  z.object({ t: z.literal('resume'), after: z.string().optional() }),
  z.object({ t: z.literal('typing') }),
  z.object({ t: z.literal('ack'), upTo: z.string() }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientStreamMessage = z.infer<typeof ClientStreamMessage>;

/** HTTP error body. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
