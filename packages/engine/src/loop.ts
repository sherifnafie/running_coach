import {
  ProviderError,
  ZERO_USAGE,
  addUsage,
  toolResultText,
  type AgentLoop,
  type AssistantItem,
  type ConvItem,
  type ModelRequest,
  type ModelStreamEvent,
  type ResolvedModel,
  type RunTurnInput,
  type RunTurnResult,
  type ToolCallPart,
  type ToolResult,
  type ToolSpec,
  type TurnStopReason,
  type TurnStreamEvent,
  type Usage,
} from '@opencoach/protocol';
import { abortError } from './errors';
import { priceFor } from './pricing';
import { defaultSleep, errorMessage, isInvalidToolInput } from './util';

export interface AgentLoopOptions {
  /** USD cost of a usage record (wire `router.cost`). Defaults to the built-in price table. */
  price?: (model: string, usage: Usage) => number;
  /**
   * Monotonic milliseconds used ONLY to enforce the wall-time limit (never "current time", which
   * goes through Clock). Defaults to `performance.now()`; inject in tests.
   */
  monotonicNow?: () => number;
  /** Jitter source for retry backoff (default Math.random). */
  random?: () => number;
}

/** Harness note appended when a response was cut off by the output token limit. */
/** Continuations allowed after plain text is cut off by the output limit, before the turn ends as max_tokens. */
const MAX_TEXT_CUTOFFS = 2;
/** A model request that sends nothing for this long is treated as stalled and retried (then the fallback chain). */
export const STREAM_IDLE_MS = 180_000;
/** Past this share of the turn's wall time the model is asked to finish; the hard limit stays a backstop. */
const WRAP_UP_AT = 0.5;
export const WRAP_UP_NOTE = 'This turn has used half of its time limit. Finish now: deliver what is needed (if the athlete is waiting, send the reply), save your work, and hand anything longer to a background helper.';
export const MAX_TOKENS_NOTE = 'Your previous response was cut off by the output token limit; continue concisely.';

const MAX_BACKOFF_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

interface StepData {
  entry: ResolvedModel;
  end: Extract<ModelStreamEvent, { type: 'message_end' }>;
  /** Tool call ids for which the provider emitted `tool_call_end`. */
  ended: Set<string>;
  /** Tool call ids for which the provider emitted `tool_call_start`. */
  started: Set<string>;
}

type CallOutcome = ({ type: 'ok' } & StepData) | { type: 'stop'; reason: TurnStopReason; error?: string };

/**
 * The default AgentLoop (SPEC §5.2, §5.8): repeated model calls with parallel tool execution between
 * them, steering injection at tool boundaries, limits, retries and the model fallback chain.
 *
 * Step numbers in events, `beforeStep` and request metadata are 1-based. On a `retry` or `fallback`
 * event, consumers must discard anything streamed so far for the failed attempt.
 */
export function createAgentLoop(options: AgentLoopOptions = {}): AgentLoop {
  const env = {
    price: options.price ?? ((model: string, usage: Usage) => priceFor(model, usage)),
    mono: options.monotonicNow ?? (() => performance.now()),
    random: options.random ?? Math.random,
  };
  return { runTurn: (input) => runTurnImpl(input, env) };
}

interface Env {
  price: (model: string, usage: Usage) => number;
  mono: () => number;
  random: () => number;
}

/** Reject as soon as `signal` aborts, whether or not the underlying promise honours it. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function label(entry: ResolvedModel): string {
  return `${entry.provider.id}:${entry.model}`;
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError(errorMessage(e), { kind: 'unknown', retryable: false, cause: e });
}

function assistantText(item: ConvItem | undefined): string {
  if (!item || item.kind !== 'assistant') return '';
  return item.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

async function runTurnImpl(input: RunTurnInput, env: Env): Promise<RunTurnResult> {
  const startedAt = env.mono();
  const elapsed = () => env.mono() - startedAt;
  const { route, limits } = input;
  const maxRetries = input.maxRetries ?? 2;
  const sleep = input.sleep ?? defaultSleep;

  // One signal for everything the turn does: caller abort OR wall-time expiry.
  const ctrl = new AbortController();
  let abortedBy: 'caller' | 'wall' | undefined;
  const onCallerAbort = () => {
    abortedBy ??= 'caller';
    ctrl.abort();
  };
  if (input.signal?.aborted) onCallerAbort();
  else input.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(limits.maxWallMs)) {
    wallTimer = setTimeout(() => {
      abortedBy ??= 'wall';
      ctrl.abort();
    }, Math.min(Math.max(0, limits.maxWallMs - elapsed()), MAX_TIMER_MS));
    wallTimer.unref?.();
  }

  const items: ConvItem[] = [...input.items];
  const newItems: ConvItem[] = [];
  const fallbacks: string[] = [];
  const pendingNotes: string[] = [];
  let usageTotal: Usage = { ...ZERO_USAGE };
  let costUsd = 0;
  let steps = 0;
  // A reply cut off mid-text (often reasoning that used up the output budget) gets a bounded chance to continue.
  let textCutoffs = 0;
  let wrapNoted = false;
  let routeIndex = 0;
  let current: ResolvedModel | undefined = route[0];

  const emit = (e: TurnStreamEvent) => {
    try {
      input.onEvent?.(e);
    } catch {
      // a faulty listener must never break the turn
    }
  };
  const append = (item: ConvItem) => {
    items.push(item);
    newItems.push(item);
    emit({ type: 'item', item });
  };
  const abortReason = (): TurnStopReason => (abortedBy === 'wall' ? 'max_wall' : 'aborted');

  const finish = (stopReason: TurnStopReason, error?: string): RunTurnResult => {
    let last: ConvItem | undefined;
    for (let i = newItems.length - 1; i >= 0; i--) {
      const it = newItems[i];
      if (it && it.kind === 'assistant') {
        last = it;
        break;
      }
    }
    return {
      newItems,
      stopReason,
      finalText: assistantText(last),
      usage: usageTotal,
      costUsd,
      steps,
      provider: current?.provider.id ?? '',
      model: current?.model ?? '',
      fallbacks,
      ...(error !== undefined ? { error } : {}),
    };
  };

  const stopCheck = (): TurnStopReason | undefined => {
    if (ctrl.signal.aborted) return abortReason();
    if (steps >= limits.maxSteps) return 'max_steps';
    if (elapsed() >= limits.maxWallMs) return 'max_wall';
    if (limits.maxCostUsd !== undefined && costUsd >= limits.maxCostUsd) return 'max_cost';
    return undefined;
  };

  const backoffMs = (err: ProviderError, attempt: number): number => {
    const base =
      err.retryAfterMs !== undefined ? err.retryAfterMs * (1 + env.random() * 0.1) : 1000 * 2 ** attempt * (0.8 + env.random() * 0.4);
    return Math.round(Math.min(base, MAX_BACKOFF_MS));
  };

  /** Run one streamed model call, forwarding events; returns the final message. */
  const streamOnce = async (entry: ResolvedModel, req: ModelRequest): Promise<StepData> => {
    const names = new Map<string, string>();
    const started = new Set<string>();
    const ended = new Set<string>();
    let end: StepData['end'] | undefined;
    // Per-attempt signal: the turn's signal, plus a stall timer that resets whenever the stream sends anything.
    const attempt = new AbortController();
    const onTurnAbort = () => attempt.abort();
    if (ctrl.signal.aborted) attempt.abort();
    else ctrl.signal.addEventListener('abort', onTurnAbort, { once: true });
    let stalled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        attempt.abort();
      }, STREAM_IDLE_MS);
      idle.unref?.();
    };
    armIdle();
    const iterator = entry.provider.stream(req, attempt.signal)[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<ModelStreamEvent>;
        try {
          next = await raceAbort(iterator.next(), attempt.signal);
        } catch (e) {
          if (stalled && !ctrl.signal.aborted) throw new ProviderError(`model stream stalled (nothing for ${STREAM_IDLE_MS / 1000} s)`, { kind: 'timeout', retryable: true });
          throw e;
        }
        armIdle();
        if (next.done) break;
        const ev = next.value;
        switch (ev.type) {
          case 'text_delta':
          case 'progress':
            emit(ev);
            break;
          case 'tool_call_start':
            names.set(ev.id, ev.name);
            started.add(ev.id);
            emit(ev);
            break;
          case 'tool_input_delta':
            emit({ type: 'tool_input_delta', id: ev.id, name: names.get(ev.id) ?? '', partialJson: ev.partialJson });
            break;
          case 'tool_call_end':
            ended.add(ev.id);
            emit(ev);
            break;
          case 'message_end':
            end = ev;
            break;
        }
      }
    } finally {
      if (idle) clearTimeout(idle);
      ctrl.signal.removeEventListener('abort', onTurnAbort);
      // best effort: release the underlying connection if we stopped early
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
    if (!end) throw new ProviderError('model stream ended without a final message', { kind: 'network', retryable: true });
    return { entry, end, ended, started };
  };

  /** One model call with retries, then the fallback chain. */
  const callModel = async (step: number, specs: ToolSpec[]): Promise<CallOutcome> => {
    let lastRefusal: string | undefined;
    for (;;) {
      const entry = route[routeIndex]!;
      current = entry;
      const req: ModelRequest = {
        model: entry.model,
        system: input.system,
        items: [...items],
        tools: specs,
        effort: input.effort ?? entry.effort,
        maxOutputTokens: entry.maxOutputTokens,
        cacheKey: input.cacheKey,
        metadata: { turnId: input.turnId, step },
      };
      let failure: ProviderError | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const data = await streamOnce(entry, req);
          if (data.end.stopReason === 'refusal') {
            // The refused attempt was still billed: count it, but it is not a step and not part of the transcript.
            usageTotal = addUsage(usageTotal, data.end.usage);
            costUsd += env.price(entry.model, data.end.usage);
            lastRefusal = data.end.refusalCategory ? `model refused the request (${data.end.refusalCategory})` : 'model refused the request';
            failure = new ProviderError(lastRefusal, { kind: 'refusal', retryable: false });
            break;
          }
          return { type: 'ok', ...data };
        } catch (e) {
          if (ctrl.signal.aborted) return { type: 'stop', reason: abortReason() };
          const err = toProviderError(e);
          failure = err;
          if (err.retryable && attempt < maxRetries) {
            const delayMs = backoffMs(err, attempt);
            emit({ type: 'retry', attempt: attempt + 1, delayMs, reason: err.message });
            await sleep(delayMs, ctrl.signal);
            if (ctrl.signal.aborted) return { type: 'stop', reason: abortReason() };
            continue;
          }
          break;
        }
      }
      const nextEntry = route[routeIndex + 1];
      const reason = failure?.message ?? 'unknown failure';
      if (!nextEntry) {
        if (failure?.kind === 'refusal') return { type: 'stop', reason: 'refusal', error: lastRefusal };
        return { type: 'stop', reason: 'error', error: `${label(entry)}: ${reason}` };
      }
      emit({ type: 'fallback', from: label(entry), to: label(nextEntry), reason });
      fallbacks.push(label(nextEntry));
      routeIndex += 1;
    }
  };

  const executeAll = (calls: ToolCallPart[]): Promise<ToolResult[]> =>
    Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        let result: ToolResult;
        if (isInvalidToolInput(call.input)) {
          const raw = call.input.__invalid_json;
          result = toolResultText(
            call.id,
            call.name,
            `The input for this call was not valid JSON (it may have been cut off), so the tool was not run. Call it again with a complete, valid JSON object. Received: ${raw.length > 400 ? `${raw.slice(0, 400)}…` : raw}`,
            true,
          );
        } else if (ctrl.signal.aborted) {
          result = toolResultText(call.id, call.name, 'Not run: the turn was aborted before this tool could start.', true);
        } else {
          try {
            const r = await raceAbort(Promise.resolve(input.tools.execute(call, ctrl.signal)), ctrl.signal);
            result = { ...r, callId: call.id, name: call.name };
          } catch (e) {
            result = toolResultText(
              call.id,
              call.name,
              ctrl.signal.aborted ? 'Cancelled: the turn was aborted while this tool was running.' : `Tool execution failed: ${errorMessage(e)}`,
              true,
            );
          }
        }
        emit({ type: 'tool_result', id: call.id, name: call.name, isError: result.isError });
        return result;
      }),
    );

  try {
    if (route.length === 0) return finish('error', 'no model route was provided');

    let specs: ToolSpec[];
    try {
      specs = input.tools.specs();
    } catch (e) {
      return finish('error', `could not list tools: ${errorMessage(e)}`);
    }

    for (;;) {
      const stop = stopCheck();
      if (stop) return finish(stop);

      if (steps > 0) {
        // Tool boundary: steering first (athlete words), then harness notes, then the caller's hook.
        try {
          for (const u of input.steering?.drain() ?? []) append(u);
        } catch {
          // a faulty steering source must not lose the turn
        }
        if (!wrapNoted && Number.isFinite(limits.maxWallMs) && elapsed() >= limits.maxWallMs * WRAP_UP_AT) {
          wrapNoted = true;
          pendingNotes.push(WRAP_UP_NOTE);
        }
        for (const text of pendingNotes.splice(0)) append({ kind: 'harness', text });
        try {
          const extra = input.beforeStep?.({ step: steps + 1, elapsedMs: elapsed(), costUsd, items: [...items] });
          for (const it of extra ?? []) append(it);
        } catch {
          // ignore hook failures
        }
      }

      const step = steps + 1;
      const outcome = await callModel(step, specs);
      if (outcome.type === 'stop') return finish(outcome.reason, outcome.error);

      steps = step;
      const { entry, end, ended, started } = outcome;
      usageTotal = addUsage(usageTotal, end.usage);
      const stepCost = env.price(entry.model, end.usage);
      costUsd += stepCost;

      // Normalise the assistant item; drop tool calls the model did not finish (max_tokens cut-off).
      let item: AssistantItem = { ...end.item, provider: end.item.provider || entry.provider.id, model: end.item.model || entry.model };
      const truncated = end.stopReason === 'max_tokens';
      const incompleteParts = truncated ? item.parts.filter((p) => p.type === 'tool_call' && !ended.has(p.id)) : [];
      const unfinishedStarts = truncated ? [...started].filter((id) => !ended.has(id)) : [];
      if (incompleteParts.length > 0) {
        const drop = new Set(incompleteParts.map((p) => (p.type === 'tool_call' ? p.id : '')));
        // The provider-native content still contains the unfinished call, so it can no longer be replayed.
        item = { ...item, raw: undefined, parts: item.parts.filter((p) => !(p.type === 'tool_call' && drop.has(p.id))) };
      }
      const cutOff = truncated && (incompleteParts.length > 0 || unfinishedStarts.length > 0);

      if (item.parts.length > 0 || item.raw !== undefined) append(item);
      emit({ type: 'step_end', step, usage: end.usage, costUsd: stepCost, provider: entry.provider.id, model: entry.model });

      const calls = item.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
      if (calls.length === 0) {
        if (cutOff || (truncated && textCutoffs < MAX_TEXT_CUTOFFS)) {
          if (!cutOff) textCutoffs += 1;
          pendingNotes.push(MAX_TOKENS_NOTE);
          continue;
        }
        return finish(truncated ? 'max_tokens' : 'end_turn');
      }

      const results = await executeAll(calls);
      append({ kind: 'tool_results', results });
      if (cutOff) pendingNotes.push(MAX_TOKENS_NOTE);
    }
  } catch (e) {
    // Defence in depth: runTurn never rejects. Items appended so far are kept.
    return finish('error', errorMessage(e));
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    input.signal?.removeEventListener('abort', onCallerAbort);
  }
}
