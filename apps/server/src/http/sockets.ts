/** Anything with a close(): the subset of a ws WebSocket the registry needs. */
export interface Closable {
  close(code?: number, reason?: string): void;
}

/**
 * Tracks open WebSocket connections so a logout or account deletion can drop them immediately
 * (a stream authenticated with a revoked session must not keep receiving events).
 */
export class SocketRegistry {
  private bySession = new Map<string, Set<Closable>>();
  private byAthlete = new Map<string, Set<Closable>>();

  add(athleteId: string, sessionId: string, socket: Closable): () => void {
    let s = this.bySession.get(sessionId);
    if (!s) this.bySession.set(sessionId, (s = new Set()));
    s.add(socket);
    let a = this.byAthlete.get(athleteId);
    if (!a) this.byAthlete.set(athleteId, (a = new Set()));
    a.add(socket);
    return () => {
      s.delete(socket);
      if (s.size === 0) this.bySession.delete(sessionId);
      a.delete(socket);
      if (a.size === 0) this.byAthlete.delete(athleteId);
    };
  }

  closeSession(sessionId: string, code = 4401, reason = 'session ended'): void {
    for (const s of [...(this.bySession.get(sessionId) ?? [])]) safeClose(s, code, reason);
  }

  closeAthlete(athleteId: string, code = 4403, reason = 'account removed'): void {
    for (const s of [...(this.byAthlete.get(athleteId) ?? [])]) safeClose(s, code, reason);
  }

  count(athleteId?: string): number {
    if (athleteId) return this.byAthlete.get(athleteId)?.size ?? 0;
    let n = 0;
    for (const s of this.byAthlete.values()) n += s.size;
    return n;
  }
}

function safeClose(s: Closable, code: number, reason: string): void {
  try {
    s.close(code, reason);
  } catch {
    /* already closed */
  }
}
