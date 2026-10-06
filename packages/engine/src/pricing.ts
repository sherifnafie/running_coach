import type { Pricing, Usage } from '@opencoach/protocol';

/**
 * Built-in list prices (USD per MTok) as of 2026-10 (SPEC Appendix A §A.1); config can override.
 * `cacheWritePerMTok` is omitted where the provider has no separate cache-write charge (OpenAI caches
 * automatically); `priceFor` then falls back to 1.25x input, which only matters if a provider ever
 * reports cache writes for that model.
 */
export const DEFAULT_PRICES: Record<string, Pricing> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.5 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  'gpt-6-astra': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1 },
  'gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'gpt-6-sol': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 },
  // ESTIMATE: DeepSeek V4 Pro list prices are not confirmed (Appendix A §A.1 says "check current").
  'deepseek-v4-pro': { inputPerMTok: 0.5, outputPerMTok: 2, cacheReadPerMTok: 0.05 },
};

/** `claude-haiku-4-5-20251001` -> `claude-haiku-4-5` */
function stripDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function lookupPricing(model: string, overrides?: Record<string, Pricing>): Pricing | undefined {
  return overrides?.[model] ?? DEFAULT_PRICES[model] ?? overrides?.[stripDateSuffix(model)] ?? DEFAULT_PRICES[stripDateSuffix(model)];
}

/** USD cost of one usage record. Unknown model -> 0. */
export function priceFor(model: string, usage: Usage, overrides?: Record<string, Pricing>): number {
  const p = lookupPricing(model, overrides);
  if (!p) return 0;
  const cacheRead = p.cacheReadPerMTok ?? p.inputPerMTok * 0.1;
  const cacheWrite = p.cacheWritePerMTok ?? p.inputPerMTok * 1.25;
  const total =
    usage.inputTokens * p.inputPerMTok +
    usage.cachedInputTokens * cacheRead +
    usage.cacheWriteTokens * cacheWrite +
    usage.outputTokens * p.outputPerMTok;
  return total / 1_000_000;
}
