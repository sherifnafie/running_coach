import type { FastifyInstance } from 'fastify';
import { ClientStreamMessage, type StreamMessage } from '@opencoach/protocol';
import type { GatewayContext } from '../http/context';
import { SESSION_COOKIE, sha256Hex } from '../http/auth';
import { forbidden, unauthorized } from '../http/errors';
import { isAthleteVisibleStreamMessage, listVisibleEvents } from '../http/visibility';
import { ownedMessage } from './client';

/** Cookie-authenticated browser sockets, or first-frame bearer auth for other clients [SEC-4]. */
export function streamRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  app.get('/v1/stream', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (request.headers.origin !== ctx.publicOrigin) throw forbidden('WebSocket Origin must match the app.', 'invalid_origin');
      if (request.headers.authorization || request.cookies[SESSION_COOKIE]) await ctx.requireAuth(request, reply);
      else ctx.limitAuth(request);
    },
  }, (socket, request) => {
    let auth = request.auth;
    let token = request.headers.authorization?.replace(/^Bearer\s+/i, '').trim() ?? request.cookies[SESSION_COOKIE];
    let unsubscribe: (() => void) | undefined;
    let unregister: (() => void) | undefined;
    let expiry = new AbortController();
    let closed = false;
    let chain = Promise.resolve();
    const send = (message: StreamMessage | { t: 'pong' }) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'client is too slow'); return; }
      socket.send(JSON.stringify(message));
    };
    const clean = () => { closed = true; expiry.abort(); unsubscribe?.(); unregister?.(); };
    socket.on('close', clean);
    socket.on('error', clean);

    async function armExpiry() {
      expiry.abort();
      expiry = new AbortController();
      const record = token ? await ctx.deps.store.getSessionByTokenHash(sha256Hex(token)) : undefined;
      if (!record) throw unauthorized();
      void ctx.deps.clock.sleepUntil(new Date(record.expiresAt), expiry.signal).then(() => socket.close(4401, 'session expired'), () => undefined);
    }
    async function activate() {
      if (!auth || closed) return;
      unregister = ctx.sockets.add(auth.athleteId, auth.sessionId, socket);
      unsubscribe = ctx.deps.runtime.subscribe(auth.athleteId, (message) => { if (isAthleteVisibleStreamMessage(message)) send(message); });
      send({ t: 'presence', state: ctx.deps.runtime.presence(auth.athleteId) });
      await armExpiry();
    }
    if (auth) chain = activate();
    else void ctx.deps.clock.sleepUntil(new Date(ctx.deps.clock.now().getTime() + 10_000), expiry.signal).then(() => socket.close(4401, 'authentication timeout'), () => undefined);

    // Attach listeners synchronously; async work is serialized so auth/resume cannot race.
    socket.on('message', (raw) => {
      chain = chain.then(async () => {
        if (closed) return;
        let json: unknown;
        try { json = JSON.parse(raw.toString()); } catch { socket.close(4400, 'invalid JSON'); return; }
        const parsed = ClientStreamMessage.safeParse(json);
        if (!parsed.success) { socket.close(4400, 'invalid stream message'); return; }
        const message = parsed.data;
        if (!auth) {
          if (message.t !== 'auth') throw unauthorized();
          token = message.token;
          const result = await ctx.sessions.authenticate(token, 'bearer');
          if (!result) throw unauthorized();
          if (ctx.deletingAthletes.has(result.ctx.athleteId)) throw unauthorized();
          auth = result.ctx;
          await activate();
          return;
        }
        const current = token ? await ctx.sessions.authenticate(token, auth.via) : undefined;
        if (!current || current.ctx.athleteId !== auth.athleteId) throw unauthorized();
        await armExpiry();
        ctx.limitWrite(auth.athleteId);
        if (message.t === 'auth') { socket.close(4400, 'already authenticated'); return; }
        if (message.t === 'ping') { send({ t: 'pong' }); return; }
        if (message.t === 'resume') {
          let after = message.after;
          for (;;) {
            const page = await listVisibleEvents(ctx.deps.store, auth.athleteId, { after, limit: 500 });
            for (const event of page.events) send({ t: 'event', event });
            if (!page.hasMore || !page.events.length || closed) break;
            after = page.events.at(-1)!.id;
          }
        } else if (message.t === 'ack') {
          await ownedMessage(ctx, auth.athleteId, message.upTo);
          const state = await ctx.deps.store.getMessageState(message.upTo);
          if (state) await ctx.deps.store.markRead([message.upTo], ctx.deps.clock.now().toISOString());
        }
      }).catch((error) => {
        ctx.deps.logger.warn('stream closed', { error: (error as Error).message });
        socket.close(4401, 'stream authorization failed');
      });
    });
    void chain.catch(() => socket.close(4401, 'authentication failed'));
  });
}
