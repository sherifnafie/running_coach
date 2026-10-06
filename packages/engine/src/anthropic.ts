import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderError,
  type AssistantItem,
  type AssistantPart,
  type ContentPart,
  type ConvItem,
  type Effort,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type SystemBlock,
  type ToolResult,
  type ToolSpec,
  type Usage,
} from '@opencoach/protocol';
import { resolveEffort } from './effort';
import { abortError, httpInfoFromSdkError, isAbortError, providerErrorFromHttp } from './errors';
import { errorMessage, isRecord, parseToolInput } from './util';

/**
 * Anthropic Messages adapter on the official SDK (docs/adr/0001-provider-adapters.md).
 *
 * Request shapes follow the `claude-api` skill guidance for Claude Sonnet 5.5 / Opus 5.5 / Fable 5.1:
 * adaptive thinking + `output_config.effort` (thinking can't be disabled, no forced tool_choice, no
 * assistant prefill), mid-conversation `role: "system"` messages, preserved thinking (replay the
 * assistant's content blocks unchanged, only to the model that produced them), server-side refusal
 * fallbacks and `thinking.display: "updates"` progress notes (both behind betas), and eager tool
 * input streaming.
 */

type BlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
type TextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type ImageBlockParam = Anthropic.Beta.Messages.BetaImageBlockParam;
type ToolParam = Anthropic.Beta.Messages.BetaTool;
type ThinkingAdaptive = Anthropic.Beta.Messages.BetaThinkingConfigAdaptive;

export const BETA_THINKING_DISPLAY_UPDATES = 'thinking-display-updates-2026-08-18';
export const BETA_SERVER_SIDE_FALLBACK = 'server-side-fallback-2026-07-01';

/** The slice of the SDK client the adapter uses (inject a fake in tests). */
export interface AnthropicClientLike {
  beta: {
    messages: {
      create(body: StreamParams, options?: { signal?: AbortSignal }): PromiseLike<AsyncIterable<StreamEvent>>;
    };
  };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** Use server-side refusal fallbacks (beta) — default true. */
  serverSideFallbacks?: boolean;
  thinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  /** Inject an SDK client (tests). Defaults to `new Anthropic({ apiKey, baseURL, maxRetries: 0 })`. */
  client?: AnthropicClientLike;
  /**
   * Set `eager_input_streaming` on tools (default true; default false when `baseUrl` is set, because a
   * proxy in front of the API may reject the field).
   */
  eagerInputStreaming?: boolean;
}

// ------------------------------------------------------------------ model table

interface ModelInfo {
  contextTokens: number;
  maxOutputTokens: number;
  efforts: Effort[];
  midConversationSystem: boolean;
  /** Adaptive thinking is sent (always on for the 5.x models; Haiku 4.5 gets no thinking param). */
  adaptiveThinking: boolean;
  /** `thinking.display` is accepted (Opus 4.7+ / Sonnet 5+ / Fable / Mythos). */
  displayParam: boolean;
  /** `thinking.display: "updates"` (beta) is documented for this model. */
  displayUpdates: boolean;
  /** `fallbacks: "default"` (beta) is sent for this model. */
  serverFallback: boolean;
}

const FULL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MID: ModelInfo = {
  contextTokens: 1_000_000,
  maxOutputTokens: 128_000,
  efforts: FULL,
  midConversationSystem: true,
  adaptiveThinking: true,
  displayParam: true,
  displayUpdates: false,
  serverFallback: false,
};

const SERVER_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);

/** Exact-model overrides first, then family patterns. Unknown models get conservative defaults. */
export function anthropicModelInfo(rawModel: string): ModelInfo {
  const model = rawModel.replace(/-\d{8}$/, '');
  const serverFallback = SERVER_FALLBACK_MODELS.has(model);
  if (/^claude-(fable|mythos)-5(-\d+)?$/.test(model)) return { ...MID, displayUpdates: true, serverFallback };
  if (model === 'claude-opus-5-5') return { ...MID, displayUpdates: true, serverFallback };
  if (model === 'claude-sonnet-5-5') return { ...MID, displayUpdates: true, serverFallback };
  if (model === 'claude-opus-5' || model === 'claude-opus-4-8') return { ...MID };
  // Sonnet 5 and Opus 4.7 take adaptive thinking but not mid-conversation system messages.
  if (model === 'claude-sonnet-5' || model === 'claude-opus-4-7') return { ...MID, midConversationSystem: false };
  if (model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6') {
    return { ...MID, midConversationSystem: false, displayParam: false, efforts: ['low', 'medium', 'high', 'max'] };
  }
  if (model.startsWith('claude-haiku-4-5')) {
    return { ...MID, contextTokens: 200_000, maxOutputTokens: 64_000, efforts: [], midConversationSystem: false, adaptiveThinking: false, displayParam: false };
  }
  return { ...MID, contextTokens: 200_000, maxOutputTokens: 64_000, efforts: [], midConversationSystem: false, adaptiveThinking: false, displayParam: false };
}

export function anthropicCapabilities(model: string): ModelCapabilities {
  const info = anthropicModelInfo(model);
  return {
    vision: true,
    maxContextTokens: info.contextTokens,
    maxOutputTokens: info.maxOutputTokens,
    streamingToolInput: true,
    promptCaching: true,
    midConversationSystem: info.midConversationSystem,
    parallelToolCalls: true,
    efforts: info.efforts,
    batch: false,
  };
}

// ------------------------------------------------------------------ request mapping

export interface AnthropicBuildOptions {
  serverSideFallbacks: boolean;
  thinkingDisplay: 'omitted' | 'summarized' | 'updates';
  eagerInputStreaming: boolean;
}

export interface BuiltAnthropicRequest {
  params: StreamParams;
  betas: string[];
  /** The thinking display actually requested (drives whether thinking blocks become 'progress'). */
  display: 'omitted' | 'summarized' | 'updates';
}

const EPHEMERAL = { type: 'ephemeral' } as const;
const MAX_BREAKPOINTS = 4;

type RawBlock = Record<string, unknown> & { type: string };
const asBlock = (b: RawBlock): BlockParam => b as unknown as BlockParam;
const isToolResultBlock = (b: BlockParam): boolean => b.type === 'tool_result';

function imageBlock(p: Extract<ContentPart, { type: 'image' }>): BlockParam {
  return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
}

function contentBlocks(parts: ContentPart[]): BlockParam[] {
  const out: BlockParam[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.length > 0) out.push({ type: 'text', text: p.text });
    } else out.push(imageBlock(p));
  }
  return out;
}

/** Anthropic tool ids must match [a-zA-Z0-9_-]+; ids minted by other providers may not. Identity for valid ids. */
const toolId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

function toolResultBlock(r: ToolResult): BlockParam {
  const content = contentBlocks(r.content);
  return {
    type: 'tool_result',
    tool_use_id: toolId(r.callId),
    ...(content.length > 0
      ? { content: content as Array<TextBlockParam | ImageBlockParam> }
      : r.isError
        ? { content: [{ type: 'text' as const, text: 'Error (the tool returned no details).' }] }
        : {}),
    ...(r.isError ? { is_error: true } : {}),
  };
}

function assistantBlocks(item: Extract<ConvItem, { kind: 'assistant' }>, model: string): BlockParam[] {
  // Preserved thinking: replay the provider-native blocks verbatim, ONLY for the same provider+model (SPEC [MOD-3]).
  if (item.provider === 'anthropic' && item.model === model && Array.isArray(item.raw) && item.raw.length > 0) {
    return (item.raw as unknown[]).filter(isRecord).map((b) => asBlock(b as RawBlock));
  }
  const out: BlockParam[] = [];
  for (const part of item.parts as AssistantPart[]) {
    if (part.type === 'text') {
      if (part.text.length > 0) out.push({ type: 'text', text: part.text });
    } else {
      out.push({ type: 'tool_use', id: toolId(part.id), name: part.name, input: isRecord(part.input) ? part.input : {} });
    }
  }
  return out;
}

type Entry = { role: 'user' | 'assistant'; blocks: BlockParam[] } | { role: 'harness'; text: string };

/** Merge user-role blocks: tool_result blocks must come first, then text/images. */
function mergeUserBlocks(a: BlockParam[], b: BlockParam[]): BlockParam[] {
  const all = [...a, ...b];
  return [...all.filter(isToolResultBlock), ...all.filter((x) => !isToolResultBlock(x))];
}

function harnessText(text: string): BlockParam {
  return { type: 'text', text: `<harness>\n${text}\n</harness>` };
}

/**
 * Neutral items -> Messages API messages.
 *
 * - consecutive user-role content (user items, tool results, demoted harness notes) is merged into
 *   one message, tool_result blocks first;
 * - a harness item becomes a mid-conversation `role: "system"` message when the model supports it AND
 *   the placement is valid (follows a user message; is last or followed by an assistant turn; not
 *   first); otherwise it is wrapped as `<harness>…</harness>` text in the adjacent user message;
 * - assistant items replay `raw` for the same provider+model, else are rebuilt from `parts`.
 */
export function buildAnthropicMessages(items: ConvItem[], model: string, midConversationSystem: boolean): MessageParam[] {
  const entries: Entry[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'user':
      case 'tool_results': {
        const blocks = item.kind === 'user' ? contentBlocks(item.parts) : item.results.map(toolResultBlock);
        if (blocks.length === 0) break;
        const last = entries[entries.length - 1];
        if (last && last.role === 'user') last.blocks = mergeUserBlocks(last.blocks, blocks);
        else entries.push({ role: 'user', blocks });
        break;
      }
      case 'assistant': {
        const blocks = assistantBlocks(item, model);
        if (blocks.length > 0) entries.push({ role: 'assistant', blocks });
        break;
      }
      case 'harness': {
        if (item.text.trim() === '') break;
        const last = entries[entries.length - 1];
        if (last && last.role === 'harness') last.text = `${last.text}\n\n${item.text}`;
        else entries.push({ role: 'harness', text: item.text });
        break;
      }
    }
  }

  const out: MessageParam[] = [];
  let carry: BlockParam | undefined; // demoted harness text waiting for the next user message
  const pushUser = (blocks: BlockParam[]) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content = mergeUserBlocks(last.content, blocks);
    else out.push({ role: 'user', content: blocks });
  };

  entries.forEach((entry, i) => {
    if (entry.role === 'harness') {
      const prev = entries[i - 1];
      const next = entries[i + 1];
      const valid = midConversationSystem && prev?.role === 'user' && (next === undefined || next.role === 'assistant');
      if (valid) {
        out.push({ role: 'system', content: entry.text });
        return;
      }
      const wrapped = harnessText(entry.text);
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content = mergeUserBlocks(last.content, [wrapped]);
      else if (next && next.role === 'user') carry = wrapped;
      else pushUser([wrapped]);
      return;
    }
    if (entry.role === 'user') {
      let blocks = entry.blocks;
      if (carry) {
        // goes after the leading tool_result blocks, before the athlete's content
        const results = blocks.filter(isToolResultBlock);
        const rest = blocks.filter((b) => !isToolResultBlock(b));
        blocks = [...results, carry, ...rest];
        carry = undefined;
      }
      pushUser(blocks);
      return;
    }
    out.push({ role: 'assistant', content: entry.blocks });
  });
  return out;
}

/** Moving cache breakpoint: last block of the final user message (not on a mid-conversation system message). */
function addMovingBreakpoint(messages: MessageParam[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'system') continue;
    if (m.role !== 'user' || !Array.isArray(m.content) || m.content.length === 0) return;
    const lastBlock = m.content[m.content.length - 1]!;
    if (lastBlock.type !== 'text' && lastBlock.type !== 'image' && lastBlock.type !== 'tool_result') return;
    m.content[m.content.length - 1] = { ...lastBlock, cache_control: EPHEMERAL };
    return;
  }
}

function mapSystem(blocks: SystemBlock[]): { blocks: TextBlockParam[]; used: number } {
  const nonEmpty = blocks.filter((b) => b.text.trim().length > 0);
  // At most 2 system breakpoints: keep the LAST two (later breakpoints cover everything before them).
  const cacheIdx = nonEmpty.map((b, i) => (b.cache ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(cacheIdx.slice(-2));
  return {
    blocks: nonEmpty.map((b, i) => ({ type: 'text' as const, text: b.text, ...(keep.has(i) ? { cache_control: EPHEMERAL } : {}) })),
    used: keep.size,
  };
}

function mapTools(tools: ToolSpec[], eager: boolean): ToolParam[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.inputSchema, type: 'object' as const },
    ...(eager ? { eager_input_streaming: true } : {}),
    ...(i === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
}

/** Pure request builder (exported for tests). */
export function buildAnthropicRequest(req: ModelRequest, opts: AnthropicBuildOptions): BuiltAnthropicRequest {
  const info = anthropicModelInfo(req.model);
  const betas: string[] = [];

  const system = mapSystem(req.system);
  const tools = mapTools(req.tools, opts.eagerInputStreaming);
  const messages = buildAnthropicMessages(req.items, req.model, info.midConversationSystem);
  // Breakpoint budget: system (<=2) + last tool (1) + moving tail (1) = 4.
  if (system.used + (tools.length > 0 ? 1 : 0) + 1 <= MAX_BREAKPOINTS) addMovingBreakpoint(messages);

  let display: BuiltAnthropicRequest['display'] = 'omitted';
  let thinking: ThinkingAdaptive | undefined;
  if (info.adaptiveThinking) {
    display = opts.thinkingDisplay === 'updates' && !info.displayUpdates ? 'omitted' : opts.thinkingDisplay;
    if (!info.displayParam) display = 'omitted';
    thinking = info.displayParam ? { type: 'adaptive', display } : { type: 'adaptive' };
    if (display === 'updates') betas.push(BETA_THINKING_DISPLAY_UPDATES);
  }
  const effort = resolveEffort(req.effort, info.efforts, 'medium');

  const params: StreamParams = {
    model: req.model,
    max_tokens: Math.max(1, Math.min(req.maxOutputTokens, info.maxOutputTokens)),
    stream: true,
    messages,
    ...(system.blocks.length > 0 ? { system: system.blocks } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(thinking ? { thinking } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
  if (opts.serverSideFallbacks && info.serverFallback) {
    params.fallbacks = 'default';
    betas.push(BETA_SERVER_SIDE_FALLBACK);
  }
  if (betas.length > 0) params.betas = betas;
  return { params, betas, display };
}

// ------------------------------------------------------------------ stream parsing

interface Acc {
  index: number;
  raw: RawBlock;
  json: string;
  done: boolean;
}

function mapStopReason(sr: string | null | undefined): StopReason {
  switch (sr) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}

/**
 * Raw Messages stream events -> neutral stream events.
 *
 * Tool inputs are parsed strictly at `content_block_stop`. With eager input streaming the server does
 * not validate them, so an input that is not valid JSON is reported with the INVALID_TOOL_INPUT_KEY
 * marker (the loop answers it with an error result), and a tool_use cut off by `max_tokens` is dropped
 * entirely (not in `parts`, not in `raw`, no `tool_call_end`).
 */
export async function* parseAnthropicStream(
  events: AsyncIterable<StreamEvent>,
  ctx: { model: string; display: BuiltAnthropicRequest['display'] },
): AsyncGenerator<ModelStreamEvent> {
  const blocks = new Map<number, Acc>();
  const order: Acc[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason: string | null = null;
  let category: string | undefined;
  let sawStop = false;
  let fallbackBoundary = -1;
  let fallbackTo: string | undefined;
  const invalidTools: Acc[] = [];

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message.usage;
        usage.input = u.input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        break;
      }
      case 'content_block_start': {
        const raw = { ...(ev.content_block as unknown as RawBlock) };
        const acc: Acc = { index: ev.index, raw, json: '', done: false };
        blocks.set(ev.index, acc);
        order.push(acc);
        if (raw.type === 'text') raw.text = typeof raw.text === 'string' ? raw.text : '';
        else if (raw.type === 'thinking') {
          raw.thinking = typeof raw.thinking === 'string' ? raw.thinking : '';
          raw.signature = typeof raw.signature === 'string' ? raw.signature : '';
        } else if (raw.type === 'tool_use') {
          raw.input = {};
          yield { type: 'tool_call_start', id: String(raw.id), name: String(raw.name) };
        } else if (raw.type === 'fallback') {
          fallbackBoundary = ev.index;
          const to = raw.to;
          if (isRecord(to) && typeof to.model === 'string') fallbackTo = to.model;
        }
        break;
      }
      case 'content_block_delta': {
        const acc = blocks.get(ev.index);
        if (!acc) break;
        const d = ev.delta;
        if (d.type === 'text_delta') {
          acc.raw.text = String(acc.raw.text ?? '') + d.text;
          if (d.text) yield { type: 'text_delta', text: d.text };
        } else if (d.type === 'thinking_delta') {
          acc.raw.thinking = String(acc.raw.thinking ?? '') + d.thinking;
        } else if (d.type === 'signature_delta') {
          acc.raw.signature = d.signature;
        } else if (d.type === 'input_json_delta') {
          acc.json += d.partial_json;
          if (d.partial_json) yield { type: 'tool_input_delta', id: String(acc.raw.id), partialJson: d.partial_json };
        }
        break;
      }
      case 'content_block_stop': {
        const acc = blocks.get(ev.index);
        if (!acc) break;
        acc.done = true;
        if (acc.raw.type === 'tool_use') {
          const parsed = parseToolInput(acc.json);
          acc.raw.input = parsed.input;
          if (parsed.valid) yield { type: 'tool_call_end', id: String(acc.raw.id), name: String(acc.raw.name), input: parsed.input };
          else invalidTools.push(acc); // decided once the stop reason is known
        } else if (acc.raw.type === 'thinking' && ctx.display === 'updates') {
          // Under display "updates", any thinking block with text is a progress note for the athlete.
          const note = String(acc.raw.thinking ?? '').trim();
          if (note) yield { type: 'progress', text: note };
        }
        break;
      }
      case 'message_delta': {
        if (ev.delta.stop_reason !== undefined) stopReason = ev.delta.stop_reason;
        if (ev.delta.stop_details?.category) category = ev.delta.stop_details.category;
        const u = ev.usage;
        if (u.input_tokens != null) usage.input = u.input_tokens;
        if (u.output_tokens != null) usage.output = u.output_tokens;
        if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens;
        break;
      }
      case 'message_stop':
        sawStop = true;
        break;
    }
  }

  if (!sawStop && stopReason === null) {
    throw new ProviderError('Anthropic stream ended before the message was complete', { kind: 'network', retryable: true });
  }

  const cutOff = stopReason === 'max_tokens' || stopReason === 'refusal';
  // Invalid (non-JSON) inputs on a normal stop are surfaced to the loop; on a cut-off they are dropped.
  for (const acc of invalidTools) {
    if (!cutOff) yield { type: 'tool_call_end', id: String(acc.raw.id), name: String(acc.raw.name), input: acc.raw.input };
  }
  const invalid = new Set(invalidTools);
  const complete = (acc: Acc): boolean => {
    switch (acc.raw.type) {
      case 'tool_use':
        return acc.done && (!invalid.has(acc) || !cutOff);
      case 'thinking':
        return acc.done && String(acc.raw.signature ?? '') !== '';
      case 'text':
        return String(acc.raw.text ?? '') !== '';
      default:
        return acc.done;
    }
  };

  const kept = order.filter(complete);
  const parts: AssistantPart[] = [];
  for (const acc of kept) {
    if (acc.raw.type === 'text') parts.push({ type: 'text', text: String(acc.raw.text) });
    // After a server-side fallback, tool calls from before the boundary belong to the declined attempt.
    else if (acc.raw.type === 'tool_use' && acc.index > fallbackBoundary) {
      parts.push({ type: 'tool_call', id: String(acc.raw.id), name: String(acc.raw.name), input: acc.raw.input });
    }
  }
  const sawFallback = fallbackBoundary >= 0;
  const item: AssistantItem = {
    kind: 'assistant',
    parts,
    provider: 'anthropic',
    model: sawFallback && fallbackTo ? fallbackTo : ctx.model,
    // Thinking from a fallback model is not replayable on the primary; rebuild from parts instead.
    ...(sawFallback ? {} : { raw: kept.map((a) => a.raw) }),
  };
  const out: Usage = { inputTokens: usage.input, cachedInputTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, outputTokens: usage.output };
  const mapped = mapStopReason(stopReason);
  yield { type: 'message_end', stopReason: mapped, usage: out, item, ...(mapped === 'refusal' && category ? { refusalCategory: category } : {}) };
}

// ------------------------------------------------------------------ errors

/** Map an SDK/transport error to a ProviderError (or an AbortError when the call was aborted). */
export function mapAnthropicError(e: unknown): ProviderError | Error {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.APIUserAbortError || isAbortError(e)) return e instanceof Error ? e : abortError();
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError(errorMessage(e), { kind: 'timeout', retryable: true, cause: e });
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(errorMessage(e), { kind: 'network', retryable: true, cause: e });
  const info = httpInfoFromSdkError(e);
  if (info) return providerErrorFromHttp(info, e);
  return new ProviderError(errorMessage(e), { kind: 'unknown', retryable: false, cause: e });
}

// ------------------------------------------------------------------ provider

export function createAnthropicProvider(opts: AnthropicProviderOptions): ModelProvider {
  const client: AnthropicClientLike =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}), maxRetries: 0 });
  const build: AnthropicBuildOptions = {
    serverSideFallbacks: opts.serverSideFallbacks ?? true,
    thinkingDisplay: opts.thinkingDisplay ?? 'updates',
    eagerInputStreaming: opts.eagerInputStreaming ?? opts.baseUrl === undefined,
  };
  return {
    id: 'anthropic',
    capabilities: anthropicCapabilities,
    async *stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const { params, display } = buildAnthropicRequest(req, build);
      try {
        const events = await client.beta.messages.create(params, { signal });
        yield* parseAnthropicStream(events, { model: req.model, display });
      } catch (e) {
        if (signal?.aborted) throw abortError();
        throw mapAnthropicError(e);
      }
    },
  };
}
