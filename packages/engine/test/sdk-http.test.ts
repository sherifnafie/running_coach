/**
 * The adapters against the REAL SDK clients with a fake `fetch`: checks what actually goes over the wire
 * (URL, headers, JSON body) and that the SDKs' own SSE parsing / error classes feed our mappers.
 * No network involved.
 */
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { AssistantItem, ModelStreamEvent } from '@opencoach/protocol';
import { createCompatibleProvider, createOpenRouterProvider, DEFAULT_OPENROUTER_CATALOG } from '../src';
import { ModelCatalogEntry } from '@opencoach/protocol';
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


describe('OpenRouter adapter on the real SDK (fake fetch) [MOD-4]', () => {
  const models = DEFAULT_OPENROUTER_CATALOG.map((m) => ModelCatalogEntry.parse(m));
  const chunk = (delta: unknown, finish: string | null = null) => ({ data: { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'deepseek/deepseek-v4.1-flash', provider: 'DeepInfra', choices: [{ index: 0, delta, finish_reason: finish }] } });
  const toolTurn = () =>
    sse(
      [
        chunk({ role: 'assistant', content: '', reasoning: 'We', reasoning_details: [{ type: 'reasoning.text', text: 'We', format: 'unknown', index: 0 }] }),
        chunk({ reasoning: ' need', reasoning_details: [{ type: 'reasoning.text', text: ' need', format: 'unknown', index: 0 }] }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"n":1}' } }] }),
        chunk({}, 'tool_calls'),
        { data: { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 5643, completion_tokens: 50, cost: 0.0000512, prompt_tokens_details: { cached_tokens: 5632, cache_write_tokens: 0 } } } },
      ],
      'data: [DONE]\n\n',
    );

  it('sends reasoning, routing and attribution, and reports merged reasoning and the charged cost', async () => {
    const r = recorder(() => toolTurn());
    const client = new OpenAI({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1', fetch: r.fetch, maxRetries: 0 });
    const provider = createOpenRouterProvider({ apiKey: 'k', models, routing: { dataCollection: 'deny', requireParameters: true }, appUrl: 'https://coach.example' }, { client });
    const out = await drain(provider.stream(req({ model: 'deepseek/deepseek-v4.1-flash', effort: 'high', tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] })));
    expect(r.seen[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(r.seen[0]?.headers.get('x-title')).toBe('OpenCoach');
    expect(r.seen[0]?.headers.get('http-referer')).toBe('https://coach.example');
    expect(r.seen[0]?.body).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash',
      reasoning: { effort: 'high' },
      provider: { data_collection: 'deny', require_parameters: true, order: ['deepinfra/fp8', 'together', 'atlas-cloud/fp8'], allow_fallbacks: true },
    });
    expect(r.seen[0]?.body).not.toHaveProperty('reasoning_effort');
    expect(endOf(out)).toMatchObject({
      usage: { inputTokens: 11, cachedInputTokens: 5632, cacheWriteTokens: 0, outputTokens: 50, costUsd: 0.0000512 },
      item: { provider: 'openrouter', raw: { reasoning_details: [{ type: 'reasoning.text', text: 'We need', format: 'unknown', index: 0 }] } },
    });
    expect(provider.capabilities('deepseek/deepseek-v4.1-flash')).toMatchObject({ vision: true, efforts: ['low', 'medium', 'high', 'max'] });
    expect(provider.capabilities('someone/unknown-model')).toMatchObject({ vision: false, maxContextTokens: 128_000, efforts: [] });
  });

  it('switches on request-level prompt caching only for catalog models that need it', async () => {
    const r = recorder(() => sse([chunk({ content: 'ok' }, 'stop')], 'data: [DONE]\n\n'));
    const client = new OpenAI({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1', fetch: r.fetch, maxRetries: 0 });
    const provider = createOpenRouterProvider({ apiKey: 'k', models }, { client });
    await drain(provider.stream(req({ model: 'anthropic/claude-haiku-5.5', effort: 'medium' })));
    await drain(provider.stream(req({ model: 'deepseek/deepseek-v4.1-flash' })));
    expect(r.seen[0]?.body).toMatchObject({ cache_control: { type: 'ephemeral', ttl: '1h' }, reasoning: { effort: 'medium' } });
    expect(r.seen[1]?.body).not.toHaveProperty('cache_control');
    expect(provider.capabilities('anthropic/claude-haiku-5.5')).toMatchObject({ vision: true, maxContextTokens: 1_000_000 });
  });

  it('replays reasoning_details unchanged within a tool loop, only to the model that produced them', async () => {
    const r = recorder(() => sse([chunk({ content: 'done' }, 'stop')], 'data: [DONE]\n\n'));
    const client = new OpenAI({ apiKey: 'k', baseURL: 'https://openrouter.ai/api/v1', fetch: r.fetch, maxRetries: 0 });
    const provider = createOpenRouterProvider({ apiKey: 'k', models }, { client });
    const details = [{ type: 'reasoning.text', text: 'We need', format: 'unknown', index: 0 }];
    const call: AssistantItem = { kind: 'assistant', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', parts: [{ type: 'tool_call', id: 'call_1', name: 'echo', input: { n: 1 } }], raw: { reasoning_details: details } };
    const items = [user('hi'), call, { kind: 'tool_results' as const, results: [{ callId: 'call_1', name: 'echo', content: [{ type: 'text' as const, text: '1' }], isError: false }] }];
    await drain(provider.stream(req({ model: 'deepseek/deepseek-v4.1-flash', items })));
    await drain(provider.stream(req({ model: 'z-ai/glm-5.3-flash', items })));
    const sent = (i: number) => (r.seen[i]?.body.messages as Array<Record<string, unknown>>).find((m) => m.role === 'assistant');
    expect(sent(0)).toMatchObject({ reasoning_details: details, tool_calls: [{ id: 'call_1' }] });
    expect(sent(1)).not.toHaveProperty('reasoning_details');
    expect(r.seen[1]?.body).not.toHaveProperty('reasoning');
  });
});
