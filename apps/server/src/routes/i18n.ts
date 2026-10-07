import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { labelLanguage, languageDirection } from '@opencoach/protocol';
import type { GatewayContext } from '../http/context';
import { badRequest } from '../http/errors';
import { params } from './shared';

/**
 * GET /v1/i18n/:locale → interface labels for any language (no secrets: these are the app's own built-in strings). `ready: false` means the pack is being generated; the
 * client keeps English and asks again shortly. Curated languages (en, nl, ar) answer with an empty map.
 */
export function i18nRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  // Signed-in requests may start generating a pack; anonymous ones (sign-in and setup screens) only read existing packs.
  const optionalAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    await ctx.requireAuth(request, reply).catch(() => undefined);
    if (!request.auth) ctx.limitAuth(request);
  };
  app.get('/v1/i18n/:locale', { preHandler: optionalAuth }, async (request, reply) => {
    const locale = params(request).locale ?? '';
    if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,3}$/.test(locale)) throw badRequest('Unknown language tag.');
    const language = labelLanguage(locale);
    const pack = ctx.deps.labelPacks ? await ctx.deps.labelPacks.get(locale, { generate: !!request.auth }) : { language, ready: true, labels: {} };
    reply.header('Cache-Control', 'no-store');
    return { ...pack, dir: languageDirection(locale) };
  });
}
