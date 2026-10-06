import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, VoiceConfig } from '@opencoach/protocol';
import { audioExtension, createSynthesizer, createTranscriber } from '../src';
import { FakeOpenAI } from './fake-openai';

const cfg = VoiceConfig.parse({});

describe('createTranscriber [voice notes, SPEC §10.4]', () => {
  let server: FakeOpenAI;
  beforeEach(async () => {
    server = await new FakeOpenAI().start();
  });
  afterEach(async () => {
    await server.stop();
    vi.unstubAllEnvs();
  });

  it('returns undefined for provider none and for openai without a key', () => {
    expect(createTranscriber({ ...cfg.stt, provider: 'none' }, 'sk-x')).toBeUndefined();
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(createTranscriber({ ...cfg.stt, provider: 'openai' }, undefined)).toBeUndefined();
    expect(createTranscriber({ ...cfg.stt, provider: 'openai', apiKeyEnv: 'NOPE_NOT_SET' }, undefined)).toBeUndefined();
  });

  it('openai-compatible needs a baseUrl but no key', () => {
    expect(createTranscriber({ ...cfg.stt, provider: 'openai-compatible' }, undefined)).toBeUndefined();
    expect(createTranscriber({ ...cfg.stt, provider: 'openai-compatible', baseUrl: server.baseUrl }, undefined)).toBeDefined();
  });

  it('posts multipart audio with the configured model and returns text, model and duration', async () => {
    const t = createTranscriber({ ...cfg.stt, provider: 'openai', baseUrl: server.baseUrl, model: 'gpt-4o-transcribe' }, 'sk-test')!;
    expect(t).toBeDefined();
    const audio = new Uint8Array([9, 8, 7, 6, 5]);
    const res = await t.transcribe(audio, 'audio/webm;codecs=opus', { language: 'en', prompt: 'parkrun, tempo' });
    expect(res).toEqual({ text: 'hello coach', model: 'gpt-4o-transcribe', durationS: 3 });

    const req = server.requests.find((r) => r.url === '/v1/audio/transcriptions')!;
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.form!.fields.model).toBe('gpt-4o-transcribe');
    expect(req.form!.fields.language).toBe('en');
    expect(req.form!.fields.prompt).toBe('parkrun, tempo');
    const file = req.form!.files[0]!;
    expect(file.field).toBe('file');
    expect(file.filename).toBe('audio.webm');
    expect(file.contentType).toBe('audio/webm;codecs=opus');
    expect([...file.bytes]).toEqual([9, 8, 7, 6, 5]);
  });

  it('reads the key from process.env[apiKeyEnv] and works against a compatible server', async () => {
    vi.stubEnv('FASTER_WHISPER_KEY', 'local-key');
    const t = createTranscriber({ provider: 'openai-compatible', model: 'whisper-large-v3', baseUrl: server.baseUrl, apiKeyEnv: 'FASTER_WHISPER_KEY' }, undefined)!;
    expect(t.id).toBe('openai-compatible');
    const res = await t.transcribe(new Uint8Array([1]), 'audio/mp4');
    expect(res.model).toBe('whisper-large-v3');
    const req = server.requests.at(-1)!;
    expect(req.headers.authorization).toBe('Bearer local-key');
    expect(req.form!.files[0]!.filename).toBe('audio.m4a');
  });

  it('handles verbose_json style durations and missing duration', async () => {
    await server.stop();
    server = await new FakeOpenAI({ transcription: { text: 'x', duration: 12.5 } }).start();
    const t = createTranscriber({ ...cfg.stt, baseUrl: server.baseUrl }, 'k')!;
    expect((await t.transcribe(new Uint8Array([1]), 'audio/wav')).durationS).toBe(12.5);
    await server.stop();
    server = await new FakeOpenAI({ transcription: { text: 'plain' } }).start();
    const t2 = createTranscriber({ ...cfg.stt, baseUrl: server.baseUrl }, 'k')!;
    const r = await t2.transcribe(new Uint8Array([1]), 'audio/wav');
    expect(r).toEqual({ text: 'plain', model: 'gpt-4o-transcribe' });
    expect('durationS' in r).toBe(false);
  });

  it('maps HTTP failures to ProviderError', async () => {
    await server.stop();
    server = await new FakeOpenAI({ failWith: { '/v1/audio/transcriptions': 401 } }).start();
    const t = createTranscriber({ ...cfg.stt, baseUrl: server.baseUrl }, 'bad')!;
    const err = await t.transcribe(new Uint8Array([1]), 'audio/webm').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('auth');
  });
});

describe('audioExtension', () => {
  it('maps common recorder mime types', () => {
    expect(audioExtension('audio/webm')).toBe('webm');
    expect(audioExtension('audio/ogg; codecs=opus')).toBe('ogg');
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/x-m4a')).toBe('m4a');
    expect(audioExtension('audio/wav')).toBe('wav');
    expect(audioExtension('application/octet-stream')).toBe('webm');
  });
});

describe('createSynthesizer', () => {
  let server: FakeOpenAI;
  beforeEach(async () => {
    server = await new FakeOpenAI({ speech: Buffer.from([10, 20, 30]) }).start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it('returns undefined for provider none / missing key', () => {
    expect(createSynthesizer({ ...cfg.tts, provider: 'none' }, 'k')).toBeUndefined();
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(createSynthesizer({ ...cfg.tts, provider: 'openai' }, undefined)).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('sends model, voice, input, response_format and instructions; defaults to mp3', async () => {
    const s = createSynthesizer({ ...cfg.tts, baseUrl: server.baseUrl, model: 'gpt-4o-mini-tts' }, 'sk-tts')!;
    const out = await s.synthesize('Nice work today.', { voice: 'marin', instructions: 'Warm, brief.' });
    expect(out.mime).toBe('audio/mpeg');
    expect(out.model).toBe('gpt-4o-mini-tts');
    expect([...out.audio]).toEqual([10, 20, 30]);
    const req = server.requests.find((r) => r.url === '/v1/audio/speech')!;
    expect(req.headers.authorization).toBe('Bearer sk-tts');
    expect(req.json).toEqual({ model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Nice work today.', response_format: 'mp3', instructions: 'Warm, brief.' });
  });

  it('maps formats to mime types and omits instructions when absent', async () => {
    const s = createSynthesizer({ ...cfg.tts, baseUrl: server.baseUrl }, 'k')!;
    expect((await s.synthesize('a', { voice: 'alloy', format: 'opus' })).mime).toBe('audio/ogg');
    expect((await s.synthesize('a', { voice: 'alloy', format: 'wav' })).mime).toBe('audio/wav');
    const bodies = server.requests.filter((r) => r.url === '/v1/audio/speech').map((r) => r.json);
    expect(bodies.map((b) => b.response_format)).toEqual(['opus', 'wav']);
    expect('instructions' in bodies[0]).toBe(false);
  });

  it('maps HTTP failures to ProviderError', async () => {
    await server.stop();
    server = await new FakeOpenAI({ failWith: { '/v1/audio/speech': 429 } }).start();
    const s = createSynthesizer({ ...cfg.tts, baseUrl: server.baseUrl }, 'k')!;
    const err = (await s.synthesize('a', { voice: 'alloy' }).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
  });
});
