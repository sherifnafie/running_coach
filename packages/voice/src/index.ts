/**
 * @opencoach/voice — voice notes and calls (SPEC §10.4, §11).
 *
 * STUB: signatures are final; implementation provided by the voice work package.
 */
import type {
  CallMode,
  CallSessionInfo,
  Clock,
  CoachRuntimeAPI,
  Logger,
  RealtimeVoiceProvider,
  Store,
  BlobStore,
  Synthesizer,
  Transcriber,
  VoiceConfig,
} from '@opencoach/protocol';

const ni = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

/** OpenAI (or OpenAI-compatible, e.g. a local faster-whisper server) speech-to-text. */
export function createTranscriber(cfg: VoiceConfig['stt'], apiKey: string | undefined): Transcriber | undefined {
  void cfg;
  void apiKey;
  return ni('createTranscriber');
}

/** OpenAI (or compatible) text-to-speech. */
export function createSynthesizer(cfg: VoiceConfig['tts'], apiKey: string | undefined): Synthesizer | undefined {
  void cfg;
  void apiKey;
  return ni('createSynthesizer');
}

/** OpenAI Realtime (WebRTC + server sideband via call_id). */
export function createOpenAIRealtimeProvider(opts: { apiKey: string; baseUrl?: string }): RealtimeVoiceProvider {
  void opts;
  return ni('createOpenAIRealtimeProvider');
}

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

export function createCallService(deps: CallServiceDeps): CallService {
  void deps;
  return ni('createCallService');
}
