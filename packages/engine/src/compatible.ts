import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  type AssistantItem,
  type AssistantPart,
  type CompatibleProviderConfig,
  type ContentPart,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type Usage,
} from '@opencoach/protocol';
import { abortError, httpInfoFromSdkError, isAbortError, providerErrorFromHttp } from './errors';
import { dataUrl, errorMessage, isRecord, parseToolInput, stringifyInput, textOfParts } from './util';

/**
 * Any OpenAI-compatible Chat Completions endpoint (DeepSeek, Ollama, vLLM, OpenRouter, ...) on the
 * official `openai` SDK with a custom baseURL.
 */

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type UserPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

/** DeepSeek-style extensions the SDK types do not know about. */
type AssistantWithReasoning = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string };
interface DeltaExt {
  reasoning_content?: string | null;
}
interface UsageExt {
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
}

export const NO_VISION_PLACEHOLDER = '[image omitted: model has no vision]';

/** The slice of the SDK client the adapter uses (inject a fake in tests). */
export interface CompatibleClientLike {
  chat: {
    completions: {
      create(body: CreateParams, options?: { signal?: AbortSignal; headers?: Record<string, string> }): PromiseLike<AsyncIterable<Chunk>>;
    };
  };
}

export interface CompatibleProviderDeps {
  client?: CompatibleClientLike;
}

type Cfg = Pick<CompatibleProviderConfig, 'id' | 'vision' | 'contextTokens' | 'maxOutputTokens' | 'replayReasoningContent'>;

// ------------------------------------------------------------------ request mapping

function userParts(parts: ContentPart[], vision: boolean): UserPart[] {
  const out: UserPart[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.length > 0) out.push({ type: 'text', text: p.text });
    } else if (vision) out.push({ type: 'image_url', image_url: { url: dataUrl(p.mediaType, p.data) } });
    else out.push({ type: 'text', text: NO_VISION_PLACEHOLDER });
  }
  return out;
}

/** Plain string when there is no image part (the most widely supported shape), else content parts. */
function userContent(parts: UserPart[]): string | UserPart[] {
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : parts;
}

export function buildCompatibleMessages(req: ModelRequest, cfg: Cfg): Message[] {
  const messages: Message[] = [];
  const system = req.system
    .map((b) => b.text)
    .filter((t) => t.trim() !== '')
    .join('\n\n');
  if (system) messages.push({ role: 'system', content: system });

  for (const item of req.items) {
    switch (item.kind) {
      case 'user': {
        const parts = userParts(item.parts, cfg.vision);
        if (parts.length > 0) messages.push({ role: 'user', content: userContent(parts) });
        break;
      }
      case 'harness':
        if (item.text.trim() !== '') messages.push({ role: 'system', content: item.text });
        break;
      case 'assistant': {
        const text = item.parts
          .filter((p): p is Extract<AssistantPart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        const toolCalls = item.parts
          .filter((p): p is Extract<AssistantPart, { type: 'tool_call' }> => p.type === 'tool_call')
          .map((p) => ({ id: p.id, type: 'function' as const, function: { name: p.name, arguments: stringifyInput(p.input) } }));
        if (!text && toolCalls.length === 0) break;
        const msg: AssistantWithReasoning = { role: 'assistant', content: text || (toolCalls.length > 0 ? null : '') };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        // Reasoning is echoed only within a tool loop (assistant messages with tool calls), only to the model
        // that produced it, and only for providers that ask for it (DeepSeek thinking mode).
        if (cfg.replayReasoningContent && toolCalls.length > 0 && item.provider === cfg.id && item.model === req.model && isRecord(item.raw)) {
          const rc = item.raw.reasoning_content;
          if (typeof rc === 'string' && rc !== '') msg.reasoning_content = rc;
        }
        messages.push(msg);
        break;
      }
      case 'tool_results': {
        const images: UserPart[] = [];
        for (const r of item.results) {
          let text = textOfParts(r.content);
          const imgs = r.content.filter((c) => c.type === 'image');
          if (imgs.length > 0 && !cfg.vision) text = [text, ...imgs.map(() => NO_VISION_PLACEHOLDER)].filter(Boolean).join('\n');
          if (r.isError) text = `Error: ${text || 'the tool returned no details.'}`;
          else if (text === '') text = imgs.length > 0 && cfg.vision ? '(image result below)' : '(empty result)';
          messages.push({ role: 'tool', tool_call_id: r.callId, content: text });
          if (imgs.length > 0 && cfg.vision) {
            images.push({ type: 'text', text: `Image(s) returned by tool ${r.name} (call ${r.callId}):` }, ...userParts(imgs, true));
          }
        }
        if (images.length > 0) messages.push({ role: 'user', content: images });
        break;
      }
    }
  }
  return messages;
}

export function buildCompatibleRequest(req: ModelRequest, cfg: Cfg): CreateParams {
  const tools = req.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  return {
    model: req.model,
    messages: buildCompatibleMessages(req, cfg),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.max(1, Math.min(req.maxOutputTokens, cfg.maxOutputTokens)),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

// ------------------------------------------------------------------ stream parsing

interface ToolAcc {
  index: number;
  id: string;
  name: string;
  args: string;
  started: boolean;
}

function mapFinish(finish: string | null, hasToolCalls: boolean): StopReason {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    case null:
      // some servers (Ollama) report "stop" even when the message carries tool calls
      return hasToolCalls ? 'tool_use' : 'end_turn';
    default:
      return hasToolCalls ? 'tool_use' : 'other';
  }
}

/** Chat Completions stream chunks -> neutral stream events. */
export async function* parseCompatibleStream(chunks: AsyncIterable<Chunk>, ctx: { model: string; providerId: string }): AsyncGenerator<ModelStreamEvent> {
  const tools = new Map<number, ToolAcc>();
  let seq = 0;
  let text = '';
  let reasoning = '';
  let finish: string | null = null;
  let sawAnything = false;
  let usage: Usage | undefined;

  for await (const chunk of chunks) {
    sawAnything = true;
    if (chunk.usage) {
      const u = chunk.usage as Chunk['usage'] & UsageExt;
      const cached = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
      usage = {
        inputTokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
        cachedInputTokens: cached,
        cacheWriteTokens: 0,
        outputTokens: u?.completion_tokens ?? 0,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta as Chunk['choices'][number]['delta'] & DeltaExt;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (delta.content) {
      text += delta.content;
      yield { type: 'text_delta', text: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      let acc = tools.get(index);
      if (!acc) {
        acc = { index, id: tc.id || `call_c${++seq}`, name: '', args: '', started: false };
        tools.set(index, acc);
      } else if (tc.id && !acc.started) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      const argDelta = tc.function?.arguments ?? '';
      acc.args += argDelta;
      if (!acc.started && acc.name) {
        acc.started = true;
        yield { type: 'tool_call_start', id: acc.id, name: acc.name };
        if (acc.args) yield { type: 'tool_input_delta', id: acc.id, partialJson: acc.args };
      } else if (acc.started && argDelta) {
        yield { type: 'tool_input_delta', id: acc.id, partialJson: argDelta };
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  if (!sawAnything) throw new ProviderError('model stream ended without any data', { kind: 'network', retryable: true });

  const truncated = finish === 'length';
  const parts: AssistantPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const acc of [...tools.values()].sort((a, b) => a.index - b.index)) {
    if (!acc.started) continue; // never got a name: garbage
    const parsed = parseToolInput(acc.args);
    if (truncated && !parsed.valid) continue; // cut off by the output limit: dropped, no tool_call_end
    yield { type: 'tool_call_end', id: acc.id, name: acc.name, input: parsed.input };
    parts.push({ type: 'tool_call', id: acc.id, name: acc.name, input: parsed.input });
  }

  const hasCalls = parts.some((p) => p.type === 'tool_call');
  const stopReason = mapFinish(finish, hasCalls);
  const item: AssistantItem = {
    kind: 'assistant',
    parts,
    provider: ctx.providerId,
    model: ctx.model,
    ...(reasoning ? { raw: { reasoning_content: reasoning } } : {}),
  };
  yield {
    type: 'message_end',
    stopReason,
    usage: usage ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    item,
    ...(stopReason === 'refusal' ? { refusalCategory: 'content_filter' } : {}),
  };
}

// ------------------------------------------------------------------ errors

export function mapCompatibleError(e: unknown): ProviderError | Error {
  if (e instanceof ProviderError) return e;
  if (e instanceof OpenAI.APIUserAbortError || isAbortError(e)) return e instanceof Error ? e : abortError();
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError(errorMessage(e), { kind: 'timeout', retryable: true, cause: e });
  if (e instanceof OpenAI.APIConnectionError) return new ProviderError(errorMessage(e), { kind: 'network', retryable: true, cause: e });
  const info = httpInfoFromSdkError(e);
  if (info) return providerErrorFromHttp(info, e);
  return new ProviderError(errorMessage(e), { kind: 'unknown', retryable: false, cause: e });
}

// ------------------------------------------------------------------ provider

/** Any OpenAI-compatible Chat Completions endpoint (DeepSeek, Ollama, vLLM, OpenRouter, ...). */
export function createCompatibleProvider(cfg: CompatibleProviderConfig & { apiKey?: string }, deps: CompatibleProviderDeps = {}): ModelProvider {
  const apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? 'not-needed';
  const client: CompatibleClientLike = deps.client ?? new OpenAI({ apiKey, baseURL: cfg.baseUrl, maxRetries: 0 });
  const anonymousSessions = new WeakMap<ModelRequest, string>();
  function requestHeaders(req: ModelRequest): Record<string, string> | undefined {
    if (!cfg.headers && !cfg.sessionHeader) return undefined;
    const headers = { ...cfg.headers };
    if (cfg.sessionHeader) {
      // Epoch identity survives tool steps, retries and turns; fallbacks also work for direct adapter callers.
      let session = req.metadata?.epochId ?? req.metadata?.athleteId ?? req.cacheKey ?? req.metadata?.turnId;
      if (!session) {
        session = anonymousSessions.get(req) ?? randomUUID();
        anonymousSessions.set(req, session);
      }
      for (const name of Object.keys(headers)) if (name.toLowerCase() === cfg.sessionHeader.toLowerCase()) delete headers[name];
      headers[cfg.sessionHeader] = session;
    }
    return headers;
  }
  const capabilities: ModelCapabilities = {
    vision: cfg.vision,
    maxContextTokens: cfg.contextTokens,
    maxOutputTokens: cfg.maxOutputTokens,
    streamingToolInput: true,
    promptCaching: false,
    midConversationSystem: false,
    parallelToolCalls: true,
    efforts: [],
    batch: false,
  };
  return {
    id: cfg.id,
    capabilities: () => capabilities,
    async *stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const params = buildCompatibleRequest(req, cfg);
      try {
        const headers = requestHeaders(req);
        const chunks = await client.chat.completions.create(params, { signal, ...(headers ? { headers } : {}) });
        yield* parseCompatibleStream(chunks, { model: req.model, providerId: cfg.id });
      } catch (e) {
        if (signal?.aborted) throw abortError();
        throw mapCompatibleError(e);
      }
    },
  };
}
