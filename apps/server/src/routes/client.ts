import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  PostMessageRequest, VoiceNoteMetadata, UiActionRequest, ReactionRequest, ReadRequest, DeviceContextRequest,
  ViewQueryRequest, ViewFileRequest, ViewWriteRequest, ViewActRequest, ViewErrorRequest, ViewRevertRequest,
  PushSubscriptionRequest, CallCreateRequest, CallAttachRequest, Sha256, newId, IanaTimeZone,
} from '@opencoach/protocol';
import type { GatewayContext } from '../http/context';
import { badRequest, notFound, unavailable, tooMany } from '../http/errors';
import { sendFile } from '../http/static';
import { listVisibleEvents } from '../http/visibility';
import { authenticated, blobRef, ownedBlob, pageLimit, params, query, uploaded } from './shared';
import { storeUpload } from './upload-intake';

export function clientRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const { runtime, store, blobs, clock } = ctx.deps;
  const auth = (request: FastifyRequest, reply: FastifyReply) => authenticated(ctx, request, reply);
  const id = (r: FastifyRequest) => ctx.athleteId(r);
  const postMessageInflight = new Map<string, Promise<unknown>>();
  const voice = () => {
    if (!ctx.deps.callService) throw unavailable('Voice is not configured.', 'calls_unavailable');
    return ctx.deps.callService;
  };
  app.post('/v1/messages', { preHandler: auth }, async (request) => {
    const body = PostMessageRequest.parse(request.body);
    if (!body.text.trim() && !body.attachments?.length) throw badRequest('A message needs text or an attachment.');
    const athleteId = id(request);
    const key = `message:${athleteId}:${body.clientId}`;
    const stored = await store.getIdempotent(key);
    if (stored) return stored;
    const existing = postMessageInflight.get(key);
    if (existing) return existing;
    const run = (async () => {
      const attachments = await Promise.all((body.attachments ?? []).map((sha) => ownedBlob(ctx, athleteId, sha)));
      const event = await runtime.ingest(athleteId, { type: 'user.message', payload: { ...body, attachments } });
      const response = { event };
      await store.putIdempotent(key, response, new Date(clock.now().getTime() + 7 * 24 * 3600_000).toISOString());
      return response;
    })();
    postMessageInflight.set(key, run);
    try { return await run; } finally { postMessageInflight.delete(key); }
  });
  app.get('/v1/events', { preHandler: auth }, async (request) => {
    const q = query(request);
    return listVisibleEvents(store, id(request), { before: q.before, after: q.after, limit: pageLimit(q.limit) });
  });
  app.post('/v1/uploads', { preHandler: auth }, async (request) => {
    const file = await uploaded(request, 'file');
    const athleteId = id(request);
    return { blob: await storeUpload(ctx, athleteId, file) };
  });
  app.post('/v1/uploads/commit', { preHandler: auth }, async (request) => {
    const body = z.object({ blobs: z.array(Sha256).min(1).max(20), caption: z.string().max(4000).optional() }).parse(request.body);
    const refs = await Promise.all(body.blobs.map((sha) => ownedBlob(ctx, id(request), sha)));
    return { event: await runtime.ingest(id(request), { type: 'user.upload', payload: { blobs: refs, caption: body.caption } }) };
  });
  app.get('/v1/blobs/:sha', { preHandler: auth }, async (request, reply) => {
    const sha = Sha256.parse(params(request).sha);
    const ref = await ownedBlob(ctx, id(request), sha);
    const path = await blobs.path(id(request), sha);
    if (!path) throw notFound();
    const st = await stat(path);
    // HTML/SVG and other active content must not acquire the app's origin when opened directly.
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    const safeInline = /^(image\/(png|jpeg|gif|webp|avif)|audio\/|video\/)/.test(ref.mime);
    return sendFile(request, reply, { path, size: st.size, mtimeMs: st.mtimeMs }, { etag: sha, contentType: ref.mime,
      cacheControl: 'private, no-cache', ...(!safeInline ? { attachmentName: ref.name ?? sha } : {}) });
  });
  app.post('/v1/voice-notes', { preHandler: auth }, async (request) => {
    const service = voice();
    const file = await uploaded(request, 'audio');
    if (!file.mime.startsWith('audio/') && file.mime !== 'video/webm') throw badRequest('An audio file is required.');
    const duration = file.fields.durationS;
    let durationS: unknown;
    if (duration !== undefined) {
      if (Array.isArray(duration) || duration.type !== 'field' || typeof duration.value !== 'string' || !duration.value.trim()) throw badRequest('durationS must be a single numeric field.');
      durationS = Number(duration.value);
    }
    const metadata = VoiceNoteMetadata.parse({ durationS });
    const transcript = await service.transcribeVoiceNote(file.bytes, file.mime);
    const blob = blobRef(await blobs.put(id(request), file.bytes, { mime: file.mime, name: file.name, origin: 'athlete' }));
    return { event: await runtime.ingest(id(request), { type: 'user.voice_note', payload: { blob, transcript: transcript.text, transcriptModel: transcript.model, durationS: transcript.durationS ?? metadata.durationS ?? 0 } }) };
  });
  app.post('/v1/ui-actions', { preHandler: auth }, async (request) => {
    const body = UiActionRequest.parse(request.body);
    if (body.source.messageId) await ownedMessage(ctx, id(request), body.source.messageId);
    return { event: await runtime.ingest(id(request), { type: 'user.ui_action', payload: body }) };
  });
  app.post('/v1/ui-writes', { preHandler: auth }, async (request) => {
    const body = ViewWriteRequest.extend({ viewId: z.string().min(1) }).parse(request.body);
    return { event: await runtime.views.write(id(request), body.viewId, body) };
  });
  app.post('/v1/reactions', { preHandler: auth }, async (request) => {
    const body = ReactionRequest.parse(request.body);
    await ownedMessage(ctx, id(request), body.messageId);
    return { event: await runtime.ingest(id(request), { type: 'user.reaction', payload: body }) };
  });
  app.post('/v1/read', { preHandler: auth }, async (request) => {
    const body = ReadRequest.parse(request.body);
    await Promise.all(body.messageIds.map((messageId) => ownedMessage(ctx, id(request), messageId)));
    return { event: await runtime.ingest(id(request), { type: 'user.read', payload: body }) };
  });
  app.post('/v1/device-context', { preHandler: auth }, async (request) => ({ event: await runtime.ingest(id(request), { type: 'device.context', payload: DeviceContextRequest.extend({ tz: IanaTimeZone }).parse(request.body) }) }));
  app.get('/v1/app', { preHandler: auth }, async (request) => runtime.views.appInfo(id(request)));
  app.post('/v1/views/:id/query', { preHandler: auth }, async (request) => {
    const body = ViewQueryRequest.parse(request.body);
    return runtime.views.query(id(request), params(request).id!, body.sql, body.params);
  });
  app.post('/v1/views/:id/file', { preHandler: auth }, async (request, reply) => {
    const body = ViewFileRequest.parse(request.body);
    const text = await runtime.views.readFile(id(request), params(request).id!, body.path);
    return reply.type('application/json').send(JSON.stringify(text));
  });
  app.post('/v1/views/:id/write', { preHandler: auth }, async (request) => ({ event: await runtime.views.write(id(request), params(request).id!, ViewWriteRequest.parse(request.body)) }));
  app.post('/v1/views/:id/act', { preHandler: auth }, async (request) => ({ event: await runtime.views.act(id(request), params(request).id!, ViewActRequest.parse(request.body)) }));
  app.post('/v1/views/:id/error', { preHandler: auth }, async (request) => {
    const viewId = params(request).id!;
    const body = ViewErrorRequest.parse(request.body);
    if (!await store.getUiVersion(id(request), viewId, body.version)) throw notFound('Unknown published view version.');
    const r = ctx.limits.viewErrors.take(`${id(request)}:${viewId}`);
    if (!r.ok) throw tooMany(r.retryAfterSec);
    return { event: await runtime.ingest(id(request), { type: 'ui.error', payload: { viewId, version: body.version, message: body.message, stack: body.stack, device: { ua: (request.headers['user-agent'] ?? '').slice(0, 500), viewport: body.viewport } } }) };
  });
  app.get('/v1/views/:id/versions', { preHandler: auth }, async (request) => {
    const versions = await runtime.views.versions(id(request), params(request).id!);
    return versions.map(({ dir: _dir, ...version }) => version);
  });
  app.post('/v1/views/:id/revert', { preHandler: auth }, async (request) => {
    const body = ViewRevertRequest.parse(request.body ?? {});
    const { dir: _dir, ...version } = await runtime.views.revert(id(request), params(request).id!, body.toVersion);
    return version;
  });
  app.get('/v1/changes', { preHandler: auth }, async (request) => ({ changes: await runtime.listChanges(id(request), { before: query(request).before, limit: pageLimit(query(request).limit) }) }));
  app.post('/v1/calls', { preHandler: auth }, async (request) => voice().start(id(request), CallCreateRequest.parse(request.body ?? {})));
  app.post('/v1/calls/:id/attach', { preHandler: auth }, async (request, reply) => {
    const body = CallAttachRequest.parse(request.body);
    await voice().attach(id(request), params(request).id!, body.providerCallId);
    reply.code(204).send();
  });
  app.post('/v1/calls/:id/utterance', { preHandler: auth }, async (request) => {
    const file = await uploaded(request, 'audio');
    const result = await voice().utterance(id(request), params(request).id!, file.bytes, file.mime);
    return { transcript: result.transcript, replyText: result.replyText, ...(result.audioSha256 ? { audioUrl: `/v1/blobs/${result.audioSha256}` } : {}) };
  });
  app.post('/v1/calls/:id/end', { preHandler: auth }, async (request, reply) => {
    await voice().end(id(request), params(request).id!, 'athlete');
    reply.code(204).send();
  });
  // Live dictation: mint a transcription session; the browser streams audio to the provider directly.
  const dictation = () => {
    if (!ctx.deps.dictation?.available()) throw unavailable('Live dictation is not configured on this server.', 'dictation_unavailable');
    return ctx.deps.dictation;
  };
  app.post('/v1/dictation', { preHandler: auth }, async (request) => dictation().start(id(request)));
  app.post('/v1/dictation/:id/end', { preHandler: auth }, async (request, reply) => {
    await dictation().end(id(request), params(request).id!);
    reply.code(204).send();
  });
  app.get('/v1/push/vapid-public-key', { preHandler: auth }, async () => {
    if (!ctx.deps.vapidPublicKey) throw unavailable('Push notifications are not configured.');
    return { key: ctx.deps.vapidPublicKey };
  });
  app.post('/v1/push/subscriptions', { preHandler: auth }, async (request) => {
    const body = PushSubscriptionRequest.parse(request.body);
    if (ctx.deps.validatePushEndpoint) await ctx.deps.validatePushEndpoint(body.endpoint);
    else {
      const u = new URL(body.endpoint);
      // Explicitly allow known browser push services: arbitrary endpoints are server-side request targets.
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[^.]+\.notify\.windows\.com|web\.push\.apple\.com)$/.test(u.hostname)) throw badRequest('Unsupported push endpoint.');
    }
    const athleteId = id(request);
    const existing = (await store.listPushSubscriptions(athleteId)).find((s) => s.endpoint === body.endpoint);
    const subscriptionId = existing?.id ?? newId('up', clock);
    await store.addPushSubscription({ id: subscriptionId, athleteId, kind: 'webpush', ...body, userAgent: request.headers['user-agent'], createdAt: clock.now().toISOString() });
    return { id: subscriptionId };
  });
  app.delete('/v1/push/subscriptions', { preHandler: auth }, async (request, reply) => {
    const body = z.object({ endpoint: z.string().url() }).parse(request.body);
    for (const sub of await store.listPushSubscriptions(id(request))) if (sub.endpoint === body.endpoint) await store.deletePushSubscription(sub.id);
    reply.code(204).send();
  });
  app.post('/v1/sync/health', { preHandler: auth }, async (request) => {
    const body = z.object({ source: z.enum(['health_connect', 'healthkit']), range: z.tuple([z.iso.datetime(), z.iso.datetime()]), workouts: z.array(z.unknown()).max(10_000) }).parse(request.body);
    const blob = blobRef(await blobs.put(id(request), Buffer.from(JSON.stringify(body)), { mime: 'application/json', origin: 'sync', name: `${body.source}.json` }));
    return { event: await runtime.appendSystemEvent({ athleteId: id(request), actor: 'harness', type: 'data.synced', payload: { source: body.source, range: body.range, blobs: [blob] } }) };
  });
  if (ctx.deps.telegram) {
    app.post('/v1/settings/telegram/link', { preHandler: auth }, async (request) => ({ code: await ctx.deps.telegram!.createLinkCode(id(request)) }));
    app.delete('/v1/settings/telegram', { preHandler: auth }, async (request, reply) => { await ctx.deps.telegram!.unlink(id(request)); reply.code(204).send(); });
  }
}

export async function ownedMessage(ctx: GatewayContext, athleteId: string, messageId: string): Promise<void> {
  const event = await ctx.deps.store.getEvent(messageId);
  if (event?.athleteId === athleteId && event.type === 'user.message') return;
  const state = await ctx.deps.store.getMessageState(messageId);
  if (state?.athleteId === athleteId && state.delivery === 'sent') return;
  throw notFound('Unknown message.');
}
