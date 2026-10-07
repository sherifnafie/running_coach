import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accountUsable, newId, pairingCode, randomToken, Tier, TierConfig } from '@opencoach/protocol';
import { exportAthlete } from '@opencoach/workspace';
import type { GatewayContext } from '../http/context';
import { safeEqual } from '../http/auth';
import { conflict, notFound, unavailable } from '../http/errors';
import { sendFile } from '../http/static';
import { authenticated, enforceCsrf, pageLimit, params, query } from './shared';

type ExportJob = { status: 'pending' | 'ready' | 'failed'; path?: string };

export function accountRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const { store, clock, runtime, config } = ctx.deps;
  const auth = (request: FastifyRequest, reply: FastifyReply) => authenticated(ctx, request, reply);
  const admin = async (request: FastifyRequest, reply: FastifyReply) => { await ctx.requireAdmin(request, reply); enforceCsrf(ctx, request); ctx.trackRequest(request); };
  const inflightExports = new Map<string, Set<Promise<void>>>();
  const deleting = ctx.deletingAthletes;
  app.post('/v1/export', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    if (deleting.has(athleteId)) throw conflict('Account deletion is in progress.');
    if (inflightExports.get(athleteId)?.size) throw conflict('An export is already being prepared.');
    const jobId = newId('job', clock);
    const key = `export:${athleteId}:${jobId}`;
    await store.setKv(key, JSON.stringify({ status: 'pending' } satisfies ExportJob));
    const run = Promise.resolve().then(async () => {
      try {
        const path = await (ctx.deps.exportAthlete ?? exportAthlete)({ dataDir: config.dataDir, athleteId, store, clock });
        await store.setKv(key, JSON.stringify({ status: 'ready', path } satisfies ExportJob));
      } catch (error) {
        ctx.deps.logger.error('export failed', { athleteId, error: String(error) });
        await store.setKv(key, JSON.stringify({ status: 'failed' } satisfies ExportJob));
      }
    });
    let set = inflightExports.get(athleteId);
    if (!set) inflightExports.set(athleteId, set = new Set());
    set.add(run);
    void run.finally(() => { set!.delete(run); if (!set!.size) inflightExports.delete(athleteId); }).catch(() => undefined);
    return { jobId };
  });
  app.get('/v1/export/:jobId', { preHandler: auth }, async (request, reply) => {
    const raw = await store.getKv(`export:${ctx.athleteId(request)}:${params(request).jobId}`);
    if (!raw) throw notFound();
    const job = JSON.parse(raw) as ExportJob;
    if (job.status === 'pending') {
      if (!inflightExports.get(ctx.athleteId(request))?.size) throw unavailable('The export was interrupted. Start a new export.');
      return reply.code(202).send({ status: 'pending' });
    }
    if (job.status !== 'ready' || !job.path) throw unavailable('Export failed. Start a new export.');
    const st = await stat(job.path).catch(() => undefined);
    if (!st) throw notFound();
    return sendFile(request, reply, { path: job.path, size: st.size, mtimeMs: st.mtimeMs }, { contentType: 'application/gzip', cacheControl: 'no-store', attachmentName: basename(job.path) });
  });
  /**
   * Delete an account and everything it owns. Shared by self-service deletion and administrators, so both run the
   * same drains and hooks (calls ended, credentials forgotten, workspace and store rows removed).
   */
  async function deleteAccount(athleteId: string, request: FastifyRequest): Promise<void> {
    if (deleting.has(athleteId)) throw conflict('Account deletion is already in progress.');
    deleting.add(athleteId);
    try {
      ctx.sockets.closeAthlete(athleteId);
      await store.updateAthlete(athleteId, { status: 'deleted' });
      await ctx.drainRequests(athleteId, request);
      await Promise.all(inflightExports.get(athleteId) ?? []);
      if (ctx.deps.callService) {
        const started = await store.listEvents({ athleteId, types: ['call.started'], limit: 1_000_000 });
        for (const event of started) {
          if (event.type !== 'call.started') continue;
          // End live sessions before their timers/provider callbacks can recreate deleted files.
          try { await ctx.deps.callService.end(athleteId, event.payload.callId, 'athlete'); }
          catch (error) {
            const reason = (error as { reason?: string }).reason;
            if (reason !== 'call_not_found') throw error;
          }
        }
      }
      await ctx.deps.onAthleteDeleting?.(athleteId);
      await runtime.deleteAthlete(athleteId);
      await ctx.deps.onAthleteDeleted?.(athleteId);
    } catch (error) {
      // A provider/drain/filesystem failure should leave an existing account able to retry deletion.
      if (await store.getAthlete(athleteId)) await store.updateAthlete(athleteId, { status: 'active' });
      throw error;
    } finally { deleting.delete(athleteId); }
  }

  app.delete('/v1/account', { preHandler: auth }, async (request, reply) => {
    z.object({ confirm: z.literal('DELETE') }).parse(request.body);
    await deleteAccount(ctx.athleteId(request), request);
    ctx.clearSessionCookie(reply);
    reply.code(204).send();
  });

  // Start over with a fresh coach on the same account (role, sign-ins, keys and settings stay).
  app.post('/v1/account/reset', { preHandler: auth }, async (request, reply) => {
    z.object({ confirm: z.literal('RESET') }).parse(request.body);
    const athleteId = ctx.athleteId(request);
    if (deleting.has(athleteId)) throw conflict('Account deletion or reset is already in progress.');
    deleting.add(athleteId); // blocks exports and a concurrent delete while files are replaced
    try {
      await Promise.all(inflightExports.get(athleteId) ?? []);
      if (ctx.deps.callService) {
        for (const event of await store.listEvents({ athleteId, types: ['call.started'], limit: 1_000_000 })) {
          if (event.type !== 'call.started') continue;
          try { await ctx.deps.callService.end(athleteId, event.payload.callId, 'athlete'); }
          catch (error) { if ((error as { reason?: string }).reason !== 'call_not_found') throw error; }
        }
      }
      await runtime.resetAthlete(athleteId);
    } finally { deleting.delete(athleteId); }
    ctx.sockets.closeAthlete(athleteId); // clients reconnect and reload the fresh conversation
    reply.code(204).send();
  });

  // ---- administrators: suspend, reactivate or delete someone else's account
  /** The target of an admin action: an existing account other than the administrator's own. */
  async function otherAccount(request: FastifyRequest) {
    const athleteId = params(request).id!;
    const athlete = await store.getAthlete(athleteId);
    if (!athlete || athlete.status !== 'active') throw notFound('Unknown account.');
    if (athleteId === request.auth!.athleteId) throw conflict('You cannot do this to your own account here. Use Settings → Account & data for your own account.');
    return athlete;
  }
  app.post('/admin/athletes/:id/suspend', { preHandler: admin }, async (request) => {
    const athlete = await otherAccount(request);
    const at = clock.now().toISOString();
    if (!athlete.suspendedAt) await store.updateAthlete(athlete.id, { suspendedAt: at });
    // Sign out everywhere now; the session check also refuses suspended accounts on every request.
    for (const session of await store.listSessions(athlete.id)) await ctx.sessions.revoke(session.id);
    ctx.sockets.closeAthlete(athlete.id);
    await store.audit({ athleteId: athlete.id, at, actor: request.auth!.athleteId, action: 'account.suspended' });
    return { athlete: await store.getAthlete(athlete.id) };
  });
  app.post('/admin/athletes/:id/reactivate', { preHandler: admin }, async (request) => {
    const athlete = await otherAccount(request);
    if (athlete.suspendedAt) await store.updateAthlete(athlete.id, { suspendedAt: null });
    await store.audit({ athleteId: athlete.id, at: clock.now().toISOString(), actor: request.auth!.athleteId, action: 'account.reactivated' });
    return { athlete: await store.getAthlete(athlete.id) };
  });
  app.delete('/admin/athletes/:id', { preHandler: admin }, async (request, reply) => {
    const athlete = await otherAccount(request);
    z.object({ confirm: z.literal(athlete.displayName) }).parse(request.body);
    await deleteAccount(athlete.id, request);
    await store.audit({ at: clock.now().toISOString(), actor: request.auth!.athleteId, action: 'account.deleted_by_admin', detail: { athleteId: athlete.id } });
    reply.code(204).send();
  });
  async function calendarUrl(athleteId: string, rotate = false) {
    let token = (await store.getSettings(athleteId)).calendarToken;
    if (!token?.startsWith(`${athleteId}.`) || rotate) {
      token = `${athleteId}.${randomToken(32)}`;
      await store.updateSettings(athleteId, { calendarToken: token });
    }
    return { url: `${ctx.publicOrigin}/v1/exports/calendar.ics?token=${encodeURIComponent(token)}` };
  }
  app.get('/v1/settings/calendar-url', { preHandler: auth }, async (request) => calendarUrl(ctx.athleteId(request)));
  app.post('/v1/settings/calendar-url/rotate', { preHandler: auth }, async (request) => calendarUrl(ctx.athleteId(request), true));
  app.get('/v1/exports/calendar.ics', async (request, reply) => {
    ctx.limitAuth(request);
    const token = query(request).token;
    const athleteId = token?.split('.')[0];
    if (!token || !athleteId || !/^[A-Za-z0-9_-]{1,128}$/.test(athleteId) || token.length > 256 || !accountUsable(await store.getAthlete(athleteId))) throw notFound();
    const expected = (await store.getSettings(athleteId)).calendarToken;
    if (!expected || !safeEqual(token, expected)) throw notFound();
    const ics = await runtime.calendarIcs(athleteId);
    if (ics === undefined) throw notFound('Your coach has not created a calendar yet.');
    reply.header('Cache-Control', 'private, no-cache').header('Content-Disposition', 'inline; filename="coach.ics"').type('text/calendar; charset=utf-8');
    return ics;
  });
  app.get('/admin/athletes', { preHandler: admin }, async () => ({ athletes: await store.listAthletes() }));
  app.post('/admin/invites', { preHandler: admin }, async (request) => {
    const code = pairingCode();
    const expiresAt = new Date(clock.now().getTime() + 24 * 3600_000).toISOString();
    await store.createPairingCode({ code, purpose: 'invite', expiresAt, createdBy: request.auth!.athleteId });
    return { code, expiresAt };
  });
  app.get('/admin/costs', { preHandler: admin }, async (request) => ({ byDay: await store.usageByDay(query(request).athleteId, query(request).since ?? new Date(clock.now().getTime() - 30 * 24 * 3600_000).toISOString()) }));
  app.get('/admin/turns', { preHandler: admin }, async (request) => ({ turns: await store.listTurns({ athleteId: query(request).athleteId, beforeId: query(request).before, limit: pageLimit(query(request).limit) }) }));
  app.get('/admin/turns/:id', { preHandler: admin }, async (request) => {
    const turn = await store.getTurn(params(request).id!);
    if (!turn) throw notFound();
    return { turn, context: await store.getTurnContext(turn.id) };
  });
  app.post('/admin/turns/:id/replay', { preHandler: admin }, async (request) => {
    if (!await store.getTurn(params(request).id!)) throw notFound();
    const body = z.object({ tier: Tier.optional(), override: TierConfig.optional() }).parse(request.body ?? {});
    return runtime.replayTurn(params(request).id!, body);
  });
  app.post('/admin/athletes/:id/epoch', { preHandler: admin }, async (request, reply) => {
    if (!await store.getAthlete(params(request).id!)) throw notFound();
    await runtime.forceEpoch(params(request).id!);
    reply.code(204).send();
  });
  app.addHook('onClose', async () => { await Promise.all([...inflightExports.values()].flatMap((set) => [...set])); });
}
