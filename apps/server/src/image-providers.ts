import { createImageProvider } from '@opencoach/engine';
import type { ImageGenerationConfig, ImageProvider } from '@opencoach/protocol';
import { keyFingerprint } from './credentials';

/** Per-athlete OpenRouter image clients share the existing encrypted credential store. */
export function scopedImageProviders(config: Extract<ImageGenerationConfig, { provider: 'openrouter' }>, deps: {
  keyFor(athleteId: string): string | undefined;
  fallbackKey?: string;
  fetch?: typeof fetch;
}): ((athleteId: string) => ImageProvider | undefined) & { forget(athleteId: string): void } {
  const clients = new Map<string, { fingerprint: string; provider: ImageProvider }>();
  const resolve = (athleteId: string) => {
    const apiKey = deps.keyFor(athleteId) ?? deps.fallbackKey;
    if (!apiKey) { clients.delete(athleteId); return undefined; }
    const fingerprint = keyFingerprint(apiKey);
    const cached = clients.get(athleteId);
    if (cached?.fingerprint === fingerprint) return cached.provider;
    const provider = createImageProvider(config, { apiKey, fetch: deps.fetch })!;
    clients.set(athleteId, { fingerprint, provider });
    return provider;
  };
  return Object.assign(resolve, { forget: (athleteId: string) => { clients.delete(athleteId); } });
}
