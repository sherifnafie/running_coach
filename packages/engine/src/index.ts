/**
 * @opencoach/engine — the agent loop and provider adapters (SPEC §5.7, §5.8, Appendix C §C.6).
 * Adapters are written directly on official SDKs (docs/adr/0001-provider-adapters.md).
 *
 * Signatures of the original stub are final. Additions are optional parameters / extra exports only.
 */
import type { AssistantPart } from '@opencoach/protocol';

// agent loop
export { createAgentLoop, MAX_TOKENS_NOTE } from './loop';
export type { AgentLoopOptions } from './loop';

// providers
export { createAnthropicProvider } from './anthropic';
export type { AnthropicProviderOptions, AnthropicClientLike } from './anthropic';
export { createOpenAIProvider } from './openai';
export type { OpenAIProviderOptions, OpenAIClientLike } from './openai';
export { createCompatibleProvider } from './compatible';
export type { CompatibleClientLike, CompatibleProviderDeps } from './compatible';

// scripted provider (tests, evals, demo)
export { createScriptedProvider } from './scripted';
export type { ScriptedStep, ScriptHandler, ScriptedProviderOptions, ScriptedProvider, ScriptedFailKind } from './scripted';
export { demoCoachHandler } from './demo';

// routing & pricing
export { DEFAULT_PRICES, priceFor } from './pricing';
export { createModelRouter } from './router';

// streaming helpers
export { partialSendMessageText } from './partial';
export { INVALID_TOOL_INPUT_KEY, isInvalidToolInput } from './util';

export type { AssistantPart };
