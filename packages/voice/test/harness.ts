import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VirtualClock,
  VoiceConfig,
  parseSettings,
  silentLogger,
  type AnyEvent,
  type BlobStore,
  type CoachRuntimeAPI,
  type NewEvent,
  type RealtimeClientConnect,
  type RealtimeSideband,
  type RealtimeSidebandHandlers,
  type RealtimeVoiceProvider,
  type Store,
  type Synthesizer,
  type ToolSpec,
  type Transcriber,
  type AthleteSettingsInput,
} from '@opencoach/protocol';
import { createCallService, type CallService } from '../src';

export const START = '2026-10-06T10:00:00.000Z';
export const ATHLETE = 'ath_alex';
export const OTHER_ATHLETE = 'ath_other';

/** Deferred promise helper. */
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeSideband implements RealtimeSideband {
  closes = 0;
  instructions: string[] = [];
  said: string[] = [];
  constructor(
    readonly providerCallId: string,
    readonly model: string,
    readonly handlers: RealtimeSidebandHandlers,
  ) {}
  async updateInstructions(i: string) {
    this.instructions.push(i);
  }
  async say(t: string) {
    this.said.push(t);
  }
  async close() {
    this.closes++;
  }
}

export class FakeRealtime implements RealtimeVoiceProvider {
  readonly id = 'fake-realtime';
  sessions: Array<{ instructions: string; tools: ToolSpec[]; voice: string; model: string }> = [];
  sidebands: FakeSideband[] = [];
  failAttach?: Error;
  async createSession(input: { instructions: string; tools: ToolSpec[]; voice: string; model: string }): Promise<RealtimeClientConnect> {
    this.sessions.push(input);
    return { type: 'openai-webrtc', callsUrl: 'https://rt.test/v1/realtime/calls', ephemeralKey: 'ek_fake', expiresAt: '2026-10-06T10:01:00.000Z', model: input.model };
  }
  async attachSideband(input: { providerCallId: string; model: string; handlers: RealtimeSidebandHandlers }): Promise<RealtimeSideband> {
    if (this.failAttach) throw this.failAttach;
    const sb = new FakeSideband(input.providerCallId, input.model, input.handlers);
    this.sidebands.push(sb);
    return sb;
  }
}

export interface RuntimeCalls {
  briefing: Array<{ athleteId: string; purpose?: string }>;
  lookup: Array<{ athleteId: string; query: string }>;
  consult: Array<{ athleteId: string; question: string; context?: string }>;
  callTurn: Array<{ athleteId: string; callId: string; utterance: string }>;
}

export function makeRuntime() {
  const events: NewEvent[] = [];
  const calls: RuntimeCalls = { briefing: [], lookup: [], consult: [], callTurn: [] };
  const impl = {
    briefing: async (_athleteId: string, purpose?: string) => `BRIEFING for Alex. Purpose: ${purpose ?? 'none'}.`,
    lookup: async (_athleteId: string, query: string) => `Result for "${query}": Thursday = 10 km tempo.`,
    consult: async (_athleteId: string, question: string, _context?: string) => `Coach says: yes, ${question}`,
    callTurn: async (_athleteId: string, _callId: string, utterance: string) => ({ replyText: `Heard: ${utterance}` }),
  };
  const runtime = {
    callBriefing: async (athleteId: string, purpose?: string) => {
      calls.briefing.push({ athleteId, purpose });
      return impl.briefing(athleteId, purpose);
    },
    lookup: async (athleteId: string, query: string) => {
      calls.lookup.push({ athleteId, query });
      return impl.lookup(athleteId, query);
    },
    consult: async (athleteId: string, question: string, context?: string) => {
      calls.consult.push({ athleteId, question, context });
      return impl.consult(athleteId, question, context);
    },
    callTurn: async (athleteId: string, callId: string, utterance: string) => {
      calls.callTurn.push({ athleteId, callId, utterance });
      return impl.callTurn(athleteId, callId, utterance);
    },
    appendSystemEvent: async (e: NewEvent) => {
      events.push(e);
      return { id: `evt_${events.length}`, ...e } as unknown as AnyEvent;
    },
  };
  return { runtime: runtime as unknown as CoachRuntimeAPI, events, calls, impl };
}

export function makeStore(settingsByAthlete: Record<string, AthleteSettingsInput>): Store {
  return {
    getSettings: async (athleteId: string) => {
      const s = settingsByAthlete[athleteId];
      if (!s) throw new Error(`no such athlete ${athleteId}`);
      return parseSettings(s);
    },
  } as unknown as Store;
}

export function makeBlobs() {
  const puts: Array<{ athleteId: string; data: Uint8Array; meta: { mime: string; origin: string; extra?: Record<string, unknown> } }> = [];
  const blobs = {
    put: async (athleteId: string, data: Uint8Array, meta: { mime: string; origin: string; extra?: Record<string, unknown> }) => {
      puts.push({ athleteId, data, meta });
      return { sha256: createHash('sha256').update(data).digest('hex'), mime: meta.mime, bytes: data.length, path: '/blobs/x', existed: false };
    },
  } as unknown as BlobStore;
  return { blobs, puts };
}

/** STT fake: the "audio" is just the utf-8 text spoken. */
export function fakeTranscriber(): Transcriber & { calls: Array<{ mime: string; bytes: number }>; fail?: boolean } {
  const t = {
    id: 'fake-stt',
    calls: [] as Array<{ mime: string; bytes: number }>,
    fail: false,
    async transcribe(audio: Uint8Array, mime: string) {
      t.calls.push({ mime, bytes: audio.length });
      if (t.fail) throw new Error('stt down');
      return { text: new TextDecoder().decode(audio), model: 'fake-stt-model', durationS: 2 };
    },
  };
  return t;
}

export function fakeSynthesizer(): Synthesizer & { calls: Array<{ text: string; voice: string }>; fail?: boolean } {
  const s = {
    id: 'fake-tts',
    calls: [] as Array<{ text: string; voice: string }>,
    fail: false,
    async synthesize(text: string, opts: { voice: string }) {
      s.calls.push({ text, voice: opts.voice });
      if (s.fail) throw new Error('tts down');
      return { audio: new TextEncoder().encode(`AUDIO:${text}`), mime: 'audio/mpeg', model: 'fake-tts-model' };
    },
  };
  return s;
}

export interface HarnessOptions {
  realtime?: boolean;
  transcriber?: boolean;
  synthesizer?: boolean;
  start?: string;
  config?: Partial<VoiceConfig['realtime']>;
  settings?: AthleteSettingsInput;
  /** A provider, or a factory that receives the harness clock. */
  realtimeProvider?: RealtimeVoiceProvider | ((clock: VirtualClock) => RealtimeVoiceProvider);
}

export async function makeHarness(opts: HarnessOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'opencoach-voice-'));
  const clock = new VirtualClock(opts.start ?? START);
  const { runtime, events, calls, impl } = makeRuntime();
  const { blobs, puts } = makeBlobs();
  const fakeRt = new FakeRealtime();
  const transcriber = fakeTranscriber();
  const synthesizer = fakeSynthesizer();
  const settings: AthleteSettingsInput = opts.settings ?? { profile: { tz: 'Europe/Amsterdam' }, voice: { voice: 'marin' } };
  const store = makeStore({ [ATHLETE]: settings, [OTHER_ATHLETE]: { profile: { tz: 'UTC' } } });
  const config = VoiceConfig.parse({ realtime: { maxDurationS: 600, model: 'gpt-realtime-2.1', ...(opts.config ?? {}) } });
  const service: CallService = createCallService({
    runtime,
    store,
    blobs,
    clock,
    logger: silentLogger,
    dataDir,
    config,
    realtime: typeof opts.realtimeProvider === 'function' ? opts.realtimeProvider(clock) : (opts.realtimeProvider ?? (opts.realtime === false ? undefined : fakeRt)),
    transcriber: opts.transcriber ? transcriber : undefined,
    synthesizer: opts.synthesizer ? synthesizer : undefined,
  });
  return {
    service,
    clock,
    dataDir,
    runtime,
    events,
    calls,
    impl,
    puts,
    realtime: fakeRt,
    transcriber,
    synthesizer,
    config,
    eventsOf: (type: string) => events.filter((e) => e.type === type),
    cleanup: async () => {
      await service.dispose();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;
