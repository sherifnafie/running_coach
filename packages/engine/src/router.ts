import type { ModelProvider, ModelRouter, ModelsConfig, ResolvedModel, Tier, TierConfig, Usage } from '@opencoach/protocol';
import { priceFor } from './pricing';

/** Default per-call output cap when a tier doesn't set `maxOutputTokens`. */
const DEFAULT_OUTPUT_CAP = 32_000;

/**
 * Tier -> concrete provider+model chain (SPEC §5.7, [RT-7]).
 *
 * - `deep` / `fast` that are not configured use the `coach` tier configuration (and, absent explicit
 *   `fallbacks[tier]`, the coach fallbacks).
 * - Entries whose provider is not registered are skipped; duplicates (same provider+model) are dropped.
 * - Throws if nothing is routable.
 */
export interface ModelRouterOptions {
  /** A provider bound to this athlete's own credentials, if they have one for `providerId`. */
  scoped?: (providerId: string, athleteId: string) => ModelProvider | undefined;
}

export function createModelRouter(config: ModelsConfig, providers: Record<string, ModelProvider>, opts: ModelRouterOptions = {}): ModelRouter {
  const resolve = (tier: Tier, cfg: TierConfig, athleteId?: string): ResolvedModel | undefined => {
    const provider = (athleteId !== undefined ? opts.scoped?.(cfg.provider, athleteId) : undefined) ?? providers[cfg.provider];
    if (!provider) return undefined;
    const capabilities = provider.capabilities(cfg.model);
    return {
      tier,
      provider,
      model: cfg.model,
      effort: cfg.effort,
      maxOutputTokens: cfg.maxOutputTokens ?? Math.min(capabilities.maxOutputTokens, DEFAULT_OUTPUT_CAP),
      capabilities,
    };
  };

  return {
    route(tier, override, scope) {
      const own = config.tiers[tier];
      const primary = override ?? own ?? config.tiers.coach;
      const explicitFallbacks = config.fallbacks[tier];
      const fallbacks = explicitFallbacks ?? (own || override ? [] : (config.fallbacks.coach ?? []));
      const out: ResolvedModel[] = [];
      const seen = new Set<string>();
      for (const cfg of [primary, ...fallbacks]) {
        const key = `${cfg.provider}:${cfg.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = resolve(tier, cfg, scope?.athleteId);
        if (r) out.push(r);
      }
      if (out.length === 0) {
        const wanted = [primary, ...fallbacks].map((c) => `${c.provider}:${c.model}`).join(', ');
        throw new Error(`no routable model for tier "${tier}": providers not registered for [${wanted}] (registered: ${Object.keys(providers).join(', ') || 'none'})`);
      }
      return out;
    },
    cost(model: string, usage: Usage): number {
      return priceFor(model, usage, config.pricing);
    },
    providers(): string[] {
      return Object.keys(providers);
    },
  };
}
