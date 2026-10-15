import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSessionInfo, CascadedUtteranceResponse } from '@opencoach/protocol';
import { api, ApiRequestError, setUnauthorizedHandler } from './api';
import { appStore } from './appState';
import { callStore, endCall, pttEnd, pttStart, resetCall, startCall } from './calls';
import { boot, signOut } from './controller';
import { auth, calls, me } from './endpoints';
import { getMicStream, startRecording, type ActiveRecorder } from './recorder';
import { deferred, FakePeer, microphone, mockPeer } from '../test/voice';

vi.mock('./endpoints', async (original) => ({
  ...await original<typeof import('./endpoints')>(),
  calls: { create: vi.fn(), attach: vi.fn(), end: vi.fn(), utterance: vi.fn() },
  auth: { logout: vi.fn(), setupStatus: vi.fn() },
  me: { get: vi.fn() },
}));
vi.mock('./recorder', async (original) => ({ ...await original<typeof import('./recorder')>(), getMicStream: vi.fn(), startRecording: vi.fn() }));
vi.mock('./cache', () => ({ cacheClear: vi.fn(), cacheGet: vi.fn(), cacheSet: vi.fn() }));
vi.mock('./push', () => ({ disablePush: vi.fn(), syncPushSubscription: vi.fn() }));

const info = (callId = 'call-1', mode: 'realtime' | 'cascaded' = 'cascaded'): CallSessionInfo => ({
  callId, mode, maxDurationS: 60,
  ...(mode === 'realtime' ? { connect: { transport: 'webrtc', callsUrl: 'https://voice.test', ephemeralKey: 'test' } } : {}),
} as CallSessionInfo);
let mic: ReturnType<typeof microphone>;
let fetch: ReturnType<typeof mockPeer>;
let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  resetCall();
  mic = microphone();
  fetch = mockPeer();
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.mocked(getMicStream).mockResolvedValue(mic.stream);
  vi.mocked(calls.create).mockResolvedValue(info());
  vi.mocked(calls.attach).mockResolvedValue(undefined);
  vi.mocked(calls.end).mockResolvedValue(undefined);
  vi.mocked(auth.logout).mockResolvedValue(undefined);
  vi.mocked(auth.setupStatus).mockResolvedValue({ needsSetup: false });
});
afterEach(async () => {
  await endCall({ remote: true });
  resetCall();
  setUnauthorizedHandler(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SPEC §11 call attempt ownership', () => {
  it('ends during microphone permission without creating a call or resurrecting capture', async () => {
    const grant = deferred<MediaStream>();
    vi.mocked(getMicStream).mockReturnValueOnce(grant.promise);
    const starting = startCall();
    await endCall();
    grant.resolve(mic.stream);
    await starting;
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(calls.create).not.toHaveBeenCalled();
    expect(callStore.getState().phase).toBe('ended');
  });

  it.each(['microphone', 'create', 'attach'] as const)('discards a late %s response without affecting a replacement call', async (boundary) => {
    const grant = deferred<MediaStream>();
    const created = deferred<CallSessionInfo>();
    const attached = deferred<void>();
    if (boundary === 'microphone') vi.mocked(getMicStream).mockReturnValueOnce(grant.promise);
    if (boundary === 'create') vi.mocked(calls.create).mockReturnValueOnce(created.promise);
    if (boundary === 'attach') {
      vi.mocked(calls.create).mockResolvedValueOnce(info('call-1', 'realtime'));
      vi.mocked(calls.attach).mockReturnValueOnce(attached.promise);
    }
    const starting = startCall();
    await vi.waitFor(() => expect(boundary === 'microphone' ? getMicStream : boundary === 'create' ? calls.create : calls.attach).toHaveBeenCalledOnce());
    await endCall();
    const nextMic = microphone();
    vi.mocked(getMicStream).mockResolvedValue(nextMic.stream);
    vi.mocked(calls.create).mockResolvedValue(info('call-2'));
    await startCall();
    const next = callStore.getState();
    grant.resolve(mic.stream);
    created.resolve(info());
    attached.resolve();
    await starting;
    expect(callStore.getState()).toBe(next);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(nextMic.stop).not.toHaveBeenCalled();
    if (boundary !== 'microphone') expect(calls.end).toHaveBeenCalledWith('call-1');
    else expect(calls.create).toHaveBeenCalledOnce();
    if (boundary === 'attach') expect(FakePeer.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it.each(['create', 'attach'] as const)('ignores an old %s failure after a replacement connects', async (boundary) => {
    const pending = deferred<never>();
    if (boundary === 'create') vi.mocked(calls.create).mockReturnValueOnce(pending.promise);
    else {
      vi.mocked(calls.create).mockResolvedValueOnce(info('call-1', 'realtime'));
      vi.mocked(calls.attach).mockReturnValueOnce(pending.promise);
    }
    const starting = startCall();
    await vi.waitFor(() => expect(boundary === 'create' ? calls.create : calls.attach).toHaveBeenCalledOnce());
    await endCall();
    const nextMic = microphone();
    vi.mocked(getMicStream).mockResolvedValue(nextMic.stream);
    vi.mocked(calls.create).mockResolvedValue(info('call-2'));
    await startCall();
    const next = callStore.getState();
    pending.reject(new Error('old failure'));
    await starting;
    expect(callStore.getState()).toBe(next);
    expect(nextMic.stop).not.toHaveBeenCalled();
  });

  it('aborts pending SDP and ignores provider events after hang-up', async () => {
    const sdp = deferred<Response>();
    fetch.mockReturnValueOnce(sdp.promise);
    vi.mocked(calls.create).mockResolvedValue(info('call-1', 'realtime'));
    const starting = startCall();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await endCall();
    const ended = callStore.getState();
    const peer = FakePeer.instances[0]!;
    sdp.resolve(new Response('late answer'));
    await starting;
    peer.ontrack?.({ streams: [mic.stream] });
    peer.channel.onmessage?.({ data: JSON.stringify({ type: 'response.created' }) });
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(callStore.getState()).toBe(ended);
  });

  it('does not let a delayed end response mark a replacement call ended', async () => {
    await startCall();
    const ended = deferred<void>();
    vi.mocked(calls.end).mockReturnValueOnce(ended.promise);
    const ending = endCall();
    expect(callStore.getState().phase).toBe('ended');
    vi.mocked(getMicStream).mockResolvedValue(microphone().stream);
    vi.mocked(calls.create).mockResolvedValue(info('call-2'));
    await startCall();
    const next = callStore.getState();
    ended.resolve();
    await ending;
    expect(callStore.getState()).toBe(next);
  });
});

describe('SPEC §11.3 cascaded reply ownership', () => {
  it.each([
    ['resolve', false], ['reject', false], ['resolve', true], ['reject', true],
  ] as const)('discards an utterance that %ss after hang-up (replacement: %s)', async (outcome, replacement) => {
    const response = deferred<CascadedUtteranceResponse>();
    vi.mocked(calls.utterance).mockReturnValue(response.promise);
    vi.mocked(startRecording).mockResolvedValue({
      stream: mic.stream, cancel: vi.fn(), level: () => 0,
      stop: vi.fn().mockResolvedValue({ blob: new Blob(['a'.repeat(1000)]), mime: 'audio/webm', durationMs: 1000 }),
    });
    await startCall();
    await pttStart();
    const sending = pttEnd();
    await vi.waitFor(() => expect(calls.utterance).toHaveBeenCalledOnce());
    await endCall();
    if (replacement) {
      vi.mocked(getMicStream).mockResolvedValue(microphone().stream);
      vi.mocked(calls.create).mockResolvedValue(info('call-2'));
      await startCall();
    }
    const state = callStore.getState();
    if (outcome === 'reject') response.reject(new Error('late failure'));
    else response.resolve({ transcript: 'old athlete', replyText: 'old coach', audioUrl: '/old-audio' } as CascadedUtteranceResponse);
    await sending;
    expect(callStore.getState()).toBe(state);
    expect(play).not.toHaveBeenCalled();
    expect(vi.mocked(calls.utterance).mock.calls[0]![3]!.aborted).toBe(true);
  });

  it('cancels a recorder acquired after hang-up', async () => {
    const pending = deferred<ActiveRecorder>();
    vi.mocked(startRecording).mockReturnValueOnce(pending.promise);
    await startCall();
    const recording = pttStart();
    await endCall();
    const recorder = { stream: mic.stream, cancel: vi.fn(), level: () => 0, stop: vi.fn() };
    pending.resolve(recorder);
    await recording;
    expect(recorder.cancel).toHaveBeenCalledOnce();
    expect(callStore.getState().recording).toBe(false);
  });
});

describe('SPEC §11, §14 [SEC-4] session teardown', () => {
  it.each(['sign-out', 'expiry'] as const)('releases a live call and resets its state on %s', async (action) => {
    vi.mocked(me.get).mockRejectedValue(new ApiRequestError(401, 'unauthorized', 'Expired'));
    await boot();
    vi.mocked(calls.create).mockResolvedValue(info('call-1', 'realtime'));
    await startCall();
    const peer = FakePeer.instances[0]!;
    if (action === 'sign-out') {
      vi.mocked(auth.logout).mockImplementation(async () => {
        expect(mic.stop).toHaveBeenCalledOnce();
        expect(calls.end).toHaveBeenCalledWith('call-1');
      });
      await signOut();
      expect(auth.logout).toHaveBeenCalledOnce();
    } else {
      fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
      await expect(api.get('/v1/me')).rejects.toBeInstanceOf(ApiRequestError);
    }
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(callStore.getState()).toMatchObject({ phase: 'idle', transcript: [] });
    expect(callStore.getState().callId).toBeUndefined();
    expect(appStore.getState().boot).toBe('signed-out');
  });

  it.each(['sign-out', 'expiry'] as const)('invalidates pending microphone permission on %s', async (action) => {
    vi.mocked(me.get).mockRejectedValue(new ApiRequestError(401, 'unauthorized', 'Expired'));
    await boot();
    const grant = deferred<MediaStream>();
    vi.mocked(getMicStream).mockReturnValueOnce(grant.promise);
    const starting = startCall();
    if (action === 'sign-out') await signOut();
    else {
      fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
      await expect(api.get('/v1/me')).rejects.toBeInstanceOf(ApiRequestError);
    }
    grant.resolve(mic.stream);
    await starting;
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(calls.create).not.toHaveBeenCalled();
    expect(callStore.getState().phase).toBe('idle');
  });
});
