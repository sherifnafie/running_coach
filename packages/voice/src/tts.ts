import type { Synthesizer, VoiceConfig } from '@opencoach/protocol';
import { createSpeechClient } from './client';
import { toProviderError } from './errors';

type Format = 'mp3' | 'opus' | 'wav';

const MIME_BY_FORMAT: Record<Format, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg', wav: 'audio/wav' };

/** OpenAI (or compatible) text-to-speech. */
export function createSynthesizer(cfg: VoiceConfig['tts'], apiKey: string | undefined): Synthesizer | undefined {
  const client = createSpeechClient(cfg, apiKey);
  if (!client) return undefined;
  const model = cfg.model;
  return {
    id: cfg.provider,
    async synthesize(text, opts) {
      const format: Format = opts.format ?? 'mp3';
      try {
        const res = await client.audio.speech.create({
          model,
          voice: opts.voice,
          input: text,
          response_format: format,
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        });
        const audio = new Uint8Array(await res.arrayBuffer());
        return { audio, mime: MIME_BY_FORMAT[format], model };
      } catch (e) {
        throw toProviderError(e, 'speech synthesis');
      }
    },
  };
}
