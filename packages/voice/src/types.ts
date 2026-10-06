import type {
  BlobStore,
  CallMode,
  CallSessionInfo,
  Clock,
  CoachRuntimeAPI,
  Logger,
  RealtimeVoiceProvider,
  Store,
  Synthesizer,
  Transcriber,
  VoiceConfig,
} from '@opencoach/protocol';

export interface CallServiceDeps {
  runtime: CoachRuntimeAPI;
  store: Store;
  blobs: BlobStore;
  clock: Clock;
  logger: Logger;
  dataDir: string;
  config: VoiceConfig;
  realtime?: RealtimeVoiceProvider;
  transcriber?: Transcriber;
  synthesizer?: Synthesizer;
}

/**
 * Manages calls end-to-end: briefing, provider session, sideband tool handling
 * (lookup / consult_coach / note / end_call), transcripts, write-back via call.ended (SPEC §11.2),
 * and cascaded utterance turns (SPEC §11.3).
 */
export interface CallService {
  features(): { realtime: boolean; cascaded: boolean; voiceNotes: boolean };
  start(athleteId: string, opts: { mode?: CallMode; purpose?: string }): Promise<CallSessionInfo>;
  /** Realtime: client reports the provider call id from the SDP answer Location header. */
  attach(athleteId: string, callId: string, providerCallId: string): Promise<void>;
  /** Cascaded: one athlete utterance (audio) → transcript + coach reply (+ TTS audio blob sha). */
  utterance(athleteId: string, callId: string, audio: Uint8Array, mime: string): Promise<{ transcript: string; replyText: string; audioSha256?: string }>;
  end(athleteId: string, callId: string, endedBy: 'athlete' | 'coach' | 'error'): Promise<void>;
  /** Transcribe a voice note upload. */
  transcribeVoiceNote(audio: Uint8Array, mime: string): Promise<{ text: string; model: string; durationS?: number }>;
  dispose(): Promise<void>;
}
