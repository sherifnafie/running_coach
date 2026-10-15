import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationSessionInfo } from '@opencoach/protocol';
import { startDictation, type DictationHandlers } from '../../lib/dictation';
import { dictation } from '../../lib/endpoints';
import { getMicStream } from '../../lib/recorder';
import { deferred, FakePeer, microphone, mockPeer } from '../../test/voice';
import { useDictation } from './Dictation';

vi.mock('../../lib/endpoints', () => ({ dictation: { start: vi.fn(), end: vi.fn() } }));
vi.mock('../../lib/recorder', async (original) => ({ ...await original<typeof import('../../lib/recorder')>(), getMicStream: vi.fn() }));

const info = { sessionId: 'dictation-1', maxDurationS: 60, connect: { callsUrl: 'https://voice.test', ephemeralKey: 'test' } } as DictationSessionInfo;
let mic: ReturnType<typeof microphone>;
let fetch: ReturnType<typeof mockPeer>;
const handlers = (): DictationHandlers => ({ onText: vi.fn(), onLevel: vi.fn(), onLive: vi.fn(), onError: vi.fn(), onLimit: vi.fn() });

beforeEach(() => {
  vi.resetAllMocks();
  mic = microphone();
  fetch = mockPeer();
  vi.mocked(getMicStream).mockResolvedValue(mic.stream);
  vi.mocked(dictation.start).mockResolvedValue(info);
  vi.mocked(dictation.end).mockResolvedValue(undefined);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('[VOICE-1] [COST-1] dictation startup ownership', () => {
  it.each(['constructor', 'channel'] as const)('releases microphone, session and peer when WebRTC %s fails', async (failure) => {
    FakePeer.failure = failure;
    await expect(startDictation(handlers())).rejects.toThrow(`${failure} failed`);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(dictation.end).toHaveBeenCalledExactlyOnceWith(info.sessionId);
    if (failure === 'channel') expect(FakePeer.instances[0]!.close).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'unmount', 'hide', 'navigate'] as const)('releases pending SDP immediately on %s and ignores late events', async (action) => {
    const sdp = deferred<Response>();
    fetch.mockReturnValueOnce(sdp.promise);
    const setText = vi.fn();
    const view = renderHook(({ visible }) => useDictation({ visible, text: 'Draft', setText, onDone: vi.fn() }), { initialProps: { visible: true } });
    let starting!: Promise<void>;
    act(() => { starting = view.result.current.start(); });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const peer = FakePeer.instances[0]!;
    act(() => {
      if (action === 'cancel') view.result.current.cancel();
      if (action === 'unmount') view.unmount();
      if (action === 'navigate') view.rerender({ visible: false });
      if (action === 'hide') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(dictation.end).toHaveBeenCalledExactlyOnceWith(info.sessionId);
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    await act(async () => { await starting; });
    await act(async () => {
      sdp.resolve(new Response('late answer'));
      peer.channel.onopen?.();
      peer.channel.onmessage?.({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old', delta: 'late words' }) });
    });
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(setText).not.toHaveBeenCalledWith('Draft late words');
    if (action !== 'unmount') expect(view.result.current.phase).toBe('idle');
  });

  it.each(['microphone', 'session'] as const)('cleans up a late %s grant after cancellation without touching a retry', async (boundary) => {
    const grant = deferred<MediaStream>();
    const mint = deferred<DictationSessionInfo>();
    if (boundary === 'microphone') vi.mocked(getMicStream).mockReturnValueOnce(grant.promise);
    else vi.mocked(dictation.start).mockReturnValueOnce(mint.promise);
    const abort = new AbortController();
    const result = startDictation(handlers(), abort.signal).catch((e: unknown) => e);
    await waitFor(() => expect(boundary === 'microphone' ? getMicStream : dictation.start).toHaveBeenCalledOnce());
    abort.abort();
    expect(await result).toBeInstanceOf(DOMException);
    if (boundary === 'session') expect(mic.stop).toHaveBeenCalledOnce();
    const nextMic = microphone();
    vi.mocked(getMicStream).mockResolvedValue(nextMic.stream);
    vi.mocked(dictation.start).mockResolvedValue({ ...info, sessionId: 'dictation-2' });
    const next = await startDictation(handlers());
    grant.resolve(mic.stream);
    mint.resolve(info);
    await waitFor(() => expect(mic.stop).toHaveBeenCalledOnce());
    if (boundary === 'microphone') expect(dictation.start).toHaveBeenCalledTimes(1);
    else expect(dictation.end).toHaveBeenCalledWith(info.sessionId);
    expect(nextMic.stop).not.toHaveBeenCalled();
    next.cancel();
  });

  it('bounds stalled startup and releases media without waiting for the network', async () => {
    vi.useFakeTimers();
    const sdp = deferred<Response>();
    fetch.mockReturnValue(sdp.promise);
    const h = handlers();
    const result = startDictation(h).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBeInstanceOf(DOMException);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(FakePeer.instances[0]!.close).toHaveBeenCalledOnce();
    expect(dictation.end).toHaveBeenCalledWith(info.sessionId);
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });
});
