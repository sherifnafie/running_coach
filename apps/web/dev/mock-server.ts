/**
 * In-memory mock of the OpenCoach gateway (SPEC Appendix C §C.5) for developing and testing the PWA without the
 * real server. Single athlete, fake coach that streams replies with micro-UI, uploads, events, one view served from a
 * second (views) origin, changes feed, cascaded fake calls, export/delete and admin endpoints.
 *
 *   pnpm --filter @opencoach/web mock          # gateway :8787, views origin :8788
 *   pnpm --filter @opencoach/web dev:mock      # mock + vite dev server with proxy
 *
 * DEV TOOL ONLY: it has /__mock/* control routes (loopback only) and a fixed setup code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  SetupRequest,
  SystemClock,
  defaultSettings,
  mergeSettings,
  newId,
  pairingCode,
  type AnyEvent,
  type AppInfo,
  type AthleteSettings,
  type BlobRef,
  type EventType,
  type MeResponse,
  type PublishedView,
  type StreamMessage,
  type UiVersionRecord,
  ATHLETE_VISIBLE_TYPES,
} from '@opencoach/protocol';
import { CARD_JS, KIT_CSS, KIT_JS, appJs, cardHtml, indexHtml } from './mock-view';

const clock = new SystemClock();
const nowIso = () => clock.now().toISOString();

export interface MockServerOptions {
  port?: number;
  viewsPort?: number;
  setupCode?: string;
  /** Allowed WebSocket Origins. Default: any localhost / 127.0.0.1 port. */
  allowedOrigins?: RegExp[];
  /** Multiplier for the fake coach's delays (tests use < 1). */
  speed?: number;
  /** Number of old messages to pre-seed after setup (to exercise "load older"). */
  seedHistory?: number;
  quiet?: boolean;
}

export interface MockServer {
  port: number;
  viewsPort: number;
  url: string;
  viewsUrl: string;
  setupCode: string;
  state: MockState;
  close(): Promise<void>;
}

interface Athlete {
  id: string;
  displayName: string;
  isAdmin: boolean;
  settings: AthleteSettings;
}

export interface MockState {
  athlete?: Athlete;
  sessions: Set<string>;
  pairingCodes: Map<string, number>;
  events: AnyEvent[];
  blobs: Map<string, { bytes: Buffer; mime: string; name?: string }>;
  viewVersion: number;
  brokenVersions: Set<number>;
  checkins: Array<Record<string, unknown>>;
  /** Everything the client reported, for assertions. */
  log: {
    reactions: Array<{ messageId: string; reaction: string }>;
    reads: string[][];
    deviceContext: Array<{ tz: string; locale: string }>;
    viewErrors: Array<Record<string, unknown>>;
    uiActions: Array<Record<string, unknown>>;
    viewActs: Array<Record<string, unknown>>;
    typing: number;
    acks: string[];
  };
  exports: Map<string, number>;
  callStartedAt: Map<string, number>;
}

const CHECK_NAMES = ['Easy 8 km', 'Strides + drills', 'Long run 18 km'];

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const setupCode = opts.setupCode ?? process.env.MOCK_SETUP_CODE ?? 'SETUP-1234';
  const speed = opts.speed ?? Number(process.env.MOCK_SPEED ?? 1);
  const allowedOrigins = opts.allowedOrigins ?? [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
  const log = (...a: unknown[]) => {
    if (!opts.quiet) console.log('[mock]', ...a);
  };

  const state: MockState = {
    sessions: new Set(),
    pairingCodes: new Map(),
    events: [],
    blobs: new Map(),
    viewVersion: 1,
    brokenVersions: new Set(),
    checkins: [],
    log: { reactions: [], reads: [], deviceContext: [], viewErrors: [], uiActions: [], viewActs: [], typing: 0, acks: [] },
    exports: new Map(),
    callStartedAt: new Map(),
  };
  const sockets = new Set<WebSocket>();
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * speed));

  // ---- views origin --------------------------------------------------------------------------------------------
  let viewsPortActual = 0;
  const viewsServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://views.local');
    const csp = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-ancestors http://localhost:* http://127.0.0.1:*`;
    const send = (body: string, type: string, cache: string) => {
      res.writeHead(200, { 'content-type': type, 'content-security-policy': csp, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    if (url.pathname === '/kit/1/kit.js') return send(KIT_JS, 'text/javascript; charset=utf-8', 'no-cache');
    if (url.pathname === '/kit/1/kit.css') return send(KIT_CSS, 'text/css; charset=utf-8', 'no-cache');
    const m = /^\/v\/[^/]+\/([a-z0-9-]+)@(\d+)\/(.+)$/.exec(url.pathname);
    if (m) {
      const [, id, ver, file] = m;
      const version = Number(ver);
      const immutable = 'public, max-age=31536000, immutable';
      if (file === 'index.html') return send(indexHtml(id!, version), 'text/html; charset=utf-8', immutable);
      if (file === 'app.js') return send(appJs(state.brokenVersions.has(version)), 'text/javascript; charset=utf-8', immutable);
      if (file === 'card.html') return send(cardHtml(id!), 'text/html; charset=utf-8', immutable);
      if (file === 'card.js') return send(CARD_JS, 'text/javascript; charset=utf-8', immutable);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  // ---- events & stream -------------------------------------------------------------------------------------------
  const isVisible = (e: AnyEvent) =>
    (ATHLETE_VISIBLE_TYPES as readonly string[]).includes(e.type) && (e.type !== 'harness.notice' || e.payload.athleteVisible);

  function broadcast(msg: StreamMessage) {
    const data = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === 1) s.send(data);
  }

  function mkEvent<T extends EventType>(type: T, actor: AnyEvent['actor'], payload: unknown, id?: string): AnyEvent {
    const e = { id: id ?? newId('evt', clock), athleteId: state.athlete?.id ?? 'ath_none', ts: nowIso(), type, actor, payload } as unknown as AnyEvent;
    state.events.push(e);
    return e;
  }

  function emit(e: AnyEvent) {
    broadcast({ t: 'event', event: e });
    return e;
  }

  // ---- fake coach --------------------------------------------------------------------------------------------------------
  const svgChart = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" fill="#fdf0ea"/><polyline fill="none" stroke="#c8431c" stroke-width="4" points="10,130 70,100 130,110 190,60 250,70 310,30"/><text x="12" y="20" font-family="sans-serif" font-size="14">Weekly km</text></svg>`;
  function putBlob(bytes: Buffer, mime: string, name?: string): BlobRef {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    state.blobs.set(sha256, { bytes, mime, name });
    return { sha256, mime, bytes: bytes.length, ...(name ? { name } : {}) };
  }

  interface CoachReply {
    text: string;
    ui?: unknown;
    attachments?: unknown[];
    safety?: boolean;
    publish?: boolean;
    held?: boolean;
  }

  function chooseReply(userText: string): CoachReply {
    const t = userText.toLowerCase();
    if (/chest|dizz|faint/.test(t))
      return { safety: true, text: "That sounds important. **Stop any running for now** and please get checked by a medical professional, and call emergency services if it's happening right now. I'm here when you're ready to talk." };
    if (/rpe|form|survey/.test(t))
      return {
        text: 'Quick check-in on that session. How hard did it feel?',
        ui: {
          form: {
            id: 'rpe_form',
            title: 'Session check-in',
            submit_label: 'Send',
            fields: [
              { id: 'rpe', type: 'scale', label: 'Effort (RPE)', min: 1, max: 10, anchors: { '1': 'Very easy', '5': 'Moderate', '10': 'Max' } },
              { id: 'felt', type: 'choice', label: 'Legs felt', options: [{ label: 'Fresh', value: 'fresh' }, { label: 'OK', value: 'ok' }, { label: 'Heavy', value: 'heavy' }] },
              { id: 'extras', type: 'multi_choice', label: 'Did you…', options: [{ label: 'Warm up', value: 'warmup' }, { label: 'Stretch', value: 'stretch' }] },
              { id: 'km', type: 'number', label: 'Distance', unit: 'km', min: 0, max: 100 },
              { id: 'note', type: 'text', label: 'Anything else?', multiline: true, max_len: 300 },
            ],
          },
        },
      };
    if (/pain|sore|knee|calf|hurt/.test(t))
      return {
        text: 'Sorry to hear that. Show me where it hurts and how bad it is.',
        ui: { form: { id: 'pain_form', title: 'Where does it hurt?', fields: [{ id: 'where', type: 'body_map', label: 'Pain location', multi: true }] } },
      };
    if (/card/.test(t)) return { text: "Here's today's session:", attachments: [{ kind: 'view_card', viewId: 'today' }] };
    if (/image|photo|chart/.test(t)) return { text: 'Your weekly volume:', attachments: [{ kind: 'blob', blob: putBlob(Buffer.from(svgChart), 'image/svg+xml', 'weekly.svg') }] };
    if (/file|plan|pdf/.test(t))
      return { text: 'Here is the plan as a file.', attachments: [{ kind: 'file', path: 'plan/current.md', blob: putBlob(Buffer.from('# Plan\n- Easy run'), 'text/markdown', 'current.md') }] };
    if (/publish|update view/.test(t)) return { text: "I've updated your Today view.", publish: true };
    if (/expire/.test(t))
      return {
        text: 'Answer quickly (this question already expired).',
        ui: { quick_replies: [{ label: 'Yes', value: 'yes' }], expires_at: new Date(clock.now().getTime() - 60_000).toISOString() },
      };
    return {
      text: "Great to hear from you! How did today's run feel?\n\n- **Easy**: conversational\n- **Hard**: you were pushing\n\n[Training log](https://example.com/log)",
      ui: {
        quick_replies: [
          { label: 'Easy', value: 'easy' },
          { label: 'Moderate', value: 'moderate' },
          { label: 'Hard', value: 'hard' },
        ],
      },
    };
  }

  async function coachSays(reply: CoachReply, replyTo?: string) {
    broadcast({ t: 'presence', state: 'thinking' });
    await delay(150);
    broadcast({ t: 'progress', turnId: 'turn_mock', label: 'Looking at your splits…' });
    broadcast({ t: 'presence', state: 'working' });
    await delay(350);
    if (reply.safety) {
      broadcast({ t: 'safety', categories: ['cardiac'], acute: true, text: 'We noticed you mentioned chest symptoms.' });
      emit(mkEvent('harness.notice', 'harness', { kind: 'safety_flag', athleteVisible: true, text: 'Safety notice shown.', detail: { categories: ['cardiac'], acute: true } }));
    }
    broadcast({ t: 'presence', state: 'typing' });
    const messageId = newId('evt', clock);
    const streamId = `tool_${randomBytes(4).toString('hex')}`;
    broadcast({ t: 'message.start', streamId, replyTo });
    const words = reply.text.split(/(\s+)/);
    for (const w of words) {
      broadcast({ t: 'message.delta', streamId, textDelta: w });
      await delay(18);
    }
    const event = mkEvent(
      'coach.message',
      'coach',
      { messageId, text: reply.text, attachments: reply.attachments ?? [], ui: reply.ui, notify: 'normal', delivery: reply.held ? 'held' : 'sent', proactive: false, channel: 'app', replyTo },
      messageId,
    ) as Extract<AnyEvent, { type: 'coach.message' }>;
    broadcast({ t: 'message.end', streamId, event });
    broadcast({ t: 'presence', state: 'idle' });
    if (reply.publish) await publishView('Added a weekly summary');
  }

  async function publishView(summary: string, opts2: { broken?: boolean } = {}) {
    state.viewVersion += 1;
    if (opts2.broken) state.brokenVersions.add(state.viewVersion);
    const e = mkEvent('coach.ui_published', 'coach', { viewId: 'today', version: String(state.viewVersion), commit: `c${state.viewVersion}`, summary });
    broadcast({ t: 'ui.published', viewId: 'today', version: String(state.viewVersion), summary });
    emit(e);
  }

  // ---- app info --------------------------------------------------------------------------------------------------------------
  function publishedView(): PublishedView {
    const v = state.viewVersion;
    const base = `http://127.0.0.1:${viewsPortActual}/v/mocktoken/today@`;
    return {
      manifest: {
        id: 'today',
        title: 'Today',
        icon: 'today',
        placement: { nav: 0 },
        entry: 'index.html',
        kit: '1',
        reads: ['db:planned_workouts'],
        writes: [{ db: 'checkins', ops: ['insert'] }],
        actions: ['ask_coach'],
        refresh: 'on-change',
        card: { entry: 'card.html', height: 's' },
      },
      version: String(v),
      url: `${base}${v}/index.html`,
      cardUrl: `${base}${v}/card.html`,
      ...(v > 1 ? { previousVersion: String(v - 1), previousUrl: `${base}${v - 1}/index.html` } : {}),
    };
  }
  const appInfo = (): AppInfo => ({
    app: { version: 1, nav: ['today'], home: 'today', theme: { accent: '#E4572E' } },
    views: [publishedView()],
    kitUrl: `http://127.0.0.1:${viewsPortActual}/kit/1/kit.js`,
  });

  const meResponse = (): MeResponse => ({
    athlete: { id: state.athlete!.id, displayName: state.athlete!.displayName, isAdmin: state.athlete!.isAdmin },
    settings: state.athlete!.settings,
    viewsOrigin: `http://127.0.0.1:${viewsPortActual}`,
    kitUrl: `http://127.0.0.1:${viewsPortActual}/kit/1/kit.js`,
    features: { voiceNotes: true, calls: { realtime: false, cascaded: true }, passkeys: false, push: false, webSearch: false },
    harnessVersion: '0.1.0-mock',
    demoMode: true,
  });

  // ---- http helpers ---------------------------------------------------------------------------------------------------------------
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const apiError = (res: ServerResponse, status: number, code: string, message: string) => json(res, status, { error: { code, message } });

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const cookie = (req: IncomingMessage, name: string) => {
    const raw = req.headers.cookie ?? '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return undefined;
  };
  const authed = (req: IncomingMessage) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const tok = cookie(req, 'oc_session') ?? bearer;
    return !!tok && state.sessions.has(tok) && !!state.athlete;
  };
  const startSession = (res: ServerResponse) => {
    const token = randomBytes(24).toString('base64url');
    state.sessions.add(token);
    const expiresAt = new Date(clock.now().getTime() + 30 * 86_400_000).toISOString();
    res.setHeader('set-cookie', `oc_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`);
    return { athleteId: state.athlete!.id, token, expiresAt };
  };

  interface Part {
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer;
  }
  function parseMultipart(buf: Buffer, contentType: string): Part[] {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
    const b = boundary?.[1] ?? boundary?.[2];
    if (!b) return [];
    const delim = Buffer.from(`--${b}`);
    const parts: Part[] = [];
    let pos = buf.indexOf(delim);
    while (pos !== -1) {
      const next = buf.indexOf(delim, pos + delim.length);
      if (next === -1) break;
      const chunk = buf.subarray(pos + delim.length + 2, next - 2); // strip CRLF around
      const headerEnd = chunk.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headers = chunk.subarray(0, headerEnd).toString('utf8');
        const name = /name="([^"]*)"/.exec(headers)?.[1] ?? '';
        const filename = /filename="([^"]*)"/.exec(headers)?.[1];
        const ct = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1];
        parts.push({ name, filename, contentType: ct, data: chunk.subarray(headerEnd + 4) });
      }
      pos = next;
    }
    return parts;
  }

  function eventsPage(q: URLSearchParams) {
    const limit = Math.min(Number(q.get('limit') ?? 50) || 50, 500);
    const visible = state.events.filter(isVisible);
    const before = q.get('before');
    const after = q.get('after');
    if (after) {
      const rest = visible.filter((e) => e.id > after);
      return { events: rest.slice(0, limit), hasMore: rest.length > limit };
    }
    const pool = before ? visible.filter((e) => e.id < before) : visible;
    return { events: pool.slice(-limit), hasMore: pool.length > limit };
  }

  const reactTo = (userEvent: AnyEvent) => {
    const text = userEvent.type === 'user.message' ? userEvent.payload.text : userEvent.type === 'user.upload' ? (userEvent.payload.caption ?? 'files') : 'voice note';
    void coachSays(chooseReply(text), userEvent.id);
  };

  // ---- routes ---------------------------------------------------------------------------------------------------------------------
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // dev-only control routes
    if (path.startsWith('/__mock/')) {
      const ra = req.socket.remoteAddress ?? '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return apiError(res, 403, 'forbidden', 'loopback only');
      if (path === '/__mock/state') {
        return json(res, 200, { viewVersion: state.viewVersion, log: state.log, events: state.events.length, checkins: state.checkins, athlete: state.athlete?.displayName });
      }
      if (path === '/__mock/publish' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { broken?: boolean; summary?: string };
        await publishView(body.summary ?? 'Updated', { broken: body.broken });
        return json(res, 200, { version: state.viewVersion });
      }
      if (path === '/__mock/say' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}') as { text: string; held?: boolean };
        void coachSays({ text: body.text, held: body.held });
        return json(res, 200, { ok: true });
      }
      return apiError(res, 404, 'not_found', 'unknown control route');
    }

    // ---- public routes
    if (path === '/v1/setup-status' && method === 'GET') return json(res, 200, { needsSetup: !state.athlete });

    if (path === '/v1/auth/setup' && method === 'POST') {
      if (state.athlete) return apiError(res, 409, 'already_setup', 'This server is already set up');
      const parsed = SetupRequest.safeParse(JSON.parse((await readBody(req)).toString() || '{}'));
      if (!parsed.success) return apiError(res, 400, 'invalid_request', parsed.error.issues[0]?.message ?? 'Invalid request');
      if (parsed.data.code !== setupCode) return apiError(res, 403, 'invalid_code', 'That setup code is not valid');
      const settings = defaultSettings();
      settings.profile = { ...settings.profile, name: parsed.data.displayName, coachName: parsed.data.coachName ?? 'Coach', tz: parsed.data.tz, locale: parsed.data.locale, units: parsed.data.units ?? 'metric' };
      const stamp = nowIso();
      settings.consents = { healthData: stamp, aiDisclosure: stamp, ageConfirmed18: stamp };
      state.athlete = { id: newId('ath', clock), displayName: parsed.data.displayName, isAdmin: true, settings };
      const out = startSession(res);
      log('athlete created:', parsed.data.displayName);
      seedHistory(opts.seedHistory ?? 0);
      setTimeout(() => void coachSays({ text: `Hi ${parsed.data.displayName.split(' ')[0]}! I'm ${settings.profile.coachName}, your coach. What are you training for, or what would you like to work on?` }), 400 * speed);
      return json(res, 200, out);
    }

    if (path === '/v1/auth/pair' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { code?: string };
      const code = (body.code ?? '').toUpperCase();
      const exp = state.pairingCodes.get(code);
      if (!state.athlete || ((!exp || exp < clock.now().getTime()) && code !== 'PAIR-1234')) return apiError(res, 403, 'invalid_code', 'That pairing code is not valid or has expired');
      state.pairingCodes.delete(code);
      return json(res, 200, startSession(res));
    }

    if (path === '/v1/auth/logout' && method === 'POST') {
      const tok = cookie(req, 'oc_session');
      if (tok) state.sessions.delete(tok);
      res.setHeader('set-cookie', 'oc_session=; HttpOnly; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (path.startsWith('/v1/auth/passkey')) return apiError(res, 501, 'not_supported', 'Passkeys are not available in the mock server');

    // ---- authenticated routes
    if (!authed(req)) return apiError(res, 401, 'unauthorized', 'Sign in required');
    const athlete = state.athlete!;

    if (path === '/v1/auth/pairing-codes' && method === 'POST') {
      const code = pairingCode();
      const expires = clock.now().getTime() + 5 * 60_000;
      state.pairingCodes.set(code, expires);
      return json(res, 200, { code, expiresAt: new Date(expires).toISOString() });
    }
    if (path === '/v1/me' && method === 'GET') return json(res, 200, meResponse());
    if (path === '/v1/settings' && method === 'GET') return json(res, 200, athlete.settings);
    if (path === '/v1/settings' && method === 'PUT') {
      try {
        const patch = JSON.parse((await readBody(req)).toString() || '{}');
        const { settings } = mergeSettings(athlete.settings, patch);
        athlete.settings = settings;
        athlete.displayName = settings.profile.name;
        return json(res, 200, settings);
      } catch (e) {
        return apiError(res, 400, 'invalid_settings', e instanceof Error ? e.message : 'Invalid settings');
      }
    }
    if (path === '/v1/settings/calendar-url') return json(res, 200, { url: `/v1/exports/calendar.ics?token=${randomBytes(6).toString('hex')}` });

    if (path === '/v1/messages' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { text?: string; clientId?: string; attachments?: string[]; replyTo?: string };
      if (typeof body.text !== 'string' || !body.clientId) return apiError(res, 400, 'invalid_request', 'text and clientId are required');
      // idempotent on clientId
      const existing = state.events.find((e) => e.type === 'user.message' && e.payload.clientId === body.clientId);
      if (existing) return json(res, 200, { event: existing });
      const event = mkEvent('user.message', 'athlete', { text: body.text, attachments: [], channel: 'app', clientId: body.clientId, replyTo: body.replyTo });
      emit(event);
      reactTo(event);
      return json(res, 200, { event });
    }

    if (path === '/v1/uploads' && method === 'POST') {
      const parts = parseMultipart(await readBody(req), req.headers['content-type'] ?? '');
      const file = parts.find((p) => p.name === 'file');
      if (!file) return apiError(res, 400, 'invalid_request', 'file is required');
      return json(res, 200, { blob: putBlob(file.data, file.contentType ?? 'application/octet-stream', file.filename) });
    }
    if (path === '/v1/uploads/commit' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { blobs?: string[]; caption?: string };
      const blobs = (body.blobs ?? []).map((sha) => state.blobs.get(sha) && ({ sha256: sha, mime: state.blobs.get(sha)!.mime, bytes: state.blobs.get(sha)!.bytes.length, name: state.blobs.get(sha)!.name } as BlobRef)).filter(Boolean);
      if (blobs.length === 0) return apiError(res, 400, 'invalid_request', 'unknown blobs');
      const event = mkEvent('user.upload', 'athlete', { blobs, caption: body.caption });
      emit(event);
      reactTo(event);
      return json(res, 200, { event });
    }
    if (path === '/v1/voice-notes' && method === 'POST') {
      const parts = parseMultipart(await readBody(req), req.headers['content-type'] ?? '');
      const audio = parts.find((p) => p.name === 'audio');
      if (!audio) return apiError(res, 400, 'invalid_request', 'audio is required');
      const blob = putBlob(audio.data, audio.contentType ?? 'audio/webm', audio.filename);
      const event = mkEvent('user.voice_note', 'athlete', { blob, durationS: 2, transcript: 'This is a mock transcript of your voice note.', transcriptModel: 'mock' });
      emit(event);
      reactTo(event);
      return json(res, 200, { event });
    }

    if (path === '/v1/events' && method === 'GET') return json(res, 200, eventsPage(url.searchParams));

    const blobMatch = /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(path);
    if (blobMatch && method === 'GET') {
      const b = state.blobs.get(blobMatch[1]!);
      if (!b) return apiError(res, 404, 'not_found', 'No such blob');
      res.writeHead(200, { 'content-type': b.mime, 'cache-control': 'private, max-age=31536000, immutable', 'content-length': b.bytes.length });
      return void res.end(b.bytes);
    }

    if (path === '/v1/ui-actions' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { source: { messageId?: string; viewId?: string }; action: string; payload?: unknown; wake?: boolean };
      state.log.uiActions.push(body as unknown as Record<string, unknown>);
      const event = mkEvent('user.ui_action', 'athlete', { source: body.source ?? {}, action: body.action, payload: body.payload, wake: body.wake ?? true });
      emit(event);
      if (body.wake !== false && body.source?.messageId) {
        const p = (body.payload ?? {}) as { label?: string; form_id?: string };
        void coachSays({ text: body.action === 'quick_reply' ? `Got it: **${p.label ?? 'noted'}**. Thanks for letting me know.` : `Thanks, I've saved that${p.form_id ? ` (${p.form_id})` : ''}.` }, event.id);
      }
      return json(res, 200, { event });
    }
    if (path === '/v1/reactions' && method === 'POST') {
      state.log.reactions.push(JSON.parse((await readBody(req)).toString() || '{}'));
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/read' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as { messageIds: string[] };
      state.log.reads.push(body.messageIds);
      return json(res, 200, { ok: true });
    }
    if (path === '/v1/device-context' && method === 'POST') {
      state.log.deviceContext.push(JSON.parse((await readBody(req)).toString() || '{}'));
      return json(res, 200, { ok: true });
    }

    if (path === '/v1/app' && method === 'GET') return json(res, 200, appInfo());

    const viewMatch = /^\/v1\/views\/([a-z0-9-]+)\/(query|file|write|act|error|versions|revert)$/.exec(path);
    if (viewMatch) {
      const [, viewId, op] = viewMatch;
      if (viewId !== 'today') return apiError(res, 404, 'not_found', 'No such view');
      if (op === 'versions' && method === 'GET') {
        const versions: UiVersionRecord[] = [];
        for (let v = state.viewVersion; v >= 1; v--)
          versions.push({
            athleteId: athlete.id,
            viewId: 'today',
            version: String(v),
            commit: `c${v}`,
            summary: v === 1 ? 'Seed view' : `Update ${v}`,
            publishedAt: nowIso(),
            publishedBy: v === 1 ? 'seed' : 'coach',
            manifest: publishedView().manifest,
            dir: `/mock/today@${v}`,
          });
        return json(res, 200, { versions });
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}') as Record<string, unknown>;
      if (op === 'query') {
        return json(res, 200, {
          rows: CHECK_NAMES.map((title, i) => ({ id: i + 1, date: `2026-10-0${7 + i}`, title, status: i === 0 && state.checkins.length > 0 ? 'done' : 'planned' })),
        });
      }
      if (op === 'file') return json(res, 200, { content: '# Current plan\n\n- Easy 8 km' });
      if (op === 'write') {
        state.checkins.push((body.row ?? {}) as Record<string, unknown>);
        const e = mkEvent('user.ui_write', 'athlete', { viewId: 'today', target: body.target, op: body.op, row: body.row ?? {}, key: body.key });
        emit(e);
        return json(res, 200, { ok: true });
      }
      if (op === 'act') {
        state.log.viewActs.push(body);
        emit(mkEvent('user.ui_action', 'athlete', { source: { viewId: 'today' }, action: body.name, payload: body.payload, wake: body.wake ?? true }));
        return json(res, 200, { ok: true });
      }
      if (op === 'error') {
        state.log.viewErrors.push(body);
        return json(res, 200, { ok: true });
      }
      if (op === 'revert') {
        const to = typeof body.toVersion === 'string' ? Number(body.toVersion) : state.viewVersion - 1;
        if (!(to >= 1 && to < state.viewVersion)) return apiError(res, 400, 'invalid_request', 'Nothing to revert to');
        state.viewVersion = to;
        broadcast({ t: 'ui.published', viewId: 'today', version: String(to), summary: 'Reverted' });
        return json(res, 200, { ok: true });
      }
    }

    if (path === '/v1/changes' && method === 'GET')
      return json(res, 200, {
        changes: [
          { commit: 'c2', at: nowIso(), summary: 'Added weekly summary to Today', files: ['ui/views/today/index.html'], kind: 'publish' },
          { commit: 'c1', at: nowIso(), summary: 'Initial seed', files: [], kind: 'seed' },
        ],
      });

    if (path === '/v1/calls' && method === 'POST') {
      const callId = newId('call', clock);
      state.callStartedAt.set(callId, clock.now().getTime());
      emit(mkEvent('call.started', 'voice', { callId, mode: 'cascaded', provider: 'mock', model: 'mock' }));
      return json(res, 200, { callId, mode: 'cascaded', provider: 'mock', model: 'mock-cascaded', maxDurationS: 600 });
    }
    const callMatch = /^\/v1\/calls\/([^/]+)\/(attach|utterance|end)$/.exec(path);
    if (callMatch) {
      const [, callId, op] = callMatch;
      if (op === 'utterance') {
        await readBody(req);
        broadcast({ t: 'call', callId: callId!, state: 'thinking' });
        await delay(250);
        const replyText = 'Sounds good. Keep tomorrow easy and let me know how the legs feel.';
        broadcast({ t: 'call', callId: callId!, state: 'speaking', text: replyText });
        return json(res, 200, { transcript: 'I did an easy run today.', replyText });
      }
      if (op === 'end') {
        const started = state.callStartedAt.get(callId!) ?? clock.now().getTime();
        emit(mkEvent('call.ended', 'voice', { callId, durationS: Math.round((clock.now().getTime() - started) / 1000), transcriptPath: '/workspace/calls/x.md', notesPath: '/workspace/calls/x-notes.md', endedBy: 'athlete' }));
        broadcast({ t: 'call', callId: callId!, state: 'ended' });
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: true });
    }

    if (path === '/v1/push/vapid-public-key') return json(res, 200, { key: '' });
    if (path === '/v1/push/subscriptions' && method === 'POST') return json(res, 200, { ok: true });

    if (path === '/v1/export' && method === 'POST') {
      const jobId = newId('job', clock);
      state.exports.set(jobId, 0);
      return json(res, 200, { jobId });
    }
    const exportMatch = /^\/v1\/export\/([^/]+)$/.exec(path);
    if (exportMatch && method === 'GET') {
      const n = state.exports.get(exportMatch[1]!);
      if (n === undefined) return apiError(res, 404, 'not_found', 'No such export');
      state.exports.set(exportMatch[1]!, n + 1);
      if (n < 1) return json(res, 202, { status: 'pending' });
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="opencoach-export.zip"' });
      return void res.end(Buffer.from('PK\u0005\u0006' + '\0'.repeat(18), 'binary'));
    }

    if (path === '/v1/account' && method === 'DELETE') {
      state.athlete = undefined;
      state.sessions.clear();
      state.events = [];
      state.blobs.clear();
      state.viewVersion = 1;
      for (const s of sockets) s.close(4001, 'account deleted');
      res.setHeader('set-cookie', 'oc_session=; HttpOnly; Path=/; Max-Age=0');
      res.writeHead(204);
      return void res.end();
    }

    // ---- admin
    if (path === '/admin/athletes') return json(res, 200, { athletes: [{ id: athlete.id, name: athlete.displayName, isAdmin: true, createdAt: nowIso() }] });
    if (path === '/admin/invites' && method === 'POST') return json(res, 200, { code: `INV-${randomBytes(3).toString('hex').toUpperCase()}` });
    if (path === '/admin/costs') {
      const days = Array.from({ length: 7 }, (_, i) => ({ date: new Date(clock.now().getTime() - (6 - i) * 86_400_000).toISOString().slice(0, 10), usd: Math.round((0.2 + ((i * 37) % 11) / 20) * 100) / 100, turns: 3 + i }));
      return json(res, 200, { byDay: days });
    }
    if (path === '/admin/turns') return json(res, 200, { turns: [{ id: 'turn_mock_1', at: nowIso(), trigger: 'reactive', costUsd: 0.012, status: 'ok' }] });
    if (/^\/admin\/turns\/[^/]+$/.test(path)) return json(res, 200, { id: path.split('/').pop(), steps: [{ tool: 'send_message', ms: 840 }], note: 'mock trace' });

    return apiError(res, 404, 'not_found', `No route for ${method} ${path}`);
  }

  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  /** Same layout as protocol ULIDs (10 time chars + 16 random chars) so old and new ids sort together. */
  function seedId(ms: number, i: number): string {
    let t = '';
    let x = ms;
    for (let k = 0; k < 10; k++) {
      t = CROCKFORD[x % 32]! + t;
      x = Math.floor(x / 32);
    }
    return `evt_${t}${i.toString(32).toUpperCase().padStart(16, '0')}`;
  }

  function seedHistory(n: number) {
    if (n <= 0) return;
    const base = clock.now().getTime() - n * 3_600_000;
    for (let i = 0; i < n; i++) {
      const ts = new Date(base + i * 3_600_000).toISOString();
      const id = seedId(base + i * 3_600_000, i);
      const mine = i % 2 === 0;
      state.events.push({
        id,
        athleteId: state.athlete!.id,
        ts,
        type: mine ? 'user.message' : 'coach.message',
        actor: mine ? 'athlete' : 'coach',
        payload: mine ? { text: `Older message ${i}`, attachments: [], channel: 'app' } : { messageId: id, text: `Older reply ${i}`, attachments: [], notify: 'none', delivery: 'sent', proactive: false, channel: 'app' },
      } as unknown as AnyEvent);
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[mock] handler error', e);
      if (!res.headersSent) apiError(res, 500, 'internal', e instanceof Error ? e.message : 'internal error');
      else res.end();
    });
  });

  // ---- websocket -----------------------------------------------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/v1/stream') return reject('404 Not Found');
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.some((re) => re.test(origin))) return reject('403 Forbidden'); // Origin checks are always on
    if (!authed(req)) return reject('401 Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.send(JSON.stringify({ t: 'presence', state: 'idle' } satisfies StreamMessage));
      ws.on('message', (raw) => {
        let msg: { t?: string; after?: string; upTo?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.t === 'resume' && msg.after) {
          for (const e of state.events.filter((x) => isVisible(x) && x.id > msg.after!)) ws.send(JSON.stringify({ t: 'event', event: e } satisfies StreamMessage));
        } else if (msg.t === 'typing') state.log.typing++;
        else if (msg.t === 'ack' && msg.upTo) state.log.acks.push(msg.upTo);
      });
      ws.on('close', () => sockets.delete(ws));
    });
  });

  await new Promise<void>((resolve) => viewsServer.listen(opts.viewsPort ?? 0, '127.0.0.1', resolve));
  viewsPortActual = (viewsServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    viewsPort: viewsPortActual,
    url: `http://127.0.0.1:${port}`,
    viewsUrl: `http://127.0.0.1:${viewsPortActual}`,
    setupCode,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close();
        server.closeAllConnections?.();
        viewsServer.closeAllConnections?.();
        server.close(() => viewsServer.close(() => resolve()));
      }),
  };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockServer({
    port: Number(process.env.MOCK_PORT ?? 8787),
    viewsPort: Number(process.env.MOCK_VIEWS_PORT ?? 8788),
    seedHistory: Number(process.env.MOCK_SEED_HISTORY ?? 0),
  });
  console.log(`\n  OpenCoach mock gateway  ${mock.url}\n  Views origin            ${mock.viewsUrl}\n  Setup code              ${mock.setupCode}\n`);
  const stop = () => void mock.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
