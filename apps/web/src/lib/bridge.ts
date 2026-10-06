import {
  BridgeParams,
  BridgeRequest,
  type BridgeMethod,
  type BridgeNotification,
  type BridgeResponse,
  type ViewEnv,
} from '@opencoach/protocol';
import { ApiRequestError, NetworkError } from './api';

/**
 * Bridge HOST (SPEC §9.2, Appendix C §C.4): JSON-RPC 2.0 over postMessage between a view iframe and the shell.
 *
 * Security properties enforced here:
 *  - only messages whose `event.source` is the iframe's own window are considered;
 *  - every message is validated with the protocol's `BridgeRequest` + per-method `BridgeParams` schemas;
 *  - unknown methods are rejected (-32601) and reported to the gateway;
 *  - all data access goes to the gateway, which enforces the manifest server-side.
 *
 * The class has no DOM dependency so it can be unit-tested with a fake window.
 */
export const BRIDGE_ERR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  server: -32000,
  offline: -32001,
} as const;

export interface BridgeBackend {
  query(viewId: string, sql: string, params?: unknown[]): Promise<unknown>;
  file(viewId: string, path: string): Promise<unknown>;
  write(viewId: string, body: { target: string; op: 'insert' | 'update' | 'delete'; row: Record<string, unknown>; key?: Record<string, unknown> }): Promise<unknown>;
  act(viewId: string, body: { name: string; payload?: unknown; wake?: boolean }): Promise<unknown>;
  error(viewId: string, body: { version: string; message: string; stack?: string; viewport: string }): Promise<unknown>;
}

export interface BridgeActions {
  navigate(viewId: string, params?: Record<string, string>): void;
  openChat(opts: { prefill?: string; ref?: { viewId: string; params?: Record<string, unknown> } }): void;
  toast(text: string): void;
  resize(height: number): void;
  /** The view completed its handshake (`ready`). */
  ready(): void;
  /** The view reported an error (level "error"). */
  viewError(info: { message: string; stack?: string }): void;
  /** A direct write or act succeeded (other views may want to refresh). */
  wrote?(): void;
}

export interface BridgeHostOptions {
  viewId: string;
  version: string;
  /** The iframe's contentWindow (or null while detached). */
  getWindow(): unknown;
  postToView(message: BridgeResponse | BridgeNotification): void;
  backend: BridgeBackend;
  actions: BridgeActions;
  getEnv(): ViewEnv;
  /** "390x844" */
  getViewport(): string;
  debounceMs?: number;
}

export interface IncomingMessage {
  source: unknown;
  data: unknown;
}

export type HandleOutcome = 'ignored' | 'handled' | 'rejected';

/** Methods that may arrive as JSON-RPC notifications (no id, no response). */
const FIRE_AND_FORGET = new Set<BridgeMethod>(['toast', 'report', 'resize', 'navigate', 'openChat']);

class BridgeError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function normalizeRows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    for (const k of ['rows', 'result', 'data']) if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
  }
  return [];
}

export function normalizeFile(res: unknown): string {
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    for (const k of ['content', 'text', 'data', 'body']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}

export class BridgeHost {
  private readonly subs = new Map<string, string[]>();
  private nextSub = 1;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private reportedUnknown = new Set<string>();
  private disposed = false;

  constructor(private readonly opts: BridgeHostOptions) {}

  get subscriptionCount(): number {
    return this.subs.size;
  }

  dispose(): void {
    this.disposed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.subs.clear();
  }

  /** Entry point for `window.addEventListener('message', ...)`. */
  async handleMessage(ev: IncomingMessage): Promise<HandleOutcome> {
    if (this.disposed) return 'ignored';
    const win = this.opts.getWindow();
    if (!win || ev.source !== win) return 'ignored';

    const data = ev.data;
    if (!data || typeof data !== 'object' || (data as { jsonrpc?: unknown }).jsonrpc !== '2.0') return 'ignored';

    const parsed = BridgeRequest.safeParse(data);
    if (!parsed.success) {
      // Notification form (no id) of a fire-and-forget method?
      const asNotification = parseNotification(data);
      if (asNotification) {
        await this.dispatch(asNotification.method, asNotification.params).catch(() => undefined);
        return 'handled';
      }
      const id = (data as { id?: unknown }).id;
      const method = (data as { method?: unknown }).method;
      if (typeof id === 'string' || typeof id === 'number') {
        const unknown = typeof method === 'string';
        this.reply(id, undefined, {
          code: unknown ? BRIDGE_ERR.methodNotFound : BRIDGE_ERR.invalidRequest,
          message: unknown ? `Unknown bridge method: ${String(method).slice(0, 60)}` : 'Invalid request',
        });
        if (unknown) this.reportUnknown(String(method));
      }
      return 'rejected';
    }

    const { id, method, params } = parsed.data;
    try {
      const result = await this.dispatch(method, params);
      this.reply(id, result ?? null);
      return 'handled';
    } catch (e) {
      this.reply(id, undefined, toRpcError(e));
      return 'rejected';
    }
  }

  /** Debounced `changed` notification to the view (only if it subscribed). */
  notifyChanged(): void {
    if (this.disposed || this.subs.size === 0) return;
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.disposed || this.subs.size === 0) return;
      const targets = [...new Set([...this.subs.values()].flat())];
      this.opts.postToView({ jsonrpc: '2.0', method: 'changed', params: { subscriptionIds: [...this.subs.keys()], targets } });
    }, this.opts.debounceMs ?? 300);
  }

  /** Theme, viewport, params or connectivity changed. */
  notifyEnvChanged(): void {
    if (this.disposed) return;
    this.opts.postToView({ jsonrpc: '2.0', method: 'env.changed', params: this.opts.getEnv() });
  }

  private reply(id: string | number, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    const msg: BridgeResponse = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    this.opts.postToView(msg);
  }

  private reportUnknown(method: string): void {
    if (this.reportedUnknown.has(method)) return;
    this.reportedUnknown.add(method);
    void this.opts.backend
      .error(this.opts.viewId, {
        version: this.opts.version,
        message: `Unknown bridge method "${method.slice(0, 60)}" rejected by the shell`,
        viewport: this.opts.getViewport(),
      })
      .catch(() => undefined);
  }

  private validate<M extends keyof typeof BridgeParams>(method: M, params: unknown): ReturnType<(typeof BridgeParams)[M]['parse']> {
    const r = BridgeParams[method].safeParse(params ?? {});
    if (!r.success) throw new BridgeError(BRIDGE_ERR.invalidParams, `Invalid params for ${method}: ${r.error.issues[0]?.message ?? 'invalid'}`);
    return r.data as ReturnType<(typeof BridgeParams)[M]['parse']>;
  }

  private async dispatch(method: BridgeMethod, params: unknown): Promise<unknown> {
    const { viewId, version } = this.opts;
    switch (method) {
      case 'ready':
        this.opts.actions.ready();
        return this.opts.getEnv();
      case 'env.get':
        return this.opts.getEnv();
      case 'db.query': {
        const p = this.validate('db.query', params);
        return normalizeRows(await this.opts.backend.query(viewId, p.sql, p.params));
      }
      case 'db.write': {
        const p = this.validate('db.write', params);
        await this.opts.backend.write(viewId, p);
        this.opts.actions.wrote?.();
        return null;
      }
      case 'files.read': {
        const p = this.validate('files.read', params);
        return normalizeFile(await this.opts.backend.file(viewId, p.path));
      }
      case 'act': {
        const p = this.validate('act', params);
        await this.opts.backend.act(viewId, p);
        this.opts.actions.wrote?.();
        return null;
      }
      case 'navigate': {
        const p = this.validate('navigate', params);
        this.opts.actions.navigate(p.viewId, p.params);
        return null;
      }
      case 'openChat': {
        const p = this.validate('openChat', params);
        this.opts.actions.openChat(p);
        return null;
      }
      case 'subscribe': {
        const p = this.validate('subscribe', params);
        const subscriptionId = `sub_${this.nextSub++}`;
        this.subs.set(subscriptionId, p.targets);
        return { subscriptionId };
      }
      case 'unsubscribe': {
        const p = this.validate('unsubscribe', params);
        this.subs.delete(p.subscriptionId);
        return null;
      }
      case 'toast': {
        const p = this.validate('toast', params);
        this.opts.actions.toast(p.text);
        return null;
      }
      case 'report': {
        const p = this.validate('report', params);
        if (p.level === 'error') {
          const detail = p.detail && typeof p.detail === 'object' ? (p.detail as { stack?: unknown }) : undefined;
          const stack = typeof detail?.stack === 'string' ? detail.stack.slice(0, 20_000) : undefined;
          this.opts.actions.viewError({ message: p.message, stack });
          await this.opts.backend.error(viewId, { version, message: p.message.slice(0, 4000), stack, viewport: this.opts.getViewport() }).catch(() => undefined);
        }
        return null;
      }
      case 'resize': {
        const p = this.validate('resize', params);
        this.opts.actions.resize(p.height);
        return null;
      }
    }
  }
}

function parseNotification(data: unknown): { method: BridgeMethod; params: unknown } | undefined {
  const o = data as { id?: unknown; method?: unknown; params?: unknown };
  if (o.id !== undefined || typeof o.method !== 'string') return undefined;
  if (!FIRE_AND_FORGET.has(o.method as BridgeMethod)) return undefined;
  return { method: o.method as BridgeMethod, params: o.params };
}

function toRpcError(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof BridgeError) return { code: e.code, message: e.message, data: e.data };
  if (e instanceof NetworkError) return { code: BRIDGE_ERR.offline, message: 'offline' };
  if (e instanceof ApiRequestError) return { code: BRIDGE_ERR.server, message: e.message, data: { status: e.status, code: e.code } };
  return { code: BRIDGE_ERR.internal, message: e instanceof Error ? e.message : 'internal error' };
}
