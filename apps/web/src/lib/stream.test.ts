import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '@opencoach/protocol';
import { StreamClient, backoffDelay, defaultStreamUrl, type WebSocketLike } from './stream';

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function make(lastId: () => string | undefined = () => undefined) {
  const messages: StreamMessage[] = [];
  const statuses: string[] = [];
  const opens: boolean[] = [];
  const client = new StreamClient({
    url: () => 'ws://x/v1/stream',
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onOpen: ({ reconnect }) => opens.push(reconnect),
    getLastEventId: lastId,
    createSocket: (u) => new FakeSocket(u),
    random: () => 0.5,
  });
  return { client, messages, statuses, opens };
}

describe('StreamClient', () => {
  it('sends resume with the last event id right after open', () => {
    const { client, statuses } = make(() => 'evt_42');
    client.start();
    expect(statuses).toEqual(['connecting']);
    FakeSocket.all[0]!.open();
    expect(statuses).toEqual(['connecting', 'open']);
    expect(FakeSocket.all[0]!.sent[0]).toEqual({ t: 'resume', after: 'evt_42' });
  });

  it('delivers parsed server messages and ignores garbage', () => {
    const { client, messages } = make();
    client.start();
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.receive({ t: 'presence', state: 'thinking' });
    ws.onmessage?.({ data: 'not json' });
    ws.onmessage?.({ data: JSON.stringify({ nope: 1 }) });
    ws.receive({ t: 'message.delta', streamId: 's', textDelta: 'hi' });
    expect(messages).toEqual([
      { t: 'presence', state: 'thinking' },
      { t: 'message.delta', streamId: 's', textDelta: 'hi' },
    ]);
  });

  it('pings every 25 seconds while open', () => {
    const { client } = make();
    client.start();
    const ws = FakeSocket.all[0]!;
    ws.open();
    vi.advanceTimersByTime(24_999);
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(1);
    vi.advanceTimersByTime(50_000);
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(3);
  });

  it('reconnects with backoff and resumes from the latest event id', () => {
    let last: string | undefined = 'evt_1';
    const { client, opens } = make(() => last);
    client.start();
    FakeSocket.all[0]!.open();
    last = 'evt_9';
    FakeSocket.all[0]!.drop();
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1000); // first retry: 1s (jitter 0.5 => exactly base)
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    expect(FakeSocket.all[1]!.sent[0]).toEqual({ t: 'resume', after: 'evt_9' });
    expect(opens).toEqual([false, true]);
  });

  it('backs off exponentially while the server is down and resets after a successful open', () => {
    const { client } = make();
    client.start();
    FakeSocket.all[0]!.drop(); // attempt 0 → 1s
    vi.advanceTimersByTime(1000);
    FakeSocket.all[1]!.drop(); // attempt 1 → 2s
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.open();
    FakeSocket.all[2]!.drop(); // reset → 1s again
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('stop() closes the socket and never reconnects', () => {
    const { client, statuses } = make();
    client.start();
    const ws = FakeSocket.all[0]!;
    ws.open();
    client.stop();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(statuses.at(-1)).toBe('closed');
    expect(client.send({ t: 'ping' })).toBe(false);
  });

  it('nudge() reconnects immediately when closed, and does nothing while connected', () => {
    const { client } = make();
    client.start();
    FakeSocket.all[0]!.open();
    client.nudge();
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.all[0]!.drop();
    client.nudge();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('restart() replaces a (possibly half-open) socket', () => {
    const { client } = make();
    client.start();
    FakeSocket.all[0]!.open();
    client.restart();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('send() only writes on an open socket', () => {
    const { client } = make();
    client.start();
    expect(client.send({ t: 'typing' })).toBe(false);
    FakeSocket.all[0]!.open();
    expect(client.send({ t: 'ack', upTo: 'evt_1' })).toBe(true);
    expect(FakeSocket.all[0]!.sent.at(-1)).toEqual({ t: 'ack', upTo: 'evt_1' });
  });
});

describe('helpers', () => {
  it('backoffDelay doubles up to 30 s with +-25% jitter', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(1, () => 0.5)).toBe(2000);
    expect(backoffDelay(4, () => 0.5)).toBe(16_000);
    expect(backoffDelay(10, () => 0.5)).toBe(30_000);
    expect(backoffDelay(0, () => 0)).toBe(750);
    expect(backoffDelay(0, () => 1)).toBe(1250);
  });

  it('derives ws/wss from the page protocol', () => {
    expect(defaultStreamUrl({ protocol: 'https:', host: 'coach.example' })).toBe('wss://coach.example/v1/stream');
    expect(defaultStreamUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/v1/stream');
  });
});
