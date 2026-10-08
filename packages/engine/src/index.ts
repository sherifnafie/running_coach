/**
 * @opencoach/engine — the agent loop and provider adapters (SPEC §5.7, §5.8, Appendix C §C.6).
 * Chat models go through OpenRouter (docs/adr/0007-openrouter-only-chat.md); other OpenAI-compatible
 * endpoints use the compatible adapter. Both are written on the official `openai` SDK.
 *
 * Signatures of the original stub are final. Additions are optional parameters / extra exports only.
 */
import type { AssistantPart } from '@opencoach/protocol';

// agent loop
export { createAgentLoop, MAX_TOKENS_NOTE, WRAP_UP_NOTE, STREAM_IDLE_MS } from './loop';
export type { AgentLoopOptions } from './loop';

// providers
export { createOpenRouterProvider } from './openrouter';
export type { OpenRouterProviderOptions, OpenRouterProviderDeps } from './openrouter';
export { DEFAULT_OPENROUTER_CATALOG, DEFAULT_OPENROUTER_DEEP_MODEL, DEFAULT_OPENROUTER_MODEL } from './openrouter-catalog';
export { createCompatibleProvider } from './compatible';
export { createImageProvider } from './image-generation';
export type { CompatibleClientLike, CompatibleProviderDeps } from './compatible';

// scripted provider (tests, evals, demo)
export { createScriptedProvider } from './scripted';
export type { ScriptedStep, ScriptHandler, ScriptedProviderOptions, ScriptedProvider, ScriptedFailKind } from './scripted';
export { demoCoachHandler } from './demo';

// routing & pricing
export { DEFAULT_PRICES, lookupPricing, priceFor } from './pricing';
export { createModelRouter } from './router';
export type { ModelRouterOptions } from './router';

// streaming helpers
export { partialSendMessageText } from './partial';
export { INVALID_TOOL_INPUT_KEY, isInvalidToolInput } from './util';

export type { AssistantPart };
