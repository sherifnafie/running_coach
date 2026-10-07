import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pairingCode, type ModelCatalogEntry } from '@opencoach/protocol';
import { localDayStartIso, localMonthStartIso } from '@opencoach/runtime';
import type { GatewayContext } from '../http/context';
import { pkcePair, verifyOpenRouterKey } from '../credentials';
import { badRequest, forbidden, notFound, unavailable } from '../http/errors';
import { authenticated, enforceCsrf, params } from './shared';

/**
 * Who pays for the coach and what it may cost (SPEC §5.7, [COST-1], [SEC-1]).
 *
 * - managed: the deployment's OpenRouter key, or a per-athlete key an administrator assigned. The monthly budget is
 *   a hard allowance only an administrator can change.
 * - byok: the athlete connected their own OpenRouter key (pasted or through OpenRouter's OAuth PKCE flow). They set
 *   their own soft budgets and model; OpenRouter enforces whatever limit they put on the key.
 *
 * Keys are never returned to clients; responses carry a masked hint only.
 */
const OAUTH_TTL_MS = 10 * 60_000;
const RECOVERY_TTL_MS = 30 * 60_000;
const Budgets = z.object({ dailyUsd: z.number().min(0).max(1000), monthlyUsd: z.number().min(0).max(10_000) }).strict();
const KeyBody = z.object({ key: z.string().trim().min(1).max(512) }).strict();
const ModelBody = z.object({ model: z.string().min(1).max(200) }).strict();

export function aiRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const { store, runtime, clock, credentials, models } = ctx.deps;
  const auth = (request: FastifyRequest, reply: FastifyReply) => authenticated(ctx, request, reply);
  const admin = async (request: FastifyRequest, reply: FastifyReply) => { await ctx.requireAdmin(request, reply); enforceCsrf(ctx, request); ctx.trackRequest(request); };

  function requireModels() {
    if (!credentials || !models) throw unavailable('Model access is not configured on this server (no OpenRouter provider).', 'not_configured');
    return { credentials, models };
  }

  async function summary(athleteId: string) {
    const { credentials, models } = requireModels();
    const settings = await store.getSettings(athleteId);
    const billing = credentials.billing(athleteId);
    const chosen = settings.models.coach?.provider === 'openrouter' ? settings.models.coach.model : undefined;
    return {
      billing,
      openrouterKey: credentials.summary(athleteId, 'openrouter') ?? null,
      model: chosen ?? models.defaultModel,
      defaultModel: models.defaultModel,
      catalog: models.catalog.map((m: ModelCatalogEntry) => ({ id: m.id, label: m.label, description: m.description, vision: m.vision })),
      budgets: settings.budgets,
      usage: await usageSummary(athleteId),
    };
  }

  /** Same windows as the budget checks: the athlete's local day and month. */
  async function usageSummary(athleteId: string) {
    const now = clock.now();
    const tz = (await store.getSettings(athleteId)).profile.tz;
    return {
      todayUsd: (await store.sumUsage(athleteId, localDayStartIso(now, tz))).costUsd,
      monthUsd: (await store.sumUsage(athleteId, localMonthStartIso(now, tz))).costUsd,
    };
  }

  async function setModel(athleteId: string, model: string) {
    const { models } = requireModels();
    if (!models.catalog.some((m) => m.id === model)) throw badRequest('Choose one of the offered models.');
    await runtime.updateSettings(athleteId, {
      models: { coach: { provider: 'openrouter', model }, deep: { provider: 'openrouter', model, effort: 'high' } },
    });
  }

  async function storeKey(athleteId: string, key: string, owner: 'athlete' | 'admin') {
    const { credentials, models } = requireModels();
    try {
      await verifyOpenRouterKey(key, { baseUrl: models.openrouterBaseUrl });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    return credentials.set(athleteId, 'openrouter', key, owner);
  }

  async function target(request: FastifyRequest): Promise<string> {
    const id = params(request).id!;
    const athlete = await store.getAthlete(id);
    if (!athlete || athlete.status !== 'active') throw notFound('Unknown athlete.');
    return id;
  }

  // ---------------------------------------------------------------- athlete

  app.get('/v1/ai', { preHandler: auth }, async (request) => summary(ctx.athleteId(request)));

  app.put('/v1/ai/openrouter-key', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const { key } = KeyBody.parse(request.body);
    await storeKey(athleteId, key, 'athlete');
    return summary(athleteId);
  });

  app.delete('/v1/ai/openrouter-key', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const { credentials } = requireModels();
    if (credentials.summary(athleteId, 'openrouter')?.owner !== 'athlete') throw forbidden('Only a key you connected yourself can be removed here.');
    await credentials.clear(athleteId, 'openrouter');
    return summary(athleteId);
  });

  app.put('/v1/ai/model', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const { credentials } = requireModels();
    if (credentials.billing(athleteId) !== 'byok' && !request.auth!.isAdmin) throw forbidden('Your administrator chooses the model. Connect your own OpenRouter key to choose it yourself.', 'managed_billing');
    await setModel(athleteId, ModelBody.parse(request.body).model);
    return summary(athleteId);
  });

  /** OpenRouter OAuth PKCE (https://openrouter.ai/docs/use-cases/oauth-pkce): returns the URL to send the browser to. */
  app.post('/v1/ai/openrouter/oauth/start', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const { models } = requireModels();
    const { verifier, challenge } = pkcePair();
    await store.setKv(`oauth-openrouter:${athleteId}`, JSON.stringify({ verifier, expiresAt: clock.now().getTime() + OAUTH_TTL_MS }));
    const url = new URL('/auth', new URL(models.openrouterBaseUrl).origin);
    url.searchParams.set('callback_url', `${ctx.publicOrigin}/`);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString() };
  });

  app.post('/v1/ai/openrouter/oauth/finish', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const { models } = requireModels();
    const { code } = z.object({ code: z.string().min(1).max(512) }).strict().parse(request.body);
    const kvKey = `oauth-openrouter:${athleteId}`;
    const pending = await store.getKv(kvKey);
    await store.setKv(kvKey, JSON.stringify({ verifier: '', expiresAt: 0 }));
    const state = pending ? (JSON.parse(pending) as { verifier: string; expiresAt: number }) : undefined;
    if (!state?.verifier || state.expiresAt <= clock.now().getTime()) throw badRequest('The OpenRouter sign-in expired. Start again from Settings.');
    let res: Response;
    try {
      res = await fetch(`${models.openrouterBaseUrl.replace(/\/+$/, '')}/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: state.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw unavailable('Could not reach OpenRouter. Try again in a moment.');
    }
    const body = (await res.json().catch(() => ({}))) as { key?: unknown };
    if (!res.ok || typeof body.key !== 'string') throw badRequest('OpenRouter did not accept the sign-in. Start again from Settings.');
    await storeKey(athleteId, body.key, 'athlete');
    return summary(athleteId);
  });

  // ---------------------------------------------------------------- administrator

  app.get('/admin/athletes/:id/ai', { preHandler: admin }, async (request) => summary(await target(request)));

  app.put('/admin/athletes/:id/budgets', { preHandler: admin }, async (request) => {
    const athleteId = await target(request);
    await runtime.updateSettings(athleteId, { budgets: Budgets.parse(request.body) });
    return summary(athleteId);
  });

  app.put('/admin/athletes/:id/model', { preHandler: admin }, async (request) => {
    const athleteId = await target(request);
    await setModel(athleteId, ModelBody.parse(request.body).model);
    return summary(athleteId);
  });

  /** A managed per-athlete key, e.g. one with its own credit limit set in the OpenRouter dashboard. */
  app.put('/admin/athletes/:id/openrouter-key', { preHandler: admin }, async (request) => {
    const athleteId = await target(request);
    const { credentials } = requireModels();
    if (credentials.summary(athleteId, 'openrouter')?.owner === 'athlete') throw forbidden('This athlete uses their own key.');
    await storeKey(athleteId, KeyBody.parse(request.body).key, 'admin');
    return summary(athleteId);
  });

  app.delete('/admin/athletes/:id/openrouter-key', { preHandler: admin }, async (request) => {
    const athleteId = await target(request);
    const { credentials } = requireModels();
    if (credentials.summary(athleteId, 'openrouter')?.owner !== 'admin') throw forbidden('Only an administrator-assigned key can be removed here.');
    await credentials.clear(athleteId, 'openrouter');
    return summary(athleteId);
  });

  /** Account recovery: a one-time device pairing code for another athlete who lost access to all devices. */
  app.post('/admin/athletes/:id/recovery-code', { preHandler: admin }, async (request) => {
    const athleteId = await target(request);
    const code = pairingCode();
    const expiresAt = new Date(clock.now().getTime() + RECOVERY_TTL_MS).toISOString();
    await store.createPairingCode({ code, purpose: 'link_device', athleteId, createdBy: request.auth!.athleteId, expiresAt });
    await store.audit({ athleteId, at: clock.now().toISOString(), actor: request.auth!.athleteId, action: 'recovery_code_issued' });
    return { code, expiresAt };
  });
}
