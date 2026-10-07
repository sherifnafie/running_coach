import { z } from 'zod';

/** Optional trusted-server service, independent of the conversation model [MOD-1] [SEC-1]. */
export const ImageGenerationConfig = z.object({
  provider: z.enum(['google', 'openai-compatible']),
  model: z.string().regex(/^[A-Za-z0-9._-]+$/).max(120),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  baseUrl: z.string().url().optional(),
  /** Operator-supplied conservative charge per attempt, including failed/unknown billing. */
  costPerImageUsd: z.number().nonnegative().max(10),
  timeoutMs: z.number().int().min(1000).max(180_000).default(120_000),
});
export type ImageGenerationConfig = z.infer<typeof ImageGenerationConfig>;

export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  /** Generates one square raster image. No URLs, filesystem paths or credentials in tool inputs. */
  generate(prompt: string, signal: AbortSignal): Promise<{ data: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' }>;
}
