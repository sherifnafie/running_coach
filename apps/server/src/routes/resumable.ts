import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { athletePaths, newId, type BlobRef } from '@opencoach/protocol';
import type { GatewayContext } from '../http/context';
import { badRequest, conflict, forbidden, HttpError, notFound, tooMany } from '../http/errors';
import { authenticated, params } from './shared';
import { storeUpload } from './upload-intake';

/** tus creation/offset protocol: 25 MiB per upload, at most five unfinished drafts, expiry after one hour. */
export const RESUMABLE_MAX_BYTES = 25 * 1024 * 1024;
const TTL_MS = 60 * 60_000;
const ID = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
type Draft = { length: number; offset: number; expiresAt: number; mime: string; name?: string; blob?: BlobRef };

export async function resumableRoutes(app: FastifyInstance, ctx: GatewayContext): Promise<void> {
  const { store, clock, config } = ctx.deps;
  const locks = new Map<string, Promise<unknown>>();
  const timers = new Map<string, AbortController>();
  const background = new Set<Promise<unknown>>();
  const auth = (request: FastifyRequest, reply: FastifyReply) => authenticated(ctx, request, reply);
  const keyFor = (athleteId: string, uploadId: string) => `upload-draft:${athleteId}:${uploadId}`;
  const indexFor = (athleteId: string) => `upload-drafts:${athleteId}`;
  const rootFor = (athleteId: string) => join(athletePaths(config.dataDir, athleteId).tmp, 'resumable');
  const fileFor = (athleteId: string, uploadId: string) => join(rootFor(athleteId), uploadId);
  const owner = (request: FastifyRequest) => ctx.athleteId(request);

  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    locks.set(key, run);
    void run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => undefined);
    return run;
  }
  async function index(athleteId: string): Promise<string[]> {
    const raw = await store.getKv(indexFor(athleteId));
    return raw ? (JSON.parse(raw) as string[]).filter((id) => ID.test(id)) : [];
  }
  async function load(athleteId: string, uploadId: string): Promise<Draft> {
    if (!ID.test(uploadId)) throw notFound();
    const raw = await store.getKv(keyFor(athleteId, uploadId));
    if (!raw) throw notFound();
    const draft = JSON.parse(raw) as Draft;
    if (draft.expiresAt <= clock.now().getTime()) throw notFound('Upload draft expired. Start a new upload.');
    return draft;
  }
  function headers(reply: FastifyReply, draft?: Draft) {
    reply.header('Tus-Resumable', '1.0.0').header('Tus-Version', '1.0.0').header('Tus-Extension', 'creation,expiration,termination').header('Tus-Max-Size', RESUMABLE_MAX_BYTES);
    if (draft) {
      reply.header('Upload-Length', draft.length).header('Upload-Offset', draft.offset).header('Upload-Expires', new Date(draft.expiresAt).toUTCString());
      if (draft.blob) reply.header('Upload-Blob-Sha256', draft.blob.sha256).header('Upload-Complete', 'true');
    }
  }
  function version(request: FastifyRequest, reply: FastifyReply) {
    headers(reply);
    if (request.headers['tus-resumable'] !== '1.0.0') throw new HttpError(412, 'unsupported_tus_version', 'Tus-Resumable: 1.0.0 is required.');
  }
  async function expire(athleteId: string, uploadId: string) {
    await serial(keyFor(athleteId, uploadId), async () => {
      await rm(fileFor(athleteId, uploadId), { force: true });
      // Deletion owns all state once the athlete is disabled. Do not recreate KV rows after deletion.
      if ((await store.getAthlete(athleteId))?.status !== 'active') return;
      await store.setKv(keyFor(athleteId, uploadId), '');
      await serial(indexFor(athleteId), async () => store.setKv(indexFor(athleteId), JSON.stringify((await index(athleteId)).filter((id) => id !== uploadId))));
    });
  }
  function arm(athleteId: string, uploadId: string, draft: Draft) {
    const key = keyFor(athleteId, uploadId);
    timers.get(key)?.abort();
    const controller = new AbortController();
    timers.set(key, controller);
    const run = clock.sleepUntil(new Date(draft.expiresAt), controller.signal).then(async () => {
      timers.delete(key);
      await expire(athleteId, uploadId);
    }, () => undefined).catch((error) => ctx.deps.logger.warn('upload draft cleanup failed', { error: String(error) }));
    background.add(run);
    void run.finally(() => background.delete(run));
  }
  async function secureRoot(athleteId: string) {
    const tmp = athletePaths(config.dataDir, athleteId).tmp;
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const tmpStat = await lstat(tmp);
    if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) throw forbidden('Unsafe upload directory.');
    const root = rootFor(athleteId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw forbidden('Unsafe upload directory.');
  }

  app.addContentTypeParser('application/offset+octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.post('/v1/uploads/resumable', { preHandler: auth, bodyLimit: 1024 }, async (request, reply) => {
    version(request, reply);
    const value = request.headers['upload-length'];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw badRequest('Upload-Length must be a positive integer.');
    const length = Number(value);
    if (!Number.isSafeInteger(length) || length < 1) throw badRequest('Upload-Length must be a positive integer.');
    if (length > RESUMABLE_MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'Uploads are limited to 25 MiB.');
    const metadata = readMetadata(request.headers['upload-metadata']);
    const athleteId = owner(request);
    return serial(indexFor(athleteId), async () => {
      const existing = await index(athleteId);
      const live: string[] = [];
      let unfinished = 0;
      for (const id of existing) {
        const raw = await store.getKv(keyFor(athleteId, id));
        const draft = raw ? JSON.parse(raw) as Draft : undefined;
        if (!draft || draft.expiresAt <= clock.now().getTime()) {
          timers.get(keyFor(athleteId, id))?.abort();
          timers.delete(keyFor(athleteId, id));
          await rm(fileFor(athleteId, id), { force: true });
          await store.setKv(keyFor(athleteId, id), '');
        } else { live.push(id); if (!draft.blob) unfinished++; }
      }
      if (unfinished >= 5) throw tooMany(60, 'Finish or cancel an upload before starting another.');
      const uploadId = newId('job', clock);
      await secureRoot(athleteId);
      const file = await open(fileFor(athleteId, uploadId), 'wx', 0o600);
      await file.close();
      const draft: Draft = { length, offset: 0, expiresAt: clock.now().getTime() + TTL_MS, mime: metadata.filetype ?? 'application/octet-stream', name: metadata.filename };
      await store.setKv(keyFor(athleteId, uploadId), JSON.stringify(draft));
      await store.setKv(indexFor(athleteId), JSON.stringify([...live, uploadId]));
      arm(athleteId, uploadId, draft);
      headers(reply, draft);
      return reply.header('Location', `/v1/uploads/resumable/${uploadId}`).code(201).send();
    });
  });
  app.head('/v1/uploads/resumable/:id', { preHandler: auth }, async (request, reply) => {
    version(request, reply);
    headers(reply, await load(owner(request), params(request).id!));
    return reply.code(200).send();
  });
  app.get('/v1/uploads/resumable/:id', { preHandler: auth }, async (request, reply) => {
    const draft = await load(owner(request), params(request).id!);
    headers(reply, draft);
    return draft.blob ? { blob: draft.blob } : { offset: draft.offset, length: draft.length, expiresAt: new Date(draft.expiresAt).toISOString() };
  });
  app.patch('/v1/uploads/resumable/:id', { preHandler: auth, bodyLimit: RESUMABLE_MAX_BYTES }, async (request, reply) => {
    version(request, reply);
    if ((request.headers['content-type'] ?? '').split(';')[0] !== 'application/offset+octet-stream' || !Buffer.isBuffer(request.body)) throw new HttpError(415, 'unsupported_media_type', 'PATCH requires application/offset+octet-stream.');
    const offsetValue = request.headers['upload-offset'];
    if (typeof offsetValue !== 'string' || !/^\d+$/.test(offsetValue)) throw badRequest('Upload-Offset is required.');
    const athleteId = owner(request); const uploadId = params(request).id!;
    return serial(keyFor(athleteId, uploadId), async () => {
      const draft = await load(athleteId, uploadId);
      headers(reply, draft);
      if (Number(offsetValue) !== draft.offset) throw conflict('Upload offset does not match.', 'upload_offset_mismatch');
      const bytes = request.body as Buffer;
      if (bytes.length > draft.length - draft.offset) throw new HttpError(413, 'payload_too_large', 'Chunk exceeds the declared upload length.');
      if (!draft.blob) {
        await secureRoot(athleteId);
        let file;
        let completedBytes: Buffer | undefined;
        try { file = await open(fileFor(athleteId, uploadId), constants.O_RDWR | constants.O_NOFOLLOW); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw forbidden('Unsafe upload file.'); throw error; }
        try {
          const st = await file.stat();
          if (!st.isFile() || st.size < draft.offset) throw conflict('Upload draft is incomplete. Start a new upload.');
          // A crash after bytes were written but before the offset was recorded leaves a disposable tail.
          await file.truncate(draft.offset);
          for (let written = 0; written < bytes.length;) {
            const result = await file.write(bytes, written, bytes.length - written, draft.offset + written);
            if (!result.bytesWritten) throw new Error('Upload chunk could not be written.');
            written += result.bytesWritten;
          }
          await file.sync();
          if (draft.offset + bytes.length === draft.length) completedBytes = await file.readFile();
        } finally { await file.close(); }
        draft.offset += bytes.length;
        await store.setKv(keyFor(athleteId, uploadId), JSON.stringify(draft));
        if (draft.offset === draft.length) {
          draft.blob = await storeUpload(ctx, athleteId, { bytes: completedBytes!, mime: draft.mime, name: draft.name });
          await store.setKv(keyFor(athleteId, uploadId), JSON.stringify(draft));
          await rm(fileFor(athleteId, uploadId), { force: true });
        }
      }
      headers(reply, draft);
      return reply.code(204).send();
    });
  });
  app.delete('/v1/uploads/resumable/:id', { preHandler: auth }, async (request, reply) => {
    version(request, reply);
    const athleteId = owner(request); const uploadId = params(request).id!;
    await load(athleteId, uploadId);
    timers.get(keyFor(athleteId, uploadId))?.abort();
    timers.delete(keyFor(athleteId, uploadId));
    await expire(athleteId, uploadId);
    return reply.code(204).send();
  });
  // Restore expiration timers for persisted drafts after a restart.
  for (const athlete of await store.listAthletes()) {
    if (athlete.status !== 'active') continue;
    for (const uploadId of await index(athlete.id)) {
      const raw = await store.getKv(keyFor(athlete.id, uploadId));
      if (raw) arm(athlete.id, uploadId, JSON.parse(raw) as Draft);
    }
  }
  app.addHook('onClose', async () => {
    for (const timer of timers.values()) timer.abort();
    timers.clear();
    await Promise.all(background);
  });
}

function readMetadata(header: string | string[] | undefined): Record<string, string> {
  if (header === undefined) return {};
  if (typeof header !== 'string' || header.length > 4096) throw badRequest('Invalid Upload-Metadata.');
  const result: Record<string, string> = {};
  for (const item of header.split(',')) {
    const [key, encoded = '', extra] = item.trim().split(' ');
    if (!key || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(key) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw badRequest('Invalid Upload-Metadata.');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (decoded.includes('\0') || decoded.length > 255) throw badRequest('Invalid upload metadata value.');
    result[key] = key === 'filename' ? basename(decoded.replace(/\\/g, '/')) : decoded;
  }
  if (result.filetype && !/^[A-Za-z0-9!#$&^_+.-]+\/[A-Za-z0-9!#$&^_+.-]+$/.test(result.filetype)) throw badRequest('Invalid upload media type.');
  return result;
}
