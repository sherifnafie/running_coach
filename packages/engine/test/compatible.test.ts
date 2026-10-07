import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { AssistantItem, CompatibleProviderConfig, ConvItem, ModelStreamEvent } from '@opencoach/protocol';
import {
  NO_VISION_PLACEHOLDER,
  buildCompatibleMessages,
  buildCompatibleRequest,
  createCompatibleProvider,
  mapCompatibleError,
  parseCompatibleStream,
  type CompatibleClientLike,
} from '../src/compatible';
import { createAgentLoop, priceFor } from '../src';
import { baseInput, drain, fakeTools, fromArray, req, resolved, user } from './helpers';

type Chunk = Parameters<typeof parseCompatibleStream>[0] extends AsyncIterable<infer E> ? E : never;
const PNG = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' };

const cfg = (over: Partial<CompatibleProviderConfig> = {}): CompatibleProviderConfig => ({
  id: 'deepseek',
  baseUrl: 'https://api.deepseek.example/v1',
  vision: false,
  contextTokens: 128_000,
  maxOutputTokens: 8192,
  replayReasoningContent: false,
  ...over,
});
const sub = (c: CompatibleProviderConfig) => ({ id: c.id, vision: c.vision, contextTokens: c.contextTokens, maxOutputTokens: c.maxOutputTokens, replayReasoningContent: c.replayReasoningContent });

const assistant = (parts: AssistantItem['parts'], extra: Partial<AssistantItem> = {}): AssistantItem => ({ kind: 'assistant', parts, provider: 'deepseek', model: 'deepseek-v4-pro', ...extra });
const R = (model = 'deepseek-v4-pro', over: Partial<Parameters<typeof req>[0]> = {}) => req({ model, ...over });

describe('compatible: capabilities', () => {
  it('come from the provider config', () => {
    const p = createCompatibleProvider(cfg({ vision: true, contextTokens: 64_000, maxOutputTokens: 4096 }), { client: fakeClient([[]]) });
    expect(p.id).toBe('deepseek');
    expect(p.capabilities('anything')).toMatchObject({ vision: true, maxContextTokens: 64_000, maxOutputTokens: 4096, streamingToolInput: true, efforts: [] });
  });
});

describe('compatible: configured reasoning controls [MOD-1]', () => {
  it('forwards supported effort and an explicit thinking toggle, omitting unknown extensions by default', async () => {
    const client = fakeClient([[chunk({ content: 'ok' }, 'stop')]]);
    const provider = createCompatibleProvider(cfg({ reasoningEfforts: ['low', 'high', 'max'], thinking: true }), { client });
    await drain(provider.stream(R('m', { effort: 'high' })));
    await drain(provider.stream(R('m', { effort: 'medium' })));
    expect(client.bodies[0]).toMatchObject({ reasoning_effort: 'high', thinking: { type: 'enabled' } });
    expect(client.bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(provider.capabilities('m').efforts).toEqual(['low', 'high', 'max']);
    const plain = fakeClient([[chunk({ content: 'ok' }, 'stop')]]);
    await drain(createCompatibleProvider(cfg(), { client: plain }).stream(R('m', { effort: 'high' })));
    expect(plain.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(plain.bodies[0]).not.toHaveProperty('thinking');
    const disabled = fakeClient([[chunk({ content: 'ok' }, 'stop')]]);
    await drain(createCompatibleProvider(cfg({ thinking: false }), { client: disabled }).stream(R()));
    expect(disabled.bodies[0]).toMatchObject({ thinking: { type: 'disabled' } });
  });
});

describe('compatible: message mapping', () => {
  it('joins system blocks into one system message and maps harness to system role', () => {
    const msgs = buildCompatibleMessages(
      R('m', { system: [{ text: 'one', cache: true }, { text: '', cache: false }, { text: 'two', cache: false }], items: [user('hi'), { kind: 'harness', text: '<situation>x</situation>' }] }),
      sub(cfg()),
    );
    expect(msgs).toEqual([
      { role: 'system', content: 'one\n\ntwo' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: '<situation>x</situation>' },
    ]);
  });

  it('uses image_url data URLs only with vision; otherwise a placeholder', () => {
    const items: ConvItem[] = [{ kind: 'user', parts: [{ type: 'text', text: 'see' }, PNG] }];
    expect(buildCompatibleMessages(R('m', { items }), sub(cfg({ vision: true })))).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    expect(buildCompatibleMessages(R('m', { items }), sub(cfg({ vision: false })))).toEqual([{ role: 'user', content: `see\n${NO_VISION_PLACEHOLDER}` }]);
    expect(NO_VISION_PLACEHOLDER).toBe('[image omitted: model has no vision]');
  });

  it('maps assistant tool calls and one tool message per result, in order', () => {
    const items: ConvItem[] = [
      user('q'),
      assistant([{ type: 'text', text: 'Looking.' }, { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } }, { type: 'tool_call', id: 'c2', name: 'read', input: { path: 'b' } }]),
      { kind: 'tool_results', results: [
        { callId: 'c1', name: 'read', isError: false, content: [{ type: 'text', text: 'A' }] },
        { callId: 'c2', name: 'read', isError: true, content: [{ type: 'text', text: 'ENOENT' }] },
      ] },
    ];
    const msgs = buildCompatibleMessages(R('deepseek-v4-pro', { items }), sub(cfg()));
    expect(msgs.slice(1)).toEqual([
      {
        role: 'assistant',
        content: 'Looking.',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: ENOENT' },
    ]);
  });

  it('uses null content for tool-call-only assistant messages and skips empty ones', () => {
    const msgs = buildCompatibleMessages(R('m', { items: [assistant([{ type: 'tool_call', id: 'c', name: 't', input: {} }]), assistant([])] }), sub(cfg()));
    expect(msgs).toEqual([{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }] }]);
  });

  it('sends tool-result images as a follow-up user message when the model has vision', () => {
    const results: ConvItem = { kind: 'tool_results', results: [{ callId: 'c1', name: 'read', isError: false, content: [{ type: 'text', text: 'chart' }, PNG] }] };
    const withVision = buildCompatibleMessages(R('m', { items: [results] }), sub(cfg({ vision: true })));
    expect(withVision).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'chart' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image(s) returned by tool read (call c1):' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    const without = buildCompatibleMessages(R('m', { items: [results] }), sub(cfg({ vision: false })));
    expect(without).toEqual([{ role: 'tool', tool_call_id: 'c1', content: `chart\n${NO_VISION_PLACEHOLDER}` }]);
  });

  describe('reasoning_content replay', () => {
    const withReasoning = assistant([{ type: 'tool_call', id: 'c', name: 't', input: {} }], { raw: { reasoning_content: 'let me think' } });
    const textOnly = assistant([{ type: 'text', text: 'final' }], { raw: { reasoning_content: 'private' } });

    it('replays only when enabled, for the same model, on messages with tool calls', () => {
      const on = sub(cfg({ replayReasoningContent: true }));
      expect(buildCompatibleMessages(R('deepseek-v4-pro', { items: [withReasoning, textOnly] }), on)).toMatchObject([{ reasoning_content: 'let me think' }, { role: 'assistant', content: 'final' }]);
      expect(JSON.stringify(buildCompatibleMessages(R('deepseek-v4-pro', { items: [textOnly] }), on))).not.toContain('private');
      // different model: not replayed
      expect(JSON.stringify(buildCompatibleMessages(R('deepseek-v4-flash', { items: [withReasoning] }), on))).not.toContain('let me think');
      // other provider: not replayed
      expect(JSON.stringify(buildCompatibleMessages(R('deepseek-v4-pro', { items: [{ ...withReasoning, provider: 'openai' }] }), on))).not.toContain('let me think');
      // disabled in config
      expect(JSON.stringify(buildCompatibleMessages(R('deepseek-v4-pro', { items: [withReasoning] }), sub(cfg())))).not.toContain('let me think');
    });
  });

  it('builds a streaming request with usage reporting, tools and a clamped max_tokens', () => {
    const p = buildCompatibleRequest(
      R('deepseek-v4-pro', { maxOutputTokens: 100_000, tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } }] }),
      sub(cfg()),
    );
    expect(p).toMatchObject({ model: 'deepseek-v4-pro', stream: true, stream_options: { include_usage: true }, max_tokens: 8192 });
    expect(p.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } } }]);
    expect(buildCompatibleRequest(R('m'), sub(cfg()))).not.toHaveProperty('tools');
  });
});

// ------------------------------------------------------------------ stream parsing

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, extra: Record<string, unknown> = {}): Chunk =>
  ({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason, logprobs: null }], ...extra }) as unknown as Chunk;
const usageChunk = (usage: Record<string, unknown>): Chunk => ({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage }) as unknown as Chunk;
const parse = (chunks: Chunk[]) => drain(parseCompatibleStream(fromArray(chunks), { model: 'deepseek-v4-pro', providerId: 'deepseek' }));
const endOf = (out: ModelStreamEvent[]) => out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;

describe('compatible: stream parsing', () => {
  it('streams text and reads usage, incl. DeepSeek cache hit tokens', async () => {
    const out = await parse([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'Hello ' }),
      chunk({ content: 'runner' }),
      chunk({}, 'stop'),
      usageChunk({ prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'message_end']);
    expect(endOf(out).usage).toEqual({ inputTokens: 100, cachedInputTokens: 900, cacheWriteTokens: 0, outputTokens: 20 });
    expect(endOf(out)).toMatchObject({ stopReason: 'end_turn', item: { provider: 'deepseek', model: 'deepseek-v4-pro', parts: [{ type: 'text', text: 'Hello runner' }] } });
    expect(endOf(out).item.raw).toBeUndefined();
  });

  it('reads OpenAI-style cached_tokens too', async () => {
    const out = await parse([chunk({ content: 'x' }, 'stop'), usageChunk({ prompt_tokens: 500, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 200 } })]);
    expect(endOf(out).usage).toEqual({ inputTokens: 300, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 5 });
  });

  it('accumulates tool call deltas by index (parallel calls)', async () => {
    const out = await parse([
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'write', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b",' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"content":"x"}' } }] }),
      chunk({}, 'tool_calls'),
      usageChunk({ prompt_tokens: 10, completion_tokens: 10 }),
    ]);
    expect(out.map((e) => e.type)).toEqual([
      'tool_call_start', 'tool_call_start', 'tool_input_delta', 'tool_input_delta', 'tool_input_delta', 'tool_input_delta', 'tool_call_end', 'tool_call_end', 'message_end',
    ]);
    expect(out.filter((e) => e.type === 'tool_input_delta')).toEqual([
      { type: 'tool_input_delta', id: 'call_a', partialJson: '{"path":' },
      { type: 'tool_input_delta', id: 'call_b', partialJson: '{"path":"b",' },
      { type: 'tool_input_delta', id: 'call_a', partialJson: '"a"}' },
      { type: 'tool_input_delta', id: 'call_b', partialJson: '"content":"x"}' },
    ]);
    expect(out.filter((e) => e.type === 'tool_call_end')).toEqual([
      { type: 'tool_call_end', id: 'call_a', name: 'read', input: { path: 'a' } },
      { type: 'tool_call_end', id: 'call_b', name: 'write', input: { path: 'b', content: 'x' } },
    ]);
    expect(endOf(out).stopReason).toBe('tool_use');
    expect(endOf(out).item.parts).toHaveLength(2);
  });

  it('handles a whole tool call in a single chunk, a missing id, and "stop" with tool calls (Ollama style)', async () => {
    const out = await parse([chunk({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"path":"a"}' } }] }, 'stop')]);
    expect(out.map((e) => e.type)).toEqual(['tool_call_start', 'tool_input_delta', 'tool_call_end', 'message_end']);
    const start = out[0] as Extract<ModelStreamEvent, { type: 'tool_call_start' }>;
    expect(start.id).toMatch(/^call_[0-9a-f-]{36}$/);
    // Generated ids must not repeat across streams of the same turn: the runtime replays tool results by id [RT-6].
    const again = await parse([chunk({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{"path":"a"}' } }] }, 'stop')]);
    expect((again[0] as typeof start).id).not.toBe(start.id);
    expect(endOf(out).stopReason).toBe('tool_use');
    expect(endOf(out).usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  });

  it('captures reasoning_content into item.raw', async () => {
    const out = await parse([chunk({ reasoning_content: 'Hmm, ' }), chunk({ reasoning_content: 'the week.' }), chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'read', arguments: '{}' } }] }), chunk({}, 'tool_calls')]);
    expect(endOf(out).item.raw).toEqual({ reasoning_content: 'Hmm, the week.' });
    // reasoning is not shown as text
    expect(out.some((e) => e.type === 'text_delta' || e.type === 'progress')).toBe(false);
  });

  it('maps finish reasons; a truncated tool call is dropped without tool_call_end', async () => {
    const cut = await parse([chunk({ content: 'Working' }), chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'write', arguments: '{"path": "a", "con' } }] }), chunk({}, 'length')]);
    expect(endOf(cut).stopReason).toBe('max_tokens');
    expect(cut.some((e) => e.type === 'tool_call_end')).toBe(false);
    expect(cut.some((e) => e.type === 'tool_call_start')).toBe(true);
    expect(endOf(cut).item.parts).toEqual([{ type: 'text', text: 'Working' }]);
    expect(endOf(await parse([chunk({}, 'content_filter')]))).toMatchObject({ stopReason: 'refusal', refusalCategory: 'content_filter' });
    expect(endOf(await parse([chunk({ content: 'x' }, 'weird')])).stopReason).toBe('other');
  });

  it('reports invalid tool JSON with the marker on a normal stop', async () => {
    const out = await parse([chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'write', arguments: '{"a": oops' } }] }, 'tool_calls')]);
    expect(out.find((e) => e.type === 'tool_call_end')).toMatchObject({ input: { __invalid_json: '{"a": oops' } });
  });

  it('tolerates a missing finish_reason after content, and errors on an empty stream', async () => {
    expect(endOf(await parse([chunk({ content: 'hi' })])).stopReason).toBe('end_turn');
    await expect(parse([])).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
});

// ------------------------------------------------------------------ errors + provider

type ClientOptions = NonNullable<Parameters<CompatibleClientLike['chat']['completions']['create']>[1]>;
function fakeClient(scripts: Chunk[][]): CompatibleClientLike & { bodies: unknown[]; options: ClientOptions[] } {
  const bodies: unknown[] = [];
  const options: ClientOptions[] = [];
  let n = 0;
  return {
    bodies,
    options,
    chat: {
      completions: {
        async create(body, opts) {
          bodies.push(JSON.parse(JSON.stringify(body)));
          options.push({ signal: opts?.signal, ...(opts?.headers ? { headers: { ...opts.headers } } : {}) });
          return fromArray(scripts[n++] ?? scripts.at(-1)!);
        },
      },
    },
  };
}

describe('compatible: errors and provider', () => {
  it('preserves transport headers and keeps epoch sessions stable across steps and turns [RT-7] [SEC-1]', async () => {
    const client = fakeClient([[chunk({ content: 'ok' }, 'stop')]]);
    const staticHeaders = { 'User-Agent': 'OpenCoach/test', 'X-Deployment': 'test', 'X-OpenCode-Session': 'static-value' };
    const provider = createCompatibleProvider(cfg({ id: 'opencode-go', headers: staticHeaders, sessionHeader: 'x-opencode-session' }), { client });
    const signal = new AbortController().signal;
    await drain(provider.stream(R('kimi-k2.6', { metadata: { epochId: 'ep_1', athleteId: 'ath_1', turnId: 'turn_1', step: 1 } }), signal));
    await drain(provider.stream(R('kimi-k2.6', { metadata: { epochId: 'ep_1', athleteId: 'ath_1', turnId: 'turn_2', step: 2 } })));
    await drain(provider.stream(R('kimi-k2.6', { metadata: { epochId: 'ep_2', athleteId: 'ath_1' } })));
    expect(client.options.map((o) => o.headers?.['x-opencode-session'])).toEqual(['ep_1', 'ep_1', 'ep_2']);
    expect(client.options[0]).toEqual({ signal, headers: { 'User-Agent': 'OpenCoach/test', 'X-Deployment': 'test', 'x-opencode-session': 'ep_1' } });
    expect(staticHeaders['X-OpenCode-Session']).toBe('static-value');
    expect(client.bodies).not.toContainEqual(expect.objectContaining({ headers: expect.anything() }));
  });

  it('uses athlete/cache/turn identities and isolates anonymous request sessions [RT-7]', async () => {
    const client = fakeClient([[chunk({ content: 'ok' }, 'stop')]]);
    const provider = createCompatibleProvider(cfg({ sessionHeader: 'x-session' }), { client });
    await drain(provider.stream(R('m', { cacheKey: 'cache', metadata: { athleteId: 'ath', turnId: 'turn' } })));
    await drain(provider.stream(R('m', { cacheKey: 'cache', metadata: { turnId: 'turn' } })));
    await drain(provider.stream(R('m', { metadata: { turnId: 'turn' } })));
    const anonymous = R('m');
    await drain(provider.stream(anonymous));
    await drain(provider.stream(anonymous));
    await drain(provider.stream(R('m')));
    const sessions = client.options.map((o) => o.headers?.['x-session']);
    expect(sessions.slice(0, 3)).toEqual(['ath', 'cache', 'turn']);
    expect(sessions[3]).toBe(sessions[4]);
    expect(sessions[3]).not.toBe(sessions[5]);
    expect(sessions[3]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps cache-scoped conversation headers across a real tool loop [RT-7]', async () => {
    const client = fakeClient([
      [chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo', arguments: '{}' } }] }, 'tool_calls')],
      [chunk({ content: 'done' }, 'stop')],
    ]);
    const provider = createCompatibleProvider(cfg({ sessionHeader: 'x-opencode-session' }), { client });
    const result = await createAgentLoop().runTurn(baseInput({ cacheKey: 'athlete-conversation', route: [resolved(provider)], tools: fakeTools({ echo: () => 'ok' }) }));
    expect(result.stopReason).toBe('end_turn');
    expect(client.options.map((o) => o.headers?.['x-opencode-session'])).toEqual(['athlete-conversation', 'athlete-conversation']);
  });

  it('maps errors like the other adapters', () => {
    const gen = (status: number, message: string, headers: Record<string, string> = {}) => OpenAI.APIError.generate(status, { message }, message, new Headers(headers));
    expect(mapCompatibleError(gen(429, 'slow', { 'retry-after': '4' }))).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 4000 });
    expect(mapCompatibleError(gen(500, 'oops'))).toMatchObject({ retryable: true });
    expect(mapCompatibleError(gen(401, 'bad key'))).toMatchObject({ kind: 'auth', retryable: false });
    expect(mapCompatibleError(gen(400, "This model's maximum context length is 131072 tokens"))).toMatchObject({ kind: 'context_length' });
    expect(mapCompatibleError(new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' }))).toMatchObject({ kind: 'network', retryable: true });
  });

  it('runs a tool loop through the agent loop, echoing reasoning_content within the loop', async () => {
    const client = fakeClient([
      [
        chunk({ reasoning_content: 'plan the call' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo', arguments: '{"n":1}' } }] }),
        chunk({}, 'tool_calls'),
        usageChunk({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50 }),
      ],
      [chunk({ content: 'done' }, 'stop'), usageChunk({ prompt_tokens: 150, completion_tokens: 3 })],
    ]);
    const provider = createCompatibleProvider(cfg({ replayReasoningContent: true }), { client });
    const price = (model: string, usage: Parameters<typeof priceFor>[1]) => priceFor(model, usage, { 'deepseek-v4-pro': { inputPerMTok: 0.5, outputPerMTok: 2, cacheReadPerMTok: 0.05 } });
    const result = await createAgentLoop({ price }).runTurn(baseInput({ route: [resolved(provider, 'deepseek-v4-pro')], tools: fakeTools({ echo: () => 'ok' }) }));
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('done');
    // priced from the table (no reported cost): 50 in + 50 cached + 10 out, then 150 in + 3 out
    expect(result.costUsd).toBeCloseTo((50 * 0.5 + 50 * 0.05 + 10 * 2 + 150 * 0.5 + 3 * 2) / 1e6, 12);
    const body2 = client.bodies[1] as { messages: Array<Record<string, unknown>> };
    expect(body2.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(body2.messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'plan the call', tool_calls: [{ id: 'call_1' }] });
  });

  it('throws AbortError on abort and ProviderError on HTTP errors', async () => {
    const ctrl = new AbortController();
    const aborting: CompatibleClientLike = {
      chat: {
        completions: {
          async create() {
            ctrl.abort();
            throw new OpenAI.APIUserAbortError();
          },
        },
      },
    };
    await expect(drain(createCompatibleProvider(cfg(), { client: aborting }).stream(req(), ctrl.signal))).rejects.toMatchObject({ name: 'AbortError' });
    const failing: CompatibleClientLike = {
      chat: {
        completions: {
          async create() {
            throw OpenAI.APIError.generate(503, { message: 'down' }, 'down', new Headers());
          },
        },
      },
    };
    await expect(drain(createCompatibleProvider(cfg(), { client: failing }).stream(req()))).rejects.toMatchObject({ name: 'ProviderError', kind: 'overloaded', retryable: true });
  });
});
