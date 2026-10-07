import { afterEach, describe, expect, it } from 'vitest';
import { VirtualClock, silentLogger, VoiceConfig, settle, type RealtimeVoiceProvider, type Store, type UsageRecord } from '@opencoach/protocol';
import { createDictationService, createOpenAIRealtimeProvider, type DictationBudget } from '../src';
import { FakeOpenAI } from './fake-openai';

const T0 = '2026-10-06T10:00:00.000Z';

describe('[COST-1] OpenAI transcription sessions for live dictation', () => {
  let server: FakeOpenAI | undefined;
  afterEach(async () => { await server?.stop(); server = undefined; });

  it('mints a transcription-only client secret with manual turns and no model replies or tools', async () => {
    server = await new FakeOpenAI().start();
    const provider = createOpenAIRealtimeProvider({ apiKey: 'sk-dictation', baseUrl: server.baseUrl });
    const connect = await provider.createTranscriptionSession!({ model: 'gpt-realtime-whisper', prompt: 'coach chat', delay: 'low' });
    expect(connect).toMatchObject({ type: 'openai-webrtc', callsUrl: `${server.baseUrl}/realtime/calls`, ephemeralKey: 'ek_test_123', model: 'gpt-realtime-whisper' });
    const req = server.requests.find((r) => r.url === '/v1/realtime/client_secrets')!;
    expect(req.headers.authorization).toBe('Bearer sk-dictation');
    expect(req.json).toEqual({
      expires_after: { anchor: 'created_at', seconds: 120 },
      session: {
        type: 'transcription',
        audio: { input: { transcription: { model: 'gpt-realtime-whisper', prompt: 'coach chat', delay: 'low' }, turn_detection: null, noise_reduction: { type: 'near_field' } } },
      },
    });
    // The athlete's real key is only ever sent server-to-provider.
    expect(JSON.stringify(connect)).not.toContain('sk-dictation');
  });
});

function harness(opts: { budget?: Partial<DictationBudget>; config?: Record<string, unknown>; provider?: RealtimeVoiceProvider | null } = {}) {
  const clock = new VirtualClock(T0);
  const usage: UsageRecord[] = [];
  const store = { recordUsage: async (u: UsageRecord) => { usage.push(u); } } as unknown as Store;
  const minted: unknown[] = [];
  const provider: RealtimeVoiceProvider = {
    id: 'openai',
    createSession: async () => { throw new Error('not used'); },
    attachSideband: async () => { throw new Error('not used'); },
    createTranscriptionSession: async (input) => { minted.push(input); return { type: 'openai-webrtc', callsUrl: 'https://x/realtime/calls', ephemeralKey: 'ek', expiresAt: T0, model: input.model }; },
  };
  const config = VoiceConfig.parse({ dictation: opts.config ?? {} }).dictation;
  const service = createDictationService({
    store, clock, logger: silentLogger, config, realtime: opts.provider === null ? undefined : opts.provider ?? provider,
    budget: async () => ({ dayUsd: 0, monthUsd: 0, dailyUsd: 2, monthlyUsd: 30, ...opts.budget }),
  });
  return { clock, usage, minted, service };
}

describe('[COST-1] live dictation service', () => {
  it('is unavailable without a provider that supports transcription sessions', async () => {
    const { service } = harness({ provider: null });
    expect(service.available()).toBe(false);
    await expect(service.start('ath_a')).rejects.toMatchObject({ reason: 'dictation_unavailable' });
    expect(harness({ config: { enabled: false } }).service.available()).toBe(false);
  });

  it('bills server-measured open time once, on end, at the configured rate', async () => {
    const { clock, usage, minted, service } = harness();
    const info = await service.start('ath_a');
    expect(info).toMatchObject({ model: 'gpt-realtime-whisper', maxDurationS: 300, connect: { ephemeralKey: 'ek' } });
    expect(info.sessionId).toMatch(/^dict_/);
    expect(minted).toEqual([expect.objectContaining({ model: 'gpt-realtime-whisper' })]);
    // gpt-realtime-whisper rejects a transcription prompt (HTTP 400), so dictation never sends one.
    expect(minted[0]).not.toHaveProperty('prompt');
    await clock.advanceBy(90_000);
    await service.end('ath_a', info.sessionId);
    await service.end('ath_a', info.sessionId); // idempotent
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ athleteId: 'ath_a', kind: 'stt', provider: 'openai', model: 'gpt-realtime-whisper' });
    expect(usage[0]!.costUsd).toBeCloseTo(1.5 * 0.017, 6);
  });

  it('caps billing at the session maximum and closes sessions the client never ends', async () => {
    const { clock, usage, service } = harness({ config: { maxDurationS: 60 } });
    await service.start('ath_a');
    await clock.advanceBy(60_000 + 31_000);
    await settle();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.costUsd).toBeCloseTo(0.017, 6);
  });

  it('keeps one open session per athlete, billing the replaced one, and scopes sessions to their athlete', async () => {
    const { clock, usage, service } = harness();
    const first = await service.start('ath_a');
    await clock.advanceBy(30_000);
    const second = await service.start('ath_a');
    expect(usage.map((u) => u.costUsd)).toEqual([expect.closeTo(0.0085, 6)]);
    await service.end('ath_b', second.sessionId); // another athlete cannot close (or bill) it
    expect(usage).toHaveLength(1);
    await expect(service.end('ath_a', 'not-a-session')).rejects.toMatchObject({ reason: 'dictation_not_found' });
    await service.end('ath_a', first.sessionId); // stale id: no-op
    await service.end('ath_a', second.sessionId);
    expect(usage).toHaveLength(2);
  });

  it('shortens sessions to the remaining budget and refuses when it is used up', async () => {
    const low = harness({ budget: { dayUsd: 1.99, dailyUsd: 2 } });
    expect((await low.service.start('ath_a')).maxDurationS).toBe(35); // $0.01 at $0.017/min
    const none = harness({ budget: { monthUsd: 30, monthlyUsd: 30 } });
    await expect(none.service.start('ath_a')).rejects.toMatchObject({ reason: 'budget_exhausted' });
  });

  it('limits new sessions per hour', async () => {
    const { clock, service } = harness({ config: { maxSessionsPerHour: 2 } });
    await service.start('ath_a');
    await service.start('ath_a');
    await expect(service.start('ath_a')).rejects.toMatchObject({ reason: 'dictation_rate_limited' });
    await clock.advanceBy(3600_000);
    await expect(service.start('ath_a')).resolves.toMatchObject({ model: 'gpt-realtime-whisper' });
  });
});
