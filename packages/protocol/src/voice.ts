import { z } from 'zod';
import type { ToolSpec } from './model';

/**
 * Voice (SPEC §11). Voice notes (STT/TTS), realtime calls ("briefed voice, shared mind") and
 * cascaded calls (STT → coach turn → TTS).
 */

export interface Transcriber {
  readonly id: string;
  transcribe(audio: Uint8Array, mime: string, opts?: { language?: string; prompt?: string }): Promise<{ text: string; model: string; durationS?: number }>;
}

export interface Synthesizer {
  readonly id: string;
  synthesize(text: string, opts: { voice: string; format?: 'mp3' | 'opus' | 'wav'; instructions?: string }): Promise<{ audio: Uint8Array; mime: string; model: string }>;
}

export type CallMode = 'realtime' | 'cascaded';

/** What the client needs to connect a realtime call. */
export type RealtimeClientConnect = {
  type: 'openai-webrtc';
  /** SDP offer is POSTed here with the ephemeral key; response Location header contains the provider call id. */
  callsUrl: string;
  ephemeralKey: string;
  expiresAt: string;
  model: string;
};

export interface CallSessionInfo {
  callId: string;
  mode: CallMode;
  provider: string;
  model: string;
  /** Present for realtime calls. */
  connect?: RealtimeClientConnect;
  /** Seconds before the server ends the call automatically. */
  maxDurationS: number;
}

export interface VoiceTranscriptEntry {
  role: 'athlete' | 'coach';
  text: string;
  at: string;
}

export interface RealtimeSidebandHandlers {
  onToolCall(call: { id: string; name: string; arguments: unknown }): Promise<unknown>;
  onTranscript(entry: VoiceTranscriptEntry): void;
  onEnd(reason: 'athlete' | 'coach' | 'error' | 'timeout', detail?: string): void;
}

export interface RealtimeSideband {
  /** Update the session instructions mid-call (e.g. after consult_coach). */
  updateInstructions(instructions: string): Promise<void>;
  /** Ask the voice model to say something (e.g. relay a consult answer). */
  say(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeVoiceProvider {
  readonly id: string;
  /** Create a provider session + ephemeral client credential. */
  createSession(input: { instructions: string; tools: ToolSpec[]; voice: string; model: string }): Promise<RealtimeClientConnect>;
  /** Attach the server-side control channel to the call the client established. */
  attachSideband(input: { providerCallId: string; model: string; handlers: RealtimeSidebandHandlers }): Promise<RealtimeSideband>;
}

export const VoiceConfig = z.object({
  realtime: z
    .object({ provider: z.literal('openai').default('openai'), model: z.string().default('gpt-realtime-2.1'), voice: z.string().default('alloy'), maxDurationS: z.number().int().positive().default(1800) })
    .prefault({}),
  stt: z
    .object({ provider: z.enum(['openai', 'openai-compatible', 'none']).default('openai'), model: z.string().default('gpt-4o-transcribe'), baseUrl: z.string().optional(), apiKeyEnv: z.string().optional() })
    .prefault({}),
  tts: z
    .object({ provider: z.enum(['openai', 'openai-compatible', 'none']).default('openai'), model: z.string().default('gpt-4o-mini-tts'), voice: z.string().default('alloy'), baseUrl: z.string().optional(), apiKeyEnv: z.string().optional() })
    .prefault({}),
});
export type VoiceConfig = z.infer<typeof VoiceConfig>;
