import OpenAI from 'openai';

/** Provider settings shared by the `stt` and `tts` sections of `VoiceConfig`. */
export interface SpeechEndpointConfig {
  provider: 'openai' | 'openai-compatible' | 'none';
  baseUrl?: string;
  apiKeyEnv?: string;
}

/**
 * Build an OpenAI SDK client for a speech endpoint, or undefined when the feature is unavailable
 * (provider 'none', missing key for 'openai', missing baseUrl for 'openai-compatible').
 *
 * Key resolution: explicit `apiKey` → `process.env[cfg.apiKeyEnv]` → (provider 'openai' with no
 * `apiKeyEnv`) `process.env.OPENAI_API_KEY`, which is also what the OpenAI SDK itself would read.
 * Self-hosted compatible servers (e.g. faster-whisper) usually need no key; a placeholder is sent.
 */
export function createSpeechClient(cfg: SpeechEndpointConfig, apiKey: string | undefined): OpenAI | undefined {
  if (cfg.provider === 'none') return undefined;
  const envName = cfg.apiKeyEnv?.trim();
  const key = apiKey || (envName ? process.env[envName] : undefined) || (cfg.provider === 'openai' && !envName ? process.env.OPENAI_API_KEY : undefined) || undefined;
  if (cfg.provider === 'openai') {
    if (!key) return undefined;
    return new OpenAI({ apiKey: key, baseURL: cfg.baseUrl || undefined });
  }
  if (!cfg.baseUrl) return undefined;
  return new OpenAI({ apiKey: key ?? 'sk-no-key-required', baseURL: cfg.baseUrl });
}
