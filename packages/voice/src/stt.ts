import { toFile } from 'openai';
import type { Transcriber, VoiceConfig } from '@opencoach/protocol';
import { createSpeechClient } from './client';
import { toProviderError } from './errors';

const EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** File extension for an audio mime type (parameters such as `;codecs=opus` are ignored). Defaults to webm. */
export function audioExtension(mime: string): string {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return EXT_BY_MIME[base] ?? 'webm';
}

/** OpenAI (or OpenAI-compatible, e.g. a local faster-whisper server) speech-to-text. */
export function createTranscriber(cfg: VoiceConfig['stt'], apiKey: string | undefined): Transcriber | undefined {
  const client = createSpeechClient(cfg, apiKey);
  if (!client) return undefined;
  const model = cfg.model;
  return {
    id: cfg.provider,
    async transcribe(audio, mime, opts) {
      try {
        const file = await toFile(audio, `audio.${audioExtension(mime)}`, { type: mime });
        const res = await client.audio.transcriptions.create({
          file,
          model,
          ...(opts?.language ? { language: opts.language } : {}),
          ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        });
        const loose = res as { text?: string; duration?: unknown; usage?: { type?: string; seconds?: unknown } };
        const durationS =
          typeof loose.duration === 'number' ? loose.duration : loose.usage?.type === 'duration' && typeof loose.usage.seconds === 'number' ? loose.usage.seconds : undefined;
        return { text: (loose.text ?? '').trim(), model, ...(durationS !== undefined ? { durationS } : {}) };
      } catch (e) {
        throw toProviderError(e, 'transcription');
      }
    },
  };
}
