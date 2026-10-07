import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeMicError, getMicStream, startRecording } from './recorder';

const stopTrack = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
let constructorFails = false;
let startFails = false;
let last: FakeRecorder;
class FakeRecorder {
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/webm';
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor() { if (constructorFails) throw new Error('constructor failed'); last = this; }
  start() { if (startFails) throw new Error('start failed'); this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); queueMicrotask(() => this.onstop?.()); }
}
beforeEach(() => {
  stopTrack.mockClear(); constructorFails = startFails = false;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  vi.stubGlobal('isSecureContext', true);
});
afterEach(() => vi.unstubAllGlobals());

describe('[UI-1] microphone lifetime and errors', () => {
  it.each(['constructor', 'start'])('releases its microphone if MediaRecorder %s fails', async (failure) => {
    constructorFails = failure === 'constructor'; startFails = failure === 'start';
    await expect(startRecording()).rejects.toThrow(`${failure} failed`);
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('does not release a caller-owned call stream on failure or cancellation', async () => {
    startFails = true;
    await expect(startRecording(stream)).rejects.toThrow('start failed');
    startFails = false;
    const active = await startRecording(stream);
    active.cancel();
    expect(stopTrack).not.toHaveBeenCalled();
  });
  it('stops once, preserves final audio and releases its tracks once', async () => {
    const active = await startRecording();
    const first = active.stop();
    expect(active.stop()).toBe(first);
    expect((await first).blob.size).toBeGreaterThan(0);
    active.cancel();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('releases capture and reports a recorder failure before Stop is pressed', async () => {
    const active = await startRecording();
    last.onerror?.();
    await expect(active.stop()).rejects.toThrow('Recording failed');
    expect(stopTrack).toHaveBeenCalledOnce();
  });
  it('explains HTTPS and unsupported recording separately from denied permission', async () => {
    vi.stubGlobal('isSecureContext', false);
    await expect(getMicStream()).rejects.toThrow('HTTPS');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    vi.stubGlobal('MediaRecorder', undefined);
    await expect(startRecording()).rejects.toThrow('not supported');
    expect(describeMicError(new DOMException('Denied', 'NotAllowedError'))).toContain('Allow the microphone');
  });
});
