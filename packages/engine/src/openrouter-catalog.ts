import type { ModelCatalogEntryInput } from '@opencoach/protocol';

/**
 * Built-in OpenRouter catalog: the models the server offers in the model picker (SPEC §5.7, ADR 0007).
 *
 * Selection, checked 2026-10-07 against the Artificial Analysis leaderboard and the OpenRouter model API:
 * each entry calls tools and read a workout screenshot correctly through OpenRouter with `data_collection: deny`.
 * Default since 2026-10-07: Claude Haiku 5.5 (AA intelligence 38 at high / 43 at max vs DeepSeek V4.1 Flash 39 at max,
 * non-hallucination 55-60% vs 4%, $0.10/$0.50 per MTok with 1h prompt caching, faster first answer in our probes).
 * Prices are OpenRouter list prices (USD per MTok) and are only a fallback: OpenRouter reports the charged
 * amount on every response. Deployments override the list with `providers.openrouter.models`.
 */
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';

/**
 * Default for the deep tier (background plans, reviews, research), checked 2026-10-08 in conversation benchmarks
 * (`packages/evals-sim/src/chat-bench.ts`): DeepSeek V4.1 Flash showed the best coaching judgment and calibration of
 * the low-cost models but is too slow for chat (16-27 s per step at medium/high effort), which doesn't matter for
 * background work. At max effort it can exceed helper time limits, so the deep tier uses high.
 */
export const DEFAULT_OPENROUTER_DEEP_MODEL = 'deepseek/deepseek-v4.1-flash';

export const DEFAULT_OPENROUTER_CATALOG: ModelCatalogEntryInput[] = [
  {
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    description: 'Very low cost and long, fast answers; does more research on its own. Guesses more often than the others when it does not know.',
    vision: true,
    contextTokens: 1_048_576,
    maxOutputTokens: 32_768,
    efforts: ['low', 'medium', 'high', 'max'],
    pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.006 },
    // Pin hosts so prompt caching hits (a host switch is a cache miss); fp8 or better.
    routing: { order: ['deepinfra/fp8', 'together', 'atlas-cloud/fp8'], allowFallbacks: true },
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    description: 'Default. Smart, quick and careful at a low price: says when it does not know instead of guessing, and reads screenshots well.',
    vision: true,
    contextTokens: 1_000_000,
    maxOutputTokens: 32_768,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Cache writes at the 1h rate (2x input); reads at $0.01.
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.2 },
    promptCache: '1h',
  },
  {
    id: 'z-ai/glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    description: 'Careful and cheap: the lowest hallucination rate in its price class. Slower replies.',
    vision: true,
    contextTokens: 1_048_576,
    maxOutputTokens: 32_768,
    efforts: ['low', 'medium', 'high'],
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.5, cacheReadPerMTok: 0.03 },
  },
  {
    id: 'xiaomi/mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    description: 'Strongest reasoning at a budget price. Slow to start answering.',
    vision: true,
    contextTokens: 1_048_576,
    maxOutputTokens: 32_768,
    efforts: ['low', 'medium', 'high'],
    pricing: { inputPerMTok: 0.435, outputPerMTok: 0.87, cacheReadPerMTok: 0.0036 },
  },
  {
    id: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    description: 'Fast all-rounder with the best screenshot reading. About five times the default cost.',
    vision: true,
    contextTokens: 1_048_576,
    maxOutputTokens: 32_768,
    efforts: ['low', 'medium', 'high'],
    pricing: { inputPerMTok: 0.75, outputPerMTok: 3.75, cacheReadPerMTok: 0.075 },
  },
  {
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: 'Premium: the most reliable knowledge and quick first replies. About ten times the default cost.',
    vision: true,
    contextTokens: 1_050_000,
    maxOutputTokens: 32_768,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  },
];
