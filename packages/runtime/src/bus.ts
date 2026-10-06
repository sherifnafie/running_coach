import type { PresenceState, StreamListener, StreamMessage } from '@opencoach/protocol';

/** In-process pub/sub of StreamMessages per athlete (the gateway forwards them to WebSockets). */
export class StreamBus {
  private listeners = new Map<string, Set<StreamListener>>();
  private presence = new Map<string, PresenceState>();

  subscribe(athleteId: string, fn: StreamListener): () => void {
    let set = this.listeners.get(athleteId);
    if (!set) {
      set = new Set();
      this.listeners.set(athleteId, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set && set.size === 0) this.listeners.delete(athleteId);
    };
  }

  publish(athleteId: string, msg: StreamMessage): void {
    const set = this.listeners.get(athleteId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch {
        /* a broken listener must not break the runtime */
      }
    }
  }

  connected(athleteId: string): number {
    return this.listeners.get(athleteId)?.size ?? 0;
  }

  setPresence(athleteId: string, state: PresenceState): void {
    if (this.presence.get(athleteId) === state) return;
    this.presence.set(athleteId, state);
    this.publish(athleteId, { t: 'presence', state });
  }

  getPresence(athleteId: string): PresenceState {
    return this.presence.get(athleteId) ?? 'idle';
  }
}
