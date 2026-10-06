import {
  ProviderError,
  estimateTokens,
  type AssistantItem,
  type AssistantPart,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type StopReason,
  type Usage,
} from '@opencoach/protocol';
import { abortError } from './errors';
import { chunkFixed, chunkText, stringifyInput } from './util';

/** Failure kinds a scripted step can inject. */
export type ScriptedFailKind = 'rate_limit' | 'overloaded' | 'network' | 'invalid_request';

export interface ScriptedStep {
  /** Visible assistant text (becomes the private turn note unless tool calls follow). */
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown; id?: string }>;
  progress?: string[];
  usage?: Partial<Usage>;
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  /** Throw this ProviderError kind instead of answering (failure injection). */
  fail?: { kind: ScriptedFailKind; message?: string };
  /** Category reported with a `refusal` stop (default "scripted"). */
  refusalCategory?: string;
  /** Retry-After to attach to an injected `rate_limit` failure. */
  retryAfterMs?: number;
}

/** `ctx.call` is the 0-based index of this call on the provider. */
export type ScriptHandler = (req: ModelRequest, ctx: { call: number }) => ScriptedStep | Promise<ScriptedStep>;

export interface ScriptedProviderOptions {
  id?: string;
  /** A function, or a fixed queue of steps consumed in order (then repeats `{ text: '' }`). */
  handler: ScriptHandler | ScriptedStep[];
  capabilities?: Partial<ModelCapabilities>;
}

export interface ScriptedProvider extends ModelProvider {
  /** Every request received (for assertions). `items` is a snapshot taken at call time. */
  readonly requests: ModelRequest[];
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  vision: true,
  maxContextTokens: 200_000,
  maxOutputTokens: 32_000,
  streamingToolInput: true,
  promptCaching: false,
  midConversationSystem: true,
  parallelToolCalls: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  batch: false,
};

const FAIL_STATUS: Record<ScriptedFailKind, number> = { rate_limit: 429, overloaded: 529, network: 0, invalid_request: 400 };

function failureFor(fail: NonNullable<ScriptedStep['fail']>, retryAfterMs?: number): ProviderError {
  const message = fail.message ?? `scripted ${fail.kind} failure`;
  const status = FAIL_STATUS[fail.kind] || undefined;
  return new ProviderError(message, {
    kind: fail.kind,
    retryable: fail.kind !== 'invalid_request',
    status,
    retryAfterMs: fail.kind === 'rate_limit' ? retryAfterMs : undefined,
  });
}

/** A deterministic provider that emits realistic stream events from a handler or a queue of steps. */
export function createScriptedProvider(opts: ScriptedProviderOptions): ScriptedProvider {
  const id = opts.id ?? 'scripted';
  const capabilities: ModelCapabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
  const requests: ModelRequest[] = [];
  let calls = 0;
  let toolSeq = 0;

  const nextStep = async (req: ModelRequest, call: number): Promise<ScriptedStep> => {
    if (typeof opts.handler === 'function') return await opts.handler(req, { call });
    return opts.handler[call] ?? { text: '' };
  };

  return {
    id,
    requests,
    capabilities: () => capabilities,
    async *stream(req: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      const call = calls++;
      requests.push({ ...req, items: [...req.items] });
      const checkAbort = () => {
        if (signal?.aborted) throw abortError();
      };
      checkAbort();
      const step = await nextStep(req, call);
      checkAbort();
      if (step.fail) throw failureFor(step.fail, step.retryAfterMs);

      const toolCalls = step.toolCalls ?? [];
      const truncated = step.stopReason === 'max_tokens' && toolCalls.length > 0;
      const parts: AssistantPart[] = [];

      for (const note of step.progress ?? []) {
        checkAbort();
        yield { type: 'progress', text: note };
      }

      const text = step.text ?? '';
      if (text) {
        for (const chunk of chunkText(text)) {
          checkAbort();
          yield { type: 'text_delta', text: chunk };
        }
        parts.push({ type: 'text', text });
      }

      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        const callId = tc.id ?? `toolu_s${++toolSeq}`;
        const json = stringifyInput(tc.input);
        const incomplete = truncated && i === toolCalls.length - 1;
        yield { type: 'tool_call_start', id: callId, name: tc.name };
        const streamed = incomplete ? json.slice(0, Math.max(1, Math.floor(json.length / 2))) : json;
        for (const piece of chunkFixed(streamed)) {
          checkAbort();
          yield { type: 'tool_input_delta', id: callId, partialJson: piece };
        }
        if (incomplete) continue; // cut off by max_tokens: no tool_call_end, not part of the item
        yield { type: 'tool_call_end', id: callId, name: tc.name, input: tc.input };
        parts.push({ type: 'tool_call', id: callId, name: tc.name, input: tc.input });
      }

      const stopReason: StopReason = step.stopReason ?? (parts.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end_turn');
      const outputText = text + toolCalls.map((c) => stringifyInput(c.input)).join('');
      const usage: Usage = {
        inputTokens: estimateTokens(req.system) + estimateTokens(req.items),
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: estimateTokens(outputText),
        ...step.usage,
      };
      const item: AssistantItem = {
        kind: 'assistant',
        parts,
        provider: id,
        model: req.model,
        ...(step.progress?.length ? { reasoningSummary: step.progress.join('\n') } : {}),
      };
      yield {
        type: 'message_end',
        stopReason,
        usage,
        item,
        ...(stopReason === 'refusal' ? { refusalCategory: step.refusalCategory ?? 'scripted' } : {}),
      };
    },
  };
}
