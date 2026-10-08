import OpenAI from 'openai';
import {
  ModelCatalogEntry,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type OpenRouterRouting,
} from '@opencoach/protocol';
import { buildCompatibleRequest, mapCompatibleError, parseCompatibleStream, type CompatibleClientLike } from './compatible';
import { resolveEffort } from './effort';
import { abortError } from './errors';

/**
 * OpenRouter (https://openrouter.ai/docs): one OpenAI-compatible endpoint for every chat model (ADR 0007).
 * On top of the compatible adapter it adds per-model capabilities from the catalog, the unified `reasoning`
 * parameter, provider routing preferences and attribution headers. Responses carry reasoning_details (replayed
 * within tool loops) and the charged cost, both handled by the shared stream parser.
 */
export interface OpenRouterProviderOptions {
  /** Provider id used in tier config. Default "openrouter". */
  id?: string;
  apiKey: string;
  baseUrl?: string;
  appTitle?: string;
  appUrl?: string;
  routing?: OpenRouterRouting;
  /** Models with known capabilities; other ids are text-only with conservative limits. */
  models: ModelCatalogEntry[];
  maxOutputTokens?: number;
}

export interface OpenRouterProviderDeps {
  client?: CompatibleClientLike;
}

const UNKNOWN_MODEL_CONTEXT = 128_000;

/** Request body fields OpenRouter adds to Chat Completions. */
interface OpenRouterBodyExt {
  reasoning?: { effort: string };
  provider?: Record<string, unknown>;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' };
}

export function routingBody(routing: OpenRouterRouting | undefined): Record<string, unknown> | undefined {
  if (!routing) return undefined;
  const body: Record<string, unknown> = {
    order: routing.order,
    allow_fallbacks: routing.allowFallbacks,
    require_parameters: routing.requireParameters,
    data_collection: routing.dataCollection,
    zdr: routing.zdr,
    quantizations: routing.quantizations,
    ignore: routing.ignore,
    sort: routing.sort,
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return Object.keys(body).length > 0 ? body : undefined;
}

export function createOpenRouterProvider(opts: OpenRouterProviderOptions, deps: OpenRouterProviderDeps = {}): ModelProvider {
  const id = opts.id ?? 'openrouter';
  // High reasoning effort can spend most of a smaller budget before any answer is written.
  const outputCap = opts.maxOutputTokens ?? 32_768;
  const client: CompatibleClientLike = deps.client ?? new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl ?? 'https://openrouter.ai/api/v1', maxRetries: 0 });
  const catalog = new Map(opts.models.map((m) => [m.id, ModelCatalogEntry.parse(m)]));
  const headers: Record<string, string> = { 'X-Title': opts.appTitle ?? 'OpenCoach' };
  if (opts.appUrl) headers['HTTP-Referer'] = opts.appUrl;

  function capabilities(model: string): ModelCapabilities {
    const entry = catalog.get(model);
    return {
      vision: entry?.vision ?? false,
      maxContextTokens: entry?.contextTokens ?? UNKNOWN_MODEL_CONTEXT,
      maxOutputTokens: Math.min(entry?.maxOutputTokens ?? outputCap, outputCap),
      streamingToolInput: true,
      promptCaching: true,
      midConversationSystem: false,
      parallelToolCalls: true,
      efforts: entry?.efforts ?? [],
      batch: false,
    };
  }

  return {
    id,
    capabilities,
    async *stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const caps = capabilities(req.model);
      const base = buildCompatibleRequest(req, { id, vision: caps.vision, contextTokens: caps.maxContextTokens, maxOutputTokens: caps.maxOutputTokens, replayReasoningContent: false });
      const body: typeof base & OpenRouterBodyExt = { ...base };
      const effort = resolveEffort(req.effort, caps.efforts);
      if (effort) body.reasoning = { effort };
      const entry = catalog.get(req.model);
      const provider = routingBody({ ...opts.routing, ...entry?.routing });
      if (provider) body.provider = provider;
      if (entry?.promptCache) body.cache_control = entry.promptCache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
      try {
        const chunks = await client.chat.completions.create(body, { signal, headers });
        yield* parseCompatibleStream(chunks, { model: req.model, providerId: id });
      } catch (e) {
        if (signal?.aborted) throw abortError();
        throw mapCompatibleError(e);
      }
    },
  };
}
