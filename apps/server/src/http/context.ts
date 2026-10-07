import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import type { BlobStore, Clock, CoachRuntimeAPI, Logger, ServerConfig, Store } from '@opencoach/protocol';
import type { CallService, DictationService } from '@opencoach/voice';
import { SESSION_COOKIE, CSRF_COOKIE, SESSION_TTL_MS, RateLimiter, SessionManager, csrfTokenForSession, safeEqual, type AuthContext } from './auth';
import { conflict, forbidden, tooMany, unauthorized } from './errors';
import type { SetupCodeManager } from '../setup-code';
import type { SocketRegistry } from './sockets';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Everything the gateway needs. Built by compose.ts (real components) or by tests (fakes). */
export interface GatewayDeps {
  config: ServerConfig;
  clock: Clock;
  logger: Logger;
  store: Store;
  blobs: BlobStore;
  runtime: CoachRuntimeAPI;
  callService?: CallService;
  /** Live dictation in the composer (realtime transcription); present only with an OpenAI key. */
  dictation?: DictationService;
  setupCodes: SetupCodeManager;
  /** VAPID public key; undefined disables push features. */
  vapidPublicKey?: string;
  /** SSRF guard for client-supplied push endpoints (default: https + public host). */
  validatePushEndpoint?: (endpoint: string) => Promise<void>;
  features?: { webSearch: boolean; demoMode: boolean; imageGeneration?: boolean };
  /** Directory of the built PWA (apps/web/dist). */
  webDist?: string;
  /** UI kit assets served on the separate views origin. */
  kitDir?: string;
  /** Telegram channel (only when configured). */
  telegram?: { createLinkCode(athleteId: string): Promise<string>; unlink(athleteId: string): Promise<void> };
  /** Workspace helpers (injectable for tests). */
  exportAthlete?: (opts: { dataDir: string; athleteId: string; store: Store; clock: Clock }) => Promise<string>;
  stripImageLocation?: (data: Uint8Array, mime: string) => Promise<Uint8Array>;
  /** Per-athlete provider keys (managed or bring-your-own) [SEC-1]. */
  credentials?: import('../credentials').CredentialService;
  /** Models offered through OpenRouter and where to verify keys. Absent when OpenRouter is not configured. */
  models?: { catalog: import('@opencoach/protocol').ModelCatalogEntry[]; defaultModel: string; openrouterBaseUrl: string };
  /** Called after an account is deleted (adapters drop their mappings). */
  onAthleteDeleted?: (athleteId: string) => Promise<void>;
  /** Stop adapter producers and remove mappings before deleting the athlete's Store state. */
  onAthleteDeleting?: (athleteId: string) => Promise<void>;
}

export interface GatewayContext {
  deps: GatewayDeps;
  publicOrigin: string;
  viewsOrigin: string;
  secureCookies: boolean;
  sessions: SessionManager;
  sockets: SocketRegistry;
  /** Stops newly authorized requests while existing writes drain before hard deletion. */
  deletingAthletes: Set<string>;
  trackRequest(request: FastifyRequest): void;
  finishRequest(request: FastifyRequest): void;
  drainRequests(athleteId: string, except: FastifyRequest): Promise<void>;
  limits: {
    /** Unauthenticated credential endpoints (setup, pair, passkey login, ICS token guesses). */
    auth: RateLimiter;
    /** Authenticated write endpoints, keyed per athlete. */
    write: RateLimiter;
    /** ui.error reports, keyed per athlete+view. */
    viewErrors: RateLimiter;
  };
  setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void;
  setCsrfCookie(reply: FastifyReply, token: string): void;
  clearSessionCookie(reply: FastifyReply): void;
  /** preHandler: require a valid session (cookie or bearer). */
  requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** preHandler: require an admin (static admin token, or an admin athlete session). */
  requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Apply the unauthenticated-endpoint rate limit. */
  limitAuth(request: FastifyRequest): void;
  /** Per-athlete write limit. */
  limitWrite(athleteId: string, cost?: number): void;
  /** The authenticated athlete id (throws 401 if not authenticated). */
  athleteId(request: FastifyRequest): string;
}

export function createContext(deps: GatewayDeps, sockets: SocketRegistry): GatewayContext {
  const { config, clock } = deps;
  const publicOrigin = new URL(config.publicUrl).origin;
  const viewsOrigin = new URL(config.viewsUrl).origin;
  const secureCookies = new URL(config.publicUrl).protocol === 'https:';
  const sessions = new SessionManager({ store: deps.store, clock });
  const activeRequests = new Map<string, Set<FastifyRequest>>();
  const drainWaiters = new Map<string, Array<{ except: FastifyRequest; resolve(): void }>>();
  const deletingAthletes = new Set<string>();
  const limits = {
    auth: new RateLimiter(clock, { capacity: 10, refillPerSec: 10 / 60 }),
    write: new RateLimiter(clock, { capacity: 120, refillPerSec: 2 }),
    viewErrors: new RateLimiter(clock, { capacity: 5, refillPerSec: 1 / 60 }),
  };

  const ctx: GatewayContext = {
    deps,
    publicOrigin,
    viewsOrigin,
    secureCookies,
    sessions,
    sockets,
    deletingAthletes,
    trackRequest(request) {
      if (!request.auth) return;
      const athleteId = request.auth.athleteId;
      let set = activeRequests.get(athleteId);
      if (!set) activeRequests.set(athleteId, set = new Set());
      set.add(request);
    },
    finishRequest(request) {
      if (!request.auth) return;
      const athleteId = request.auth.athleteId;
      const set = activeRequests.get(athleteId);
      set?.delete(request);
      if (!set?.size) activeRequests.delete(athleteId);
      const waiters = drainWaiters.get(athleteId) ?? [];
      const pending = waiters.filter((waiter) => {
        if ([...(set ?? [])].some((r) => r !== waiter.except)) return true;
        waiter.resolve();
        return false;
      });
      if (pending.length) drainWaiters.set(athleteId, pending);
      else drainWaiters.delete(athleteId);
    },
    drainRequests(athleteId, except) {
      if (![...(activeRequests.get(athleteId) ?? [])].some((r) => r !== except)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = drainWaiters.get(athleteId) ?? [];
        waiters.push({ except, resolve });
        drainWaiters.set(athleteId, waiters);
      });
    },
    limits,

    setSessionCookie(reply, token, expiresAt) {
      void reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        expires: new Date(expiresAt),
      });
      ctx.setCsrfCookie(reply, token);
    },

    setCsrfCookie(reply, token) {
      void reply.setCookie(CSRF_COOKIE, csrfTokenForSession(token), { httpOnly: false, sameSite: 'lax', secure: secureCookies, path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    },

    clearSessionCookie(reply) {
      void reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies });
      void reply.clearCookie(CSRF_COOKIE, { path: '/', sameSite: 'lax', secure: secureCookies });
    },

    async requireAuth(request, reply) {
      const authz = request.headers.authorization;
      let token: string | undefined;
      let via: AuthContext['via'] = 'cookie';
      if (typeof authz === 'string' && /^Bearer\s+/i.test(authz)) {
        token = authz.replace(/^Bearer\s+/i, '').trim();
        via = 'bearer';
      } else {
        token = request.cookies?.[SESSION_COOKIE];
      }
      const res = token ? await sessions.authenticate(token, via) : undefined;
      if (!res) {
        if (via === 'cookie' && token) ctx.clearSessionCookie(reply);
        throw unauthorized();
      }
      request.auth = res.ctx;
      if (deletingAthletes.has(res.ctx.athleteId)) throw conflict('Account deletion is in progress.');
      if (res.renewedUntil && via === 'cookie' && token) ctx.setSessionCookie(reply, token, res.renewedUntil);
      else if (via === 'cookie' && token && !request.cookies[CSRF_COOKIE]) ctx.setCsrfCookie(reply, token);
    },

    async requireAdmin(request, reply) {
      const adminToken = config.admin?.token;
      const authz = request.headers.authorization;
      if (adminToken && typeof authz === 'string' && /^Bearer\s+/i.test(authz) && safeEqual(authz.replace(/^Bearer\s+/i, '').trim(), adminToken)) {
        request.auth = { athleteId: 'admin-token', isAdmin: true, sessionId: 'admin-token', via: 'bearer' };
        return;
      }
      await ctx.requireAuth(request, reply);
      if (!request.auth?.isAdmin) throw forbidden('Administrator access required.', 'admin_required');
    },

    limitAuth(request) {
      const r = limits.auth.take(`ip:${request.ip}`);
      if (!r.ok) throw tooMany(r.retryAfterSec);
    },

    limitWrite(athleteId, cost = 1) {
      const r = limits.write.take(athleteId, cost);
      if (!r.ok) throw tooMany(r.retryAfterSec);
    },

    athleteId(request) {
      if (!request.auth) throw unauthorized();
      return request.auth.athleteId;
    },
  };
  return ctx;
}
