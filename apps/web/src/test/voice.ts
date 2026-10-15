import { vi } from 'vitest';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function microphone() {
  const stop = vi.fn();
  const track = { stop, enabled: true };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, stop };
}

export class FakePeer {
  static instances: FakePeer[] = [];
  static failure?: 'constructor' | 'channel';
  connectionState = 'connecting';
  ontrack?: (event: { streams: MediaStream[] }) => void;
  onconnectionstatechange?: () => void;
  channel = {
    readyState: 'connecting',
    onopen: undefined as (() => void) | undefined,
    onmessage: undefined as ((event: { data: string }) => void) | undefined,
    close: vi.fn(),
    send: vi.fn(),
  };
  constructor() {
    if (FakePeer.failure === 'constructor') throw new Error('constructor failed');
    FakePeer.instances.push(this);
  }
  createDataChannel() {
    if (FakePeer.failure === 'channel') throw new Error('channel failed');
    return this.channel;
  }
  addTrack = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'offer' });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
}

export function mockPeer() {
  FakePeer.instances = [];
  FakePeer.failure = undefined;
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('AudioContext', undefined);
  const fetch = vi.fn().mockResolvedValue(new Response('answer', { headers: { Location: '/calls/rtc_test' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
