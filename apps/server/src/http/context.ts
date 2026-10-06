import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BlobStore, Clock, CoachRuntimeAPI, Logger, ServerConfig, Store } from '@opencoach/protocol';
import type { CallService } from '@opencoach/voice';
import { SESSION_COOKIE, SESSION_TTL_MS, RateLimiter, SessionManager, safeEqual, type AuthContext } from './auth';
import { forbidden, tooMany, unauthorized } from './errors';
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
  callService: CallService;
  setupCodes: SetupCodeManager;
  /** VAPID public key; undefined disables push features. */
  vapidPublicKey?: string;
  /** SSRF guard for client-supplied push endpoints (default: https + public host). */
  validatePushEndpoint?: (endpoint: string) => Promise<void>;
  features: { webSearch: boolean; demoMode: boolean };
  /** Directory of the built PWA (apps/web/dist). */
  webDist?: string;
  /** Telegram channel (only when configured). */
  telegram?: { createLinkCode(athleteId: string): Promise<string>; unlink(athleteId: string): Promise<void> };
  /** Workspace helpers (injectable for tests). */
  exportAthlete(opts: { dataDir: string; athleteId: string; store: Store; clock: Clock }): Promise<string>;
  stripImageLocation(data: Uint8Array, mime: string): Promise<Uint8Array>;
  /** Called after an account is deleted (adapters drop their mappings). */
  onAthleteDeleted?: (athleteId: string) => Promise<void>;
}

export interface GatewayContext {
  deps: GatewayDeps;
  publicOrigin: string;
  viewsOrigin: string;
  secureCookies: boolean;
  sessions: SessionManager;
  sockets: SocketRegistry;
  limits: {
    /** Unauthenticated credential endpoints (setup, pair, passkey login, ICS token guesses). */
    auth: RateLimiter;
    /** Authenticated write endpoints, keyed per athlete. */
    write: RateLimiter;
    /** ui.error reports, keyed per athlete+view. */
    viewErrors: RateLimiter;
  };
  setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void;
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
    },

    clearSessionCookie(reply) {
      void reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies });
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
      if (res.renewedUntil && via === 'cookie' && token) ctx.setSessionCookie(reply, token, res.renewedUntil);
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
