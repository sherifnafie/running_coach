/**
 * The adapters against the REAL SDK clients with a fake `fetch`: checks what actually goes over the wire
 * (URL, headers, JSON body) and that the SDKs' own SSE parsing / error classes feed our mappers.
 * No network involved.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { ModelStreamEvent } from '@opencoach/protocol';
import { createAnthropicProvider, createCompatibleProvider, createOpenAIProvider } from '../src';
import { BETA_SERVER_SIDE_FALLBACK, BETA_THINKING_DISPLAY_UPDATES } from '../src/anthropic';
import { drain, req, user } from './helpers';

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const sse = (events: Array<{ event?: string; data: unknown }>, extra = ''): Response => {
  const text = events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('') + extra;
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function recorder(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (input: unknown, init?: { headers?: unknown; body?: unknown; signal?: AbortSignal | null }) => {
    const s: Seen = {
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    seen.push(s);
    const res = await respond(s);
    // a real fetch rejects once its signal is aborted
    if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    return res;
  };
  return { seen, fetch: fetch as unknown as typeof globalThis.fetch };
}

const endOf = (out: ModelStreamEvent[]) => out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;

// ------------------------------------------------------------------ Anthropic

const anthropicStream = (extra: Array<{ event: string; data: unknown }> = []) =>
  sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Looking at the tempo run.' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'send_message', input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text": "Nice ' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'work"}' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null, stop_details: null, container: null }, usage: { output_tokens: 33 } } },
    ...extra,
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);

describe('Anthropic adapter on the real SDK (fake fetch)', () => {
  const make = (respond: Parameters<typeof recorder>[0]) => {
    const r = recorder(respond);
    const client = new Anthropic({ apiKey: 'sk-test', fetch: r.fetch, maxRetries: 0 });
    return { ...r, provider: createAnthropicProvider({ apiKey: 'sk-test', client }) };
  };

  it('sends the documented request shape and parses the SSE stream', async () => {
    const { provider, seen } = make(() => anthropicStream());
    const out = await drain(
      provider.stream(
        req({
          system: [{ text: 'You are a coach.', cache: true }],
          tools: [{ name: 'send_message', description: 'Send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
          items: [user('tempo done'), { kind: 'harness', text: '<situation>now</situation>' }],
          effort: 'medium',
        }),
      ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('/v1/messages');
    expect(seen[0]?.headers.get('x-api-key')).toBe('sk-test');
    const betaHeader = seen[0]?.headers.get('anthropic-beta') ?? '';
    expect(betaHeader.split(',')).toEqual(expect.arrayContaining([BETA_THINKING_DISPLAY_UPDATES, BETA_SERVER_SIDE_FALLBACK]));
    const body = seen[0]!.body;
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      stream: true,
      max_tokens: 4096,
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      system: [{ type: 'text', text: 'You are a coach.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'send_message', eager_input_streaming: true, cache_control: { type: 'ephemeral' }, input_schema: { type: 'object' } }],
    });
    expect(body).not.toHaveProperty('betas'); // sent as a header, not in the body
    expect(body).not.toHaveProperty('tool_choice');
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(messages[1]?.content).toBe('<situation>now</situation>');

    expect(out.map((e) => e.type)).toEqual(['progress', 'tool_call_start', 'tool_input_delta', 'tool_input_delta', 'tool_call_end', 'message_end']);
    expect(out[0]).toEqual({ type: 'progress', text: 'Looking at the tempo run.' });
    expect(endOf(out)).toMatchObject({
      stopReason: 'tool_use',
      usage: { inputTokens: 12, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 33 },
      item: { raw: [{ type: 'thinking', thinking: 'Looking at the tempo run.', signature: 'SIG' }, { type: 'tool_use', id: 'toolu_1', name: 'send_message', input: { text: 'Nice work' } }] },
    });
  });

  it('maps HTTP errors from the SDK', async () => {
    const cases: Array<[() => Response, Record<string, unknown>]> = [
      [() => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '7' }), { kind: 'rate_limit', retryable: true, retryAfterMs: 7000, status: 429 }],
      [() => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { kind: 'overloaded', retryable: true }],
      [() => json(500, { type: 'error', error: { type: 'api_error', message: 'Internal' } }), { retryable: true, status: 500 }],
      [() => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } }), { kind: 'context_length', retryable: false }],
      [() => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type.disabled is not supported for this model' } }), { kind: 'invalid_request', retryable: false }],
      [() => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { kind: 'auth', retryable: false }],
      [() => json(403, { type: 'error', error: { type: 'permission_error', message: 'forbidden' } }), { kind: 'auth', retryable: false }],
    ];
    for (const [respond, expected] of cases) {
      const { provider } = make(respond);
      await expect(drain(provider.stream(req()))).rejects.toMatchObject({ name: 'ProviderError', ...expected });
    }
  });

  it('maps connection failures and mid-stream errors', async () => {
    const down = createAnthropicProvider({
      apiKey: 'k',
      client: new Anthropic({
        apiKey: 'k',
        maxRetries: 0,
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof globalThis.fetch,
      }),
    });
    await expect(drain(down.stream(req()))).rejects.toMatchObject({ name: 'ProviderError', kind: 'network', retryable: true });

    const { provider } = make(() => anthropicStream([{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }]));
    await expect(drain(provider.stream(req()))).rejects.toMatchObject({ name: 'ProviderError', kind: 'overloaded', retryable: true });
  });

  it('treats a stream cut off before message_stop as a retryable network error', async () => {
    const truncated = () =>
      sse([
        { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } },
      ]);
    const { provider } = make(truncated);
    await expect(drain(provider.stream(req()))).rejects.toMatchObject({ name: 'ProviderError', kind: 'network', retryable: true });
  });

  it('aborts via the signal', async () => {
    const ctrl = new AbortController();
    const { provider } = make(async () => {
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 5));
      return anthropicStream();
    });
    await expect(drain(provider.stream(req(), ctrl.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ------------------------------------------------------------------ OpenAI Responses

describe('OpenAI adapter on the real SDK (fake fetch)', () => {
  const completedResponse = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6.1-sol',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Nice work', annotations: [] }] }],
    usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 400 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 520 },
  };
  const stream = () =>
    sse([
      { event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { ...completedResponse, status: 'in_progress', output: [] } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 1, output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'Nice ', logprobs: [] } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'work', logprobs: [] } },
      { event: 'response.completed', data: { type: 'response.completed', sequence_number: 3, response: completedResponse } },
    ]);
  const make = (respond: Parameters<typeof recorder>[0]) => {
    const r = recorder(respond);
    const client = new OpenAI({ apiKey: 'sk-test', fetch: r.fetch, maxRetries: 0 });
    return { ...r, provider: createOpenAIProvider({ apiKey: 'sk-test', client }) };
  };

  it('sends a stateless Responses request and parses the SSE stream', async () => {
    const { provider, seen } = make(stream);
    const out = await drain(
      provider.stream(req({ model: 'gpt-6.1-sol', system: [{ text: 'Coach.', cache: true }], cacheKey: 'ath-1', effort: 'max', tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }], items: [user('hi')] })),
    );
    expect(seen[0]?.url).toContain('/responses');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-test');
    expect(seen[0]?.body).toMatchObject({
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      instructions: 'Coach.',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'xhigh', summary: 'auto' },
      parallel_tool_calls: true,
      prompt_cache_key: 'ath-1',
      tools: [{ type: 'function', name: 'echo', strict: false }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
    expect(out.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'message_end']);
    expect(endOf(out).usage).toEqual({ inputTokens: 100, cachedInputTokens: 400, cacheWriteTokens: 0, outputTokens: 20 });
  });

  it('maps HTTP errors', async () => {
    const { provider } = make(() => json(429, { error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '3' }));
    await expect(drain(provider.stream(req({ model: 'gpt-6.1-sol' })))).rejects.toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 3000 });
    const bad = make(() => json(400, { error: { message: 'Input tokens exceed the configured limit', type: 'invalid_request_error', code: 'context_length_exceeded' } }));
    await expect(drain(bad.provider.stream(req({ model: 'gpt-6.1-sol' })))).rejects.toMatchObject({ kind: 'context_length', retryable: false });
    const auth = make(() => json(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error', code: 'invalid_api_key' } }));
    await expect(drain(auth.provider.stream(req({ model: 'gpt-6.1-sol' })))).rejects.toMatchObject({ kind: 'auth', retryable: false });
  });
});

// ------------------------------------------------------------------ Chat Completions (compatible)

describe('compatible adapter on the real SDK (fake fetch)', () => {
  const cfg = { id: 'deepseek', baseUrl: 'https://api.deepseek.example/v1', vision: false, contextTokens: 128_000, maxOutputTokens: 8192, replayReasoningContent: true };
  const chunk = (delta: unknown, finish: string | null = null) => ({ data: { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finish }] } });

  it('posts to {baseUrl}/chat/completions with usage reporting and parses the stream', async () => {
    const r = recorder(() =>
      sse(
        [
          chunk({ role: 'assistant', content: '', reasoning_content: 'hmm' }),
          chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"n":1}' } }] }),
          chunk({}, 'tool_calls'),
          { data: { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 100, completion_tokens: 8, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } } },
        ],
        'data: [DONE]\n\n',
      ),
    );
    const client = new OpenAI({ apiKey: 'k', baseURL: cfg.baseUrl, fetch: r.fetch, maxRetries: 0 });
    const provider = createCompatibleProvider(cfg, { client });
    const out = await drain(provider.stream(req({ model: 'deepseek-v4-pro', system: [{ text: 'Coach.', cache: false }], tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] })));
    expect(r.seen[0]?.url).toBe('https://api.deepseek.example/v1/chat/completions');
    expect(r.seen[0]?.body).toMatchObject({ model: 'deepseek-v4-pro', stream: true, stream_options: { include_usage: true }, max_tokens: 4096, messages: [{ role: 'system', content: 'Coach.' }, { role: 'user', content: 'hi' }] });
    expect(out.map((e) => e.type)).toEqual(['tool_call_start', 'tool_input_delta', 'tool_call_end', 'message_end']);
    expect(endOf(out)).toMatchObject({
      stopReason: 'tool_use',
      usage: { inputTokens: 40, cachedInputTokens: 60, outputTokens: 8 },
      item: { raw: { reasoning_content: 'hmm' }, parts: [{ type: 'tool_call', id: 'call_1', name: 'echo', input: { n: 1 } }] },
    });
  });

  it('builds its own client from the config (baseUrl + apiKey) when none is injected', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
      seen.push(`${String(input)} | ${new Headers(init?.headers as HeadersInit).get('authorization')}`);
      return sse([chunk({ content: 'ok' }, 'stop')], 'data: [DONE]\n\n');
    }) as unknown as typeof globalThis.fetch;
    try {
      const provider = createCompatibleProvider({ ...cfg, apiKey: 'sk-deepseek' });
      await drain(provider.stream(req({ model: 'deepseek-v4-pro' })));
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(['https://api.deepseek.example/v1/chat/completions | Bearer sk-deepseek']);
  });
});
