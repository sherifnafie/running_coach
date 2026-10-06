import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  toolResultText,
  type AssistantItem,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ToolResultsItem,
} from '@opencoach/protocol';
import { MAX_TOKENS_NOTE, createAgentLoop, createScriptedProvider, type ScriptedStep } from '../src';
import { INVALID_TOOL_INPUT_KEY } from '../src/util';
import { baseInput, collect, fakeTools, kinds, resolved, user } from './helpers';

const loop = createAgentLoop({ random: () => 0.5 });

function scripted(steps: ScriptedStep[], id = 'scripted') {
  return createScriptedProvider({ id, handler: steps });
}

describe('agent loop: basic flow', () => {
  it('runs a single text step', async () => {
    const p = scripted([{ text: 'Hello there, runner.', usage: { inputTokens: 100, outputTokens: 10 } }]);
    const { events, onEvent } = collect();
    const r = await loop.runTurn(baseInput({ route: [resolved(p, 'claude-sonnet-5-5')], onEvent }));

    expect(r.stopReason).toBe('end_turn');
    expect(r.finalText).toBe('Hello there, runner.');
    expect(r.steps).toBe(1);
    expect(r.newItems).toHaveLength(1);
    expect(r.newItems[0]).toMatchObject({ kind: 'assistant', provider: 'scripted', model: 'claude-sonnet-5-5' });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    // default price table: sonnet 5.5 = $2 in / $10 out per MTok
    expect(r.costUsd).toBeCloseTo((100 * 2 + 10 * 10) / 1e6, 10);
    expect(r.provider).toBe('scripted');
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.fallbacks).toEqual([]);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'text_delta').length).toBeGreaterThan(0);
    expect(types.indexOf('item')).toBeGreaterThan(types.lastIndexOf('text_delta'));
    expect(types.indexOf('step_end')).toBeGreaterThan(types.indexOf('item'));
    const stepEnd = events.find((e) => e.type === 'step_end');
    expect(stepEnd).toMatchObject({ step: 1, provider: 'scripted', model: 'claude-sonnet-5-5' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toBe('Hello there, runner.');
  });

  it('does not mutate input.items and passes request fields through', async () => {
    const p = scripted([{ text: 'ok' }]);
    const items = [user('hello')];
    await loop.runTurn(
      baseInput({ route: [resolved(p, 'm', { effort: 'low', maxOutputTokens: 777 })], items, effort: 'high', cacheKey: 'athlete-1', turnId: 'turn-9' }),
    );
    expect(items).toHaveLength(1);
    const r = p.requests[0]!;
    expect(r).toMatchObject({ model: 'm', effort: 'high', maxOutputTokens: 777, cacheKey: 'athlete-1', metadata: { turnId: 'turn-9', step: 1 } });
    expect(r.tools.map((t) => t.name)).toEqual(['echo']);
    expect(r.system[0]?.text).toBe('You are a coach.');
  });

  it('falls back to the route entry effort when the turn sets none', async () => {
    const p = scripted([{ text: 'ok' }]);
    await loop.runTurn(baseInput({ route: [resolved(p, 'm', { effort: 'medium' })] }));
    expect(p.requests[0]?.effort).toBe('medium');
  });

  it('executes tools between steps and keeps item order', async () => {
    const p = scripted([{ toolCalls: [{ name: 'echo', input: { q: 1 } }] }, { text: 'All done.' }]);
    const tools = fakeTools({ echo: (i) => `echoed ${JSON.stringify(i)}` });
    const { events, onEvent } = collect();
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools, onEvent }));

    expect(r.stopReason).toBe('end_turn');
    expect(r.steps).toBe(2);
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results', 'assistant']);
    const tr = r.newItems[1] as ToolResultsItem;
    expect(tr.results).toHaveLength(1);
    expect(tr.results[0]).toMatchObject({ callId: 'toolu_s1', name: 'echo', isError: false });
    expect(tools.calls[0]?.input).toEqual({ q: 1 });
    expect(r.finalText).toBe('All done.');
    // second request saw the tool results
    expect(kinds(p.requests[1]!.items)).toEqual(['user', 'assistant', 'tool_results']);
    expect(p.requests[1]?.metadata?.step).toBe(2);
    expect(events.some((e) => e.type === 'tool_result' && e.name === 'echo' && !e.isError)).toBe(true);
    // every appended item has an item event, in order
    expect(events.filter((e) => e.type === 'item').map((e) => (e.type === 'item' ? e.item : undefined))).toEqual(r.newItems);
  });

  it('forwards tool streaming events with the tool name on input deltas [RT-9]', async () => {
    const p = scripted([{ toolCalls: [{ name: 'echo', input: { text: 'a fairly long message that is chunked' } }] }, { text: 'k' }]);
    const { events, onEvent } = collect();
    await loop.runTurn(baseInput({ route: [resolved(p)], tools: fakeTools({ echo: () => 'ok' }), onEvent }));
    const deltas = events.filter((e) => e.type === 'tool_input_delta');
    expect(deltas.length).toBeGreaterThan(1);
    for (const d of deltas) if (d.type === 'tool_input_delta') expect(d.name).toBe('echo');
    const json = deltas.map((d) => (d.type === 'tool_input_delta' ? d.partialJson : '')).join('');
    expect(JSON.parse(json)).toEqual({ text: 'a fairly long message that is chunked' });
    expect(events.find((e) => e.type === 'tool_call_start')).toMatchObject({ name: 'echo' });
    expect(events.find((e) => e.type === 'tool_call_end')).toMatchObject({ name: 'echo', input: { text: 'a fairly long message that is chunked' } });
  });

  it('forwards progress notes [RT-9]', async () => {
    const p = scripted([{ progress: ['Looking at your splits'], text: 'done' }]);
    const { events, onEvent } = collect();
    await loop.runTurn(baseInput({ route: [resolved(p)], onEvent }));
    expect(events.find((e) => e.type === 'progress')).toMatchObject({ text: 'Looking at your splits' });
  });

  it('ignores a throwing onEvent listener', async () => {
    const p = scripted([{ text: 'fine' }]);
    const r = await loop.runTurn(
      baseInput({
        route: [resolved(p)],
        onEvent: () => {
          throw new Error('listener bug');
        },
      }),
    );
    expect(r.stopReason).toBe('end_turn');
  });
});

describe('agent loop: tool execution', () => {
  it('runs all calls in parallel and preserves call order in the results', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const tools = fakeTools({
      slow: async () => {
        started.push('slow');
        await slowGate;
        finished.push('slow');
        return 'slow-result';
      },
      fast: async () => {
        started.push('fast');
        // the slow tool must already be running (parallel), and we finish first
        expect(started).toContain('slow');
        finished.push('fast');
        releaseSlow();
        return 'fast-result';
      },
    });
    const p = scripted([
      {
        toolCalls: [
          { name: 'slow', input: {}, id: 'c1' },
          { name: 'fast', input: {}, id: 'c2' },
        ],
      },
      { text: 'ok' },
    ]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools }));
    expect(finished).toEqual(['fast', 'slow']);
    const tr = r.newItems[1] as ToolResultsItem;
    expect(tr.results.map((x) => x.callId)).toEqual(['c1', 'c2']);
    expect(tr.results.map((x) => x.content[0])).toEqual([
      { type: 'text', text: 'slow-result' },
      { type: 'text', text: 'fast-result' },
    ]);
  });

  it('converts tool throws into error results', async () => {
    const tools = fakeTools({
      boom: () => {
        throw new Error('disk on fire');
      },
    });
    const p = scripted([{ toolCalls: [{ name: 'boom', input: {} }] }, { text: 'recovered' }]);
    const { events, onEvent } = collect();
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools, onEvent }));
    expect(r.stopReason).toBe('end_turn');
    const tr = r.newItems[1] as ToolResultsItem;
    expect(tr.results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(tr.results[0]?.content)).toContain('disk on fire');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
  });

  it('answers a call with invalid JSON input without running the tool', async () => {
    const tools = fakeTools({ echo: () => 'should not run' });
    const p = scripted([{ toolCalls: [{ name: 'echo', input: { [INVALID_TOOL_INPUT_KEY]: '{"text": "cut of' } }] }, { text: 'retrying' }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools }));
    expect(tools.calls).toHaveLength(0);
    const tr = r.newItems[1] as ToolResultsItem;
    expect(tr.results[0]?.isError).toBe(true);
    expect(JSON.stringify(tr.results[0]?.content)).toContain('not valid JSON');
  });

  it('forces the result callId/name to match the call', async () => {
    const tools = fakeTools({ echo: (_i, call) => toolResultText('wrong', 'wrong', `hi ${call.id}`) });
    const p = scripted([{ toolCalls: [{ name: 'echo', input: {}, id: 'abc' }] }, { text: 'k' }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools }));
    expect((r.newItems[1] as ToolResultsItem).results[0]).toMatchObject({ callId: 'abc', name: 'echo' });
  });
});

describe('agent loop: steering and beforeStep [RT-3]', () => {
  it('injects steering items at the tool boundary, before the next model call', async () => {
    const p = scripted([{ toolCalls: [{ name: 'echo', input: {} }] }, { text: 'answered both' }]);
    let drained = 0;
    const steering = {
      drain: () => {
        drained++;
        return drained === 1 ? [user('while you were working: tap 8')] : [];
      },
    };
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools: fakeTools({ echo: () => 'ok' }), steering }));
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results', 'user', 'assistant']);
    expect(kinds(p.requests[1]!.items)).toEqual(['user', 'assistant', 'tool_results', 'user']);
    // not drained before the first call, nor after the final answer
    expect(drained).toBe(1);
  });

  it('does not drain steering when a limit ends the turn at the boundary', async () => {
    const p = scripted([{ toolCalls: [{ name: 'echo', input: {} }] }, { text: 'never' }]);
    let drained = 0;
    const r = await loop.runTurn(
      baseInput({
        route: [resolved(p)],
        tools: fakeTools({ echo: () => 'ok' }),
        limits: { maxSteps: 1, maxWallMs: 600_000 },
        steering: {
          drain: () => {
            drained++;
            return [user('late')];
          },
        },
      }),
    );
    expect(r.stopReason).toBe('max_steps');
    expect(drained).toBe(0);
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results']);
  });

  it('calls beforeStep before every model call after the first and appends its items', async () => {
    const p = scripted([{ toolCalls: [{ name: 'echo', input: {} }] }, { toolCalls: [{ name: 'echo', input: {} }] }, { text: 'end' }]);
    const infos: Array<{ step: number; items: number; cost: number }> = [];
    const r = await loop.runTurn(
      baseInput({
        route: [resolved(p, 'claude-sonnet-5-5')],
        tools: fakeTools({ echo: () => 'ok' }),
        beforeStep: ({ step, items, costUsd }) => {
          infos.push({ step, items: items.length, cost: costUsd });
          return step === 3 ? [{ kind: 'harness', text: 'near the step limit' }] : undefined;
        },
      }),
    );
    expect(infos.map((i) => i.step)).toEqual([2, 3]);
    expect(infos[0]?.items).toBe(3); // user + assistant + tool_results
    expect(infos[1]?.cost).toBeGreaterThan(0);
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results', 'assistant', 'tool_results', 'harness', 'assistant']);
    expect(p.requests[2]?.items.at(-1)).toEqual({ kind: 'harness', text: 'near the step limit' });
  });
});

describe('agent loop: retries and fallbacks [RT-7]', () => {
  it('retries retryable errors with backoff and then succeeds', async () => {
    const p = scripted([
      { fail: { kind: 'rate_limit', message: 'slow down' }, retryAfterMs: 2000 },
      { fail: { kind: 'overloaded' } },
      { text: 'finally' },
    ]);
    const sleeps: number[] = [];
    const { events, onEvent } = collect();
    const r = await createAgentLoop({ random: () => 0 }).runTurn(
      baseInput({
        route: [resolved(p)],
        onEvent,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(r.stopReason).toBe('end_turn');
    expect(r.finalText).toBe('finally');
    expect(r.fallbacks).toEqual([]);
    expect(p.requests).toHaveLength(3);
    // first: Retry-After 2000ms honoured; second: 1s * 2^1 with jitter factor 0.8 (random()=0)
    expect(sleeps).toEqual([2000, 1600]);
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toMatchObject([
      { type: 'retry', attempt: 1, delayMs: 2000, reason: 'slow down' },
      { type: 'retry', attempt: 2, delayMs: 1600 },
    ]);
  });

  it('jitters exponential backoff within +-20%', async () => {
    const mk = async (rand: number) => {
      const sleeps: number[] = [];
      const p = scripted([{ fail: { kind: 'network' } }, { text: 'x' }]);
      await createAgentLoop({ random: () => rand }).runTurn(baseInput({ route: [resolved(p)], sleep: async (ms) => void sleeps.push(ms) }));
      return sleeps[0]!;
    };
    expect(await mk(0)).toBe(800);
    expect(await mk(0.5)).toBe(1000);
    expect(await mk(0.999)).toBeLessThanOrEqual(1200);
  });

  it('honours maxRetries', async () => {
    const p = scripted([{ fail: { kind: 'network' } }, { fail: { kind: 'network' } }, { fail: { kind: 'network' } }, { text: 'never' }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], maxRetries: 1 }));
    expect(r.stopReason).toBe('error');
    expect(p.requests).toHaveLength(2);
  });

  it('falls back to the next route entry after retries are exhausted', async () => {
    const primary = createScriptedProvider({ id: 'anthropic', handler: () => ({ fail: { kind: 'overloaded' as const } }) });
    const secondary = scripted([{ text: 'from the fallback' }], 'openai');
    const { events, onEvent } = collect();
    const r = await loop.runTurn(baseInput({ route: [resolved(primary, 'a1'), resolved(secondary, 'o1')], onEvent }));
    expect(primary.requests).toHaveLength(3); // 1 + 2 retries
    expect(r.stopReason).toBe('end_turn');
    expect(r.finalText).toBe('from the fallback');
    expect(r.fallbacks).toEqual(['openai:o1']);
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('o1');
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    expect(events.find((e) => e.type === 'fallback')).toMatchObject({ from: 'anthropic:a1', to: 'openai:o1' });
  });

  it('falls back immediately on non-retryable errors (auth / invalid_request / context_length)', async () => {
    for (const kind of ['auth', 'invalid_request', 'context_length'] as const) {
      const primary: ModelProvider = {
        id: 'p1',
        capabilities: () => resolved(scripted([])).capabilities,
        // eslint-disable-next-line require-yield
        async *stream(): AsyncGenerator<ModelStreamEvent> {
          throw new ProviderError(`${kind} problem`, { kind, retryable: false });
        },
      };
      const secondary = scripted([{ text: 'ok' }], 'p2');
      const sleeps: number[] = [];
      const r = await loop.runTurn(baseInput({ route: [resolved(primary), resolved(secondary)], sleep: async (ms) => void sleeps.push(ms) }));
      expect(r.stopReason).toBe('end_turn');
      expect(r.fallbacks).toEqual(['p2:model-a']);
      expect(sleeps).toEqual([]);
    }
  });

  it('treats a non-ProviderError throw as a non-retryable failure (falls back)', async () => {
    const primary: ModelProvider = {
      id: 'buggy',
      capabilities: () => resolved(scripted([])).capabilities,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new TypeError('x is undefined');
      },
    };
    const secondary = scripted([{ text: 'ok' }], 'p2');
    const r = await loop.runTurn(baseInput({ route: [resolved(primary), resolved(secondary)] }));
    expect(r.stopReason).toBe('end_turn');
    expect(r.fallbacks).toEqual(['p2:model-a']);
  });

  it('retries a stream that ends without message_end', async () => {
    let calls = 0;
    const flaky: ModelProvider = {
      id: 'flaky',
      capabilities: () => resolved(scripted([])).capabilities,
      async *stream(req: ModelRequest): AsyncGenerator<ModelStreamEvent> {
        calls++;
        if (calls === 1) {
          yield { type: 'text_delta', text: 'partial' };
          return; // dropped connection
        }
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
          item: { kind: 'assistant', parts: [{ type: 'text', text: 'whole' }], provider: 'flaky', model: req.model },
        };
      },
    };
    const r = await loop.runTurn(baseInput({ route: [resolved(flaky)] }));
    expect(r.finalText).toBe('whole');
    expect(calls).toBe(2);
  });

  it('returns stopReason error when every route entry fails, keeping prior items', async () => {
    const p1 = scripted([{ toolCalls: [{ name: 'echo', input: {} }] }, { fail: { kind: 'invalid_request', message: 'bad prompt' } }], 'p1');
    const p2 = scripted([{ fail: { kind: 'invalid_request', message: 'also bad' } }], 'p2');
    // p1 succeeds on step 1 and fails on step 2; p2 then fails too
    const r = await loop.runTurn(baseInput({ route: [resolved(p1, 'm1'), resolved(p2, 'm2')], tools: fakeTools({ echo: () => 'ok' }) }));
    expect(r.stopReason).toBe('error');
    expect(r.error).toContain('p2:m2');
    expect(r.error).toContain('also bad');
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results']);
    expect(r.fallbacks).toEqual(['p2:m2']);
    expect(r.steps).toBe(1);
  });

  it('errors cleanly on an empty route', async () => {
    const r = await loop.runTurn(baseInput({ route: [] }));
    expect(r.stopReason).toBe('error');
    expect(r.error).toMatch(/route/);
  });

  it('stays on the fallback model for later steps of the same turn', async () => {
    const primary = scripted([{ fail: { kind: 'invalid_request' } }], 'p1');
    const secondary = scripted([{ toolCalls: [{ name: 'echo', input: {} }] }, { text: 'done' }], 'p2');
    const r = await loop.runTurn(baseInput({ route: [resolved(primary), resolved(secondary)], tools: fakeTools({ echo: () => 'ok' }) }));
    expect(r.stopReason).toBe('end_turn');
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(2);
    expect(r.fallbacks).toEqual(['p2:model-a']);
  });
});

describe('agent loop: limits and abort [RT-5]', () => {
  const toolLoop = (n = 50) => scripted(Array.from({ length: n }, () => ({ toolCalls: [{ name: 'echo', input: {} }] })));

  it('stops at maxSteps', async () => {
    const p = toolLoop();
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools: fakeTools({ echo: () => 'ok' }), limits: { maxSteps: 3, maxWallMs: 600_000 } }));
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(3);
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results', 'assistant', 'tool_results', 'assistant', 'tool_results']);
  });

  it('stops at maxWallMs (monotonic clock)', async () => {
    let t = 0;
    const l = createAgentLoop({ monotonicNow: () => t });
    const p = scripted(Array.from({ length: 20 }, () => ({ toolCalls: [{ name: 'echo', input: {} }] })));
    const tools = fakeTools({
      echo: () => {
        t += 400;
        return 'ok';
      },
    });
    const r = await l.runTurn(baseInput({ route: [resolved(p)], tools, limits: { maxSteps: 50, maxWallMs: 1000 } }));
    expect(r.stopReason).toBe('max_wall');
    expect(r.steps).toBe(3); // 3 x 400ms >= 1000ms
  });

  it('enforces the wall limit on a model call that never returns', async () => {
    const hang: ModelProvider = {
      id: 'hang',
      capabilities: () => resolved(scripted([])).capabilities,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        await new Promise<void>(() => undefined); // ignores the abort signal entirely
      },
    };
    const r = await createAgentLoop().runTurn(baseInput({ route: [resolved(hang)], limits: { maxSteps: 5, maxWallMs: 40 } }));
    expect(r.stopReason).toBe('max_wall');
  });

  it('stops at maxCostUsd', async () => {
    const p = scripted(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'echo', input: {} }], usage: { inputTokens: 1000, outputTokens: 0 } })));
    const l = createAgentLoop({ price: () => 0.4 });
    const r = await l.runTurn(baseInput({ route: [resolved(p)], tools: fakeTools({ echo: () => 'ok' }), limits: { maxSteps: 50, maxWallMs: 600_000, maxCostUsd: 1 } }));
    expect(r.stopReason).toBe('max_cost');
    expect(r.steps).toBe(3);
    expect(r.costUsd).toBeCloseTo(1.2, 10);
    expect(r.usage.inputTokens).toBe(3000);
  });

  it('uses the injected price function for step_end cost', async () => {
    const p = scripted([{ text: 'x', usage: { inputTokens: 5, outputTokens: 5 } }]);
    const seen: Array<[string, number]> = [];
    const { events, onEvent } = collect();
    const r = await createAgentLoop({
      price: (model, u) => {
        seen.push([model, u.inputTokens]);
        return 0.25;
      },
    }).runTurn(baseInput({ route: [resolved(p, 'm-x')], onEvent }));
    expect(seen).toEqual([['m-x', 5]]);
    expect(r.costUsd).toBe(0.25);
    expect(events.find((e) => e.type === 'step_end')).toMatchObject({ costUsd: 0.25 });
  });

  it('returns aborted when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = scripted([{ text: 'never' }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], signal: ctrl.signal }));
    expect(r.stopReason).toBe('aborted');
    expect(p.requests).toHaveLength(0);
    expect(r.newItems).toEqual([]);
  });

  it('returns aborted when aborted while a tool runs, with a synthesized result for the call', async () => {
    const ctrl = new AbortController();
    const tools = fakeTools({
      slow: () => {
        queueMicrotask(() => ctrl.abort());
        return new Promise<string>(() => undefined); // never resolves, ignores the signal
      },
    });
    const p = scripted([{ toolCalls: [{ name: 'slow', input: {}, id: 's1' }] }, { text: 'never' }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools, signal: ctrl.signal }));
    expect(r.stopReason).toBe('aborted');
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results']);
    expect((r.newItems[1] as ToolResultsItem).results[0]).toMatchObject({ callId: 's1', isError: true });
    expect(p.requests).toHaveLength(1);
  });

  it('returns aborted when aborted during retry backoff', async () => {
    const ctrl = new AbortController();
    const p = scripted([{ fail: { kind: 'network' } }, { text: 'never' }]);
    const r = await loop.runTurn(
      baseInput({
        route: [resolved(p)],
        signal: ctrl.signal,
        sleep: async () => {
          ctrl.abort();
        },
      }),
    );
    expect(r.stopReason).toBe('aborted');
    expect(p.requests).toHaveLength(1);
  });
});

describe('agent loop: max_tokens, refusal', () => {
  it('drops an incomplete tool call, adds a continue note and keeps going', async () => {
    const p = scripted([
      { text: 'Writing a long message', toolCalls: [{ name: 'echo', input: { text: 'x'.repeat(200) } }], stopReason: 'max_tokens' },
      { text: 'Shorter now.' },
    ]);
    const tools = fakeTools({ echo: () => 'should not run' });
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools }));

    expect(tools.calls).toHaveLength(0);
    expect(r.stopReason).toBe('end_turn');
    expect(r.steps).toBe(2);
    expect(kinds(r.newItems)).toEqual(['assistant', 'harness', 'assistant']);
    const first = r.newItems[0] as AssistantItem;
    expect(first.parts).toEqual([{ type: 'text', text: 'Writing a long message' }]);
    expect(r.newItems[1]).toEqual({ kind: 'harness', text: MAX_TOKENS_NOTE });
    expect(MAX_TOKENS_NOTE).toBe('Your previous response was cut off by the output token limit; continue concisely.');
    expect(p.requests[1]?.items.at(-1)).toEqual({ kind: 'harness', text: MAX_TOKENS_NOTE });
  });

  it('runs the complete calls of a cut-off response and appends the note after the results', async () => {
    const p = scripted([
      {
        toolCalls: [
          { name: 'echo', input: { n: 1 }, id: 'done' },
          { name: 'echo', input: { n: 2, filler: 'y'.repeat(100) }, id: 'cut' },
        ],
        stopReason: 'max_tokens',
      },
      { text: 'ok' },
    ]);
    const tools = fakeTools({ echo: () => 'ran' });
    const r = await loop.runTurn(baseInput({ route: [resolved(p)], tools }));
    expect(tools.calls.map((c) => c.id)).toEqual(['done']);
    expect(kinds(r.newItems)).toEqual(['assistant', 'tool_results', 'harness', 'assistant']);
    expect((r.newItems[0] as AssistantItem).parts.filter((x) => x.type === 'tool_call')).toHaveLength(1);
  });

  it('removes provider raw content when an incomplete call is dropped', async () => {
    let calls = 0;
    const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    const provider: ModelProvider = {
      id: 'raw',
      capabilities: () => resolved(scripted([])).capabilities,
      async *stream(req: ModelRequest): AsyncGenerator<ModelStreamEvent> {
        calls++;
        if (calls === 1) {
          yield { type: 'text_delta', text: 'thinking out loud' };
          yield { type: 'tool_call_start', id: 'a', name: 'echo' };
          // a provider that (wrongly) leaves the unfinished call in `parts`, plus provider-native raw content
          yield {
            type: 'message_end',
            stopReason: 'max_tokens',
            usage,
            item: {
              kind: 'assistant',
              parts: [{ type: 'text', text: 'thinking out loud' }, { type: 'tool_call', id: 'a', name: 'echo', input: {} }],
              provider: 'raw',
              model: req.model,
              raw: [{ any: 'thing' }],
            },
          };
          return;
        }
        yield { type: 'message_end', stopReason: 'end_turn', usage, item: { kind: 'assistant', parts: [{ type: 'text', text: 'second' }], provider: 'raw', model: req.model } };
      },
    };
    const tools = fakeTools({ echo: () => 'x' });
    const r = await loop.runTurn(baseInput({ route: [resolved(provider)], tools }));
    expect(tools.calls).toHaveLength(0);
    const first = r.newItems[0] as AssistantItem;
    expect(first.parts).toEqual([{ type: 'text', text: 'thinking out loud' }]);
    expect(first.raw).toBeUndefined(); // raw still contained the unfinished call, so it can no longer be replayed
    expect(kinds(r.newItems)).toEqual(['assistant', 'harness', 'assistant']);
  });

  it('ends the turn with max_tokens when plain text is cut off', async () => {
    const p = scripted([{ text: 'a long answer that gets cut', stopReason: 'max_tokens' }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p)] }));
    expect(r.stopReason).toBe('max_tokens');
    expect(r.finalText).toBe('a long answer that gets cut');
  });

  it('stops with refusal when the only model refuses', async () => {
    const p = scripted([{ stopReason: 'refusal', refusalCategory: 'cyber', text: 'partial', usage: { inputTokens: 1000, outputTokens: 10 } }]);
    const r = await loop.runTurn(baseInput({ route: [resolved(p, 'claude-sonnet-5-5')] }));
    expect(r.stopReason).toBe('refusal');
    expect(r.error).toContain('cyber');
    expect(r.newItems).toEqual([]); // the refused message is not part of the transcript
    expect(r.steps).toBe(0);
    // ...but it was billed, so it counts towards usage and cost
    expect(r.usage.inputTokens).toBe(1000);
    expect(r.costUsd).toBeCloseTo((1000 * 2 + 10 * 10) / 1e6, 10);
  });

  it('falls back to the next model on refusal', async () => {
    const primary = scripted([{ stopReason: 'refusal' }], 'p1');
    const secondary = scripted([{ text: 'happy to help' }], 'p2');
    const { events, onEvent } = collect();
    const r = await loop.runTurn(baseInput({ route: [resolved(primary), resolved(secondary)], onEvent }));
    expect(r.stopReason).toBe('end_turn');
    expect(r.fallbacks).toEqual(['p2:model-a']);
    expect(events.find((e) => e.type === 'fallback')).toMatchObject({ reason: expect.stringContaining('refused') });
  });
});
