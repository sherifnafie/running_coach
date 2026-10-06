import { createStore as idbCreateStore, get as idbGet, set as idbSet } from 'idb-keyval';
import { clock } from './clock';

/**
 * Offline queue (SPEC §9.9): idempotent-enough HTTP requests (messages carry a clientId; ui-actions and
 * view writes are best effort) are persisted to IndexedDB while offline and replayed in order on reconnect.
 */
export type QueueKind = 'message' | 'ui_action' | 'view_write' | 'view_act' | 'reaction';

export interface QueuedRequest {
  id: string;
  kind: QueueKind;
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  createdAt: number;
  /** Message clientId (matches the optimistic bubble). */
  clientId?: string;
  attempts: number;
  /** Free-form metadata for the UI (e.g. the message id an action answers). */
  meta?: Record<string, unknown>;
}

/** Persistence for the queue. IndexedDB in the app, an in-memory object in tests. */
export interface QueueStorage {
  load(): Promise<QueuedRequest[]>;
  save(items: QueuedRequest[]): Promise<void>;
}

export type SendResult = { ok: true; data: unknown } | { ok: false; retryable: boolean; error: unknown };

export interface QueueEvents {
  /** A queued request was delivered. */
  onSent?(req: QueuedRequest, data: unknown): void;
  /** A queued request was rejected permanently (4xx) and removed. */
  onDropped?(req: QueuedRequest, error: unknown): void;
  /** The queue contents changed. */
  onChange?(items: QueuedRequest[]): void;
}

export class OfflineQueue {
  private flushing: Promise<FlushResult> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(
    private readonly storage: QueueStorage,
    private readonly send: (req: QueuedRequest) => Promise<SendResult>,
    private readonly events: QueueEvents = {},
  ) {}

  /** Serialise storage read-modify-write cycles. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  list(): Promise<QueuedRequest[]> {
    return this.exclusive(() => this.storage.load());
  }

  async enqueue(req: Omit<QueuedRequest, 'id' | 'createdAt' | 'attempts'>): Promise<QueuedRequest> {
    const item: QueuedRequest = { ...req, id: `q_${clock.nowMs().toString(36)}_${(this.seq++).toString(36)}`, createdAt: clock.nowMs(), attempts: 0 };
    return this.exclusive(async () => {
      const items = await this.storage.load();
      // A retried message with the same clientId must not be queued twice.
      if (item.clientId && items.some((i) => i.clientId === item.clientId && i.kind === item.kind)) {
        return items.find((i) => i.clientId === item.clientId && i.kind === item.kind)!;
      }
      items.push(item);
      await this.storage.save(items);
      this.events.onChange?.([...items]);
      return item;
    });
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(async () => {
      const items = (await this.storage.load()).filter((i) => i.id !== id);
      await this.storage.save(items);
      this.events.onChange?.([...items]);
    });
  }

  /**
   * Replay queued requests oldest first. Stops at the first retryable failure (order matters: a later
   * message must not overtake an earlier one) and drops requests the server rejects for good.
   */
  flush(): Promise<FlushResult> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, dropped: 0, remaining: 0 };
    for (;;) {
      const next = (await this.list())[0];
      if (!next) break;
      let res: SendResult;
      try {
        res = await this.send(next);
      } catch (error) {
        res = { ok: false, retryable: true, error };
      }
      if (res.ok) {
        await this.remove(next.id);
        result.sent++;
        this.events.onSent?.(next, res.data);
        continue;
      }
      if (res.retryable) {
        await this.exclusive(async () => {
          const items = await this.storage.load();
          const it = items.find((i) => i.id === next.id);
          if (it) {
            it.attempts++;
            await this.storage.save(items);
          }
        });
        break;
      }
      await this.remove(next.id);
      result.dropped++;
      this.events.onDropped?.(next, res.error);
    }
    result.remaining = (await this.list()).length;
    return result;
  }
}

export interface FlushResult {
  sent: number;
  dropped: number;
  remaining: number;
}

/** In-memory storage (tests, or when IndexedDB is unavailable). */
export function memoryQueueStorage(initial: QueuedRequest[] = []): QueueStorage {
  let items = [...initial];
  return {
    load: async () => items.map((i) => ({ ...i })),
    save: async (next) => {
      items = next.map((i) => ({ ...i }));
    },
  };
}

/** IndexedDB-backed storage (idb-keyval). Falls back to memory if IndexedDB is unusable. */
export function idbQueueStorage(dbName = 'opencoach-queue'): QueueStorage {
  let store: ReturnType<typeof idbCreateStore> | null = null;
  const fallback = memoryQueueStorage();
  let broken = false;
  const get = () => (store ??= idbCreateStore(dbName, 'queue'));
  return {
    async load() {
      if (broken) return fallback.load();
      try {
        return (await idbGet<QueuedRequest[]>('items', get())) ?? [];
      } catch {
        broken = true;
        return fallback.load();
      }
    },
    async save(items) {
      if (broken) return fallback.save(items);
      try {
        await idbSet('items', items, get());
      } catch {
        broken = true;
        await fallback.save(items);
      }
    },
  };
}
