import { createHash, timingSafeEqual } from 'node:crypto';
import { newId, randomToken, type Clock, type SessionRecord, type Store } from '@opencoach/protocol';

export const SESSION_COOKIE = 'oc_session';
export const CSRF_COOKIE = 'oc_csrf';
/** 90-day sliding session lifetime (SPEC §13 / task contract). */
export const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
/** A session is re-issued (same token, new expiry) once less than this much lifetime remains. */
const RENEW_BELOW_MS = SESSION_TTL_MS / 2;
/** lastSeenAt is refreshed at most this often per session. */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export interface AuthContext {
  athleteId: string;
  isAdmin: boolean;
  sessionId: string;
  via: 'cookie' | 'bearer';
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Browser-readable proof bound to the httpOnly session; it cannot authenticate without that session. */
export function csrfTokenForSession(token: string): string {
  return sha256Hex(`oc-csrf:${token}`);
}

/** Constant-time string equality (hashes both sides first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface IssuedSession {
  token: string;
  expiresAt: string;
  record: SessionRecord;
}

export class SessionManager {
  private lastTouch = new Map<string, number>();

  constructor(private deps: { store: Store; clock: Clock }) {}

  /** Create a session. Only the sha256 of the token is stored. */
  async create(athleteId: string, opts: { deviceName?: string; kind?: SessionRecord['kind'] } = {}): Promise<IssuedSession> {
    const { store, clock } = this.deps;
    const now = clock.now();
    const token = randomToken(32);
    const record: SessionRecord = {
      id: newId('ses', clock),
      athleteId,
      tokenHash: sha256Hex(token),
      kind: opts.kind ?? 'cookie',
      deviceName: opts.deviceName,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    };
    await store.createSession(record);
    return { token, expiresAt: record.expiresAt, record };
  }

  /**
   * Resolve a raw token to an auth context. Returns `renewedUntil` when the session lifetime was extended
   * (the caller re-sets the cookie). The store contract has no "extend expiry" call, so renewal re-creates the
   * record under the same id and token hash once the session is past half of its lifetime.
   */
  async authenticate(token: string, via: AuthContext['via']): Promise<{ ctx: AuthContext; renewedUntil?: string } | undefined> {
    if (!token || token.length > 256) return undefined;
    const { store, clock } = this.deps;
    const rec = await store.getSessionByTokenHash(sha256Hex(token));
    if (!rec) return undefined;
    const now = clock.now().getTime();
    if (new Date(rec.expiresAt).getTime() <= now) return undefined;
    const athlete = await store.getAthlete(rec.athleteId);
    if (!athlete || athlete.status !== 'active') return undefined;

    let renewedUntil: string | undefined;
    const remaining = new Date(rec.expiresAt).getTime() - now;
    if (remaining < RENEW_BELOW_MS) {
      const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
      try {
        await store.deleteSession(rec.id);
        await store.createSession({ ...rec, lastSeenAt: new Date(now).toISOString(), expiresAt });
        renewedUntil = expiresAt;
        this.lastTouch.set(rec.id, now);
      } catch {
        // Renewal is best-effort; the session is still valid until its stored expiry.
      }
    } else {
      const last = this.lastTouch.get(rec.id) ?? 0;
      if (now - last > TOUCH_EVERY_MS) {
        this.lastTouch.set(rec.id, now);
        if (this.lastTouch.size > 10_000) this.lastTouch.clear();
        try {
          await store.touchSession(rec.id, new Date(now).toISOString());
        } catch {
          /* non-fatal */
        }
      }
    }
    return { ctx: { athleteId: rec.athleteId, isAdmin: athlete.isAdmin, sessionId: rec.id, via }, renewedUntil };
  }

  async revoke(sessionId: string): Promise<void> {
    this.lastTouch.delete(sessionId);
    await this.deps.store.deleteSession(sessionId);
  }
}

// ---------------------------------------------------------------------------------------------
// Rate limiting (simple in-memory token bucket)
// ---------------------------------------------------------------------------------------------

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private clock: Clock,
    private opts: { capacity: number; refillPerSec: number; maxKeys?: number },
  ) {}

  /** Take `cost` tokens for `key`. */
  take(key: string, cost = 1): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.clock.now().getTime();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, at: now };
      this.buckets.set(key, b);
      if (this.buckets.size > (this.opts.maxKeys ?? 10_000)) this.prune(now);
    } else {
      const elapsed = Math.max(0, now - b.at) / 1000;
      b.tokens = Math.min(this.opts.capacity, b.tokens + elapsed * this.opts.refillPerSec);
      b.at = now;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: (cost - b.tokens) / this.opts.refillPerSec };
  }

  private prune(now: number): void {
    const fullAfterMs = (this.opts.capacity / this.opts.refillPerSec) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at > fullAfterMs) this.buckets.delete(k);
    // Still too many (an attack with many distinct keys): drop the oldest half.
    if (this.buckets.size > (this.opts.maxKeys ?? 10_000)) {
      const keys = [...this.buckets.keys()];
      for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.buckets.delete(k);
    }
  }
}

/** Origin of a Referer header value, if parseable. */
export function originOfReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/** "k7qm 3xpd" / "k7qm3xpd" / "K7QM-3XPD" → "K7QM-3XPD". */
export function normalizeCode(input: string): string {
  const s = input.trim().toUpperCase().replace(/[\s-]+/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : input.trim().toUpperCase();
}
