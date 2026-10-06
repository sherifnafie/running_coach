import { z } from 'zod';
import { Effort, Tier } from './common';
import type { AssistantItem, ConvItem, SystemBlock } from './conversation';

/**
 * Model layer (SPEC §5.7). The runtime addresses models by TIER; deployment config maps tiers to
 * concrete provider+model. Providers are adapters over official SDKs (see docs/adr/0001).
 */

export interface ModelCapabilities {
  vision: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  /** Tool input arrives as streamed partial JSON. */
  streamingToolInput: boolean;
  promptCaching: boolean;
  /** Supports harness/system messages mid-conversation without breaking caches. */
  midConversationSystem: boolean;
  parallelToolCalls: boolean;
  efforts: Effort[];
  batch: boolean;
}

/** JSON Schema object (draft 2020-12 subset) for tool inputs. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model: string;
  system: SystemBlock[];
  items: ConvItem[];
  tools: ToolSpec[];
  effort?: Effort;
  maxOutputTokens: number;
  /** Stable key for provider-side prompt cache routing (e.g. athlete id). */
  cacheKey?: string;
  metadata?: { athleteId?: string; turnId?: string; step?: number };
}

export interface Usage {
  inputTokens: number; // uncached input tokens
  cachedInputTokens: number; // cache reads
  cacheWriteTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  /** Short progress note (e.g. Claude thinking display "updates"), shown to the athlete as progress. */
  | { type: 'progress'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'tool_call_end'; id: string; name: string; input: unknown }
  /** Exactly one per stream, last. `item` is what gets appended to the transcript. */
  | { type: 'message_end'; stopReason: StopReason; usage: Usage; item: AssistantItem; refusalCategory?: string };

export interface ModelProvider {
  /** e.g. "anthropic", "openai", "deepseek", "scripted" */
  readonly id: string;
  capabilities(model: string): ModelCapabilities;
  /** Stream one model call. Throws ProviderError on failure. */
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export type ProviderErrorKind = 'rate_limit' | 'overloaded' | 'auth' | 'invalid_request' | 'network' | 'timeout' | 'refusal' | 'context_length' | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, opts: { kind: ProviderErrorKind; retryable: boolean; status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

// ---- configuration -----------------------------------------------------------------------

export const TierConfig = z.object({
  provider: z.string(),
  model: z.string(),
  effort: Effort.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type TierConfig = z.infer<typeof TierConfig>;

export const Pricing = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});
export type Pricing = z.infer<typeof Pricing>;

export const ModelsConfig = z.object({
  tiers: z.object({ coach: TierConfig, deep: TierConfig.optional(), fast: TierConfig.optional() }),
  fallbacks: z.partialRecord(Tier, z.array(TierConfig)).default({}),
  /** Override/extend built-in price table, keyed by model id. */
  pricing: z.record(z.string(), Pricing).default({}),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

/** A concrete, callable model for a tier. */
export interface ResolvedModel {
  tier: Tier;
  provider: ModelProvider;
  model: string;
  effort?: Effort;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
}

export interface ModelRouter {
  /** Primary first, then fallbacks. Throws if the tier cannot be resolved. */
  route(tier: Tier, override?: TierConfig): ResolvedModel[];
  /** USD cost of a usage record for a model (0 if unknown pricing). */
  cost(model: string, usage: Usage): number;
  /** Providers registered (for diagnostics / settings UI). */
  providers(): string[];
}
