import OpenAI from 'openai';
import {
  ProviderError,
  type AssistantItem,
  type AssistantPart,
  type ConvItem,
  type Effort,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type ToolSpec,
  type Usage,
} from '@opencoach/protocol';
import { resolveEffort } from './effort';
import { abortError, classifyHttpError, httpInfoFromSdkError, isAbortError, providerErrorFromHttp } from './errors';
import { dataUrl, errorMessage, isRecord, parseToolInput, stringifyInput, textOfParts } from './util';

/**
 * OpenAI Responses API adapter (GPT-6 family etc.) on the official SDK.
 *
 * Stateless by design: `store: false` with `reasoning.encrypted_content` so reasoning items can be
 * replayed (byte-for-byte, only to the same model) without OpenAI keeping the conversation.
 */

type ResponseStreamEvent = OpenAI.Responses.ResponseStreamEvent;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type CreateParams = OpenAI.Responses.ResponseCreateParamsStreaming;
type OutputItem = OpenAI.Responses.ResponseOutputItem;

/** The slice of the SDK client the adapter uses (inject a fake in tests). */
export interface OpenAIClientLike {
  responses: {
    create(body: CreateParams, options?: { signal?: AbortSignal }): PromiseLike<AsyncIterable<ResponseStreamEvent>>;
  };
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  /** Inject an SDK client (tests). Defaults to `new OpenAI({ apiKey, baseURL, organization, maxRetries: 0 })`. */
  client?: OpenAIClientLike;
}

// ------------------------------------------------------------------ model table

interface OpenAIModelInfo {
  contextTokens: number;
  maxOutputTokens: number;
  vision: boolean;
  /** Sends `reasoning` + encrypted reasoning items. */
  reasoning: boolean;
  /** Reasoning efforts the model accepts (ASSUMPTION: per-model limits are not documented in the SDK types). */
  efforts: Effort[];
}

const OPENAI_MODELS: Record<string, OpenAIModelInfo> = {
  'gpt-6-astra': { contextTokens: 1_000_000, maxOutputTokens: 128_000, vision: true, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6.1-sol': { contextTokens: 1_050_000, maxOutputTokens: 128_000, vision: true, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
  'gpt-6-sol': { contextTokens: 1_050_000, maxOutputTokens: 128_000, vision: true, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'] },
  'gpt-6-luna': { contextTokens: 1_050_000, maxOutputTokens: 128_000, vision: true, reasoning: true, efforts: ['low', 'medium', 'high'] },
};

export function openaiModelInfo(model: string): OpenAIModelInfo {
  const known = OPENAI_MODELS[model];
  if (known) return known;
  const reasoning = /^(gpt-[5-9]|o\d)/.test(model);
  return { contextTokens: 128_000, maxOutputTokens: 16_384, vision: true, reasoning, efforts: reasoning ? ['low', 'medium', 'high'] : [] };
}

export function openaiCapabilities(model: string): ModelCapabilities {
  const info = openaiModelInfo(model);
  return {
    vision: info.vision,
    maxContextTokens: info.contextTokens,
    maxOutputTokens: info.maxOutputTokens,
    streamingToolInput: true,
    promptCaching: true,
    midConversationSystem: true, // `developer` messages anywhere in the input
    parallelToolCalls: true,
    efforts: info.efforts,
    batch: false,
  };
}

// ------------------------------------------------------------------ request mapping

type UserContent = Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }>;

function userContent(parts: Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>): UserContent {
  const out: UserContent = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.length > 0) out.push({ type: 'input_text', text: p.text });
    } else out.push({ type: 'input_image', image_url: dataUrl(p.mediaType, p.data), detail: 'auto' });
  }
  return out;
}

/** Neutral items -> Responses `input` items. */
export function buildOpenAIInput(items: ConvItem[], model: string): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'user': {
        const content = userContent(item.parts);
        if (content.length > 0) input.push({ role: 'user', content });
        break;
      }
      case 'harness':
        if (item.text.trim() !== '') input.push({ role: 'developer', content: item.text });
        break;
      case 'assistant': {
        if (item.provider === 'openai' && item.model === model && Array.isArray(item.raw) && item.raw.length > 0) {
          // Same model: replay the output items (incl. reasoning with encrypted_content) unchanged.
          for (const raw of item.raw as unknown[]) if (isRecord(raw)) input.push(raw as unknown as ResponseInputItem);
          break;
        }
        let text = '';
        const flush = () => {
          if (text.length > 0) input.push({ role: 'assistant', content: text });
          text = '';
        };
        for (const part of item.parts as AssistantPart[]) {
          if (part.type === 'text') text += part.text;
          else {
            flush();
            input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: stringifyInput(part.input) });
          }
        }
        flush();
        break;
      }
      case 'tool_results': {
        const images: UserContent = [];
        for (const r of item.results) {
          let output = textOfParts(r.content);
          if (r.isError) output = `Error: ${output || 'the tool returned no details.'}`;
          else if (output === '') output = '(empty result)';
          input.push({ type: 'function_call_output', call_id: r.callId, output });
          const imgs = r.content.filter((c) => c.type === 'image');
          if (imgs.length > 0) {
            images.push({ type: 'input_text', text: `Image(s) returned by tool ${r.name} (call ${r.callId}):` }, ...userContent(imgs));
          }
        }
        // Function outputs cannot carry images on every model: send them as a user message right after.
        if (images.length > 0) input.push({ role: 'user', content: images });
        break;
      }
    }
  }
  return input;
}

function mapTools(tools: ToolSpec[]): OpenAI.Responses.FunctionTool[] {
  return tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
}

/** Pure request builder (exported for tests). */
export function buildOpenAIRequest(req: ModelRequest): CreateParams {
  const info = openaiModelInfo(req.model);
  const instructions = req.system
    .map((b) => b.text)
    .filter((t) => t.trim() !== '')
    .join('\n\n');
  const effort = resolveEffort(req.effort, info.efforts);
  const tools = mapTools(req.tools);
  return {
    model: req.model,
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    input: buildOpenAIInput(req.items, req.model),
    ...(tools.length > 0 ? { tools, parallel_tool_calls: true } : {}),
    ...(info.reasoning ? { reasoning: { ...(effort ? { effort } : {}), summary: 'auto' as const }, include: ['reasoning.encrypted_content' as const] } : {}),
    max_output_tokens: Math.max(16, Math.min(req.maxOutputTokens, info.maxOutputTokens)),
    ...(req.cacheKey ? { prompt_cache_key: req.cacheKey } : {}),
  };
}

// ------------------------------------------------------------------ stream parsing

interface FnCall {
  callId: string;
  name: string;
  ended: boolean;
}

function mapResponseError(err: { code?: string | null; message?: string | null } | null | undefined): ProviderError {
  const message = err?.message || 'OpenAI response failed';
  const code = err?.code ?? undefined;
  if (code && /^(server_error|internal_error|internal_server_error|service_unavailable|overloaded)$/.test(code)) {
    return new ProviderError(message, { kind: 'unknown', retryable: true });
  }
  const { kind, retryable } = classifyHttpError({ message, code });
  return new ProviderError(message, { kind, retryable });
}

function parsePartsFromOutput(output: OutputItem[], complete: (fc: OpenAI.Responses.ResponseFunctionToolCall) => boolean): { parts: AssistantPart[]; refused: boolean } {
  const parts: AssistantPart[] = [];
  let refused = false;
  for (const it of output) {
    if (it.type === 'message') {
      for (const c of it.content) {
        if (c.type === 'output_text') {
          if (c.text) parts.push({ type: 'text', text: c.text });
        } else if (c.type === 'refusal') refused = true;
      }
    } else if (it.type === 'function_call' && complete(it)) {
      parts.push({ type: 'tool_call', id: it.call_id, name: it.name, input: parseToolInput(it.arguments).input });
    }
  }
  return { parts, refused };
}

/** Responses stream events -> neutral stream events. */
export async function* parseOpenAIStream(events: AsyncIterable<ResponseStreamEvent>, ctx: { model: string }): AsyncGenerator<ModelStreamEvent> {
  const calls = new Map<number, FnCall>(); // by output_index
  const endedCallIds = new Set<string>();
  const summaries: string[] = [];
  let final: OpenAI.Responses.Response | undefined;

  for await (const ev of events) {
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) yield { type: 'text_delta', text: ev.delta };
        break;
      case 'response.output_item.added':
        if (ev.item.type === 'function_call') {
          calls.set(ev.output_index, { callId: ev.item.call_id, name: ev.item.name, ended: false });
          yield { type: 'tool_call_start', id: ev.item.call_id, name: ev.item.name };
        }
        break;
      case 'response.function_call_arguments.delta': {
        const fc = calls.get(ev.output_index);
        if (fc && ev.delta) yield { type: 'tool_input_delta', id: fc.callId, partialJson: ev.delta };
        break;
      }
      case 'response.function_call_arguments.done': {
        const fc = calls.get(ev.output_index);
        if (fc && !fc.ended) {
          fc.ended = true;
          endedCallIds.add(fc.callId);
          yield { type: 'tool_call_end', id: fc.callId, name: fc.name, input: parseToolInput(ev.arguments).input };
        }
        break;
      }
      case 'response.reasoning_summary_text.done': {
        // One progress note per finished summary part (not per token).
        const note = ev.text.trim();
        if (note) {
          summaries.push(note);
          yield { type: 'progress', text: note };
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        final = ev.response;
        break;
      case 'response.failed':
        throw mapResponseError(ev.response.error);
      case 'error':
        throw mapResponseError({ code: ev.code, message: ev.message });
      default:
        break;
    }
  }

  if (!final) throw new ProviderError('OpenAI stream ended before the response completed', { kind: 'network', retryable: true });

  const incomplete = final.status === 'incomplete';
  const isComplete = (fc: OpenAI.Responses.ResponseFunctionToolCall): boolean =>
    endedCallIds.has(fc.call_id) || (!incomplete && fc.status !== 'incomplete');
  // Calls that finished but never produced an arguments.done event (defensive).
  for (const it of final.output) {
    if (it.type === 'function_call' && isComplete(it) && !endedCallIds.has(it.call_id)) {
      endedCallIds.add(it.call_id);
      yield { type: 'tool_call_end', id: it.call_id, name: it.name, input: parseToolInput(it.arguments).input };
    }
  }

  const { parts, refused } = parsePartsFromOutput(final.output, isComplete);

  // Provider-native replay content: drop unfinished calls, and any reasoning item left dangling at the end
  // (the API rejects a reasoning item without its following item).
  const raw: unknown[] = final.output.filter((it) => !(it.type === 'function_call' && !isComplete(it)));
  while (raw.length > 0 && isRecord(raw[raw.length - 1]) && (raw[raw.length - 1] as { type?: unknown }).type === 'reasoning') raw.pop();

  let stopReason: StopReason;
  let refusalCategory: string | undefined;
  const reason = final.incomplete_details?.reason;
  if (refused) stopReason = 'refusal';
  else if (incomplete && reason === 'content_filter') {
    stopReason = 'refusal';
    refusalCategory = 'content_filter';
  } else if (incomplete && reason === 'max_output_tokens') stopReason = 'max_tokens';
  else if (incomplete) stopReason = 'other';
  else stopReason = parts.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end_turn';

  const u = final.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: u?.output_tokens ?? 0,
  };
  const item: AssistantItem = {
    kind: 'assistant',
    parts,
    provider: 'openai',
    model: ctx.model,
    ...(raw.length > 0 ? { raw } : {}),
    ...(summaries.length > 0 ? { reasoningSummary: summaries.join('\n\n') } : {}),
  };
  yield { type: 'message_end', stopReason, usage, item, ...(refusalCategory ? { refusalCategory } : {}) };
}

// ------------------------------------------------------------------ errors

export function mapOpenAIError(e: unknown): ProviderError | Error {
  if (e instanceof ProviderError) return e;
  if (e instanceof OpenAI.APIUserAbortError || isAbortError(e)) return e instanceof Error ? e : abortError();
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError(errorMessage(e), { kind: 'timeout', retryable: true, cause: e });
  if (e instanceof OpenAI.APIConnectionError) return new ProviderError(errorMessage(e), { kind: 'network', retryable: true, cause: e });
  const info = httpInfoFromSdkError(e);
  if (info) return providerErrorFromHttp(info, e);
  return new ProviderError(errorMessage(e), { kind: 'unknown', retryable: false, cause: e });
}

// ------------------------------------------------------------------ provider

/** OpenAI Responses API (GPT-6 family etc.). */
export function createOpenAIProvider(opts: OpenAIProviderOptions): ModelProvider {
  const client: OpenAIClientLike =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.organization ? { organization: opts.organization } : {}),
      maxRetries: 0,
    });
  return {
    id: 'openai',
    capabilities: openaiCapabilities,
    async *stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const params = buildOpenAIRequest(req);
      try {
        const events = await client.responses.create(params, { signal });
        yield* parseOpenAIStream(events, { model: req.model });
      } catch (e) {
        if (signal?.aborted) throw abortError();
        throw mapOpenAIError(e);
      }
    },
  };
}
