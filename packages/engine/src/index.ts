/**
 * @opencoach/engine — the agent loop and provider adapters (SPEC §5.7, §5.8, Appendix C §C.6).
 * Adapters are written directly on official SDKs (docs/adr/0001-provider-adapters.md).
 *
 * STUB: signatures are final; implementation provided by the engine work package.
 */
import type { AgentLoop, CompatibleProviderConfig, ModelCapabilities, ModelProvider, ModelRequest, ModelRouter, ModelsConfig, Pricing, Usage, AssistantPart } from '@opencoach/protocol';

const ni = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

/** The default AgentLoop (retries, fallbacks, parallel tool execution, steering, limits). */
export function createAgentLoop(): AgentLoop {
  return ni('createAgentLoop');
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Use server-side refusal fallbacks (beta) — default true. */
  serverSideFallbacks?: boolean;
  thinkingDisplay?: 'omitted' | 'summarized' | 'updates';
}
export function createAnthropicProvider(opts: AnthropicProviderOptions): ModelProvider {
  void opts;
  return ni('createAnthropicProvider');
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
}
/** OpenAI Responses API (GPT-6 family etc.). */
export function createOpenAIProvider(opts: OpenAIProviderOptions): ModelProvider {
  void opts;
  return ni('createOpenAIProvider');
}

/** Any OpenAI-compatible Chat Completions endpoint (DeepSeek, Ollama, vLLM, OpenRouter, ...). */
export function createCompatibleProvider(cfg: CompatibleProviderConfig & { apiKey?: string }): ModelProvider {
  void cfg;
  return ni('createCompatibleProvider');
}

// ---------------------------------------------------------------- scripted provider (tests, evals, demo)

export interface ScriptedStep {
  /** Visible assistant text (becomes the private turn note unless tool calls follow). */
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown; id?: string }>;
  progress?: string[];
  usage?: Partial<Usage>;
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  /** Throw this ProviderError kind instead of answering (failure injection). */
  fail?: { kind: 'rate_limit' | 'overloaded' | 'network' | 'invalid_request'; message?: string };
}

export type ScriptHandler = (req: ModelRequest, ctx: { call: number }) => ScriptedStep | Promise<ScriptedStep>;

export interface ScriptedProviderOptions {
  id?: string;
  /** A function, or a fixed queue of steps consumed in order (then repeats `{ text: '' }`). */
  handler: ScriptHandler | ScriptedStep[];
  capabilities?: Partial<ModelCapabilities>;
}

export interface ScriptedProvider extends ModelProvider {
  /** Every request received (for assertions). */
  readonly requests: ModelRequest[];
}

export function createScriptedProvider(opts: ScriptedProviderOptions): ScriptedProvider {
  void opts;
  return ni('createScriptedProvider');
}

/**
 * The built-in demo coach used when no API keys are configured (`demo: true`). Deterministic,
 * rule-based; exercises send_message (with quick replies), schedule, write and publish flows so the
 * whole app can be clicked through and e2e-tested without a model.
 */
export function demoCoachHandler(): ScriptHandler {
  return ni('demoCoachHandler');
}

// ---------------------------------------------------------------- routing & pricing

/** Built-in list prices (USD per MTok) as of 2026-10 (SPEC Appendix A §A.1); config can override. */
export const DEFAULT_PRICES: Record<string, Pricing> = {};

export function priceFor(model: string, usage: Usage, overrides?: Record<string, Pricing>): number {
  void model;
  void usage;
  void overrides;
  return ni('priceFor');
}

export function createModelRouter(config: ModelsConfig, providers: Record<string, ModelProvider>): ModelRouter {
  void config;
  void providers;
  return ni('createModelRouter');
}

/** Extract the `text` field from a partial JSON string of send_message input (for streaming). */
export function partialSendMessageText(partialJson: string): string | undefined {
  void partialJson;
  return ni('partialSendMessageText');
}

export type { AssistantPart };
