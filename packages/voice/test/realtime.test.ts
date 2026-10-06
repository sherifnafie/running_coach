import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, VirtualClock, settle, toToolJsonSchema, ToolInputs, type RealtimeSideband, type RealtimeSidebandHandlers, type ToolSpec, type VoiceTranscriptEntry } from '@opencoach/protocol';
import { createOpenAIRealtimeProvider, voiceToolSpecs } from '../src';
import { FakeOpenAI, type FakeWsConn } from './fake-openai';

const T0 = '2026-10-06T10:00:00.000Z';

const tools: ToolSpec[] = [
  { name: 'lookup', description: 'Look things up', inputSchema: toToolJsonSchema(ToolInputs.lookup) },
  { name: 'note', description: 'Take a note', inputSchema: toToolJsonSchema(ToolInputs.note) },
];

describe('createOpenAIRealtimeProvider.createSession', () => {
  let server: FakeOpenAI;
  afterEach(async () => {
    await server.stop();
  });

  it('POSTs the session config to /realtime/client_secrets and maps the response to RealtimeClientConnect', async () => {
    server = await new FakeOpenAI().start();
    const provider = createOpenAIRealtimeProvider({ apiKey: 'sk-realtime', baseUrl: server.baseUrl });
    expect(provider.id).toBe('openai');

    const connect = await provider.createSession({ instructions: 'You are the voice of Coach.', tools, voice: 'marin', model: 'gpt-realtime-2.1' });

    expect(connect).toEqual({
      type: 'openai-webrtc',
      callsUrl: `${server.baseUrl}/realtime/calls`,
      ephemeralKey: 'ek_test_123',
      expiresAt: new Date(1_790_000_000 * 1000).toISOString(),
      model: 'gpt-realtime-2.1',
    });

    const req = server.requests.find((r) => r.url === '/v1/realtime/client_secrets')!;
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer sk-realtime');
    expect(req.headers['content-type']).toContain('application/json');
    expect(req.json).toEqual({
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        instructions: 'You are the voice of Coach.',
        audio: {
          input: { transcription: { model: 'gpt-realtime-whisper' }, turn_detection: { type: 'semantic_vad' } },
          output: { voice: 'marin' },
        },
        tools: [
          { type: 'function', name: 'lookup', description: 'Look things up', parameters: toToolJsonSchema(ToolInputs.lookup) },
          { type: 'function', name: 'note', description: 'Take a note', parameters: toToolJsonSchema(ToolInputs.note) },
        ],
        tool_choice: 'auto',
      },
    });
  });

  it('tolerates the nested { client_secret: { value, expires_at } } shape, ISO expiry and a trailing slash in baseUrl', async () => {
    server = await new FakeOpenAI({ clientSecret: { client_secret: { value: 'ek_nested', expires_at: '2026-10-06T10:01:00Z' } } }).start();
    const provider = createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: `${server.baseUrl}/` });
    const connect = await provider.createSession({ instructions: 'x', tools: [], voice: 'alloy', model: 'm' });
    expect(connect.ephemeralKey).toBe('ek_nested');
    expect(connect.expiresAt).toBe('2026-10-06T10:01:00.000Z');
    expect(connect.callsUrl).toBe(`${server.baseUrl}/realtime/calls`);
  });

  it('uses the clock for a missing expiry', async () => {
    server = await new FakeOpenAI({ clientSecret: { value: 'ek' } }).start();
    const clock = new VirtualClock(T0);
    const provider = createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: server.baseUrl, clock });
    const connect = await provider.createSession({ instructions: 'x', tools: [], voice: 'alloy', model: 'm' });
    expect(connect.expiresAt).toBe('2026-10-06T10:01:00.000Z');
  });

  it('throws ProviderError on HTTP errors and on a response without a secret', async () => {
    server = await new FakeOpenAI({ failWith: { '/v1/realtime/client_secrets': 401 } }).start();
    const provider = createOpenAIRealtimeProvider({ apiKey: 'bad', baseUrl: server.baseUrl });
    const err = (await provider.createSession({ instructions: 'x', tools: [], voice: 'alloy', model: 'm' }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('auth');
    await server.stop();

    server = await new FakeOpenAI({ clientSecret: { nothing: true } }).start();
    const p2 = createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: server.baseUrl });
    await expect(p2.createSession({ instructions: 'x', tools: [], voice: 'alloy', model: 'm' })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('voiceToolSpecs', () => {
  it('exposes the four voice tools with descriptions and object schemas', () => {
    const specs = voiceToolSpecs();
    expect(specs.map((s) => s.name)).toEqual(['lookup', 'consult_coach', 'note', 'end_call']);
    for (const s of specs) {
      expect(s.description.length).toBeGreaterThan(40);
      expect(s.inputSchema.type).toBe('object');
      expect(s.inputSchema).not.toHaveProperty('$schema');
    }
    expect((specs[1]!.inputSchema as { required: string[] }).required).toEqual(['question']);
  });
});

/** Handlers that record everything. */
function recorder(over: Partial<RealtimeSidebandHandlers> = {}) {
  const transcripts: VoiceTranscriptEntry[] = [];
  const ends: Array<{ reason: string; detail?: string }> = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  const handlers: RealtimeSidebandHandlers = {
    onToolCall: async (c) => {
      toolCalls.push(c);
      return { echoed: c.arguments };
    },
    onTranscript: (e) => transcripts.push(e),
    onEnd: (reason, detail) => ends.push({ reason, detail }),
    ...over,
  };
  return { handlers, transcripts, ends, toolCalls };
}

describe('OpenAI sideband', () => {
  let server: FakeOpenAI;
  let clock: VirtualClock;
  let conn: FakeWsConn;
  let sb: RealtimeSideband;
  let rec: ReturnType<typeof recorder>;

  async function attach(over: Partial<RealtimeSidebandHandlers> = {}, opts: { graceMs?: number } = {}) {
    rec = recorder(over);
    const provider = createOpenAIRealtimeProvider({ apiKey: 'sk-side', baseUrl: server.baseUrl, clock, responseDoneGraceMs: opts.graceMs });
    sb = await provider.attachSideband({ providerCallId: 'rtc_abc123', model: 'gpt-realtime-2.1', handlers: rec.handlers });
    conn = await server.nextConnection();
  }

  beforeEach(async () => {
    server = await new FakeOpenAI().start();
    clock = new VirtualClock(T0);
  });
  afterEach(async () => {
    await sb?.close().catch(() => {});
    await server.stop();
  });

  it('connects to /realtime?call_id=<id> with the bearer key (http→ws)', async () => {
    await attach();
    expect(conn.url).toBe('/v1/realtime?call_id=rtc_abc123');
    expect(conn.headers.authorization).toBe('Bearer sk-side');
  });

  it('rejects with ProviderError when the handshake is refused or the server is down', async () => {
    await server.stop();
    server = await new FakeOpenAI({ rejectUpgrade: 401 }).start();
    const provider = createOpenAIRealtimeProvider({ apiKey: 'bad', baseUrl: server.baseUrl });
    const err = (await provider.attachSideband({ providerCallId: 'x', model: 'm', handlers: recorder().handlers }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);

    const dead = createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1' });
    const err2 = await dead.attachSideband({ providerCallId: 'x', model: 'm', handlers: recorder().handlers }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ProviderError);
  });

  it('round-trips a tool call: onToolCall → function_call_output, then response.create once the response is done', async () => {
    await attach();
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'call_1', name: 'lookup', arguments: '{"query":"thursday long run"}', response_id: 'resp_1', item_id: 'item_1' });

    const output = await conn.waitFor((m) => m.type === 'conversation.item.create');
    expect(rec.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: { query: 'thursday long run' } }]);
    expect(output).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ echoed: { query: 'thursday long run' } }) },
    });

    // The response that issued the call is still active: response.create must wait for response.done.
    await settle();
    expect(conn.received.some((m) => m.type === 'response.create')).toBe(false);
    conn.send({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
    await conn.waitFor((m) => m.type === 'response.create');
    expect(conn.received.map((m) => m.type)).toEqual(['conversation.item.create', 'response.create']);
  });

  it('sends response.create right away when the response already finished, or the event has no response_id', async () => {
    await attach();
    conn.send({ type: 'response.done', response: { id: 'resp_early' } });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'call_a', name: 'note', arguments: '{"text":"x"}', response_id: 'resp_early' });
    await conn.waitFor((m) => m.type === 'response.create');

    const from = conn.received.length;
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'call_b', name: 'note', arguments: '{"text":"y"}' });
    await conn.waitFor((m) => m.type === 'response.create', from);
    expect(conn.received.slice(from).map((m) => m.type)).toEqual(['conversation.item.create', 'response.create']);
  });

  it('answers parallel calls of one response with a single response.create after all outputs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await attach({
      onToolCall: async (c) => {
        if (c.name === 'lookup') await gate;
        return { name: c.name };
      },
    });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'lookup', arguments: '{"query":"q"}', response_id: 'r1' });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'c2', name: 'note', arguments: '{"text":"t"}', response_id: 'r1' });
    conn.send({ type: 'response.done', response: { id: 'r1' } });
    await conn.waitFor((m) => m.type === 'conversation.item.create' && m.item.call_id === 'c2');
    await settle();
    expect(conn.received.some((m) => m.type === 'response.create')).toBe(false);
    release();
    await conn.waitFor((m) => m.type === 'response.create');
    const types = conn.received.map((m) => (m.type === 'conversation.item.create' ? `output:${m.item.call_id}` : m.type));
    expect(types).toEqual(['output:c2', 'output:c1', 'response.create']);
  });

  it('falls back to response.create after a grace period if response.done never arrives (clock-driven)', async () => {
    await attach({}, { graceMs: 2000 });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'note', arguments: '{"text":"t"}', response_id: 'r_never_done' });
    await conn.waitFor((m) => m.type === 'conversation.item.create');
    await settle();
    expect(conn.received.some((m) => m.type === 'response.create')).toBe(false);
    await clock.advanceBy(2000);
    await conn.waitFor((m) => m.type === 'response.create');
  });

  it('reports handler failures and malformed arguments to the model instead of crashing', async () => {
    await attach({
      onToolCall: async (c) => {
        if (c.name === 'boom') throw new Error('workspace unavailable');
        return { ok: true };
      },
    });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'boom', arguments: '{}' });
    const out1 = await conn.waitFor((m) => m.type === 'conversation.item.create' && m.item.call_id === 'c1');
    expect(JSON.parse(out1.item.output)).toEqual({ error: 'workspace unavailable' });

    let called = false;
    sb = await createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: server.baseUrl, clock }).attachSideband({
      providerCallId: 'rtc_2',
      model: 'm',
      handlers: recorder({ onToolCall: async () => ((called = true), {}) }).handlers,
    });
    const conn2 = server.connections[1]!;
    conn2.send({ type: 'response.function_call_arguments.done', call_id: 'bad', name: 'note', arguments: '{not json' });
    const out2 = await conn2.waitFor((m) => m.type === 'conversation.item.create');
    expect(called).toBe(false);
    expect(JSON.parse(out2.item.output).error).toMatch(/invalid_arguments/);
    await sb.close();
  });

  it('does not run the same call twice if the event is repeated', async () => {
    await attach();
    const ev = { type: 'response.function_call_arguments.done', call_id: 'dup', name: 'note', arguments: '{"text":"t"}' };
    conn.send(ev);
    conn.send(ev);
    await conn.waitFor((m) => m.type === 'response.create');
    await settle();
    expect(rec.toolCalls).toHaveLength(1);
    expect(conn.received.filter((m) => m.type === 'conversation.item.create')).toHaveLength(1);
  });

  it('emits transcripts for both roles, including the beta alias, and ignores empty ones', async () => {
    await attach();
    conn.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: ' How was my tempo? ' });
    await expect.poll(() => rec.transcripts.length).toBe(1);
    await clock.advanceBy(1000);
    conn.send({ type: 'response.output_audio_transcript.done', transcript: 'It looked strong.' });
    await expect.poll(() => rec.transcripts.length).toBe(2);
    await clock.advanceBy(1000);
    conn.send({ type: 'response.audio_transcript.done', transcript: 'Keep it easy tomorrow.' });
    conn.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i2', transcript: '   ' });
    conn.send({ type: 'response.output_audio_transcript.done', transcript: '' });
    conn.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i3', transcript: 'Thanks!' });
    await expect.poll(() => rec.transcripts.length).toBe(4);
    await settle(5);
    expect(rec.transcripts).toEqual([
      { role: 'athlete', text: 'How was my tempo?', at: '2026-10-06T10:00:00.000Z' },
      { role: 'coach', text: 'It looked strong.', at: '2026-10-06T10:00:01.000Z' },
      { role: 'coach', text: 'Keep it easy tomorrow.', at: '2026-10-06T10:00:02.000Z' },
      { role: 'athlete', text: 'Thanks!', at: '2026-10-06T10:00:02.000Z' },
    ]);
  });

  it('timestamps a late athlete transcript with when the athlete stopped speaking', async () => {
    await attach();
    conn.send({ type: 'input_audio_buffer.speech_stopped', item_id: 'i9', audio_end_ms: 1200 });
    // frames are handled in order, so once this one is seen the speech_stopped has been recorded
    conn.send({ type: 'response.output_audio_transcript.done', transcript: 'Sure, one moment.' });
    await expect.poll(() => rec.transcripts.length).toBe(1);
    await clock.advanceBy(3000);
    conn.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i9', transcript: 'Can we move Thursday?' });
    await expect.poll(() => rec.transcripts.length).toBe(2);
    expect(rec.transcripts[1]).toEqual({ role: 'athlete', text: 'Can we move Thursday?', at: '2026-10-06T10:00:00.000Z' });
  });

  it('logs error events without ending the session', async () => {
    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, data?: Record<string, unknown>) => logs.push({ msg, data }),
      child: () => logger,
    };
    rec = recorder();
    sb = await createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: server.baseUrl, clock, logger }).attachSideband({ providerCallId: 'x', model: 'm', handlers: rec.handlers });
    conn = await server.nextConnection();
    conn.send({ type: 'error', error: { type: 'invalid_request_error', code: 'bad_thing', message: 'nope' } });
    await settle(5);
    expect(logs.some((l) => l.data?.code === 'bad_thing' && l.data?.message === 'nope')).toBe(true);
    expect(rec.ends).toEqual([]);
  });

  it('updateInstructions and say send session.update / response.create', async () => {
    await attach();
    await sb.updateInstructions('New briefing');
    await sb.say('Your coach suggests an easy day.');
    await conn.waitFor((m) => m.type === 'response.create');
    expect(conn.received).toEqual([
      { type: 'session.update', session: { type: 'realtime', instructions: 'New briefing' } },
      { type: 'response.create', response: { instructions: 'Say this to the athlete naturally, in your own voice: Your coach suggests an easy day.' } },
    ]);
  });

  it("a provider-side close reports onEnd('athlete') exactly once", async () => {
    await attach();
    conn.socket.close(1000, 'bye');
    await expect.poll(() => rec.ends.length).toBe(1);
    expect(rec.ends[0]!.reason).toBe('athlete');
    await sb.close(); // no second onEnd
    expect(rec.ends).toHaveLength(1);
  });

  it("close() reports 'coach' once; close with a reason reports it; later provider close adds nothing", async () => {
    await attach();
    await Promise.all([sb.close(), sb.close()]);
    expect(rec.ends.map((e) => e.reason)).toEqual(['coach']);
    await expect(sb.say('too late')).rejects.toThrow(/closed/);

    // timeout reason (OpenAISideband accepts an optional reason)
    const provider = createOpenAIRealtimeProvider({ apiKey: 'k', baseUrl: server.baseUrl, clock });
    const r2 = recorder();
    const sb2 = await provider.attachSideband({ providerCallId: 'y', model: 'm', handlers: r2.handlers });
    await (sb2 as unknown as { close(reason: 'timeout'): Promise<void> }).close('timeout');
    expect(r2.ends.map((e) => e.reason)).toEqual(['timeout']);
  });

  it('pending tool results after close are dropped quietly', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await attach({ onToolCall: async () => (await gate, { late: true }) });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'late', name: 'lookup', arguments: '{"query":"x"}' });
    await settle(5);
    await sb.close();
    release();
    await settle(5);
    expect(conn.received.some((m) => m.type === 'conversation.item.create')).toBe(false);
  });
});
