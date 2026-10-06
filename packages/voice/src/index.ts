/**
 * @opencoach/voice — voice notes and calls (SPEC §10.4, §11).
 *
 *  - createTranscriber / createSynthesizer: OpenAI (or OpenAI-compatible) STT and TTS (voice notes, cascaded calls)
 *  - createOpenAIRealtimeProvider: OpenAI Realtime session minting + server sideband (tools, transcripts)
 *  - createCallService: calls end to end ("briefed voice, shared mind", SPEC §11.2) and cascaded turns (§11.3)
 *
 * Signatures here are the package's final contract (docs/implementation.md); modules and exports may be added.
 */
export { createTranscriber, audioExtension } from './stt';
export { createSynthesizer } from './tts';
export { createOpenAIRealtimeProvider, DEFAULT_OPENAI_BASE_URL, REALTIME_TRANSCRIPTION_MODEL } from './openai-realtime';
export type { OpenAIRealtimeOptions } from './openai-realtime';
export { OpenAISideband } from './openai-sideband';
export type { SidebandOptions } from './openai-sideband';
export { createCallService } from './call-service';
export type { CallService, CallServiceDeps } from './types';
export { VoiceError, toProviderError } from './errors';
export type { VoiceErrorReason } from './errors';
export { voiceToolSpecs } from './voice-tools';
export { renderTranscript, renderNotes, writeCallFiles, callDirName, virtualCallPaths } from './call-files';
export type { CallRecord, CallFilePaths } from './call-files';
