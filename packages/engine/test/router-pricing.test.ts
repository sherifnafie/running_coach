import { describe, expect, it } from 'vitest';
import { ModelsConfig, type ModelCapabilities, type ModelProvider, type Usage } from '@opencoach/protocol';
import { DEFAULT_PRICES, createModelRouter, createScriptedProvider, priceFor } from '../src';

const U = (over: Partial<Usage> = {}): Usage => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...over });

describe('DEFAULT_PRICES', () => {
  it('has the documented list prices', () => {
    expect(DEFAULT_PRICES['claude-fable-5-1']).toEqual({ inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25, cacheWritePerMTok: 12.5 });
    expect(DEFAULT_PRICES['claude-opus-5-5']).toEqual({ inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 });
    expect(DEFAULT_PRICES['claude-sonnet-5-5']).toEqual({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 });
    expect(DEFAULT_PRICES['claude-haiku-4-5']).toEqual({ inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 });
    expect(DEFAULT_PRICES['gpt-6-astra']).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1 });
    expect(DEFAULT_PRICES['gpt-6.1-sol']).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 });
    expect(DEFAULT_PRICES['gpt-6-sol']).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 });
    expect(DEFAULT_PRICES['gpt-6-luna']).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01 });
    expect(DEFAULT_PRICES['deepseek-v4-pro']).toMatchObject({ inputPerMTok: 0.5, outputPerMTok: 2, cacheReadPerMTok: 0.05 });
    expect(DEFAULT_PRICES['gpt-6-luna']?.cacheWritePerMTok).toBeUndefined();
  });
});

describe('priceFor [COST-4]', () => {
  it('prices input, cache reads, cache writes and output per MTok', () => {
    const usage = U({ inputTokens: 100_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 20_000, outputTokens: 10_000 });
    // sonnet 5.5: 0.1*2 + 1.0*0.2 + 0.02*2.5 + 0.01*10
    expect(priceFor('claude-sonnet-5-5', usage)).toBeCloseTo(0.2 + 0.2 + 0.05 + 0.1, 10);
    // fable 5.1 (cache reads at 0.025x)
    expect(priceFor('claude-fable-5-1', U({ cachedInputTokens: 4_000_000 }))).toBeCloseTo(1, 10);
  });

  it('defaults cache read to 0.1x and cache write to 1.25x of input when the table omits them', () => {
    const overrides = { custom: { inputPerMTok: 4, outputPerMTok: 8 } };
    expect(priceFor('custom', U({ cachedInputTokens: 1_000_000 }), overrides)).toBeCloseTo(0.4, 10);
    expect(priceFor('custom', U({ cacheWriteTokens: 1_000_000 }), overrides)).toBeCloseTo(5, 10);
    // gpt-6-luna has no cache-write price: falls back to 1.25 x 0.10
    expect(priceFor('gpt-6-luna', U({ cacheWriteTokens: 1_000_000 }))).toBeCloseTo(0.125, 10);
  });

  it('returns 0 for unknown models and lets overrides win', () => {
    expect(priceFor('mystery-model', U({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBe(0);
    expect(priceFor('claude-sonnet-5-5', U({ outputTokens: 1_000_000 }), { 'claude-sonnet-5-5': { inputPerMTok: 1, outputPerMTok: 3 } })).toBeCloseTo(3, 10);
    expect(priceFor('mystery-model', U({ inputTokens: 1_000_000 }), { 'mystery-model': { inputPerMTok: 7, outputPerMTok: 1 } })).toBeCloseTo(7, 10);
  });

  it('matches dated model ids to their alias', () => {
    expect(priceFor('claude-haiku-4-5-20251001', U({ inputTokens: 1_000_000 }))).toBeCloseTo(1, 10);
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
    expect(router.cost('gpt-6-luna', U({ inputTokens: 1_000_000 }))).toBeCloseTo(0.1, 10); // built-in
    expect(router.cost('nobody', U({ inputTokens: 1_000_000 }))).toBe(0);
  });

  it('lists registered providers', () => {
    expect(router.providers().sort()).toEqual(['anthropic', 'deepseek', 'openai']);
  });
});
