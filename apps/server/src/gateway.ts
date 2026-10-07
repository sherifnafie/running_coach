import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { kitDistDir } from '@opencoach/ui-kit';
import { athleteForViewToken } from '@opencoach/runtime';
import { createContext, type GatewayDeps } from './http/context';
import { appSecurityHeaders, viewsSecurityHeaders } from './http/security';
import { forbidden, notFound, toApiError, toHttpError } from './http/errors';
import { resolveSafeFile, sendFile } from './http/static';
import { SocketRegistry } from './http/sockets';
import { authRoutes } from './routes/auth';
import { clientRoutes } from './routes/client';
import { accountRoutes } from './routes/account';
import { aiRoutes } from './routes/ai';
import { streamRoutes } from './routes/stream';
import { resumableRoutes } from './routes/resumable';
import { DEFAULT_WEB_DIST } from './paths';

export type { GatewayDeps } from './http/context';

/** Build both HTTP listeners; composition owns their listen/close lifecycle. */
export async function createGateway(deps: GatewayDeps) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: deps.config.trustProxy });
  const views = Fastify({ logger: false });
  const context = createContext(deps, new SocketRegistry());
  if (context.publicOrigin === context.viewsOrigin) throw new Error('Views must use a separate origin [SEC-3].');
  configureErrors(app, deps);
  configureErrors(views, deps);
  app.decorateRequest('auth', null);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10, parts: 11 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addHook('onRequest', async (_request, reply) => {
    for (const [k, v] of Object.entries(appSecurityHeaders(deps.config))) reply.header(k, v);
    reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onResponse', async (request) => { context.finishRequest(request); });
  app.addHook('onSend', async (request, reply, payload) => {
    // The handler has finished its work. A cancelled browser response may never reach onResponse.
    // Register here (not on request abort) so unfinished writes still block hard deletion.
    if (reply.raw.destroyed) context.finishRequest(request);
    else reply.raw.once('close', () => context.finishRequest(request));
    return payload;
  });
  app.addHook('preHandler', async (request) => {
    // Browser requests to credential endpoints are origin-checked even before they have a session.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin && request.headers.origin !== context.publicOrigin) {
      throw forbidden('Request origin does not match the app.', 'invalid_origin');
    }
  });
  authRoutes(app, context);
  clientRoutes(app, context);
  accountRoutes(app, context);
  aiRoutes(app, context);
  streamRoutes(app, context);
  await resumableRoutes(app, context);
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/v1/') || request.url.startsWith('/admin/')) throw notFound();
    const pathname = request.url.split('?')[0] ?? '/';
    const root = deps.webDist ?? DEFAULT_WEB_DIST;
    const rel = pathname.replace(/^\/+/, '') || 'index.html';
    const file = await resolveSafeFile(root, rel) ?? (!rel.includes('.') ? await resolveSafeFile(root, 'index.html') : undefined);
    if (!file) throw notFound('Build the web app before starting the server.');
    return sendFile(request, reply, file, { cacheControl: rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  });
  views.addHook('onRequest', async (_request, reply) => {
    for (const [k, v] of Object.entries(viewsSecurityHeaders(deps.config))) reply.header(k, v);
  });
  views.get('/kit/1/*', async (request, reply) => {
    const rel = (request.params as { '*': string })['*'];
    const file = await resolveSafeFile(deps.kitDir ?? await kitDistDir(), rel);
    if (!file) throw notFound();
    return sendFile(request, reply, file, { cacheControl: 'public, max-age=31536000, immutable' });
  });
  views.get('/v/:token/:bundle/*', async (request, reply) => {
    const { token, bundle, '*': rel } = request.params as { token: string; bundle: string; '*': string };
    const match = /^([a-z0-9][a-z0-9-]{0,31})@([0-9]+)$/.exec(bundle);
    if (!match) throw notFound();
    const athleteId = await athleteForViewToken(deps.store, token);
    if (!athleteId || (await deps.store.getAthlete(athleteId))?.status !== 'active') throw notFound();
    const record = await deps.store.getUiVersion(athleteId, match[1]!, match[2]!);
    if (!record) throw notFound();
    const file = await resolveSafeFile(record.dir, rel || record.manifest.entry);
    if (!file) throw notFound();
    return sendFile(request, reply, file, { cacheControl: 'private, max-age=31536000, immutable' });
  });
  await Promise.all([app.ready(), views.ready()]);
  return { app, views, context };
}

function configureErrors(app: FastifyInstance, deps: GatewayDeps): void {
  app.setErrorHandler((error, _request, reply) => {
    const err = toHttpError(error);
    if (err.status >= 500) deps.logger.error('gateway request failed', { error: (error as Error).message });
    for (const [k, v] of Object.entries(err.headers ?? {})) reply.header(k, v);
    reply.code(err.status).send(toApiError(err));
  });
}
