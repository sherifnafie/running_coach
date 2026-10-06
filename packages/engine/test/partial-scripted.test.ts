import { describe, expect, it } from 'vitest';
import { ProviderError, type ModelStreamEvent } from '@opencoach/protocol';
import { createScriptedProvider, partialSendMessageText } from '../src';
import { drain, req, user } from './helpers';

describe('partialSendMessageText', () => {
  it('extracts text from incomplete send_message JSON', () => {
    expect(partialSendMessageText('{"text": "Nice wo')).toBe('Nice wo');
    expect(partialSendMessageText('{"text": "Nice work", "reply_to": "ev')).toBe('Nice work');
    expect(partialSendMessageText('{"text": "Nice work"}')).toBe('Nice work');
    expect(partialSendMessageText('{"reply_to": "evt_1", "text": "Hi th')).toBe('Hi th');
  });

  it('handles escapes and unicode', () => {
    expect(partialSendMessageText('{"text": "line one\\nline \\"two\\" and \\u00e9')).toBe('line one\nline "two" and é');
    expect(partialSendMessageText('{"text": "half an escape \\')).toMatch(/^half an escape/);
    expect(partialSendMessageText('{"text": "emoji \\ud83d')).toMatch(/^emoji/);
  });

  it('returns undefined when there is no text string yet', () => {
    expect(partialSendMessageText('')).toBeUndefined();
    expect(partialSendMessageText('   ')).toBeUndefined();
    expect(partialSendMessageText('{')).toBeUndefined();
    expect(partialSendMessageText('{"te')).toBeUndefined();
    expect(partialSendMessageText('{"text":')).toBeUndefined();
    expect(partialSendMessageText('{"reply_to": "evt_1"}')).toBeUndefined();
    expect(partialSendMessageText('{"text": 5}')).toBeUndefined();
    expect(partialSendMessageText('[1,2')).toBeUndefined();
    expect(partialSendMessageText('"just a string')).toBeUndefined();
  });

  it('never throws on garbage', () => {
    for (const s of ['}{', 'not json', '{"text": "x" "y"', '\u0000', '{"text": tru', 'null', '12']) {
      expect(() => partialSendMessageText(s)).not.toThrow();
    }
    expect(partialSendMessageText(undefined as unknown as string)).toBeUndefined();
  });

  it('streams progressively', () => {
    const full = '{"text": "Great tempo run today! Let us talk recovery.", "reply_to": "evt_9"}';
    let prev = '';
    for (let i = 1; i <= full.length; i++) {
      const t = partialSendMessageText(full.slice(0, i));
      if (t !== undefined) {
        expect(t.startsWith(prev)).toBe(true);
        prev = t;
      }
    }
    expect(prev).toBe('Great tempo run today! Let us talk recovery.');
  });
});

describe('scripted provider', () => {
  const run = (p: ReturnType<typeof createScriptedProvider>, model = 'm') => drain(p.stream(req({ model })));
  const endOf = (out: ModelStreamEvent[]) => out.at(-1) as Extract<ModelStreamEvent, { type: 'message_end' }>;

  it('streams chunked text, then message_end with defaults', async () => {
    const p = createScriptedProvider({ handler: [{ text: 'Hello there, this is a somewhat longer scripted reply.' }] });
    const out = await run(p, 'scripted-1');
    const texts = out.filter((e) => e.type === 'text_delta');
    expect(texts.length).toBeGreaterThan(2);
    expect(texts.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toBe('Hello there, this is a somewhat longer scripted reply.');
    const end = endOf(out);
    expect(end.stopReason).toBe('end_turn');
    expect(end.item).toEqual({ kind: 'assistant', parts: [{ type: 'text', text: 'Hello there, this is a somewhat longer scripted reply.' }], provider: 'scripted', model: 'scripted-1' });
    expect(end.usage.inputTokens).toBeGreaterThan(0);
    expect(end.usage.outputTokens).toBeGreaterThan(0);
    expect(end.usage.cachedInputTokens).toBe(0);
  });

  it('streams tool calls with chunked JSON and ids toolu_s<n>', async () => {
    const p = createScriptedProvider({
      handler: [
        { toolCalls: [{ name: 'write', input: { path: 'journal/2026-10-07.md', content: 'x'.repeat(40) } }, { name: 'read', input: { path: 'a' }, id: 'mine' }] },
        { toolCalls: [{ name: 'read', input: {} }] },
      ],
    });
    const out = await run(p);
    expect(out.filter((e) => e.type === 'tool_call_start')).toEqual([
      { type: 'tool_call_start', id: 'toolu_s1', name: 'write' },
      { type: 'tool_call_start', id: 'mine', name: 'read' },
    ]);
    const deltas = out.filter((e) => e.type === 'tool_input_delta' && e.id === 'toolu_s1');
    expect(deltas.length).toBeGreaterThan(1);
    expect(JSON.parse(deltas.map((d) => (d.type === 'tool_input_delta' ? d.partialJson : '')).join(''))).toEqual({ path: 'journal/2026-10-07.md', content: 'x'.repeat(40) });
    expect(out.filter((e) => e.type === 'tool_call_end').map((e) => (e.type === 'tool_call_end' ? e.id : ''))).toEqual(['toolu_s1', 'mine']);
    expect(endOf(out).stopReason).toBe('tool_use');
    // ids keep counting across calls on the same provider
    const second = await run(p);
    expect(second.find((e) => e.type === 'tool_call_start')).toMatchObject({ id: 'toolu_s2' });
  });

  it('emits progress first, honours usage overrides and records requests', async () => {
    const p = createScriptedProvider({ handler: [{ progress: ['Looking at splits'], text: 'x', usage: { inputTokens: 5, cachedInputTokens: 4, outputTokens: 3, cacheWriteTokens: 2 } }] });
    const out = await drain(p.stream(req({ items: [user('a')] })));
    expect(out[0]).toEqual({ type: 'progress', text: 'Looking at splits' });
    expect(endOf(out).usage).toEqual({ inputTokens: 5, cachedInputTokens: 4, cacheWriteTokens: 2, outputTokens: 3 });
    expect(endOf(out).item.reasoningSummary).toBe('Looking at splits');
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]?.items).toHaveLength(1);
  });

  it('accepts a handler function (sync or async) with a 0-based call index', async () => {
    const seen: number[] = [];
    const p = createScriptedProvider({
      handler: async (r, { call }) => {
        seen.push(call);
        return { text: `call ${call} saw ${r.items.length} items` };
      },
    });
    const a = await drain(p.stream(req({ items: [user('1')] })));
    const b = await drain(p.stream(req({ items: [user('1'), user('2')] })));
    expect(seen).toEqual([0, 1]);
    expect(endOf(a).item.parts).toEqual([{ type: 'text', text: 'call 0 saw 1 items' }]);
    expect(endOf(b).item.parts).toEqual([{ type: 'text', text: 'call 1 saw 2 items' }]);
  });

  it('repeats an empty step once the queue is exhausted', async () => {
    const p = createScriptedProvider({ handler: [{ text: 'only' }] });
    await run(p);
    const out = await run(p);
    expect(endOf(out).item.parts).toEqual([]);
    expect(endOf(out).stopReason).toBe('end_turn');
  });

  it('throws ProviderError for injected failures', async () => {
    const kinds = ['rate_limit', 'overloaded', 'network', 'invalid_request'] as const;
    for (const kind of kinds) {
      const p = createScriptedProvider({ handler: [{ fail: { kind, message: `boom ${kind}` }, retryAfterMs: 1500 }] });
      const err = await run(p).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind, message: `boom ${kind}`, retryable: kind !== 'invalid_request' });
      if (kind === 'rate_limit') expect(err).toMatchObject({ retryAfterMs: 1500, status: 429 });
    }
    const p = createScriptedProvider({ handler: [{ fail: { kind: 'network' } }] });
    expect(await run(p).catch((e: ProviderError) => e.message)).toMatch(/network/);
    expect(p.requests).toHaveLength(1); // failed requests are recorded too
  });

  it('supports refusal and max_tokens stop reasons', async () => {
    const p = createScriptedProvider({ handler: [{ stopReason: 'refusal', refusalCategory: 'bio' }, { stopReason: 'refusal' }, { text: 'cut', stopReason: 'max_tokens' }] });
    expect(endOf(await run(p))).toMatchObject({ stopReason: 'refusal', refusalCategory: 'bio' });
    expect(endOf(await run(p))).toMatchObject({ refusalCategory: 'scripted' });
    expect(endOf(await run(p)).stopReason).toBe('max_tokens');
  });

  it('has default capabilities and accepts overrides', () => {
    const p = createScriptedProvider({ handler: [] });
    expect(p.id).toBe('scripted');
    expect(p.capabilities('x')).toMatchObject({ vision: true, maxContextTokens: 200_000, midConversationSystem: true });
    const q = createScriptedProvider({ id: 'other', handler: [], capabilities: { vision: false, maxContextTokens: 8000 } });
    expect(q.id).toBe('other');
    expect(q.capabilities('x')).toMatchObject({ vision: false, maxContextTokens: 8000, midConversationSystem: true });
  });

  it('stops when aborted', async () => {
    const ctrl = new AbortController();
    const p = createScriptedProvider({ handler: [{ text: 'a b c d e f g h i j k l m n o p' }] });
    const err = await (async () => {
      try {
        for await (const e of p.stream(req(), ctrl.signal)) {
          if (e.type === 'text_delta') ctrl.abort();
        }
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.name).toBe('AbortError');
  });
});
