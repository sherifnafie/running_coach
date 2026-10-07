import type { Pricing, Usage } from '@opencoach/protocol';
import { DEFAULT_OPENROUTER_CATALOG } from './openrouter-catalog';

/**
 * Fallback list prices (USD per MTok), keyed by model id; config `models.pricing` overrides them.
 * OpenRouter reports what each call cost, and that amount wins (`Usage.costUsd`). The table only prices calls
 * without a reported cost: other compatible endpoints, or a stream cut off before its usage chunk.
 * `cacheWritePerMTok` falls back to 1.25x input when a provider reports cache writes without a price.
 */
export const DEFAULT_PRICES: Record<string, Pricing> = Object.fromEntries(
  DEFAULT_OPENROUTER_CATALOG.filter((m) => m.pricing).map((m) => [m.id, m.pricing!]),
);

/** `claude-haiku-4-5-20251001` -> `claude-haiku-4-5` */
function stripDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function lookupPricing(model: string, overrides?: Record<string, Pricing>): Pricing | undefined {
  return overrides?.[model] ?? DEFAULT_PRICES[model] ?? overrides?.[stripDateSuffix(model)] ?? DEFAULT_PRICES[stripDateSuffix(model)];
}

/** USD cost of one usage record: the provider-reported charge when present, else the list price. Unknown model -> 0. */
export function priceFor(model: string, usage: Usage, overrides?: Record<string, Pricing>): number {
  if (usage.costUsd !== undefined) return usage.costUsd;
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
