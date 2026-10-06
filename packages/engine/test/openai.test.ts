import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { ProviderError, type AssistantItem, type ConvItem, type ModelStreamEvent } from '@opencoach/protocol';
import { buildOpenAIInput, buildOpenAIRequest, createOpenAIProvider, mapOpenAIError, openaiCapabilities, parseOpenAIStream, type OpenAIClientLike } from '../src/openai';
import { createAgentLoop } from '../src';
import { baseInput, drain, fakeTools, fromArray, req, resolved, user } from './helpers';

type StreamEvent = Parameters<typeof parseOpenAIStream>[0] extends AsyncIterable<infer E> ? E : never;
const ev = (x: unknown): StreamEvent => x as StreamEvent;
const PNG = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' };

const assistant = (parts: AssistantItem['parts'], extra: Partial<AssistantItem> = {}): AssistantItem => ({
  kind: 'assistant',
  parts,
  provider: 'openai',
  model: 'gpt-6.1-sol',
  ...extra,
});

describe('openai capabilities', () => {
  it('knows the GPT-6 family and defaults sensibly for unknown models', () => {
    for (const m of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna']) {
      expect(openaiCapabilities(m)).toMatchObject({ vision: true, maxOutputTokens: 128_000, streamingToolInput: true, parallelToolCalls: true });
      expect(openaiCapabilities(m).maxContextTokens).toBeGreaterThanOrEqual(1_000_000);
    }
    expect(openaiCapabilities('gpt-6.1-sol').maxContextTokens).toBe(1_050_000);
    const unknown = openaiCapabilities('some-future-model');
    expect(unknown.vision).toBe(true);
    expect(unknown.maxContextTokens).toBeGreaterThan(0);
    expect(unknown.efforts).toEqual([]);
    expect(openaiCapabilities('gpt-7-nova').efforts.length).toBeGreaterThan(0);
  });
});

describe('openai request mapping', () => {
  it('builds a stateless streaming request with reasoning, tools and cache key', () => {
    const p = buildOpenAIRequest(
      req({
        model: 'gpt-6.1-sol',
        system: [{ text: 'Be a coach.', cache: true }, { text: '', cache: false }, { text: 'Be kind.', cache: false }],
        tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        effort: 'high',
        cacheKey: 'athlete-42',
        maxOutputTokens: 5000,
      }),
    );
    expect(p).toMatchObject({
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      instructions: 'Be a coach.\n\nBe kind.',
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'athlete-42',
      max_output_tokens: 5000,
    });
    expect(p.tools).toEqual([{ type: 'function', name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }]);
  });

  it('omits tools / parallel_tool_calls / cache key / instructions when absent', () => {
    const p = buildOpenAIRequest(req({ model: 'gpt-6-luna', system: [] }));
    expect(p).not.toHaveProperty('tools');
    expect(p).not.toHaveProperty('parallel_tool_calls');
    expect(p).not.toHaveProperty('prompt_cache_key');
    expect(p).not.toHaveProperty('instructions');
    expect(p.reasoning).toEqual({ summary: 'auto' }); // no effort requested -> model default
  });

  it('maps xhigh/max to the highest effort each model accepts', () => {
    const eff = (model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => buildOpenAIRequest(req({ model, effort })).reasoning?.effort;
    expect(eff('gpt-6.1-sol', 'max')).toBe('xhigh');
    expect(eff('gpt-6.1-sol', 'xhigh')).toBe('xhigh');
    expect(eff('gpt-6-luna', 'xhigh')).toBe('high');
    expect(eff('gpt-6-luna', 'max')).toBe('high');
    expect(eff('gpt-6-astra', 'max')).toBe('max');
    expect(eff('gpt-6-sol', 'low')).toBe('low');
  });

  it('does not send reasoning params to non-reasoning models', () => {
    const p = buildOpenAIRequest(req({ model: 'gpt-4.1', effort: 'high' }));
    expect(p).not.toHaveProperty('reasoning');
    expect(p).not.toHaveProperty('include');
  });

  it('clamps max_output_tokens to the model limit', () => {
    expect(buildOpenAIRequest(req({ model: 'gpt-6-luna', maxOutputTokens: 500_000 })).max_output_tokens).toBe(128_000);
  });
});

describe('openai input mapping', () => {
  it('maps user text and images to input_text / input_image data URLs, harness to developer', () => {
    const input = buildOpenAIInput([{ kind: 'user', parts: [{ type: 'text', text: 'look' }, PNG] }, { kind: 'harness', text: '<situation>x</situation>' }], 'gpt-6.1-sol');
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
      { role: 'developer', content: '<situation>x</situation>' },
    ]);
  });

  it('replays raw output items (with encrypted reasoning) for the same provider and model [MOD-3]', () => {
    const rawItems = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}', status: 'completed' },
    ];
    const item = assistant([{ type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'a' } }], { raw: rawItems });
    const input = buildOpenAIInput([user('q'), item, { kind: 'tool_results', results: [{ callId: 'call_1', name: 'read', isError: false, content: [{ type: 'text', text: 'A' }] }] }], 'gpt-6.1-sol');
    expect(input[1]).toBe(rawItems[0]);
    expect(input[2]).toBe(rawItems[1]);
    expect(input[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'A' });
  });

  it('rebuilds output text + function_call items for another model (dropping reasoning) [MOD-3]', () => {
    const rawItems = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' }];
    const item = assistant(
      [{ type: 'text', text: 'Checking.' }, { type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'a' } }, { type: 'text', text: 'Then more.' }],
      { raw: rawItems },
    );
    for (const model of ['gpt-6-luna']) {
      const input = buildOpenAIInput([user('q'), item], model);
      expect(JSON.stringify(input)).not.toContain('ENC');
      expect(input.slice(1)).toEqual([
        { role: 'assistant', content: 'Checking.' },
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
        { role: 'assistant', content: 'Then more.' },
      ]);
    }
    // history from another provider entirely
    const foreign = { ...item, provider: 'anthropic', model: 'gpt-6.1-sol' };
    expect(JSON.stringify(buildOpenAIInput([user('q'), foreign], 'gpt-6.1-sol'))).not.toContain('ENC');
  });

  it('maps tool results to function_call_output, with error prefix, and images as a following user message', () => {
    const items: ConvItem[] = [
      user('q'),
      assistant([{ type: 'tool_call', id: 'c1', name: 'read', input: {} }, { type: 'tool_call', id: 'c2', name: 'bash', input: {} }, { type: 'tool_call', id: 'c3', name: 'write', input: {} }]),
      {
        kind: 'tool_results',
        results: [
          { callId: 'c1', name: 'read', isError: false, content: [{ type: 'text', text: 'chart' }, PNG] },
          { callId: 'c2', name: 'bash', isError: true, content: [{ type: 'text', text: 'exit 1' }] },
          { callId: 'c3', name: 'write', isError: false, content: [] },
        ],
      },
    ];
    const input = buildOpenAIInput(items, 'gpt-6-luna');
    expect(input.slice(-4)).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'chart' },
      { type: 'function_call_output', call_id: 'c2', output: 'Error: exit 1' },
      { type: 'function_call_output', call_id: 'c3', output: '(empty result)' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Image(s) returned by tool read (call c1):' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
    ]);
  });

  it('skips empty items', () => {
    expect(buildOpenAIInput([user(''), { kind: 'harness', text: '  ' }, assistant([])], 'gpt-6.1-sol')).toEqual([]);
  });
});

// ------------------------------------------------------------------ stream parsing

const parse = (events: StreamEvent[]) => drain(parseOpenAIStream(fromArray(events), { model: 'gpt-6.1-sol' }));
const completed = (output: unknown[], usage: unknown = { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1050 }, extra: Record<string, unknown> = {}) =>
  ev({ type: 'response.completed', sequence_number: 99, response: { id: 'resp_1', status: 'completed', output, usage, incomplete_details: null, error: null, ...extra } });
const added = (output_index: number, item: unknown) => ev({ type: 'response.output_item.added', output_index, sequence_number: 1, item });

describe('openai stream parsing', () => {
  it('streams text and reports usage (cached split out) plus the raw output items', async () => {
    const output = [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello runner', annotations: [] }] }];
    const out = await parse([
      ev({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'Hello ', logprobs: [], sequence_number: 1 }),
      ev({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'runner', logprobs: [], sequence_number: 2 }),
      completed(output),
    ]);
    expect(out.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'message_end']);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('end_turn');
    expect(end.usage).toEqual({ inputTokens: 200, cachedInputTokens: 800, cacheWriteTokens: 0, outputTokens: 50 });
    expect(end.item).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', parts: [{ type: 'text', text: 'Hello runner' }] });
    expect(end.item.raw).toEqual(output);
  });

  it('streams a function call: start, argument deltas, end with parsed input', async () => {
    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_77', name: 'send_message', arguments: '{"text":"Nice work"}', status: 'completed' };
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Thinking' }], encrypted_content: 'ENC' };
    const out = await parse([
      added(0, { ...reasoning, summary: [] }),
      ev({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'Reading ', sequence_number: 2 }),
      ev({ type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'rs_1', summary_index: 0, text: '**Reading your week**', sequence_number: 3 }),
      added(1, { ...fc, arguments: '' }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"text":', sequence_number: 4 }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '"Nice work"}', sequence_number: 5 }),
      ev({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1', arguments: '{"text":"Nice work"}', sequence_number: 6 }),
      completed([reasoning, fc]),
    ]);
    expect(out.map((e) => e.type)).toEqual(['progress', 'tool_call_start', 'tool_input_delta', 'tool_input_delta', 'tool_call_end', 'message_end']);
    expect(out[0]).toEqual({ type: 'progress', text: '**Reading your week**' });
    expect(out[1]).toEqual({ type: 'tool_call_start', id: 'call_77', name: 'send_message' });
    expect(out[4]).toEqual({ type: 'tool_call_end', id: 'call_77', name: 'send_message', input: { text: 'Nice work' } });
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('tool_use');
    expect(end.item.parts).toEqual([{ type: 'tool_call', id: 'call_77', name: 'send_message', input: { text: 'Nice work' } }]);
    expect(end.item.raw).toEqual([reasoning, fc]);
    expect(end.item.reasoningSummary).toBe('**Reading your week**');
  });

  it('handles parallel function calls by output index', async () => {
    const a = { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read', arguments: '{"path":"a"}', status: 'completed' };
    const b = { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'read', arguments: '{"path":"b"}', status: 'completed' };
    const out = await parse([
      added(0, { ...a, arguments: '' }),
      added(1, { ...b, arguments: '' }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"path":"b"}', sequence_number: 3 }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"path":"a"}', sequence_number: 4 }),
      ev({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: a.arguments, sequence_number: 5 }),
      ev({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_b', arguments: b.arguments, sequence_number: 6 }),
      completed([a, b]),
    ]);
    const deltas = out.filter((e) => e.type === 'tool_input_delta');
    expect(deltas).toEqual([
      { type: 'tool_input_delta', id: 'call_b', partialJson: '{"path":"b"}' },
      { type: 'tool_input_delta', id: 'call_a', partialJson: '{"path":"a"}' },
    ]);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.item.parts.map((p) => (p.type === 'tool_call' ? p.id : ''))).toEqual(['call_a', 'call_b']);
  });

  it('ends a function call that finished without an arguments.done event', async () => {
    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}', status: 'completed' };
    const out = await parse([added(0, { ...fc, arguments: '' }), completed([fc])]);
    expect(out.map((e) => e.type)).toEqual(['tool_call_start', 'tool_call_end', 'message_end']);
  });

  it('max_output_tokens: drops the unfinished call and the reasoning item dangling before it', async () => {
    const msg = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Starting', annotations: [] }] };
    const reasoning = { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'ENC2' };
    const cut = { type: 'function_call', id: 'fc_1', call_id: 'call_cut', name: 'write', arguments: '{"path":"a","content":"loooo', status: 'incomplete' };
    const out = await parse([
      added(0, { ...cut, arguments: '' }),
      ev({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"path":"a","content":"loooo', sequence_number: 2 }),
      ev({ type: 'response.incomplete', sequence_number: 3, response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [msg, reasoning, cut], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 99, total_tokens: 109 } } }),
    ]);
    expect(out.some((e) => e.type === 'tool_call_end')).toBe(false);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('max_tokens');
    expect(end.item.parts).toEqual([{ type: 'text', text: 'Starting' }]);
    expect(end.item.raw).toEqual([msg]);
  });

  it('maps content_filter and refusal parts to refusal', async () => {
    const out = await parse([ev({ type: 'response.incomplete', sequence_number: 1, response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } })]);
    expect(out.at(-1)).toMatchObject({ stopReason: 'refusal', refusalCategory: 'content_filter' });
    const refusal = [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: "I can't help with that." }] }];
    expect((await parse([completed(refusal)])).at(-1)).toMatchObject({ stopReason: 'refusal' });
  });

  it('maps failures to ProviderError', async () => {
    await expect(parse([ev({ type: 'response.failed', sequence_number: 1, response: { id: 'r', error: { code: 'server_error', message: 'oops' } } })])).rejects.toMatchObject({ kind: 'unknown', retryable: true, message: 'oops' });
    await expect(parse([ev({ type: 'response.failed', sequence_number: 1, response: { id: 'r', error: { code: 'rate_limit_exceeded', message: 'slow' } } })])).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
    await expect(parse([ev({ type: 'error', code: 'context_length_exceeded', message: 'too long', param: null, sequence_number: 1 })])).rejects.toMatchObject({ kind: 'context_length', retryable: false });
    await expect(parse([])).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
});

// ------------------------------------------------------------------ errors + provider

describe('openai error mapping', () => {
  const gen = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => OpenAI.APIError.generate(status, body, String(body.message), new Headers(headers));

  it('maps HTTP errors', () => {
    expect(mapOpenAIError(gen(429, { message: 'Rate limit', type: 'tokens', code: 'rate_limit_exceeded' }, { 'retry-after': '2' }))).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 2000 });
    expect(mapOpenAIError(gen(500, { message: 'oops' }))).toMatchObject({ retryable: true });
    expect(mapOpenAIError(gen(503, { message: 'down' }))).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(mapOpenAIError(gen(401, { message: 'bad key', code: 'invalid_api_key' }))).toMatchObject({ kind: 'auth', retryable: false });
    expect(mapOpenAIError(gen(400, { message: 'bad', code: 'invalid_value' }))).toMatchObject({ kind: 'invalid_request', retryable: false });
    expect(mapOpenAIError(gen(400, { message: "This model's maximum context length is 1 tokens", code: 'context_length_exceeded' }))).toMatchObject({ kind: 'context_length', retryable: false });
    expect(mapOpenAIError(new OpenAI.APIConnectionError({ message: 'reset' }))).toMatchObject({ kind: 'network', retryable: true });
    expect(mapOpenAIError(new OpenAI.APIConnectionTimeoutError())).toMatchObject({ kind: 'timeout', retryable: true });
    expect(mapOpenAIError(new OpenAI.APIUserAbortError())).not.toBeInstanceOf(ProviderError);
  });
});

function fakeClient(scripts: StreamEvent[][]): OpenAIClientLike & { bodies: unknown[] } {
  const bodies: unknown[] = [];
  let n = 0;
  return {
    bodies,
    responses: {
      async create(body) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        return fromArray(scripts[n++] ?? scripts.at(-1)!);
      },
    },
  };
}

describe('openai provider', () => {
  it('streams through the client and the agent loop, replaying encrypted reasoning on step 2', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' };
    const fc = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo', arguments: '{"n":1}', status: 'completed' };
    const msg = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'all done', annotations: [] }] };
    const client = fakeClient([
      [added(0, { ...reasoning }), added(1, { ...fc, arguments: '' }), ev({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1', arguments: fc.arguments, sequence_number: 3 }), completed([reasoning, fc])],
      [ev({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'all done', logprobs: [], sequence_number: 1 }), completed([msg])],
    ]);
    const provider = createOpenAIProvider({ apiKey: 'k', client });
    expect(provider.id).toBe('openai');
    const result = await createAgentLoop().runTurn(baseInput({ route: [resolved(provider, 'gpt-6.1-sol')], tools: fakeTools({ echo: () => 'result' }), cacheKey: 'ath-1' }));
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('all done');
    const body2 = client.bodies[1] as { input: Array<Record<string, unknown>>; prompt_cache_key: string };
    expect(body2.prompt_cache_key).toBe('ath-1');
    expect(body2.input.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(body2.input[1]).toEqual(reasoning);
    expect(body2.input[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'result' });
  });

  it('maps client errors and aborts', async () => {
    const failing: OpenAIClientLike = {
      responses: {
        async create() {
          throw OpenAI.APIError.generate(429, { message: 'slow', code: 'rate_limit_exceeded' }, 'slow', new Headers({ 'retry-after': '1' }));
        },
      },
    };
    await expect(drain(createOpenAIProvider({ apiKey: 'k', client: failing }).stream(req({ model: 'gpt-6.1-sol' })))).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 1000 });
    const ctrl = new AbortController();
    const aborting: OpenAIClientLike = {
      responses: {
        async create() {
          ctrl.abort();
          throw new OpenAI.APIUserAbortError();
        },
      },
    };
    await expect(drain(createOpenAIProvider({ apiKey: 'k', client: aborting }).stream(req({ model: 'gpt-6.1-sol' }), ctrl.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
