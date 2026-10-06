import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { ProviderError, type AssistantItem, type ConvItem, type ModelStreamEvent } from '@opencoach/protocol';
import {
  BETA_SERVER_SIDE_FALLBACK,
  BETA_THINKING_DISPLAY_UPDATES,
  anthropicCapabilities,
  buildAnthropicMessages,
  buildAnthropicRequest,
  createAnthropicProvider,
  mapAnthropicError,
  parseAnthropicStream,
  type AnthropicBuildOptions,
  type AnthropicClientLike,
} from '../src/anthropic';
import { createAgentLoop } from '../src';
import { baseInput, drain, fakeTools, fromArray, req, resolved, user } from './helpers';

type StreamEvent = Parameters<typeof parseAnthropicStream>[0] extends AsyncIterable<infer E> ? E : never;
const ev = (x: unknown): StreamEvent => x as StreamEvent;
const rec = (c: unknown) => c as Array<Record<string, unknown>>;

const OPTS: AnthropicBuildOptions = { serverSideFallbacks: true, thinkingDisplay: 'updates', eagerInputStreaming: true };
const PNG = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' };

const assistant = (parts: AssistantItem['parts'], extra: Partial<AssistantItem> = {}): AssistantItem => ({
  kind: 'assistant',
  parts,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  ...extra,
});

// ------------------------------------------------------------------ capabilities

describe('anthropic capabilities', () => {
  it('has the documented table', () => {
    for (const m of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-4-8']) {
      expect(anthropicCapabilities(m)).toMatchObject({ vision: true, maxContextTokens: 1_000_000, maxOutputTokens: 128_000, midConversationSystem: true, streamingToolInput: true });
    }
    expect(anthropicCapabilities('claude-sonnet-5-5').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const haiku = anthropicCapabilities('claude-haiku-4-5');
    expect(haiku).toMatchObject({ vision: true, maxContextTokens: 200_000, maxOutputTokens: 64_000, midConversationSystem: false, efforts: [] });
    expect(anthropicCapabilities('claude-haiku-4-5-20251001').maxContextTokens).toBe(200_000);
    expect(anthropicCapabilities('claude-sonnet-5').midConversationSystem).toBe(false);
  });
});

// ------------------------------------------------------------------ system + tools

describe('anthropic request: system, tools, params', () => {
  it('maps system blocks and keeps at most two cache breakpoints (the last two)', () => {
    const { params } = buildAnthropicRequest(
      req({
        system: [
          { text: 'A', cache: true },
          { text: 'B', cache: true },
          { text: '   ', cache: true },
          { text: 'C', cache: true },
          { text: 'D', cache: false },
        ],
      }),
      OPTS,
    );
    expect(params.system).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'C', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'D' },
    ]);
  });

  it('omits system when empty', () => {
    expect(buildAnthropicRequest(req({ system: [] }), OPTS).params.system).toBeUndefined();
  });

  it('maps tools: input_schema, eager input streaming, cache_control on the last tool only', () => {
    const { params } = buildAnthropicRequest(
      req({
        tools: [
          { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
          { name: 'no_reply', description: 'Stay silent', inputSchema: { properties: {} } },
        ],
      }),
      OPTS,
    );
    expect(params.tools).toEqual([
      { name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, eager_input_streaming: true },
      { name: 'no_reply', description: 'Stay silent', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true, cache_control: { type: 'ephemeral' } },
    ]);
    const lazy = buildAnthropicRequest(req({ tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] }), { ...OPTS, eagerInputStreaming: false });
    expect(lazy.params.tools?.[0]).not.toHaveProperty('eager_input_streaming');
    expect(params).not.toHaveProperty('tool_choice');
  });

  it('streams, clamps max_tokens to the model limit and never sends prefill/tool_choice/sampling params', () => {
    const { params } = buildAnthropicRequest(req({ maxOutputTokens: 999_999 }), OPTS);
    expect(params.stream).toBe(true);
    expect(params.max_tokens).toBe(128_000);
    expect(buildAnthropicRequest(req({ model: 'claude-haiku-4-5', maxOutputTokens: 100_000 }), OPTS).params.max_tokens).toBe(64_000);
    for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice']) expect(params).not.toHaveProperty(k);
  });
});

describe('anthropic request: thinking, effort, betas', () => {
  it('sonnet-5-5: adaptive thinking with display updates, effort medium by default, betas', () => {
    const { params, betas, display } = buildAnthropicRequest(req(), OPTS);
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'updates' });
    expect(params.output_config).toEqual({ effort: 'medium' });
    expect(params.fallbacks).toBe('default');
    expect(betas).toEqual([BETA_THINKING_DISPLAY_UPDATES, BETA_SERVER_SIDE_FALLBACK]);
    expect(params.betas).toEqual(betas);
    expect(display).toBe('updates');
  });

  it('passes the requested effort, degrading to what the model supports', () => {
    expect(buildAnthropicRequest(req({ effort: 'max' }), OPTS).params.output_config).toEqual({ effort: 'max' });
    expect(buildAnthropicRequest(req({ model: 'claude-opus-4-6', effort: 'xhigh' }), OPTS).params.output_config).toEqual({ effort: 'high' });
  });

  it('haiku: no thinking, no effort, no betas', () => {
    const { params, betas } = buildAnthropicRequest(req({ model: 'claude-haiku-4-5', effort: 'high' }), OPTS);
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
    expect(params.fallbacks).toBeUndefined();
    expect(betas).toEqual([]);
    expect(params.betas).toBeUndefined();
  });

  it('never sends thinking disabled / budget_tokens on the 5.x models', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      const t = buildAnthropicRequest(req({ model }), OPTS).params.thinking;
      expect(t).toMatchObject({ type: 'adaptive' });
      expect(t).not.toHaveProperty('budget_tokens');
    }
  });

  it('only requests display "updates" where it is documented', () => {
    const opus5 = buildAnthropicRequest(req({ model: 'claude-opus-5' }), OPTS);
    expect(opus5.params.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(opus5.betas).toEqual([]);
    expect(buildAnthropicRequest(req({ model: 'claude-opus-5-5' }), OPTS).params.thinking).toEqual({ type: 'adaptive', display: 'updates' });
    expect(buildAnthropicRequest(req({ model: 'claude-fable-5-1' }), OPTS).betas).toContain(BETA_THINKING_DISPLAY_UPDATES);
    // no `display` field at all on models that predate it
    expect(buildAnthropicRequest(req({ model: 'claude-opus-4-6' }), OPTS).params.thinking).toEqual({ type: 'adaptive' });
  });

  it('honours thinkingDisplay summarized / omitted', () => {
    const s = buildAnthropicRequest(req(), { ...OPTS, thinkingDisplay: 'summarized' });
    expect(s.params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(s.betas).not.toContain(BETA_THINKING_DISPLAY_UPDATES);
  });

  it('server-side fallbacks only on sonnet-5-5 / opus-5-5 / fable-5-1 and only when enabled', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      expect(buildAnthropicRequest(req({ model: m }), OPTS).params.fallbacks).toBe('default');
    }
    expect(buildAnthropicRequest(req({ model: 'claude-opus-5' }), OPTS).params.fallbacks).toBeUndefined();
    const off = buildAnthropicRequest(req(), { ...OPTS, serverSideFallbacks: false });
    expect(off.params.fallbacks).toBeUndefined();
    expect(off.betas).not.toContain(BETA_SERVER_SIDE_FALLBACK);
  });
});

// ------------------------------------------------------------------ message mapping

describe('anthropic messages: alternation and merging', () => {
  it('maps text and images to user blocks (base64)', () => {
    const msgs = buildAnthropicMessages([{ kind: 'user', parts: [{ type: 'text', text: 'look' }, PNG, { type: 'text', text: '' }] }], 'claude-sonnet-5-5', true);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);
  });

  it('merges consecutive user-role items, putting tool_result blocks first', () => {
    const items: ConvItem[] = [
      user('start'),
      assistant([{ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } }, { type: 'tool_call', id: 'c2', name: 'read', input: { path: 'b' } }]),
      { kind: 'tool_results', results: [
        { callId: 'c1', name: 'read', isError: false, content: [{ type: 'text', text: 'A' }] },
        { callId: 'c2', name: 'read', isError: true, content: [{ type: 'text', text: 'ENOENT' }] },
      ] },
      user('(steering) tap 8'),
      { kind: 'user', parts: [PNG] },
    ];
    const msgs = buildAnthropicMessages(items, 'claude-opus-5', true);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const last = msgs[2]!.content as Array<{ type: string }>;
    expect(last.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text', 'image']);
    expect(last[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'A' }] });
    expect(last[1]).toEqual({ type: 'tool_result', tool_use_id: 'c2', content: [{ type: 'text', text: 'ENOENT' }], is_error: true });
    expect(msgs[1]!.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } },
      { type: 'tool_use', id: 'c2', name: 'read', input: { path: 'b' } },
    ]);
  });

  it('keeps tool_result first even when a user item precedes the results', () => {
    const msgs = buildAnthropicMessages(
      [user('x'), { kind: 'tool_results', results: [{ callId: 'c', name: 't', isError: false, content: [{ type: 'text', text: 'r' }] }] }],
      'claude-opus-5',
      true,
    );
    expect(msgs).toHaveLength(1);
    expect((msgs[0]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('allows images inside tool_result content and handles empty results', () => {
    const msgs = buildAnthropicMessages(
      [
        user('x'),
        { kind: 'tool_results', results: [
          { callId: 'a', name: 'read', isError: false, content: [{ type: 'text', text: 'chart:' }, PNG] },
          { callId: 'b', name: 'write', isError: false, content: [] },
          { callId: 'c', name: 'bash', isError: true, content: [] },
        ] },
      ],
      'claude-opus-5',
      true,
    );
    const blocks = rec(msgs[0]!.content);
    expect(blocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'a',
      content: [
        { type: 'text', text: 'chart:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    });
    expect(blocks[1]).toEqual({ type: 'tool_result', tool_use_id: 'b' });
    expect(blocks[2]).toMatchObject({ type: 'tool_result', tool_use_id: 'c', is_error: true });
    expect((blocks[2]?.content as unknown[]).length).toBe(1);
  });

  it('skips empty user and assistant items', () => {
    const msgs = buildAnthropicMessages([user(''), user('hi'), assistant([]), assistant([{ type: 'text', text: '' }])], 'claude-opus-5', true);
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });
});

describe('anthropic messages: harness placement', () => {
  const sit: ConvItem = { kind: 'harness', text: '<situation>now: today</situation>' };

  it('uses a mid-conversation system message after a user message when the model supports it', () => {
    const msgs = buildAnthropicMessages([user('hi'), sit], 'claude-sonnet-5-5', true);
    expect(msgs).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: '<situation>now: today</situation>' },
    ]);
  });

  it('keeps it a system message when followed by an assistant turn (and after tool results)', () => {
    const items: ConvItem[] = [
      user('hi'),
      sit,
      assistant([{ type: 'tool_call', id: 'c', name: 't', input: {} }]),
      { kind: 'tool_results', results: [{ callId: 'c', name: 't', isError: false, content: [{ type: 'text', text: 'r' }] }] },
      { kind: 'harness', text: 'near the limit' },
      assistant([{ type: 'text', text: 'ok' }]),
    ];
    const msgs = buildAnthropicMessages(items, 'claude-sonnet-5-5', true);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user', 'system', 'assistant']);
  });

  it('merges consecutive harness items into one system message', () => {
    const msgs = buildAnthropicMessages([user('hi'), sit, { kind: 'harness', text: 'second' }], 'claude-sonnet-5-5', true);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ role: 'system', content: '<situation>now: today</situation>\n\nsecond' });
  });

  it('wraps in <harness> text when the model has no mid-conversation system support', () => {
    const msgs = buildAnthropicMessages([user('hi'), sit], 'claude-haiku-4-5', false);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'text', text: '<harness>\n<situation>now: today</situation>\n</harness>' },
        ],
      },
    ]);
  });

  it('wraps when the placement is invalid: first message, after an assistant turn, or followed by a user message', () => {
    // first
    let msgs = buildAnthropicMessages([sit, user('hi')], 'claude-sonnet-5-5', true);
    expect(msgs).toHaveLength(1);
    expect((msgs[0]!.content as Array<{ text?: string }>).map((b) => b.text)).toEqual(['<harness>\n<situation>now: today</situation>\n</harness>', 'hi']);

    // after an assistant turn (no user in between) and then a user message
    msgs = buildAnthropicMessages([user('a'), assistant([{ type: 'text', text: 'b' }]), sit, user('c')], 'claude-sonnet-5-5', true);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((msgs[2]!.content as Array<{ text?: string }>).map((b) => b.text)).toEqual(['<harness>\n<situation>now: today</situation>\n</harness>', 'c']);

    // trailing after an assistant turn: becomes its own user message
    msgs = buildAnthropicMessages([user('a'), assistant([{ type: 'text', text: 'b' }]), sit], 'claude-sonnet-5-5', true);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    // followed by another user message: appended to the previous user message, then merged
    msgs = buildAnthropicMessages([user('a'), sit, user('b')], 'claude-sonnet-5-5', true);
    expect(msgs).toHaveLength(1);
    expect((msgs[0]!.content as Array<{ text?: string }>).map((b) => b.text)).toEqual(['a', '<harness>\n<situation>now: today</situation>\n</harness>', 'b']);
  });

  it('puts a demoted harness after the tool_result blocks of the next user message', () => {
    const msgs = buildAnthropicMessages(
      [user('a'), assistant([{ type: 'tool_call', id: 'c', name: 't', input: {} }]), sit, { kind: 'tool_results', results: [{ callId: 'c', name: 't', isError: false, content: [{ type: 'text', text: 'r' }] }] }],
      'claude-sonnet-5-5',
      true,
    );
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((msgs[2]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(['tool_result', 'text']);
  });
});

describe('anthropic messages: assistant replay vs rebuild', () => {
  const raw = [
    { type: 'thinking', thinking: '', signature: 'SIG123' },
    { type: 'text', text: 'On it.', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.md' } },
  ];
  const item = assistant(
    [{ type: 'text', text: 'On it.' }, { type: 'tool_call', id: 'toolu_1', name: 'read', input: { path: 'a.md' } }],
    { raw },
  );
  const results: ConvItem = { kind: 'tool_results', results: [{ callId: 'toolu_1', name: 'read', isError: false, content: [{ type: 'text', text: 'x' }] }] };

  it('replays raw content blocks verbatim for the same provider and model [MOD-3]', () => {
    const msgs = buildAnthropicMessages([user('q'), item, results], 'claude-sonnet-5-5', true);
    expect(msgs[1]).toEqual({ role: 'assistant', content: raw });
    expect((msgs[1]!.content as unknown[])[0]).toBe(raw[0]); // same object: nothing was edited or re-serialised
  });

  it('rebuilds from parts (dropping thinking) for another model [MOD-3]', () => {
    const msgs = buildAnthropicMessages([user('q'), item, results], 'claude-opus-5-5', true);
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.md' } },
      ],
    });
    expect(JSON.stringify(msgs)).not.toContain('SIG123');
  });

  it('rebuilds for another provider even if raw is an array', () => {
    const foreign = { ...item, provider: 'openai', model: 'claude-sonnet-5-5' };
    const msgs = buildAnthropicMessages([user('q'), foreign, results], 'claude-sonnet-5-5', true);
    expect(JSON.stringify(msgs)).not.toContain('SIG123');
  });

  it('sanitises tool ids minted by other providers (consistently in tool_use and tool_result)', () => {
    const odd = assistant([{ type: 'tool_call', id: 'call_1|fc_2', name: 'read', input: {} }], { provider: 'openai', model: 'gpt-6.1-sol' });
    const msgs = buildAnthropicMessages(
      [user('q'), odd, { kind: 'tool_results', results: [{ callId: 'call_1|fc_2', name: 'read', isError: false, content: [{ type: 'text', text: 'x' }] }] }],
      'claude-sonnet-5-5',
      true,
    );
    expect((msgs[1]!.content as Array<{ id?: string }>)[0]?.id).toBe('call_1_fc_2');
    expect((msgs[2]!.content as Array<{ tool_use_id?: string }>)[0]?.tool_use_id).toBe('call_1_fc_2');
    // valid ids are untouched
    const ok = buildAnthropicMessages([user('q'), assistant([{ type: 'tool_call', id: 'toolu_01AbC-9_x', name: 'read', input: {} }], { provider: 'scripted' })], 'claude-sonnet-5-5', true);
    expect((ok[1]!.content as Array<{ id?: string }>)[0]?.id).toBe('toolu_01AbC-9_x');
  });

  it('rebuilds when there is no raw (e.g. scripted or other-provider history)', () => {
    const plain = assistant([{ type: 'text', text: 'hi' }, { type: 'tool_call', id: 't', name: 'x', input: 'not-an-object' }]);
    const msgs = buildAnthropicMessages([user('q'), plain], 'claude-sonnet-5-5', true);
    expect(msgs[1]!.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't', name: 'x', input: {} },
    ]);
  });
});

describe('anthropic request: cache breakpoints [COST-2]', () => {
  const countBreakpoints = (o: unknown): number => JSON.stringify(o).split('"cache_control"').length - 1;

  it('adds a moving breakpoint on the last block of the final user message', () => {
    const { params } = buildAnthropicRequest(
      req({
        system: [{ text: 'S', cache: true }],
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
        items: [
          user('first'),
          assistant([{ type: 'tool_call', id: 'c', name: 't', input: {} }]),
          { kind: 'tool_results', results: [{ callId: 'c', name: 't', isError: false, content: [{ type: 'text', text: 'r' }] }] },
          { kind: 'user', parts: [{ type: 'text', text: 'tail' }, PNG] },
        ],
      }),
      OPTS,
    );
    const last = params.messages.at(-1)!;
    const blocks = rec(last.content);
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'text', 'image']);
    expect(blocks.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1]?.cache_control).toBeUndefined();
    expect(countBreakpoints(params)).toBe(3); // system + last tool + moving tail
  });

  it('puts the breakpoint on the preceding user message when the request ends with a system message', () => {
    const { params } = buildAnthropicRequest(req({ items: [user('hello'), { kind: 'harness', text: '<situation>x</situation>' }] }), OPTS);
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(rec(params.messages[0]!.content)[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages[1]).toEqual({ role: 'system', content: '<situation>x</situation>' });
  });

  it('never exceeds 4 breakpoints and never mutates replayed raw blocks', () => {
    const raw = [{ type: 'text', text: 'old answer' }];
    const items: ConvItem[] = [user('q'), assistant([{ type: 'text', text: 'old answer' }], { raw }), user('next')];
    const { params } = buildAnthropicRequest(
      req({
        system: [
          { text: 'a', cache: true },
          { text: 'b', cache: true },
          { text: 'c', cache: true },
        ],
        tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
        items,
      }),
      OPTS,
    );
    expect(countBreakpoints(params)).toBe(4);
    expect(raw).toEqual([{ type: 'text', text: 'old answer' }]);
    expect(raw[0]).not.toHaveProperty('cache_control');
  });

  it('adds no breakpoint when the conversation ends with an assistant message', () => {
    const { params } = buildAnthropicRequest(req({ items: [user('q'), assistant([{ type: 'text', text: 'a' }])] }), OPTS);
    expect(countBreakpoints(params.messages)).toBe(0);
  });
});

// ------------------------------------------------------------------ stream parsing

const startEv = (usage: Record<string, number> = {}, model = 'claude-sonnet-5-5') =>
  ev({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
  });
const blockStart = (index: number, content_block: unknown) => ev({ type: 'content_block_start', index, content_block });
const delta = (index: number, d: unknown) => ev({ type: 'content_block_delta', index, delta: d });
const stop = (index: number) => ev({ type: 'content_block_stop', index });
const msgDelta = (stop_reason: string, usage: Record<string, unknown> = { output_tokens: 20 }, stop_details: unknown = null) =>
  ev({ type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details, container: null }, usage });
const msgStop = ev({ type: 'message_stop' });

const parse = (events: StreamEvent[], display: 'omitted' | 'summarized' | 'updates' = 'omitted') =>
  drain(parseAnthropicStream(fromArray(events), { model: 'claude-sonnet-5-5', display }));

describe('anthropic stream parsing', () => {
  it('streams text and reports usage, stop reason and the raw content array', async () => {
    const out = await parse([
      startEv({ input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }),
      blockStart(0, { type: 'text', text: '', citations: null }),
      delta(0, { type: 'text_delta', text: 'Hello ' }),
      delta(0, { type: 'text_delta', text: 'runner' }),
      stop(0),
      msgDelta('end_turn', { output_tokens: 42 }),
      msgStop,
    ]);
    expect(out.map((e) => e.type)).toEqual(['text_delta', 'text_delta', 'message_end']);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('end_turn');
    expect(end.usage).toEqual({ inputTokens: 100, cachedInputTokens: 5000, cacheWriteTokens: 300, outputTokens: 42 });
    expect(end.item).toMatchObject({ kind: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', parts: [{ type: 'text', text: 'Hello runner' }] });
    expect(end.item.raw).toEqual([{ type: 'text', text: 'Hello runner', citations: null }]);
  });

  it('turns display "updates" thinking blocks into progress notes [RT-9] and keeps them (with signatures) in raw', async () => {
    const events = [
      startEv(),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'Checking your last ' }),
      delta(0, { type: 'thinking_delta', thinking: 'three tempo runs.' }),
      delta(0, { type: 'signature_delta', signature: 'SIGABC' }),
      stop(0),
      blockStart(1, { type: 'thinking', thinking: '', signature: '' }),
      delta(1, { type: 'signature_delta', signature: 'SIG2' }),
      stop(1),
      blockStart(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: 'Done.' }),
      stop(2),
      msgDelta('end_turn'),
      msgStop,
    ];
    const upd = await parse(events, 'updates');
    expect(upd.filter((e) => e.type === 'progress')).toEqual([{ type: 'progress', text: 'Checking your last three tempo runs.' }]);
    const end = upd.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.item.raw).toEqual([
      { type: 'thinking', thinking: 'Checking your last three tempo runs.', signature: 'SIGABC' },
      { type: 'thinking', thinking: '', signature: 'SIG2' },
      { type: 'text', text: 'Done.' },
    ]);
    expect(end.item.parts).toEqual([{ type: 'text', text: 'Done.' }]);
    // summarized/omitted display: thinking text is reasoning, not progress
    expect((await parse(events, 'summarized')).some((e) => e.type === 'progress')).toBe(false);
  });

  it('streams tool_use input and ends the call with the parsed input', async () => {
    const out = await parse([
      startEv(),
      blockStart(0, { type: 'tool_use', id: 'toolu_9', name: 'send_message', input: {}, caller: { type: 'direct' } }),
      delta(0, { type: 'input_json_delta', partial_json: '{"text": "Nice ' }),
      delta(0, { type: 'input_json_delta', partial_json: 'work", "reply_to": "evt_1"}' }),
      stop(0),
      msgDelta('tool_use'),
      msgStop,
    ]);
    expect(out.map((e) => e.type)).toEqual(['tool_call_start', 'tool_input_delta', 'tool_input_delta', 'tool_call_end', 'message_end']);
    expect(out[0]).toEqual({ type: 'tool_call_start', id: 'toolu_9', name: 'send_message' });
    expect(out[3]).toEqual({ type: 'tool_call_end', id: 'toolu_9', name: 'send_message', input: { text: 'Nice work', reply_to: 'evt_1' } });
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('tool_use');
    expect(end.item.parts).toEqual([{ type: 'tool_call', id: 'toolu_9', name: 'send_message', input: { text: 'Nice work', reply_to: 'evt_1' } }]);
    expect(end.item.raw).toEqual([{ type: 'tool_use', id: 'toolu_9', name: 'send_message', input: { text: 'Nice work', reply_to: 'evt_1' }, caller: { type: 'direct' } }]);
  });

  it('treats a tool_use with no input deltas as {}', async () => {
    const out = await parse([startEv(), blockStart(0, { type: 'tool_use', id: 't', name: 'list_schedules', input: {} }), stop(0), msgDelta('tool_use'), msgStop]);
    expect(out.find((e) => e.type === 'tool_call_end')).toMatchObject({ input: {} });
  });

  it('reports non-JSON tool input with the invalid-input marker (eager streaming is unvalidated)', async () => {
    const out = await parse([
      startEv(),
      blockStart(0, { type: 'tool_use', id: 't', name: 'write', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"path": "a", "content": "x" oops' }),
      stop(0),
      msgDelta('tool_use'),
      msgStop,
    ]);
    const end = out.find((e) => e.type === 'tool_call_end');
    expect(end).toMatchObject({ id: 't', input: { __invalid_json: '{"path": "a", "content": "x" oops' } });
    expect((out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>).item.parts).toHaveLength(1);
  });

  it('drops a tool_use cut off by max_tokens (no end event, not in parts or raw)', async () => {
    const out = await parse([
      startEv(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Working on it' }),
      stop(0),
      blockStart(1, { type: 'tool_use', id: 'cut', name: 'write', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{"path": "a.md", "content": "long long lo' }),
      stop(1),
      msgDelta('max_tokens'),
      msgStop,
    ]);
    expect(out.some((e) => e.type === 'tool_call_end')).toBe(false);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('max_tokens');
    expect(end.item.parts).toEqual([{ type: 'text', text: 'Working on it' }]);
    expect(end.item.raw).toEqual([{ type: 'text', text: 'Working on it' }]);
    // the tool_call_start was streamed, so the loop knows a call was started and never finished
    expect(out.some((e) => e.type === 'tool_call_start')).toBe(true);
  });

  it('keeps a complete tool_use when max_tokens hits right after it', async () => {
    const out = await parse([
      startEv(),
      blockStart(0, { type: 'tool_use', id: 'ok', name: 'read', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"path": "a"}' }),
      stop(0),
      msgDelta('max_tokens'),
      msgStop,
    ]);
    expect(out.some((e) => e.type === 'tool_call_end')).toBe(true);
  });

  it('drops incomplete thinking blocks (no signature) from raw', async () => {
    const out = await parse([
      startEv(),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'half a thought' }),
      msgDelta('max_tokens'),
      msgStop,
    ]);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.item.raw).toEqual([]);
  });

  it('maps a refusal with its category', async () => {
    const out = await parse([startEv(), msgDelta('refusal', { output_tokens: 0 }, { type: 'refusal', category: 'cyber', explanation: null }), msgStop]);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.stopReason).toBe('refusal');
    expect(end.refusalCategory).toBe('cyber');
  });

  it('maps stop reasons', async () => {
    const reasons: Array<[string, string]> = [['stop_sequence', 'end_turn'], ['pause_turn', 'pause'], ['model_context_window_exceeded', 'other'], ['compaction', 'other']];
    for (const [from, to] of reasons) {
      const out = await parse([startEv(), msgDelta(from), msgStop]);
      expect((out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>).stopReason).toBe(to);
    }
  });

  it('after a server-side fallback: no raw, served model recorded, earlier tool calls dropped', async () => {
    const out = await parse([
      startEv(),
      blockStart(0, { type: 'tool_use', id: 'declined', name: 'read', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{}' }),
      stop(0),
      blockStart(1, { type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } }),
      stop(1),
      blockStart(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: 'Answered by the fallback.' }),
      stop(2),
      blockStart(3, { type: 'tool_use', id: 'kept', name: 'read', input: {} }),
      delta(3, { type: 'input_json_delta', partial_json: '{"path":"a"}' }),
      stop(3),
      msgDelta('tool_use'),
      msgStop,
    ]);
    const end = out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;
    expect(end.item.model).toBe('claude-opus-4-8');
    expect(end.item.raw).toBeUndefined();
    expect(end.item.parts).toEqual([
      { type: 'text', text: 'Answered by the fallback.' },
      { type: 'tool_call', id: 'kept', name: 'read', input: { path: 'a' } },
    ]);
  });

  it('updates usage from message_delta', async () => {
    const out = await parse([startEv({ input_tokens: 10 }), msgDelta('end_turn', { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 99, cache_creation_input_tokens: null }), msgStop]);
    expect((out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>).usage).toEqual({ inputTokens: 12, cachedInputTokens: 99, cacheWriteTokens: 0, outputTokens: 7 });
  });

  it('throws a retryable network error when the stream ends early', async () => {
    await expect(parse([startEv(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'hi' })])).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'network',
      retryable: true,
    });
  });
});

// ------------------------------------------------------------------ errors

describe('anthropic error mapping', () => {
  const gen = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
    Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers(headers));

  it('429 -> rate_limit, retryable, with retry-after', () => {
    const e = mapAnthropicError(gen(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' })) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: true, status: 429, retryAfterMs: 7000 });
    expect((mapAnthropicError(gen(429, 'rate_limit_error', 'x', { 'retry-after-ms': '1500' })) as ProviderError).retryAfterMs).toBe(1500);
  });

  it('529 / overloaded_error -> overloaded, retryable', () => {
    expect(mapAnthropicError(gen(529, 'overloaded_error', 'Overloaded'))).toMatchObject({ kind: 'overloaded', retryable: true });
  });

  it('5xx -> retryable', () => {
    expect(mapAnthropicError(gen(500, 'api_error', 'oops'))).toMatchObject({ retryable: true });
    expect(mapAnthropicError(gen(503, 'api_error', 'down'))).toMatchObject({ kind: 'overloaded', retryable: true });
  });

  it('mid-stream error events (no status) are classified from the body type', () => {
    const e = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', undefined, 'overloaded_error');
    expect(mapAnthropicError(e)).toMatchObject({ kind: 'overloaded', retryable: true });
  });

  it('400 -> invalid_request, unless the prompt is too long', () => {
    expect(mapAnthropicError(gen(400, 'invalid_request_error', 'messages.0: bad'))).toMatchObject({ kind: 'invalid_request', retryable: false, status: 400 });
    expect(mapAnthropicError(gen(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'))).toMatchObject({ kind: 'context_length', retryable: false });
  });

  it('401 / 403 -> auth, not retryable', () => {
    expect(mapAnthropicError(gen(401, 'authentication_error', 'invalid x-api-key'))).toMatchObject({ kind: 'auth', retryable: false });
    expect(mapAnthropicError(gen(403, 'permission_error', 'nope'))).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('connection problems -> network / timeout, retryable', () => {
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'ECONNRESET' }))).toMatchObject({ kind: 'network', retryable: true });
    expect(mapAnthropicError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('abort stays an AbortError', () => {
    const e = mapAnthropicError(new Anthropic.APIUserAbortError());
    expect(e).not.toBeInstanceOf(ProviderError);
    expect(e.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError).toBe(true);
  });

  it('plain objects with a status are classified too (fake clients)', () => {
    const e = Object.assign(new Error('rate limited'), { status: 429 });
    expect(mapAnthropicError(e)).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(mapAnthropicError(new Error('???'))).toMatchObject({ kind: 'unknown', retryable: false });
  });
});

// ------------------------------------------------------------------ provider + loop integration

function fakeClient(scripts: StreamEvent[][]): AnthropicClientLike & { bodies: unknown[]; signals: Array<AbortSignal | undefined> } {
  const bodies: unknown[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let n = 0;
  return {
    bodies,
    signals,
    beta: {
      messages: {
        async create(body, options) {
          bodies.push(JSON.parse(JSON.stringify(body)));
          signals.push(options?.signal);
          const events = scripts[n++] ?? scripts.at(-1)!;
          return fromArray(events);
        },
      },
    },
  };
}

describe('anthropic provider', () => {
  it('sends the built request and parses the stream', async () => {
    const client = fakeClient([[startEv(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'hey' }), stop(0), msgDelta('end_turn'), msgStop]]);
    const p = createAnthropicProvider({ apiKey: 'k', client });
    expect(p.id).toBe('anthropic');
    const ctrl = new AbortController();
    const out = await drain(p.stream(req({ system: [{ text: 'sys', cache: true }] }), ctrl.signal));
    expect(out.at(-1)).toMatchObject({ type: 'message_end', stopReason: 'end_turn' });
    expect(client.signals[0]).toBe(ctrl.signal);
    expect(client.bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, thinking: { type: 'adaptive', display: 'updates' }, fallbacks: 'default', betas: [BETA_THINKING_DISPLAY_UPDATES, BETA_SERVER_SIDE_FALLBACK] });
  });

  it('options control fallbacks, display and eager input streaming', async () => {
    const client = fakeClient([[startEv(), msgDelta('end_turn'), msgStop]]);
    const p = createAnthropicProvider({ apiKey: 'k', client, serverSideFallbacks: false, thinkingDisplay: 'summarized' });
    await drain(p.stream(req({ tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] })));
    const body = client.bodies[0] as Record<string, unknown>;
    expect(body.fallbacks).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect((body.tools as Array<Record<string, unknown>>)[0]?.eager_input_streaming).toBe(true);

    const proxied = createAnthropicProvider({ apiKey: 'k', client, baseUrl: 'https://proxy.example' });
    await drain(proxied.stream(req({ tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] })));
    expect((client.bodies[1] as { tools: Array<Record<string, unknown>> }).tools[0]).not.toHaveProperty('eager_input_streaming');
  });

  it('maps SDK errors thrown by the client to ProviderError', async () => {
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          async create() {
            throw Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 'x', new Headers({ 'retry-after': '3' }));
          },
        },
      },
    };
    const p = createAnthropicProvider({ apiKey: 'k', client });
    await expect(drain(p.stream(req()))).rejects.toMatchObject({ name: 'ProviderError', kind: 'rate_limit', retryAfterMs: 3000 });
  });

  it('throws AbortError when aborted', async () => {
    const ctrl = new AbortController();
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          async create() {
            ctrl.abort();
            throw new Anthropic.APIUserAbortError();
          },
        },
      },
    };
    const p = createAnthropicProvider({ apiKey: 'k', client });
    await expect(drain(p.stream(req(), ctrl.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('capabilities delegate to the model table', () => {
    const p = createAnthropicProvider({ apiKey: 'k', client: fakeClient([[]]) });
    expect(p.capabilities('claude-haiku-4-5').maxContextTokens).toBe(200_000);
  });
});

describe('anthropic provider inside the agent loop (preserved thinking across steps)', () => {
  it('replays the first response blocks verbatim on step 2, and rebuilds them for a different model', async () => {
    const step1 = [
      startEv(),
      blockStart(0, { type: 'thinking', thinking: '', signature: 'SIG-STEP1' }),
      stop(0),
      blockStart(1, { type: 'tool_use', id: 'toolu_a', name: 'echo', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{"n": 1}' }),
      stop(1),
      msgDelta('tool_use', { output_tokens: 30 }),
      msgStop,
    ];
    const step2 = [startEv(), blockStart(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'done' }), stop(0), msgDelta('end_turn'), msgStop];
    const client = fakeClient([step1, step2]);
    const provider = createAnthropicProvider({ apiKey: 'k', client });
    const tools = fakeTools({ echo: () => 'result' });
    const result = await createAgentLoop().runTurn(
      baseInput({ route: [resolved(provider, 'claude-sonnet-5-5')], tools, items: [user('go'), { kind: 'harness', text: '<situation>x</situation>' }] }),
    );
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toBe('done');
    const body2 = client.bodies[1] as { messages: Array<{ role: string; content: unknown }> };
    expect(body2.messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(body2.messages[2]?.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'SIG-STEP1' },
      { type: 'tool_use', id: 'toolu_a', name: 'echo', input: { n: 1 } },
    ]);
    // the system message from step 1 sits unchanged in front of the replayed assistant turn
    const body1 = client.bodies[0] as { messages: Array<{ role: string }> };
    expect(body1.messages.map((m) => m.role)).toEqual(['user', 'system']);

    // another model gets the rebuilt blocks, without the thinking block
    const msgs = buildAnthropicMessages([...result.newItems.slice(0, 2)], 'claude-opus-5-5', true);
    expect(JSON.stringify(msgs)).not.toContain('SIG-STEP1');
  });
});
