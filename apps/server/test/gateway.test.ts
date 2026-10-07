import { mkdtemp, mkdir, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  ModelCatalogEntry, ServerConfig, VirtualClock, defaultSettings, newId, type CoachRuntimeAPI, type StreamListener, type StreamMessage,
  type InboundEventInput, type Logger, type Store, type AnyEvent,
  athletePaths,
} from '@opencoach/protocol';
import { openSqliteStore } from '@opencoach/store';
import { createFsBlobStore } from '@opencoach/workspace';
import type { CallService } from '@opencoach/voice';
import { createGateway } from '../src/gateway';
import { CredentialService, CredentialVault, keyHint } from '../src/credentials';
import { DEFAULT_OPENROUTER_CATALOG, DEFAULT_OPENROUTER_MODEL } from '@opencoach/engine';
import { SetupCodeManager, issueSetupCode } from '../src/setup-code';
import { SESSION_COOKIE, CSRF_COOKIE, sha256Hex } from '../src/http/auth';
import { RESUMABLE_MAX_BYTES } from '../src/routes/resumable';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(opts: { ai?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-gateway-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const clock = new VirtualClock('2026-10-06T10:00:00.000Z');
  const store = await openSqliteStore({ path: ':memory:', clock });
  cleanups.push(() => store.close());
  const config = ServerConfig.parse({ dataDir: dir, publicUrl: 'http://localhost:8080', viewsUrl: 'http://localhost:8081', demo: true });
  const listeners = new Map<string, Set<StreamListener>>();
  function emit(athleteId: string, message: StreamMessage) { for (const listener of listeners.get(athleteId) ?? []) listener(message); }
  const ingest = vi.fn(async (athleteId: string, input: InboundEventInput) => {
    const event = await store.appendEvent({ athleteId, ...input, actor: 'athlete', payload: input.payload as never }) as AnyEvent;
    if (input.type === 'user.read') await store.markRead(input.payload.messageIds, clock.now().toISOString());
    emit(athleteId, { t: 'event', event } as StreamMessage);
    return event;
  });
  const runtime: CoachRuntimeAPI = {
    start: async () => {}, stop: async () => {},
    createAthlete: async (input) => store.createAthlete({ id: newId('ath', clock), displayName: input.displayName, isAdmin: input.isAdmin,
      settings: { ...defaultSettings(), profile: { ...defaultSettings().profile, name: input.displayName, coachName: input.coachName ?? 'Coach', tz: input.tz, locale: input.locale }, consents: { ...defaultSettings().consents, ...input.consents }, calendarToken: 'legacy-runtime-token' } }),
    deleteAthlete: vi.fn(async (id) => { await store.deleteAthlete(id); }),
    updateSettings: async (id, patch) => (await store.updateSettings(id, patch)).settings,
    ingest, appendSystemEvent: async (event) => await store.appendEvent(event) as AnyEvent,
    presence: () => 'idle', subscribe: (id, listener) => { let set = listeners.get(id); if (!set) listeners.set(id, set = new Set()); set.add(listener); return () => set!.delete(listener); },
    views: {
      appInfo: async () => ({ app: { version: 1, title: 'Coach', theme: {}, nav: [] }, views: [] } as never),
      query: vi.fn(async () => [{ value: 7 }]), readFile: async () => '# profile',
      write: async (id, viewId, input) => store.appendEvent({ athleteId: id, type: 'user.ui_write', actor: 'athlete', payload: { viewId, ...input } }),
      act: async (id, viewId, input) => ingest(id, { type: 'user.ui_action', payload: { source: { viewId }, action: input.name, payload: input.payload, wake: input.wake ?? true } }),
      versions: async (id, viewId) => store.listUiVersions(id, viewId),
      revert: async (id, viewId, version) => (await store.getUiVersion(id, viewId, version ?? '1'))!,
    },
    listChanges: async () => [], calendarIcs: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    consult: async () => 'answer', lookup: async () => 'lookup', callBriefing: async () => 'briefing', callTurn: async () => ({ replyText: 'reply' }),
    forceEpoch: async () => {}, replayTurn: async () => ({} as never),
  };
  const blobs = createFsBlobStore({ dataDir: dir, clock, store });
  const calls: CallService = {
    features: () => ({ realtime: true, cascaded: true, voiceNotes: true }),
    start: async () => ({ callId: 'call_test', mode: 'cascaded', model: 'test', provider: 'test', maxDurationS: 600 }),
    attach: vi.fn(async () => {}), end: vi.fn(async () => {}), utterance: vi.fn(async () => ({ transcript: 'hi', replyText: 'hello', audioSha256: 'a'.repeat(64) })),
    transcribeVoiceNote: vi.fn(async () => ({ text: 'heard you', model: 'test', durationS: 2 })), dispose: async () => {},
  };
  const setupCodes = new SetupCodeManager({ store, clock, dataDir: dir, logger, publicUrl: config.publicUrl, print() {} });
  const kitDir = join(dir, 'kit');
  await mkdir(kitDir);
  await writeFile(join(kitDir, 'kit.js'), 'export const version = 1;');
  const webDist = join(dir, 'web');
  await mkdir(webDist);
  await writeFile(join(webDist, 'index.html'), '<html>app</html>');
  const exportPath = join(dir, 'bundle.tar.gz');
  await writeFile(exportPath, 'archive');
  const strip = vi.fn(async (_data: Uint8Array): Promise<Uint8Array> => Buffer.from('stripped'));
  const credentials = opts.ai ? new CredentialService({ store, vault: CredentialVault.fromKey(randomBytes(32)), clock, logger }) : undefined;
  const models = opts.ai ? { catalog: DEFAULT_OPENROUTER_CATALOG.map((m) => ModelCatalogEntry.parse(m)), defaultModel: DEFAULT_OPENROUTER_MODEL, openrouterBaseUrl: 'https://openrouter.test/api/v1' } : undefined;
  const gateway = await createGateway({ config, clock, store, runtime, blobs, logger, setupCodes, callService: calls,
    kitDir, webDist, stripImageLocation: strip, exportAthlete: async () => exportPath, vapidPublicKey: 'vapid-test', credentials, models });
  cleanups.push(async () => { await gateway.app.close(); await gateway.views.close(); });
  async function setup(displayName = 'Athlete') {
    const code = await issueSetupCode(store, clock);
    const response = await gateway.app.inject({ method: 'POST', url: '/v1/auth/setup', headers: { origin: config.publicUrl }, payload: {
      code: code.code, displayName, tz: 'Europe/Amsterdam', locale: 'en', consents: { healthData: true, aiDisclosure: true, ageConfirmed18: true },
    } });
    expect(response.statusCode).toBe(200);
    return { ...response.json<{ athleteId: string; token: string; expiresAt: string }>(), cookie: response.cookies.find((c) => c.name === SESSION_COOKIE)!.value, csrf: response.cookies.find((c) => c.name === CSRF_COOKIE)!.value };
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return { ...gateway, dir, clock, store, runtime, blobs, calls, config, strip, setup, bearer, emit, credentials };
}

function multipart(field: string, text = 'bytes', mime = 'application/octet-stream', metadata: Record<string, string> = {}) {
  const boundary = 'oc-boundary';
  const fields = Object.entries(metadata).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('');
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.from(`${fields}--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="sample"\r\nContent-Type: ${mime}\r\n\r\n${text}\r\n--${boundary}--\r\n`) };
}

describe('gateway authentication and client API [SEC-4] [RT-3]', () => {
  it('requires all onboarding consents, consumes setup codes once and stores only token hashes', async () => {
    const f = await fixture();
    expect((await f.app.inject('/v1/setup-status')).json()).toEqual({ needsSetup: true });
    expect((await f.app.inject('/v1/me')).statusCode).toBe(401);
    const invalid = await f.app.inject({ method: 'POST', url: '/v1/auth/setup', payload: { code: 'ABCD-2345', displayName: 'A', tz: 'UTC', locale: 'en', consents: { healthData: true, aiDisclosure: true, ageConfirmed18: false } } });
    expect(invalid.statusCode).toBe(400);
    const a = await f.setup();
    const stored = await f.store.getSessionByTokenHash(sha256Hex(a.token));
    expect(stored?.tokenHash).toBe(sha256Hex(a.token));
    expect(JSON.stringify(stored)).not.toContain(a.token);
    expect((await f.app.inject('/v1/setup-status')).json()).toEqual({ needsSetup: false });
    expect((await f.app.inject({ url: '/v1/me', headers: f.bearer(a.token) })).json()).toMatchObject({ athlete: { id: a.athleteId, isAdmin: true }, demoMode: true, features: { voiceNotes: true } });
    const code = await f.app.inject({ method: 'POST', url: '/v1/auth/pairing-codes', headers: f.bearer(a.token) });
    const paired = await f.app.inject({ method: 'POST', url: '/v1/auth/pair', payload: { code: code.json().code.toLowerCase().replace('-', ' ') } });
    expect(paired.statusCode).toBe(200);
    expect(paired.json().athleteId).toBe(a.athleteId);
    expect((await f.app.inject({ method: 'POST', url: '/v1/auth/pair', payload: { code: code.json().code } })).statusCode).toBe(401);
  });

  it('blocks cross-origin and missing-Origin cookie writes, accepts bearer writes, expires sessions', async () => {
    const f = await fixture(); const a = await f.setup();
    const cookie = `${SESSION_COOKIE}=${a.cookie}`;
    const body = { text: 'hello', clientId: 'one' };
    expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers: { cookie }, payload: body })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers: { cookie, origin: 'https://evil.test' }, payload: body })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers: { cookie, origin: f.config.publicUrl }, payload: body })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers: { cookie, origin: f.config.publicUrl, 'x-csrf-token': 'invalid' }, payload: body })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers: { cookie, origin: f.config.publicUrl, 'x-csrf-token': a.csrf }, payload: body })).statusCode).toBe(200);
    expect((await f.app.inject({ url: '/v1/auth/csrf', headers: { cookie } })).json()).toEqual({ token: a.csrf });
    expect((await f.app.inject({ method: 'PUT', url: '/v1/settings', headers: f.bearer(a.token), payload: { notifications: { proactivePerDay: 1 } } })).json().notifications.proactivePerDay).toBe(1);
    expect((await f.app.inject({ method: 'PUT', url: '/v1/settings', headers: f.bearer(a.token), payload: { profile: { tz: 'Invalid/Zone' } } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: '/v1/device-context', headers: f.bearer(a.token), payload: { tz: 'Invalid/Zone', locale: 'en' } })).statusCode).toBe(400);
    expect((await f.store.getSettings(a.athleteId)).profile.tz).toBe('Europe/Amsterdam');
    await f.clock.advanceTo(new Date(a.expiresAt));
    expect((await f.app.inject({ url: '/v1/me', headers: f.bearer(a.token) })).statusCode).toBe(401);
  });

  it('deduplicates simultaneous and repeated message submissions and rejects foreign attachments', async () => {
    const f = await fixture(); const a = await f.setup();
    const req = { method: 'POST' as const, url: '/v1/messages', headers: f.bearer(a.token), payload: { text: 'hello', clientId: 'same' } };
    const [first, second] = await Promise.all([f.app.inject(req), f.app.inject(req)]);
    expect(first.json().event.id).toBe(second.json().event.id);
    expect((await f.app.inject(req)).json().event.id).toBe(first.json().event.id);
    expect(f.runtime.ingest).toHaveBeenCalledTimes(1);
    const missing = await f.app.inject({ ...req, payload: { text: 'file', clientId: 'missing', attachments: ['f'.repeat(64)] } });
    expect(missing.statusCode).toBe(404);
  });

  it('[UI-1] preserves recorded duration when speech omits it, and prefers provider duration', async () => {
    const f = await fixture(); const a = await f.setup();
    const audio = multipart('audio', 'sound', 'audio/webm', { durationS: '3.75' });
    const request = { method: 'POST' as const, url: '/v1/voice-notes', ...audio, headers: { ...f.bearer(a.token), ...audio.headers } };
    vi.mocked(f.calls.transcribeVoiceNote).mockResolvedValueOnce({ text: 'heard you', model: 'test' });
    const fallback = await f.app.inject(request);
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().event.payload.durationS).toBe(3.75);
    expect((await f.app.inject(request)).json().event.payload.durationS).toBe(2);
  });

  it.each(['-1', 'Infinity', 'NaN', '86401', ''])('[SEC-4] rejects invalid voice duration %s before transcription', async (durationS) => {
    const f = await fixture(); const a = await f.setup();
    const audio = multipart('audio', 'sound', 'audio/webm', { durationS });
    const response = await f.app.inject({ method: 'POST', url: '/v1/voice-notes', ...audio, headers: { ...f.bearer(a.token), ...audio.headers } });
    expect(response.statusCode).toBe(400);
    expect(f.calls.transcribeVoiceNote).not.toHaveBeenCalled();
    expect(f.runtime.ingest).not.toHaveBeenCalled();
  });

  it('intakes uploads and voice, strips image metadata, resolves blobs and scopes read receipts', async () => {
    const f = await fixture(); const a = await f.setup(); const headers = f.bearer(a.token);
    const upload = await f.app.inject({ method: 'POST', url: '/v1/uploads', ...multipart('file', 'image', 'image/png'), headers: { ...headers, ...multipart('file').headers } });
    expect(upload.statusCode).toBe(200);
    expect(f.strip).toHaveBeenCalledTimes(1);
    expect(upload.json().blob.bytes).toBe(8);
    const sha = upload.json().blob.sha256;
    expect((await f.app.inject({ url: `/v1/blobs/${sha}`, headers })).body).toBe('stripped');
    const committed = await f.app.inject({ method: 'POST', url: '/v1/uploads/commit', headers, payload: { blobs: [sha], caption: 'training' } });
    expect(committed.json().event.type).toBe('user.upload');
    const audio = multipart('audio', 'sound', 'audio/webm');
    const voiceNote = await f.app.inject({ method: 'POST', url: '/v1/voice-notes', ...audio, headers: { ...headers, ...audio.headers } });
    expect(voiceNote.json().event.payload).toMatchObject({ transcript: 'heard you', durationS: 2 });
    await f.store.putMessageState({ athleteId: 'someone_else', messageId: 'foreign', delivery: 'sent', proactive: false });
    expect((await f.app.inject({ method: 'POST', url: '/v1/read', headers, payload: { messageIds: ['foreign'] } })).statusCode).toBe(404);
    const call = await f.app.inject({ method: 'POST', url: '/v1/calls', headers, payload: { mode: 'cascaded' } });
    expect(call.json().callId).toBe('call_test');
    const utterance = await f.app.inject({ method: 'POST', url: '/v1/calls/call_test/utterance', ...audio, headers: { ...headers, ...audio.headers } });
    expect(utterance.json()).toMatchObject({ transcript: 'hi', replyText: 'hello', audioUrl: `/v1/blobs/${'a'.repeat(64)}` });
  });
});

describe('authenticated resumable upload intake [WS-7] [SEC-4]', () => {
  it('resumes by exact offsets, serializes chunks, finalizes immutable SHA blobs and applies image privacy', async () => {
    const f = await fixture(); const a = await f.setup();
    const headers = { ...f.bearer(a.token), 'tus-resumable': '1.0.0' };
    const create = await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: { ...headers, 'upload-length': '6', 'upload-metadata': `filename ${Buffer.from('../../example.txt').toString('base64')},filetype ${Buffer.from('text/plain').toString('base64')}` } });
    expect(create.statusCode).toBe(201); expect(create.headers['upload-offset']).toBe('0');
    const url = create.headers.location!;
    const chunk = (offset: number, text: string) => f.app.inject({ method: 'PATCH', url, headers: { ...headers, 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) }, payload: Buffer.from(text) });
    const [first, duplicate] = await Promise.all([chunk(0, 'abc'), chunk(0, 'abc')]);
    expect([first.statusCode, duplicate.statusCode].sort()).toEqual([204, 409]);
    expect((await chunk(0, 'bad')).statusCode).toBe(409);
    const head = await f.app.inject({ method: 'HEAD', url, headers });
    expect(head.headers['upload-offset']).toBe('3'); expect(head.headers['upload-length']).toBe('6');
    const final = await chunk(3, 'def'); expect(final.statusCode).toBe(204);
    const sha = createHash('sha256').update('abcdef').digest('hex');
    expect(final.headers['upload-blob-sha256']).toBe(sha);
    const result = await f.app.inject({ url, headers });
    expect(result.json()).toEqual({ blob: { sha256: sha, bytes: 6, mime: 'text/plain', name: 'example.txt' } });
    expect(Buffer.from(await f.blobs.read(a.athleteId, sha)).toString()).toBe('abcdef');
    expect((await f.app.inject({ method: 'POST', url: '/v1/uploads/commit', headers, payload: { blobs: [sha] } })).json().event.type).toBe('user.upload');
    const image = await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: { ...headers, 'upload-length': '3', 'upload-metadata': `filetype ${Buffer.from('image/png').toString('base64')}` } });
    expect((await f.app.inject({ method: 'PATCH', url: image.headers.location!, headers: { ...headers, 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' }, payload: Buffer.from('img') })).statusCode).toBe(204);
    expect(f.strip).toHaveBeenCalledTimes(1);
    expect((await f.app.inject({ url: image.headers.location!, headers })).json().blob.bytes).toBe(8);
  });

  it('enforces ownership, length, MIME/metadata, expiry, cancellation and private temp-file boundaries', async () => {
    const f = await fixture(); const a = await f.setup();
    const headers = { ...f.bearer(a.token), 'tus-resumable': '1.0.0' };
    expect((await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: { ...headers, 'upload-length': String(RESUMABLE_MAX_BYTES + 1) } })).statusCode).toBe(413);
    expect((await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: { ...headers, 'upload-length': '2', 'upload-metadata': 'filename !!!' } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: f.bearer(a.token) })).statusCode).toBe(412);
    const created = await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: { ...headers, 'upload-length': '2' } });
    const url = created.headers.location!; const uploadId = url.split('/').at(-1)!;
    await f.store.createAthlete({ id: 'ath_foreign', displayName: 'Foreign', isAdmin: false, settings: defaultSettings() });
    const other = await f.context.sessions.create('ath_foreign');
    expect((await f.app.inject({ method: 'HEAD', url, headers: { ...f.bearer(other.token), 'tus-resumable': '1.0.0' } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'PATCH', url, headers: { ...headers, 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' }, payload: Buffer.from('too big') })).statusCode).toBe(413);
    const draftFile = join(athletePaths(f.config.dataDir, a.athleteId).tmp, 'resumable', uploadId);
    expect((await stat(draftFile)).mode & 0o777).toBe(0o600);
    const outside = join(f.dir, 'private-outside'); await writeFile(outside, 'private');
    await rm(draftFile); await symlink(outside, draftFile);
    expect((await f.app.inject({ method: 'PATCH', url, headers: { ...headers, 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' }, payload: Buffer.from('ok') })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204);
    expect((await f.app.inject({ method: 'HEAD', url, headers })).statusCode).toBe(404);
    expect((await stat(outside)).size).toBe(7);
    const expiring = await f.app.inject({ method: 'POST', url: '/v1/uploads/resumable', headers: { ...headers, 'upload-length': '2' } });
    const expiringUrl = expiring.headers.location!;
    await f.clock.advanceBy(60 * 60_000 + 1);
    expect((await f.app.inject({ method: 'HEAD', url: expiringUrl, headers })).statusCode).toBe(404);
    await vi.waitFor(async () => expect(await stat(join(athletePaths(f.config.dataDir, a.athleteId).tmp, 'resumable', expiringUrl.split('/').at(-1)!)).catch(() => undefined)).toBeUndefined());
  });
});

describe('gateway views, history, export and administration [SEC-3] [SEC-5] [SEC-6]', () => {
  it('drains a running upload and rejects new requests before deleting athlete data', async () => {
    const f = await fixture(); const a = await f.setup(); const headers = f.bearer(a.token);
    let release!: (bytes: Uint8Array) => void;
    f.strip.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { release = resolve; }));
    const file = multipart('file', 'image', 'image/png');
    const upload = f.app.inject({ method: 'POST', url: '/v1/uploads', ...file, headers: { ...headers, ...file.headers } });
    await vi.waitFor(() => expect(f.strip).toHaveBeenCalledTimes(1));
    const deletion = f.app.inject({ method: 'DELETE', url: '/v1/account', headers, payload: { confirm: 'DELETE' } });
    await vi.waitFor(async () => expect((await f.store.getAthlete(a.athleteId))?.status).toBe('deleted'));
    expect(f.runtime.deleteAthlete).not.toHaveBeenCalled();
    expect((await f.app.inject({ method: 'POST', url: '/v1/messages', headers, payload: { text: 'too late', clientId: 'during-delete' } })).statusCode).toBe(401);
    release(Buffer.from('stripped'));
    expect((await upload).statusCode).toBe(200);
    expect((await deletion).statusCode).toBe(204);
    expect(await f.store.listBlobs(a.athleteId)).toEqual([]);
  });

  it('filters private events and held messages and pages visible history', async () => {
    const f = await fixture(); const a = await f.setup();
    await f.store.appendEvent({ athleteId: a.athleteId, type: 'coach.message', actor: 'coach', payload: { messageId: 'held', text: 'secret', delivery: 'held', proactive: true, notify: 'normal' } });
    await f.store.appendEvent({ athleteId: a.athleteId, type: 'harness.notice', actor: 'harness', payload: { kind: 'budget_warning', athleteVisible: false, text: 'private' } });
    await f.store.appendEvent({ athleteId: a.athleteId, type: 'user.message', actor: 'athlete', payload: { text: 'visible' } });
    const page = await f.app.inject({ url: '/v1/events?limit=1', headers: f.bearer(a.token) });
    expect(page.json().events).toHaveLength(1); expect(page.json().events[0].payload.text).toBe('visible'); expect(page.json().hasMore).toBe(false);
    expect((await f.app.inject({ url: '/v1/events?limit=0', headers: f.bearer(a.token) })).statusCode).toBe(400);
  });

  it('serves capability views with isolated CSP/CORS and refuses token/traversal/symlink escapes', async () => {
    const f = await fixture(); const a = await f.setup();
    const published = join(f.dir, 'published'); await mkdir(published);
    await writeFile(join(published, 'index.html'), '<html>view</html>');
    await f.store.setKv('view-token-rev:token_123456789', a.athleteId);
    await f.store.addUiVersion({ athleteId: a.athleteId, viewId: 'today', version: '1', commit: 'commit', summary: 'seed', publishedAt: f.clock.now().toISOString(), publishedBy: 'seed', dir: published,
      manifest: { id: 'today', title: 'Today', entry: 'index.html', icon: 'sun', description: '', kit: '1', reads: [], writes: [], actions: [] } as never });
    const response = await f.views.inject('/v/token_123456789/today@1/index.html');
    expect(response.statusCode).toBe(200); expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['content-security-policy']).toContain('frame-ancestors http://localhost:8080');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await f.views.inject('/v/bad/today@1/index.html')).statusCode).toBe(404);
    expect((await f.views.inject('/v/token_123456789/today@1/%2e%2e/kit/kit.js')).statusCode).toBe(404);
    expect((await f.views.inject('/kit/1/kit.js')).statusCode).toBe(200);
    const headers = f.bearer(a.token);
    expect((await f.app.inject({ method: 'POST', url: '/v1/views/today/query', headers, payload: { sql: 'SELECT value' } })).json()).toEqual([{ value: 7 }]);
    expect((await f.app.inject({ method: 'POST', url: '/v1/views/today/file', headers, payload: { path: 'profile.md' } })).json()).toBe('# profile');
    expect((await f.app.inject({ url: '/v1/views/today/versions', headers })).json()[0].dir).toBeUndefined();
    expect((await f.app.inject('/settings')).statusCode).toBe(200);
    expect((await f.app.inject('/v1/unknown')).statusCode).toBe(404);
  });

  it.each(['query', 'write'])('[SEC-6] drains cancelled %s requests only after their handlers finish', async (kind) => {
    const f = await fixture(); const a = await f.setup();
    const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    const target = kind === 'query' ? f.runtime.views.query : f.runtime.ingest;
    const originalIngest = vi.mocked(f.runtime.ingest).getMockImplementation()!;
    if (kind === 'query') vi.mocked(f.runtime.views.query).mockImplementationOnce(async () => { await work; return []; });
    else vi.mocked(f.runtime.ingest).mockImplementationOnce(async (id, input) => { await work; return originalIngest(id, input); });
    const path = kind === 'query' ? '/v1/views/today/query' : '/v1/messages';
    const body = JSON.stringify(kind === 'query' ? { sql: 'SELECT 1' } : { text: 'Cancelled transport, unfinished work', clientId: 'cancelled' });
    const request = httpRequest(`${url}${path}`, { method: 'POST', agent: false, headers: { ...f.bearer(a.token), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    request.on('error', () => {}); // Expected ECONNRESET after the browser-equivalent cancellation.
    request.end(body);
    try {
      await vi.waitFor(() => expect(target).toHaveBeenCalledOnce());
      const closed = new Promise<void>((resolve) => request.once('close', resolve));
      request.destroy();
      await closed;
      const deleting = f.app.inject({ method: 'DELETE', url: '/v1/account', headers: f.bearer(a.token), payload: { confirm: 'DELETE' } });
      await vi.waitFor(async () => expect((await f.store.getAthlete(a.athleteId))?.status).toBe('deleted'));
      expect(f.runtime.deleteAthlete).not.toHaveBeenCalled();
      finishWork();
      expect((await deleting).statusCode).toBe(204);
      expect(f.runtime.deleteAthlete).toHaveBeenCalledOnce();
      expect(await f.store.getAthlete(a.athleteId)).toBeUndefined();
    } finally { finishWork(); request.destroy(); }
  });

  it('rotates legacy calendar tokens, exports data, guards admin and deletes accounts with explicit confirmation', async () => {
    const f = await fixture(); const a = await f.setup(); const headers = f.bearer(a.token);
    const cal = (await f.app.inject({ url: '/v1/settings/calendar-url', headers })).json().url;
    expect((await f.app.inject(new URL(cal).pathname + new URL(cal).search)).body).toContain('BEGIN:VCALENDAR');
    const rotated = (await f.app.inject({ method: 'POST', url: '/v1/settings/calendar-url/rotate', headers })).json().url;
    expect(rotated).not.toBe(cal);
    expect((await f.app.inject(new URL(cal).pathname + new URL(cal).search)).statusCode).toBe(404);
    expect((await f.app.inject('/admin/athletes')).statusCode).toBe(401);
    expect((await f.app.inject({ url: '/admin/athletes', headers })).json().athletes).toHaveLength(1);
    const invite = await f.app.inject({ method: 'POST', url: '/admin/invites', headers });
    const other = await f.app.inject({ method: 'POST', url: '/v1/auth/setup', payload: { code: invite.json().code, displayName: 'Other', tz: 'UTC', locale: 'en', consents: { healthData: true, aiDisclosure: true, ageConfirmed18: true } } });
    expect((await f.app.inject({ url: '/admin/athletes', headers: f.bearer(other.json().token) })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'PUT', url: '/v1/settings', headers: f.bearer(other.json().token), payload: { models: { coach: { provider: 'scripted', model: 'expensive' } } } })).statusCode).toBe(403);
    const jobId = (await f.app.inject({ method: 'POST', url: '/v1/export', headers })).json().jobId;
    await vi.waitFor(async () => expect((await f.app.inject({ url: `/v1/export/${jobId}`, headers })).statusCode).toBe(200));
    expect((await f.app.inject({ url: `/v1/export/${jobId}`, headers })).body).toBe('archive');
    expect((await f.app.inject({ url: `/v1/export/${jobId}`, headers: f.bearer(other.json().token) })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'DELETE', url: '/v1/account', headers })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'DELETE', url: '/v1/account', headers, payload: { confirm: 'DELETE' } })).statusCode).toBe(204);
    expect((await f.app.inject({ url: '/v1/me', headers })).statusCode).toBe(401);
    expect(await f.store.getAthlete(a.athleteId)).toBeUndefined();
  });

  it('issues passkey challenges and rejects missing, invalid and reused verification', async () => {
    const f = await fixture(); const a = await f.setup(); const headers = f.bearer(a.token);
    const registration = await f.app.inject({ method: 'POST', url: '/v1/auth/passkey/register/options', headers });
    expect(registration.json().rp.id).toBe('localhost'); expect(registration.json().authenticatorSelection.residentKey).toBe('required');
    expect((await f.app.inject({ method: 'POST', url: '/v1/auth/passkey/register/verify', headers, payload: {} })).statusCode).toBe(401);
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/passkey/login/options' });
    expect(login.json().challenge).toBeTruthy();
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    expect((await f.app.inject({ method: 'POST', url: '/v1/auth/passkey/login/verify', headers: { cookie }, payload: { id: 'not_registered' } })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/v1/auth/passkey/login/verify', headers: { cookie }, payload: { id: 'not_registered' } })).statusCode).toBe(401);
  });
});

describe('WebSocket authentication, replay and session revocation [SEC-4]', () => {
  it('checks Origin, supports first-frame bearer auth, filters history and closes on logout', async () => {
    const f = await fixture(); const a = await f.setup();
    const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
    const wsUrl = url.replace('http:', 'ws:') + '/v1/stream';
    const rejected = new WebSocket(wsUrl, { origin: 'https://evil.test' });
    const rejectStatus = await new Promise<number>((resolve) => { rejected.on('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); rejected.terminate(); }); rejected.on('error', () => {}); });
    expect(rejectStatus).toBe(403);
    const socket = new WebSocket(wsUrl, { origin: f.config.publicUrl });
    const messages: Array<Record<string, unknown>> = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ t: 'auth', token: a.token }));
    await vi.waitFor(() => expect(messages[0]).toEqual({ t: 'presence', state: 'idle' }));
    expect(f.context.sockets.count(a.athleteId)).toBe(1);
    const visible = await f.store.appendEvent({ athleteId: a.athleteId, type: 'user.message', actor: 'athlete', payload: { text: 'resume me' } });
    const hidden = await f.store.appendEvent({ athleteId: a.athleteId, type: 'coach.message', actor: 'coach', payload: { messageId: 'held', text: 'hidden', delivery: 'held', proactive: true, notify: 'normal' } });
    f.emit(a.athleteId, { t: 'event', event: hidden });
    socket.send(JSON.stringify({ t: 'resume' }));
    await vi.waitFor(() => expect(messages.some((m) => m.t === 'event' && (m.event as { id: string }).id === visible.id)).toBe(true));
    expect(JSON.stringify(messages)).not.toContain('hidden');
    socket.send(JSON.stringify({ t: 'ping' }));
    await vi.waitFor(() => expect(messages.some((m) => m.t === 'pong')).toBe(true));
    const close = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    expect((await f.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: f.bearer(a.token) })).statusCode).toBe(204);
    expect(await close).toBe(4401);
    expect((await f.app.inject({ url: '/v1/me', headers: f.bearer(a.token) })).statusCode).toBe(401);
  });
});

describe('model access: managed allowance, own keys, model choice and recovery [COST-1] [SEC-1] [SEC-4]', () => {
  const KEY = 'sk-or-v1-' + 'a'.repeat(40);
  const OTHER = 'sk-or-v1-' + 'b'.repeat(40);
  afterEach(() => { vi.unstubAllGlobals(); });
  function stubOpenRouter() {
    const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization ?? '';
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: { limit_remaining: 4 } }), { status: auth.includes('bad') ? 401 : 200 });
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('encrypts keys bound to athlete and provider, and only shows a masked hint', () => {
    const vault = CredentialVault.fromKey(randomBytes(32));
    const sealed = vault.encrypt(KEY, 'ath_1:openrouter');
    expect(sealed).not.toContain(KEY.slice(10));
    expect(vault.decrypt(sealed, 'ath_1:openrouter')).toBe(KEY);
    expect(() => vault.decrypt(sealed, 'ath_2:openrouter')).toThrow();
    expect(keyHint(KEY)).toBe('sk-or-…aaaa');
  });

  it('managed athletes cannot raise budgets or pick models; admins set allowance, keys and recovery codes', async () => {
    stubOpenRouter();
    const f = await fixture({ ai: true });
    const admin = await f.setup('Admin');
    const adminHeaders = f.bearer(admin.token);
    const invite = (await f.app.inject({ method: 'POST', url: '/admin/invites', headers: adminHeaders })).json().code;
    const mom = (await f.app.inject({ method: 'POST', url: '/v1/auth/setup', payload: { code: invite, displayName: 'Mom', tz: 'UTC', locale: 'en', consents: { healthData: true, aiDisclosure: true, ageConfirmed18: true } } })).json();
    const momHeaders = f.bearer(mom.token);

    const ai = (await f.app.inject({ url: '/v1/ai', headers: momHeaders })).json();
    expect(ai).toMatchObject({ billing: 'managed', openrouterKey: null, model: DEFAULT_OPENROUTER_MODEL });
    expect(ai.catalog.length).toBeGreaterThan(1);
    expect((await f.app.inject({ method: 'PUT', url: '/v1/settings', headers: momHeaders, payload: { budgets: { monthlyUsd: 500 } } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'PUT', url: '/v1/ai/model', headers: momHeaders, payload: { model: 'openai/gpt-6.1-sol' } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'PUT', url: `/admin/athletes/${mom.athleteId}/budgets`, headers: momHeaders, payload: { dailyUsd: 9, monthlyUsd: 99 } })).statusCode).toBe(403);

    const budgets = await f.app.inject({ method: 'PUT', url: `/admin/athletes/${mom.athleteId}/budgets`, headers: adminHeaders, payload: { dailyUsd: 0.5, monthlyUsd: 3 } });
    expect(budgets.json().budgets).toEqual({ dailyUsd: 0.5, monthlyUsd: 3 });
    expect((await f.app.inject({ method: 'PUT', url: `/admin/athletes/${mom.athleteId}/model`, headers: adminHeaders, payload: { model: 'nobody/unknown' } })).statusCode).toBe(400);
    const managedKey = await f.app.inject({ method: 'PUT', url: `/admin/athletes/${mom.athleteId}/openrouter-key`, headers: adminHeaders, payload: { key: KEY } });
    expect(managedKey.json()).toMatchObject({ billing: 'managed', openrouterKey: { owner: 'admin', hint: 'sk-or-…aaaa' } });
    expect(managedKey.body).not.toContain(KEY);
    expect(f.credentials!.key(mom.athleteId, 'openrouter')).toBe(KEY);
    expect((await f.store.listCredentials(mom.athleteId))[0]?.ciphertext).not.toContain(KEY.slice(10));
    expect((await f.app.inject({ method: 'DELETE', url: '/v1/ai/openrouter-key', headers: momHeaders })).statusCode).toBe(403);

    const recovery = await f.app.inject({ method: 'POST', url: `/admin/athletes/${mom.athleteId}/recovery-code`, headers: adminHeaders });
    const paired = await f.app.inject({ method: 'POST', url: '/v1/auth/pair', payload: { code: recovery.json().code, deviceName: 'New phone' } });
    expect(paired.json().athleteId).toBe(mom.athleteId);
    expect((await f.app.inject({ method: 'POST', url: '/v1/auth/pair', payload: { code: recovery.json().code } })).statusCode).toBe(401);
  });

  it('an athlete who brings their own key controls budgets and model; bad keys are rejected', async () => {
    const fetch = stubOpenRouter();
    const f = await fixture({ ai: true });
    const admin = await f.setup('Admin');
    const invite = (await f.app.inject({ method: 'POST', url: '/admin/invites', headers: f.bearer(admin.token) })).json().code;
    const sis = (await f.app.inject({ method: 'POST', url: '/v1/auth/setup', payload: { code: invite, displayName: 'Sis', tz: 'UTC', locale: 'en', consents: { healthData: true, aiDisclosure: true, ageConfirmed18: true } } })).json();
    const headers = f.bearer(sis.token);
    expect((await f.app.inject({ method: 'PUT', url: '/v1/ai/openrouter-key', headers, payload: { key: 'not-a-key' } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'PUT', url: '/v1/ai/openrouter-key', headers, payload: { key: 'sk-or-v1-bad' + 'c'.repeat(30) } })).statusCode).toBe(400);
    const connected = await f.app.inject({ method: 'PUT', url: '/v1/ai/openrouter-key', headers, payload: { key: OTHER } });
    expect(connected.json()).toMatchObject({ billing: 'byok', openrouterKey: { owner: 'athlete', hint: 'sk-or-…bbbb' } });
    expect(fetch).toHaveBeenCalledWith('https://openrouter.test/api/v1/key', expect.anything());
    expect((await f.app.inject({ method: 'PUT', url: '/v1/settings', headers, payload: { budgets: { monthlyUsd: 50 } } })).statusCode).toBe(200);
    const picked = await f.app.inject({ method: 'PUT', url: '/v1/ai/model', headers, payload: { model: 'z-ai/glm-5.3-flash' } });
    expect(picked.json().model).toBe('z-ai/glm-5.3-flash');
    expect((await f.store.getSettings(sis.athleteId)).models.deep).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', effort: 'high' });
    const start = (await f.app.inject({ method: 'POST', url: '/v1/ai/openrouter/oauth/start', headers })).json().url as string;
    expect(new URL(start).origin).toBe('https://openrouter.test');
    expect(new URL(start).searchParams.get('code_challenge_method')).toBe('S256');
    expect((await f.app.inject({ method: 'DELETE', url: '/v1/ai/openrouter-key', headers })).json()).toMatchObject({ billing: 'managed', openrouterKey: null });
  });
});
