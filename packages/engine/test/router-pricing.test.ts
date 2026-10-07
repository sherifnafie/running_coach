import { describe, expect, it } from 'vitest';
import { ModelsConfig, type ModelCapabilities, type ModelProvider, type Usage } from '@opencoach/protocol';
import { DEFAULT_PRICES, createModelRouter, createScriptedProvider, priceFor } from '../src';

const U = (over: Partial<Usage> = {}): Usage => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...over });

const SONNET = { 'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 } };

describe('DEFAULT_PRICES', () => {
  it('holds the catalog list prices as a fallback', () => {
    expect(DEFAULT_PRICES['deepseek/deepseek-v4.1-flash']).toEqual({ inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.006 });
    expect(DEFAULT_PRICES['openai/gpt-6.1-sol']).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(DEFAULT_PRICES['deepseek/deepseek-v4.1-flash']?.cacheWritePerMTok).toBeUndefined();
  });
});

describe('priceFor [COST-4]', () => {
  it('prices input, cache reads, cache writes and output per MTok', () => {
    const usage = U({ inputTokens: 100_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 20_000, outputTokens: 10_000 });
    // 0.1*2 + 1.0*0.2 + 0.02*2.5 + 0.01*10
    expect(priceFor('claude-sonnet-5-5', usage, SONNET)).toBeCloseTo(0.2 + 0.2 + 0.05 + 0.1, 10);
  });

  it('prefers the cost the provider reported over any price table', () => {
    expect(priceFor('claude-sonnet-5-5', U({ inputTokens: 1_000_000, costUsd: 0.0123 }), SONNET)).toBe(0.0123);
    expect(priceFor('mystery-model', U({ outputTokens: 5, costUsd: 0 }))).toBe(0);
  });

  it('defaults cache read to 0.1x and cache write to 1.25x of input when the table omits them', () => {
    const overrides = { custom: { inputPerMTok: 4, outputPerMTok: 8 } };
    expect(priceFor('custom', U({ cachedInputTokens: 1_000_000 }), overrides)).toBeCloseTo(0.4, 10);
    expect(priceFor('custom', U({ cacheWriteTokens: 1_000_000 }), overrides)).toBeCloseTo(5, 10);
    // the default model has no cache-write price: falls back to 1.25 x 0.30
    expect(priceFor('deepseek/deepseek-v4.1-flash', U({ cacheWriteTokens: 1_000_000 }))).toBeCloseTo(0.375, 10);
  });

  it('returns 0 for unknown models and lets overrides win', () => {
    expect(priceFor('mystery-model', U({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBe(0);
    expect(priceFor('deepseek/deepseek-v4.1-flash', U({ outputTokens: 1_000_000 }), { 'deepseek/deepseek-v4.1-flash': { inputPerMTok: 1, outputPerMTok: 3 } })).toBeCloseTo(3, 10);
    expect(priceFor('mystery-model', U({ inputTokens: 1_000_000 }), { 'mystery-model': { inputPerMTok: 7, outputPerMTok: 1 } })).toBeCloseTo(7, 10);
  });

  it('matches dated model ids to their alias', () => {
    expect(priceFor('claude-haiku-4-5-20251001', U({ inputTokens: 1_000_000 }), { 'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 } })).toBeCloseTo(1, 10);
  });
});

// ------------------------------------------------------------------ router

const provider = (id: string, over: Partial<ModelCapabilities> = {}): ModelProvider => createScriptedProvider({ id, handler: [], capabilities: over });

describe('createModelRouter [RT-7]', () => {
  const config = ModelsConfig.parse({
    tiers: {
      coach: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
      deep: { provider: 'openai', model: 'gpt-6.1-sol', effort: 'high', maxOutputTokens: 9000 },
    },
    fallbacks: { coach: [{ provider: 'openai', model: 'gpt-6.1-sol' }, { provider: 'deepseek', model: 'deepseek-v4-pro' }] },
    pricing: { 'claude-sonnet-5-5': { inputPerMTok: 1, outputPerMTok: 1 } },
  });
  const providers = { anthropic: provider('anthropic', { maxOutputTokens: 128_000 }), openai: provider('openai', { maxOutputTokens: 16_000 }), deepseek: provider('deepseek', { maxOutputTokens: 8192 }) };
  const router = createModelRouter(config, providers);

  it('routes primary then fallbacks as resolved models', () => {
    const route = router.route('coach');
    expect(route.map((r) => `${r.provider.id}:${r.model}`)).toEqual(['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'deepseek:deepseek-v4-pro']);
    expect(route.every((r) => r.tier === 'coach')).toBe(true);
    expect(route[0]).toMatchObject({ effort: 'medium', provider: providers.anthropic });
    expect(route[0]?.capabilities).toEqual(providers.anthropic.capabilities('claude-sonnet-5-5'));
  });

  it('maxOutputTokens = tier setting, else min(capability, 32000)', () => {
    const route = router.route('coach');
    expect(route.map((r) => r.maxOutputTokens)).toEqual([32_000, 16_000, 8192]);
    expect(router.route('deep')[0]?.maxOutputTokens).toBe(9000);
  });

  it('deep / fast without their own config use the coach tier (and its fallbacks)', () => {
    const fast = router.route('fast');
    expect(fast.map((r) => `${r.provider.id}:${r.model}`)).toEqual(['anthropic:claude-sonnet-5-5', 'openai:gpt-6.1-sol', 'deepseek:deepseek-v4-pro']);
    expect(fast.every((r) => r.tier === 'fast')).toBe(true);
    // deep is configured: no fallbacks configured for it -> just itself
    expect(router.route('deep').map((r) => r.model)).toEqual(['gpt-6.1-sol']);
  });

  it('accepts an override as the primary', () => {
    const route = router.route('coach', { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'low', maxOutputTokens: 1234 });
    expect(route[0]).toMatchObject({ model: 'deepseek-v4-pro', effort: 'low', maxOutputTokens: 1234 });
    // coach fallbacks follow the override (the duplicate deepseek entry is dropped)
    expect(route.map((r) => r.model)).toEqual(['deepseek-v4-pro', 'gpt-6.1-sol']);
  });

  it('skips entries whose provider is not registered and dedupes', () => {
    const partial = createModelRouter(config, { openai: providers.openai });
    expect(partial.route('coach').map((r) => `${r.provider.id}:${r.model}`)).toEqual(['openai:gpt-6.1-sol']);
    expect(partial.providers()).toEqual(['openai']);
  });

  it('throws when nothing is routable', () => {
    const none = createModelRouter(config, {});
    expect(() => none.route('coach')).toThrow(/no routable model for tier "coach"/);
    expect(() => none.route('deep')).toThrow(/anthropic|openai/);
  });

  it('prices with config overrides over the built-in table', () => {
    expect(router.cost('claude-sonnet-5-5', U({ inputTokens: 1_000_000 }))).toBeCloseTo(1, 10); // overridden: $1/MTok
    expect(router.cost('deepseek/deepseek-v4.1-flash', U({ inputTokens: 1_000_000 }))).toBeCloseTo(0.3, 10); // built-in
    expect(router.cost('nobody', U({ inputTokens: 1_000_000 }))).toBe(0);
  });

  it('uses an athlete-scoped provider when one exists for that athlete [SEC-1]', () => {
    const own = provider('openai', { maxOutputTokens: 16_000 });
    const scopedRouter = createModelRouter(config, providers, { scoped: (id, athleteId) => (id === 'openai' && athleteId === 'ath_byok' ? own : undefined) });
    expect(scopedRouter.route('deep', undefined, { athleteId: 'ath_byok' })[0]?.provider).toBe(own);
    expect(scopedRouter.route('deep', undefined, { athleteId: 'ath_other' })[0]?.provider).toBe(providers.openai);
    expect(scopedRouter.route('deep')[0]?.provider).toBe(providers.openai);
  });

  it('lists registered providers', () => {
    expect(router.providers().sort()).toEqual(['anthropic', 'deepseek', 'openai']);
  });
});
