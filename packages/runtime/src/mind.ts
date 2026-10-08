import type { AnyEvent, TriggerClass } from '@opencoach/protocol';
import type { Core } from './core';

/**
 * One AthleteMind per athlete (SPEC §5.2):
 *  [RT-1] single-flight: at most one main-coach turn at a time (plus exclusive sections for consults/calls)
 *  [RT-2] batching: reactive events are debounced (idle 2.5 s, max 8 s by default)
 *  [RT-3] steering: athlete events arriving during a turn are injected at the next tool boundary
 */

interface Queued {
  event: AnyEvent;
  cls: TriggerClass;
}

const PRIORITY: Record<TriggerClass, number> = { reactive: 5, call: 4, followup: 3, scheduled: 2, consolidation: 1 };

export type TurnFn = (athleteId: string, events: AnyEvent[], cls: TriggerClass) => Promise<void>;

export class AthleteMind {
  private queue: Queued[] = [];
  private passive: AnyEvent[] = [];
  private steering: AnyEvent[] = [];
  private running = false;
  private stopped = false;
  private inTurn: { cls: TriggerClass } | null = null;
  private debounce: { first: number; last: number; timer: AbortController } | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private core: Core,
    readonly athleteId: string,
    private runTurn: TurnFn,
  ) {}

  /** Queue an event that should start (or steer) a turn. */
  enqueue(event: AnyEvent, cls: TriggerClass): void {
    if (this.stopped) return;
    const isAthlete = event.actor === 'athlete';
    if (this.inTurn && isAthlete && cls === 'reactive' && this.inTurn.cls !== 'consolidation') {
      this.steering.push(event);
      return;
    }
    this.queue.push({ event, cls });
    if (cls === 'reactive') this.bumpDebounce();
    this.kick();
  }

  /** Record a non-waking event the coach should see in its next turn. */
  addPassive(event: AnyEvent): void {
    this.passive.push(event);
  }

  takePassive(): AnyEvent[] {
    const p = this.passive;
    this.passive = [];
    return p;
  }

  /** Called by the turn runner at tool boundaries. */
  drainSteering(): AnyEvent[] {
    const s = this.steering;
    this.steering = [];
    return s;
  }

  isBusy(): boolean {
    return this.running || this.inTurn !== null;
  }

  /** Run `fn` while holding the mind's lock (no turn runs concurrently). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }

  /** Resolves when the mind has nothing queued and no turn running (tests, sims). */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0 && !this.debounce && !this.inTurn) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stop(): void {
    this.stopped = true;
    this.debounce?.timer.abort();
    this.debounce = null;
    this.queue = [];
    // Unanswered athlete events remain in the durable inbox for the next runtime.
    this.steering = [];
    this.notifyIdle();
  }

  // ------------------------------------------------------------------ internals

  private bumpDebounce(): void {
    const { debounceIdleMs, debounceMaxMs } = this.core.config.limits;
    if (debounceIdleMs <= 0) return;
    const now = this.core.clock.now().getTime();
    if (this.debounce) {
      this.debounce.last = now;
      return;
    }
    const d = { first: now, last: now, timer: new AbortController() };
    this.debounce = d;
    void (async () => {
      for (;;) {
        const wakeAt = Math.min(d.last + debounceIdleMs, d.first + debounceMaxMs);
        try {
          await this.core.clock.sleepUntil(new Date(wakeAt), d.timer.signal);
        } catch {
          return;
        }
        const t = this.core.clock.now().getTime();
        if (t >= d.last + debounceIdleMs || t >= d.first + debounceMaxMs) break;
      }
      if (this.debounce === d) this.debounce = null;
      this.kick();
    })();
  }

  private kick(): void {
    if (this.running || this.stopped || this.queue.length === 0) return;
    if (this.debounce && this.queue.some((q) => q.cls === 'reactive')) return;
    this.running = true;
    void this.loop();
  }

  private takeBatch(): { events: AnyEvent[]; cls: TriggerClass } {
    const nonCons = this.queue.filter((q) => q.cls !== 'consolidation');
    const pick = nonCons.length ? nonCons : this.queue.slice(0, 1);
    const pickSet = new Set(pick);
    this.queue = this.queue.filter((q) => !pickSet.has(q));
    let cls: TriggerClass = 'consolidation';
    for (const q of pick) if (PRIORITY[q.cls] > PRIORITY[cls]) cls = q.cls;
    return { events: pick.map((q) => q.event), cls };
  }

  private async loop(): Promise<void> {
    try {
      while (this.queue.length && !this.stopped) {
        if (this.debounce && this.queue.some((q) => q.cls === 'reactive')) break;
        const batch = this.takeBatch();
        await this.runExclusive(async () => {
          this.inTurn = { cls: batch.cls };
          try {
            await this.runTurn(this.athleteId, batch.events, batch.cls);
          } catch (e) {
            this.core.log.error('turn crashed', { athleteId: this.athleteId, error: (e as Error).stack ?? String(e) });
          } finally {
            this.inTurn = null;
            // steering events that arrived after the last tool boundary start a new turn
            const leftover = this.drainSteering();
            if (!this.stopped) for (const ev of leftover.reverse()) this.queue.unshift({ event: ev, cls: 'reactive' });
          }
        });
      }
    } finally {
      this.running = false;
      if (this.queue.length && !this.stopped) this.kick();
      else this.notifyIdle();
    }
  }

  private notifyIdle(): void {
    if (this.running || this.queue.length || this.debounce || this.inTurn) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of w) r();
  }
}

export class Minds {
  private minds = new Map<string, AthleteMind>();
  constructor(
    private core: Core,
    private runTurn: TurnFn,
  ) {}

  get(athleteId: string): AthleteMind {
    let m = this.minds.get(athleteId);
    if (!m) {
      m = new AthleteMind(this.core, athleteId, this.runTurn);
      this.minds.set(athleteId, m);
    }
    return m;
  }

  delete(athleteId: string): void {
    this.minds.get(athleteId)?.stop();
    this.minds.delete(athleteId);
  }

  stopAll(): void {
    for (const m of this.minds.values()) m.stop();
  }

  async whenAllIdle(): Promise<void> {
    await Promise.all([...this.minds.values()].map((m) => m.whenIdle()));
  }
}
