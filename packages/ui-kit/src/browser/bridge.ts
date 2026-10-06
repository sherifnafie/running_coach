/**
 * Bridge transport: JSON-RPC 2.0 over postMessage between the view iframe (this code) and the host
 * shell. Requests go to `window.parent` with targetOrigin '*' (the iframe has an opaque origin and
 * cannot know the parent's); responses and notifications are accepted ONLY from `window.parent`.
 */
import type { BridgeMethod } from '@opencoach/protocol';
import { isRecord } from './util';

export type RpcError = Error & { code?: number; data?: unknown };

export interface ParentLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface BridgeOptions {
  win: Window & typeof globalThis;
  /** Defaults to win.parent. Pass explicitly in tests. */
  parent?: ParentLike | null;
  /** Default per-request timeout. */
  timeoutMs?: number;
}

export type NotificationHandler = (method: string, params: unknown) => void;

export class Bridge {
  private seq = 0;
  private readonly pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>();
  private readonly handlers = new Set<NotificationHandler>();
  private readonly parent: ParentLike | null;
  private readonly timeoutMs: number;
  /** True when not embedded (window.parent === window): there is no host to talk to. */
  readonly standalone: boolean;

  constructor(private readonly opts: BridgeOptions) {
    const p = opts.parent === undefined ? opts.win.parent : opts.parent;
    this.standalone = !p || p === (opts.win as unknown);
    this.parent = this.standalone ? null : (p as ParentLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    opts.win.addEventListener('message', this.onMessage as EventListener);
  }

  /** Number of requests awaiting a response (used to detect "render settled"). */
  get inflight(): number {
    return this.pending.size;
  }

  onNotification(h: NotificationHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  request<T = unknown>(method: BridgeMethod, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (!this.parent) return Promise.reject(this.err(`No host: this view is not embedded in the app (${method})`, -32001));
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.err(`Bridge request "${method}" timed out after ${timeoutMs} ms`, -32002));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      try {
        this.parent?.postMessage({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, '*');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Fire and forget: still a JSON-RPC request (the protocol requires ids) but errors are swallowed. */
  send(method: BridgeMethod, params?: unknown): void {
    this.request(method, params, 5_000).catch(() => {});
  }

  dispose(): void {
    this.opts.win.removeEventListener('message', this.onMessage as EventListener);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.err('Bridge disposed', -32003));
    }
    this.pending.clear();
  }

  private err(message: string, code?: number, data?: unknown): RpcError {
    const e = new Error(message) as RpcError;
    e.code = code;
    e.data = data;
    return e;
  }

  private onMessage = (ev: MessageEvent): void => {
    if (!this.parent || ev.source !== (this.parent as unknown)) return;
    const msg: unknown = ev.data;
    if (!isRecord(msg) || msg.jsonrpc !== '2.0') return;
    const id = msg.id;
    if ((typeof id === 'string' || typeof id === 'number') && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (isRecord(msg.error)) {
        p.reject(this.err(String(msg.error.message ?? 'Bridge error'), typeof msg.error.code === 'number' ? msg.error.code : undefined, msg.error.data));
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string' && id === undefined) {
      for (const h of this.handlers) {
        try {
          h(msg.method, msg.params);
        } catch {
          /* handler errors must not break the bridge */
        }
      }
    }
  };
}
