/**
 * Clock (SPEC P11): ALL harness time flows through a Clock so the whole system can be
 * fast-forwarded in evals. Never call Date.now() / new Date() for "now" outside a Clock.
 */
export interface Clock {
  now(): Date;
  /** Resolves when the clock reaches `t` (immediately if already past). Rejects with AbortError on abort. */
  sleepUntil(t: Date, signal?: AbortSignal): Promise<void>;
}

const MAX_TIMEOUT_MS = 2_147_483_647; // setTimeout limit (~24.8 days)

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleepUntil(t: Date, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(abortError());
      };
      const tick = () => {
        const remaining = t.getTime() - Date.now();
        if (remaining <= 0) {
          signal?.removeEventListener('abort', onAbort);
          resolve();
          return;
        }
        timer = setTimeout(tick, Math.min(remaining, MAX_TIMEOUT_MS));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      tick();
    });
  }
}

interface Waiter {
  at: number;
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Deterministic clock for tests and the eval time machine. Time only moves when
 * advanceTo/advanceBy is called. Waiters are resolved in time order, yielding to the
 * event loop between each so dependent work can schedule further waiters.
 */
export class VirtualClock implements Clock {
  private t: number;
  private seq = 0;
  private waiters: Waiter[] = [];

  constructor(start: Date | string | number) {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  sleepUntil(t: Date, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (t.getTime() <= this.t) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w: Waiter = { at: t.getTime(), seq: this.seq++, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      this.waiters.sort((a, b) => a.at - b.at || a.seq - b.seq);
    });
  }

  /** Earliest pending wake-up, if any. */
  nextWakeAt(): Date | undefined {
    const w = this.waiters[0];
    return w ? new Date(w.at) : undefined;
  }

  pendingCount(): number {
    return this.waiters.length;
  }

  /** Advance to `target`, resolving due waiters in order (with macrotask yields between them). */
  async advanceTo(target: Date | string | number): Promise<void> {
    const to = new Date(target).getTime();
    if (to < this.t) throw new Error(`VirtualClock cannot go backwards (${new Date(to).toISOString()} < ${new Date(this.t).toISOString()})`);
    for (;;) {
      const next = this.waiters[0];
      if (!next || next.at > to) break;
      this.waiters.shift();
      this.t = Math.max(this.t, next.at);
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
      await settle();
    }
    this.t = to;
    await settle();
  }

  advanceBy(ms: number): Promise<void> {
    return this.advanceTo(this.t + ms);
  }
}

/** Let pending promise chains and immediate timers run. */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
  }
}
