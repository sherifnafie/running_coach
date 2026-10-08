import { z } from 'zod';
import type { BlobRef } from './common';

export const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-2.5-flare';
export const DEFAULT_IMAGE_STYLE = 'Original playful pixel-art icon. Chunky pixels, limited warm colors, bold silhouette, minimal shading. One centered subject with wide margins for a small circular crop. No lettering, watermark, scenery or painted background.';
const shared = {
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().min(1000).max(180_000).default(120_000),
  stylePrompt: z.string().trim().max(1000).default(DEFAULT_IMAGE_STYLE),
};

/** Optional trusted-server service, independent of the conversation model [MOD-1] [SEC-1]. */
export const ImageGenerationConfig = z.discriminatedUnion('provider', [
  z.object({ ...shared, provider: z.literal('openrouter'),
    model: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/).max(160).default(DEFAULT_IMAGE_MODEL),
    /** Optional override; otherwise use the athlete's OpenRouter key, then the deployment key. */
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    /** Deployment-selected only; the coach cannot choose auto/high/4K requests. */
    quality: z.enum(['low', 'medium']).default('medium'),
    /** Maximum reservation for one bounded request; unknown token profiles are refused. */
    costPerImageUsd: z.number().positive().max(10).default(0.02),
  }),
  z.object({ ...shared, provider: z.enum(['google', 'openai-compatible']),
    model: z.string().regex(/^[A-Za-z0-9._-]+$/).max(120),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** Operator-supplied conservative charge per attempt, including unknown billing. */
    costPerImageUsd: z.number().nonnegative().max(10),
  }),
]);
export type ImageGenerationConfig = z.infer<typeof ImageGenerationConfig>;

export interface ImageQuote { costUsd: number; provider: string; }
export type GeneratedImage = BlobRef & { workspacePath: string; reservedCostUsd?: number; reportedCostUsd?: number };

export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  /** Generates one square raster image. No URLs, filesystem paths or credentials in tool inputs. */
  /** Optional live preflight; fixed-price providers bind the paid request to this quote. */
  quote?(signal: AbortSignal, prompt?: string): Promise<ImageQuote>;
  generate(prompt: string, signal: AbortSignal, quote?: ImageQuote): Promise<{ data: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp'; costUsd?: number }>;
}
