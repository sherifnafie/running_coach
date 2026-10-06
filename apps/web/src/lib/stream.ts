import type { ClientStreamMessage, StreamMessage } from '@opencoach/protocol';

/**
 * WebSocket client for `GET /v1/stream` (SPEC §15, Appendix C §C.5).
 * - cookie auth at upgrade (the gateway checks Origin), then `{t:'resume', after}` as the first frame;
 * - `{t:'ping'}` every 25 s;
 * - reconnect with exponential backoff + jitter, resuming from the last event id.
 */
export type StreamStatus = 'connecting' | 'open' | 'closed';

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface StreamClientOptions {
  url: () => string;
  onMessage: (m: StreamMessage) => void;
  onStatus?: (s: StreamStatus) => void;
  /** Called after every (re)open, right after `resume` is sent. */
  onOpen?: (info: { reconnect: boolean }) => void;
  getLastEventId: () => string | undefined;
  createSocket?: (url: string) => WebSocketLike;
  random?: () => number;
  pingMs?: number;
}

export const PING_MS = 25_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff with +-25% jitter. attempt starts at 0. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

export class StreamClient {
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private everOpened = false;
  private status: StreamStatus = 'closed';

  constructor(private readonly o: StreamClientOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
    }
    this.setStatus('closed');
  }

  /** Reconnect now (tab became visible, network came back). */
  nudge(): void {
    if (!this.running) return;
    if (this.ws && this.ws.readyState <= 1) return; // connecting or open
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect();
  }

  /** Drop the current socket (possibly half-open) and connect again right away. */
  restart(): void {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(4000, 'restart');
      } catch {
        /* ignore */
      }
    }
    this.attempt = 0;
    this.connect();
  }

  send(m: ClientStreamMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  get currentStatus(): StreamStatus {
    return this.status;
  }

  private setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus?.(s);
  }

  private connect(): void {
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = (this.o.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike))(this.o.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus('open');
      this.send({ t: 'resume', after: this.o.getLastEventId() });
      this.clearPing();
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), this.o.pingMs ?? PING_MS);
      this.o.onOpen?.({ reconnect });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && typeof (msg as { t?: unknown }).t === 'string') this.o.onMessage(msg as StreamMessage);
    };
    ws.onerror = () => {
      /* `close` follows; handled there */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      this.setStatus('closed');
      if (this.running) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt++, this.o.random);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) this.connect();
    }, delay);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}

export function defaultStreamUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/v1/stream`;
}
