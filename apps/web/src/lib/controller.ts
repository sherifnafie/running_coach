import type { AnyEvent, AppInfo, AthleteSettings, AuthResponse, MeResponse, StreamMessage } from '@opencoach/protocol';
import { ApiRequestError, describeError, isRetryable, NetworkError, request, setUnauthorizedHandler } from './api';
import { appStore, patchApp, type ThemePref, type Toast } from './appState';
import { cacheClear, cacheGet, cacheSet } from './cache';
import { applyServerCallMessage } from './calls';
import { emitWorkspaceChange, isWorkspaceChange } from './changeBus';
import { chatReducer, noticeText, type ChatAction, type LocalAnswer, type PendingAttachment } from './chatModel';
import { clock } from './clock';
import { accentText, contrastText } from './color';
import { hasCuratedLabels, labelLanguage, languageDirection, setLabelPack } from '@opencoach/protocol';
import { account, aiApi, auth, chat, i18nApi, me as meApi, settingsApi, views } from './endpoints';
import { OfflineQueue, idbQueueStorage, type QueuedRequest, type SendResult } from './offlineQueue';
import { extensionForMime, type Recording } from './recorder';
import { disablePush, syncPushSubscription } from './push';
import { navigate } from './router';
import { addDismissed, bannerFromEvent, bannerFromHistory, bannerFromStream, isDismissed } from './safety';
import { lsClearApp, lsGet, lsGetJson, lsRemove, lsSet, lsSetJson } from './storage';
import { StreamClient, defaultStreamUrl } from './stream';

/**
 * Application controller: orchestrates the stores, the gateway client, the WebSocket stream and the offline
 * queue. UI components call these functions and subscribe to `appStore`; there is no coaching logic here.
 */

const EVENTS_CACHE_KEY = 'chat:events';
const APP_CACHE_KEY = 'app';
const ME_CACHE_KEY = 'me';
const PAGE = 50;

let stream: StreamClient | undefined;
let queue: OfflineQueue | undefined;
let booted = false;
let chatVisible = false;
let hiddenAt = 0;
// Preserve write order and prevent an older settings GET from undoing a newer saved preference.
let settingsRequests: Promise<unknown> = Promise.resolve();
function queueSettings<T>(request: () => Promise<T>): Promise<T> {
  const result = settingsRequests.then(request);
  settingsRequests = result.catch(() => undefined);
  return result;
}
const retryHandlers = new Map<string, () => Promise<void>>();

export function getQueue(): OfflineQueue | undefined {
  return queue;
}

export function dispatchChat(action: ChatAction): void {
  appStore.setState((s) => ({ ...s, chat: chatReducer(s.chat, action) }));
}

// ---- toasts -----------------------------------------------------------------------------------

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = `t${toastSeq++}`;
  appStore.setState((s) => ({ ...s, toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 6000 : 3500);
}

export function dismissToast(id: string): void {
  appStore.setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---- theme & accent ------------------------------------------------------------------------------

export function initTheme(): void {
  const pref = (lsGet('oc.theme') as ThemePref | null) ?? 'system';
  setTheme(pref === 'light' || pref === 'dark' ? pref : 'system');
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyPresentation);
}

export function setTheme(pref: ThemePref): void {
  patchApp({ theme: pref });
  lsSet('oc.theme', pref);
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/** Effective theme for views (`ViewEnv.theme`). */
export function effectiveTheme(): 'light' | 'dark' {
  const pref = appStore.getState().theme;
  if (pref !== 'system') return pref;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyAccent(accent: string | undefined): void {
  const root = document.documentElement;
  if (!accent || !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    root.style.removeProperty('--rc-accent');
    root.style.removeProperty('--rc-on-accent');
    root.style.removeProperty('--rc-accent-text');
    return;
  }
  root.style.setProperty('--rc-accent', accent);
  root.style.setProperty('--rc-on-accent', contrastText(accent));
  root.style.setProperty('--rc-accent-text', accentText(accent, effectiveTheme() === 'dark' ? '#1a1b1e' : '#ffffff'));
}

function applyPresentation(): void {
  const s = appStore.getState();
  const settings = s.me?.settings;
  if (settings) {
    setTheme(settings.appearance.theme);
    document.documentElement.lang = settings.profile.locale;
    document.documentElement.dir = languageDirection(settings.profile.locale);
    void ensureLabels(settings.profile.locale);
  }
  applyAccent(settings?.appearance.accent ?? s.app?.app.theme?.accent);
}

// ---- interface labels in any language -----------------------------------------------------------------------------------

let labelsFor: string | undefined;
let labelsTimer: ReturnType<typeof setTimeout> | undefined;

function installLabels(language: string, labels: Record<string, string>): void {
  setLabelPack(language, labels);
  patchApp({ labelsVersion: appStore.getState().labelsVersion + 1 });
}

/**
 * Languages without a curated table get a generated label pack from the server (made once per language). The last
 * pack is kept in localStorage so a reload shows the right language immediately; until one exists labels stay English.
 */
async function ensureLabels(locale: string, attempt = 0): Promise<void> {
  const language = labelLanguage(locale);
  if (hasCuratedLabels(language)) return;
  if (attempt === 0) {
    if (labelsFor === language) return;
    labelsFor = language;
    if (labelsTimer) clearTimeout(labelsTimer);
    const cached = lsGetJson<Record<string, string> | null>(`oc.labels.${language}`, null);
    if (cached) installLabels(language, cached);
  }
  try {
    const pack = await i18nApi.labels(locale);
    if (labelsFor !== language) return;
    if (Object.keys(pack.labels).length) {
      installLabels(language, pack.labels);
      lsSetJson(`oc.labels.${language}`, pack.labels);
    }
    if (pack.ready && Object.keys(pack.labels).length) return;
  } catch {
    /* offline or server busy: retry below */
  }
  if (attempt < 30 && labelsFor === language) labelsTimer = setTimeout(() => void ensureLabels(locale, attempt + 1), Math.min(2000 + attempt * 1000, 10_000));
}

async function refreshSettings(): Promise<void> {
  const athleteId = appStore.getState().me?.athlete.id;
  if (!athleteId) return;
  await queueSettings(async () => {
    if (appStore.getState().me?.athlete.id !== athleteId) return;
    try {
      const me = await meApi.get();
      if (appStore.getState().me?.athlete.id !== athleteId) return;
      patchApp({ me });
      void cacheSet(ME_CACHE_KEY, me);
      applyPresentation();
    } catch { /* Keep the last saved presentation offline. Reconnect retries. */ }
  });
}

// ---- boot & session -------------------------------------------------------------------------------

export async function boot(): Promise<void> {
  patchApp({ boot: 'loading', bootError: undefined });
  setUnauthorizedHandler(() => void handleSignedOut());
  try {
    const me = await meApi.get({ noAuthRedirect: true });
    await startSession(me);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) {
      await handleSignedOut();
      return;
    }
    if (e instanceof NetworkError) {
      const cachedMe = await cacheGet<MeResponse>(ME_CACHE_KEY);
      if (cachedMe) {
        patchApp({ online: false });
        await startSession(cachedMe, { offline: true });
        return;
      }
    }
    patchApp({ boot: 'unreachable', bootError: describeError(e) });
  }
}

async function handleSignedOut(): Promise<void> {
  teardownSession();
  try {
    const { needsSetup } = await auth.setupStatus();
    patchApp({ boot: needsSetup ? 'needs-setup' : 'signed-out', me: undefined });
    // The first-visit screens follow the browser's language (an existing generated pack, if the server has one).
    void ensureLabels(navigator.language || 'en');
  } catch (e) {
    patchApp({ boot: e instanceof NetworkError ? 'unreachable' : 'signed-out', bootError: describeError(e), me: undefined });
  }
}

/** After setup / pairing / passkey login succeeded (cookie is set). */
export async function onAuthenticated(_res?: AuthResponse, opts: { fresh?: boolean } = {}): Promise<void> {
  const me = await meApi.get();
  const key = `oc.onboarded.${me.athlete.id}`;
  const show = opts.fresh === true || lsGet(key) !== '1';
  await startSession(me);
  if (show) patchApp({ onboarding: true });
}

export function finishOnboarding(): void {
  const id = appStore.getState().me?.athlete.id;
  if (id) lsSet(`oc.onboarded.${id}`, '1');
  patchApp({ onboarding: false });
}

async function startSession(me: MeResponse, opts: { offline?: boolean } = {}): Promise<void> {
  void cacheSet(ME_CACHE_KEY, me);
  // Read the cached app and conversation before the shell first renders, so a refresh goes straight to the last
  // known screen instead of passing through an empty nav and an empty chat.
  const [cachedApp, cachedEvents] = await Promise.all([cacheGet<AppInfo>(APP_CACHE_KEY), cacheGet<AnyEvent[]>(EVENTS_CACHE_KEY)]);
  if (cachedApp) patchApp({ app: cachedApp, appFromCache: true });
  if (cachedEvents?.length) dispatchChat({ type: 'history', events: cachedEvents, mode: 'initial', hasMore: true });
  patchApp({
    me,
    boot: 'ready',
    safetyDismissed: lsGetJson<string[]>('oc.safety.dismissed', []),
  });
  initQueue();
  applyPresentation();
  if (opts.offline) {
    patchApp({ appChecked: true });
    startStream();
    return;
  }
  void refreshApp();
  await loadInitialHistory();
  startStream();
  void syncDevicePush();
  void sendDeviceContext();
  void queue?.flush();
  void finishOpenRouterOAuth();
}

/** Set before leaving for OpenRouter's sign-in page; OpenRouter sends the browser back to `/?code=…`. */
export const OPENROUTER_OAUTH_MARKER = 'oc.openrouter-oauth';

async function finishOpenRouterOAuth(): Promise<void> {
  const code = new URLSearchParams(location.search).get('code');
  if (!code || lsGet(OPENROUTER_OAUTH_MARKER) !== '1') return;
  lsRemove(OPENROUTER_OAUTH_MARKER);
  history.replaceState(null, '', `${location.pathname}#/settings`);
  try {
    await aiApi.oauthFinish(code);
    await refreshMe();
    toast('Your OpenRouter account is connected. Your coach now runs on your own key.', 'info');
  } catch (e) {
    toast(`Could not connect OpenRouter: ${describeError(e)}`, 'error');
  }
}

/** Reload /v1/me (billing and features change outside the settings patch flow). */
export async function refreshMe(): Promise<void> {
  try {
    const next = await meApi.get();
    void cacheSet(ME_CACHE_KEY, next);
    patchApp({ me: next });
  } catch {
    /* keep the current state; the next boot refreshes it */
  }
}

function teardownSession(): void {
  stream?.stop();
  stream = undefined;
  booted = false;
  retryHandlers.clear();
  appStore.setState((s) => ({
    ...s,
    app: undefined,
    appFromCache: false,
    appChecked: false,
    ws: 'closed',
    presence: 'idle',
    progress: undefined,
    safety: null,
    updated: {},
    chat: chatReducer(s.chat, { type: 'reset' }),
    unseen: 0,
    onboarding: false,
    queued: 0,
  }));
  applyAccent(undefined);
  document.documentElement.lang = navigator.language || 'en';
  document.documentElement.dir = languageDirection(navigator.language || 'en');
  setTheme('system');
}

export async function signOut(): Promise<void> {
  await disablePush();
  try {
    await auth.logout();
  } catch {
    /* sign out locally even if the server is unreachable */
  }
  await clearLocalData();
  await handleSignedOut();
}

/** Wipe caches, queue and local preferences (sign-out, account deletion). */
export async function clearLocalData(): Promise<void> {
  stream?.stop();
  await queue?.list().then((items) => Promise.all(items.map((i) => queue!.remove(i.id)))).catch(() => undefined);
  await cacheClear();
  await disablePush();
  lsClearApp();
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage({ type: 'CLEAR_CACHES' });
  } catch {
    /* ignore */
  }
}

/**
 * Start over with a fresh coach on the same account. Cached conversation, views and the unsent draft belong to the
 * old coach, so they are dropped; the sign-in, push subscription and preferences on this device stay.
 */
export async function resetCoach(): Promise<void> {
  const athleteId = appStore.getState().me?.athlete.id;
  await account.reset();
  stream?.stop();
  await queue?.list().then((items) => Promise.all(items.map((i) => queue!.remove(i.id)))).catch(() => undefined);
  await cacheClear();
  if (athleteId) lsRemove(`oc.draft.${athleteId}`);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage({ type: 'CLEAR_CACHES' });
  } catch {
    /* ignore */
  }
  location.replace('/#/chat');
  location.reload();
}

export async function deleteAccount(): Promise<void> {
  await account.delete();
  await clearLocalData();
  await handleSignedOut();
}

// ---- app info (views) ---------------------------------------------------------------------------------

function setApp(app: AppInfo, fromCache = false): void {
  patchApp({ app, appFromCache: fromCache });
  applyPresentation();
}

export async function refreshApp(): Promise<void> {
  try {
    const app = await views.app();
    setApp(app);
    void cacheSet(APP_CACHE_KEY, app);
  } catch (e) {
    if (!(e instanceof NetworkError)) console.warn('GET /v1/app failed', e);
  } finally {
    patchApp({ appChecked: true });
  }
}

export function markUpdated(viewId: string, version: string, summary: string): void {
  appStore.setState((s) => s.updated[viewId]?.version === version && s.updated[viewId]?.summary === summary
    ? s : ({ ...s, updated: { ...s.updated, [viewId]: { version, summary } } }));
}

export function clearUpdated(viewId: string): void {
  appStore.setState((s) => {
    if (!s.updated[viewId]) return s;
    const { [viewId]: _gone, ...rest } = s.updated;
    return { ...s, updated: rest };
  });
}

// ---- history ------------------------------------------------------------------------------------------

async function loadInitialHistory(): Promise<void> {
  try {
    const page = await chat.events({ limit: PAGE });
    dispatchChat({ type: 'history', events: page.events, hasMore: page.hasMore, mode: 'initial' });
    const banner = bannerFromHistory(page.events, clock.nowMs());
    if (banner && !isDismissed(banner, appStore.getState().safetyDismissed)) patchApp({ safety: banner });
    persistEvents();
  } catch (e) {
    dispatchChat({ type: 'history', events: [], mode: 'initial' });
    if (!(e instanceof NetworkError)) toast(`Could not load messages: ${describeError(e)}`, 'error');
  }
}

export async function loadOlder(): Promise<void> {
  const { events, hasMore } = appStore.getState().chat;
  const oldest = events[0];
  if (!hasMore || !oldest) return;
  try {
    const page = await chat.events({ before: oldest.id, limit: PAGE });
    dispatchChat({ type: 'history', events: page.events, hasMore: page.hasMore, mode: 'older' });
  } catch (e) {
    toast(`Could not load older messages: ${describeError(e)}`, 'error');
  }
}

/** Catch up on anything missed while the socket was down (belt and braces next to `resume`). */
async function fillGap(): Promise<void> {
  let after = appStore.getState().chat.lastEventId;
  if (!after) return;
  for (let i = 0; i < 10; i++) {
    try {
      const page = await chat.events({ after, limit: 200 });
      dispatchChat({ type: 'history', events: page.events, mode: 'newer' });
      const last = page.events[page.events.length - 1];
      if (!page.hasMore || !last) break;
      after = last.id;
    } catch {
      break;
    }
  }
  persistEvents();
}

/** Re-read the newest page (merge replaces by id): picks up held messages that were released. */
async function refreshRecent(): Promise<void> {
  try {
    const page = await chat.events({ limit: 30 });
    dispatchChat({ type: 'history', events: page.events, mode: 'newer' });
  } catch {
    /* ignore */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistEvents(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { events } = appStore.getState().chat;
    void cacheSet(EVENTS_CACHE_KEY, events.slice(-100));
  }, 800);
}

// ---- stream ---------------------------------------------------------------------------------------------

function startStream(): void {
  if (stream) return;
  stream = new StreamClient({
    url: () => defaultStreamUrl(),
    getLastEventId: () => appStore.getState().chat.lastEventId,
    onStatus: (ws) => patchApp({ ws }),
    onMessage: handleStream,
    onOpen: ({ reconnect }) => {
      if (reconnect) {
        void fillGap();
        void refreshApp();
        void refreshSettings();
      }
      void queue?.flush();
    },
  });
  stream.start();
  if (!booted) {
    booted = true;
    bindGlobalListeners();
  }
}

export function handleStream(m: StreamMessage): void {
  const nowIso = clock.nowIso();
  switch (m.t) {
    case 'settings.changed':
      void refreshSettings();
      return;
    case 'presence':
      appStore.setState((s) => ({ ...s, presence: m.state, progress: m.state === 'idle' ? undefined : s.progress }));
      return;
    case 'progress':
      patchApp({ progress: { label: m.label, turnId: m.turnId } });
      return;
    case 'message.start':
    case 'message.delta':
    case 'message.cancel':
      dispatchChat({ type: 'stream', message: m, nowIso });
      return;
    case 'message.end':
      dispatchChat({ type: 'stream', message: m, nowIso });
      patchApp({ progress: undefined });
      if (m.event.payload.delivery !== 'held') onCoachMessageArrived();
      persistEvents();
      if (isWorkspaceChange(m)) emitWorkspaceChange();
      return;
    case 'event': {
      dispatchChat({ type: 'event', event: m.event });
      onEventArrived(m.event);
      persistEvents();
      if (isWorkspaceChange(m)) emitWorkspaceChange();
      return;
    }
    case 'ui.published':
      markUpdated(m.viewId, m.version, m.summary);
      void refreshApp().then(() => emitWorkspaceChange());
      return;
    case 'notice': {
      if (m.kind === 'message_released') {
        void refreshRecent();
        return;
      }
      if (m.kind === 'safety_flag') return; // the `safety` message carries the banner
      const text = noticeText(m.kind, m.text);
      if (text && m.kind !== 'held_quiet_hours') dispatchChat({ type: 'notice', notice: { id: `${m.kind}:${nowIso}`, ts: nowIso, kind: m.kind, text } });
      return;
    }
    case 'safety': {
      const banner = bannerFromStream(m, clock.nowMs());
      patchApp({ safety: banner });
      return;
    }
    case 'call':
      applyServerCallMessage(m);
      return;
  }
}

function onEventArrived(e: AnyEvent): void {
  if (e.type === 'coach.message' && e.payload.delivery !== 'held') onCoachMessageArrived();
  if (e.type === 'coach.ui_published') {
    markUpdated(e.payload.viewId, e.payload.version, e.payload.summary);
    void refreshApp();
  }
  if (e.type === 'harness.notice') {
    if (e.payload.kind === 'message_released') void refreshRecent();
    const banner = bannerFromEvent(e);
    if (banner && !isDismissed(banner, appStore.getState().safetyDismissed)) patchApp({ safety: banner });
  }
}

function onCoachMessageArrived(): void {
  if (!chatVisible || document.visibilityState !== 'visible') {
    appStore.setState((s) => ({ ...s, unseen: s.unseen + 1 }));
    updateTitle();
  }
}

function updateTitle(): void {
  const n = appStore.getState().unseen;
  document.title = n > 0 ? `(${n}) OpenCoach` : 'OpenCoach';
}

export function setChatVisible(v: boolean): void {
  chatVisible = v;
  if (v && document.visibilityState === 'visible') {
    patchApp({ unseen: 0 });
    updateTitle();
    ackLatest();
  }
}

// ---- global listeners (online/offline, visibility) -------------------------------------------------------

function bindGlobalListeners(): void {
  window.addEventListener('online', () => {
    patchApp({ online: true });
    stream?.nudge();
    void queue?.flush();
    void refreshApp();
    void syncDevicePush();
  });
  window.addEventListener('offline', () => patchApp({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = clock.nowMs();
      return;
    }
    // Back in the foreground: sockets die silently on mobile, so reconnect after a long absence.
    const away = hiddenAt ? clock.nowMs() - hiddenAt : 0;
    if (away > 30_000) stream?.restart();
    else stream?.nudge();
    void queue?.flush();
    if (chatVisible) {
      patchApp({ unseen: 0 });
      updateTitle();
    }
    void sendDeviceContext();
    void syncDevicePush();
  });
}

async function syncDevicePush(): Promise<void> {
  const me = appStore.getState().me;
  if (!me?.features.push || !me.settings.notifications.push || !appStore.getState().online) return;
  await syncPushSubscription(me.vapidPublicKey).catch(() => undefined);
}

let lastCtx = '';
async function sendDeviceContext(): Promise<void> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = navigator.language || 'en';
  const sig = `${tz}|${locale}`;
  if (sig === lastCtx || !appStore.getState().online) return;
  try {
    await chat.deviceContext(tz, locale);
    lastCtx = sig;
  } catch {
    /* best effort */
  }
}

// ---- offline queue --------------------------------------------------------------------------------------------

function initQueue(): void {
  if (queue) return;
  queue = new OfflineQueue(
    idbQueueStorage(),
    async (req: QueuedRequest): Promise<SendResult> => {
      try {
        const data = await request(req.method, req.path, req.body);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, retryable: isRetryable(error), error };
      }
    },
    {
      onChange: (items) => patchApp({ queued: items.length }),
      onSent: (req, data) => {
        if (req.kind === 'message') {
          const ev = (data as { event?: AnyEvent } | undefined)?.event;
          if (ev) dispatchChat({ type: 'event', event: ev });
          if (req.clientId) dispatchChat({ type: 'pending/remove', clientId: req.clientId });
        }
        if (req.kind === 'ui_action' || req.kind === 'reaction') {
          const ev = (data as { event?: AnyEvent } | undefined)?.event;
          if (ev) dispatchChat({ type: 'event', event: ev });
        }
        if (req.kind === 'view_write' || req.kind === 'view_act') emitWorkspaceChange();
      },
      onDropped: (req, error) => {
        const msg = describeError(error);
        if (req.kind === 'message' && req.clientId) dispatchChat({ type: 'pending/patch', clientId: req.clientId, patch: { status: 'failed', error: msg } });
        else if (req.kind === 'ui_action' && typeof req.meta?.messageId === 'string') {
          dispatchChat({ type: 'answer/clear', messageId: req.meta.messageId });
          toast(`Your answer could not be sent: ${msg}`, 'error');
        } else toast(`A change could not be saved: ${msg}`, 'error');
      },
    },
  );
  void queue.list().then((items) => patchApp({ queued: items.length }));
}

export function flushQueue(): void {
  void queue?.flush();
}

// ---- sending: text -----------------------------------------------------------------------------------------------

export function newClientId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `c_${c.randomUUID()}`;
  return `c_${clock.nowMs().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function sendText(text: string, opts: { replyTo?: string } = {}): Promise<void> {
  const t = text.trim();
  if (!t) return;
  const clientId = newClientId();
  dispatchChat({ type: 'pending/add', message: { clientId, ts: clock.nowIso(), kind: 'text', text: t, attachments: [], status: 'sending' } });
  await deliverText(clientId, t, opts.replyTo);
}

async function deliverText(clientId: string, text: string, replyTo?: string): Promise<void> {
  const body = { text, clientId, ...(replyTo ? { replyTo } : {}) };
  const enqueue = async () => {
    await queue?.enqueue({ kind: 'message', method: 'POST', path: '/v1/messages', body, clientId });
    dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'queued', error: undefined } });
  };
  if (!appStore.getState().online) return enqueue();
  dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'sending', error: undefined } });
  try {
    const res = await chat.postMessage(body);
    if (res?.event) dispatchChat({ type: 'event', event: res.event });
    dispatchChat({ type: 'pending/remove', clientId });
    persistEvents();
  } catch (e) {
    if (isRetryable(e)) await enqueue();
    else dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'failed', error: describeError(e) } });
  }
}

export async function retryPending(clientId: string): Promise<void> {
  const p = appStore.getState().chat.pending.find((x) => x.clientId === clientId);
  if (!p) return;
  const custom = retryHandlers.get(clientId);
  if (custom) return custom();
  if (p.kind === 'text') await deliverText(clientId, p.text);
}

export function discardPending(clientId: string): void {
  const p = appStore.getState().chat.pending.find((x) => x.clientId === clientId);
  retryHandlers.delete(clientId);
  revokePreviews(p?.attachments, p?.voice?.previewUrl);
  dispatchChat({ type: 'pending/remove', clientId });
  void queue?.list().then((items) => {
    const q = items.find((i) => i.clientId === clientId);
    if (q) void queue?.remove(q.id);
  });
}

function revokePreviews(attachments?: PendingAttachment[], voiceUrl?: string): void {
  for (const a of attachments ?? []) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  if (voiceUrl) URL.revokeObjectURL(voiceUrl);
}

// ---- sending: files & voice notes --------------------------------------------------------------------------------

export async function sendFiles(files: File[], caption: string): Promise<void> {
  if (files.length === 0) return;
  const clientId = newClientId();
  const attachments: PendingAttachment[] = files.map((f) => ({
    name: f.name,
    mime: f.type || 'application/octet-stream',
    bytes: f.size,
    previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
  }));
  dispatchChat({
    type: 'pending/add',
    message: { clientId, ts: clock.nowIso(), kind: 'upload', text: caption.trim(), attachments, status: 'sending', progress: 0 },
  });
  const uploaded: string[] = [];
  const run = async () => {
    dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'sending', error: undefined } });
    try {
      for (let i = uploaded.length; i < files.length; i++) {
        const f = files[i]!;
        const res = await chat.uploadFile(f, (frac) =>
          dispatchChat({ type: 'pending/patch', clientId, patch: { progress: (i + frac) / files.length } }),
        );
        uploaded.push(res.blob.sha256);
        dispatchChat({ type: 'pending/patch', clientId, patch: { blobShas: [...uploaded], progress: uploaded.length / files.length } });
      }
      const res = await chat.commitUploads(uploaded, caption.trim() || undefined);
      if (res?.event) dispatchChat({ type: 'event', event: res.event });
      retryHandlers.delete(clientId);
      revokePreviews(attachments);
      dispatchChat({ type: 'pending/remove', clientId });
      persistEvents();
    } catch (e) {
      dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'failed', error: describeError(e) } });
    }
  };
  retryHandlers.set(clientId, run);
  await run();
}

export async function sendVoiceNote(rec: Recording): Promise<void> {
  const clientId = newClientId();
  const previewUrl = URL.createObjectURL(rec.blob);
  dispatchChat({
    type: 'pending/add',
    message: {
      clientId,
      ts: clock.nowIso(),
      kind: 'voice',
      text: '',
      attachments: [],
      voice: { durationMs: rec.durationMs, previewUrl },
      status: 'sending',
      progress: 0,
    },
  });
  const run = async () => {
    dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'sending', error: undefined } });
    try {
      const res = await chat.voiceNote(rec.blob, `voice-note.${extensionForMime(rec.mime)}`, {
        durationS: rec.durationMs / 1000,
        onProgress: (frac) => dispatchChat({ type: 'pending/patch', clientId, patch: { progress: frac } }),
      });
      if (res?.event) dispatchChat({ type: 'event', event: res.event });
      retryHandlers.delete(clientId);
      URL.revokeObjectURL(previewUrl);
      dispatchChat({ type: 'pending/remove', clientId });
      persistEvents();
    } catch (e) {
      dispatchChat({ type: 'pending/patch', clientId, patch: { status: 'failed', error: describeError(e) } });
    }
  };
  retryHandlers.set(clientId, run);
  await run();
}

// ---- micro-UI answers, reactions, read state ----------------------------------------------------------------------

async function postUiAction(messageId: string, action: 'quick_reply' | 'form_submit', payload: unknown, local: LocalAnswer): Promise<void> {
  dispatchChat({ type: 'answer/set', messageId, answer: local });
  const body = { source: { messageId }, action, payload, wake: true };
  const enqueue = async () => {
    await queue?.enqueue({ kind: 'ui_action', method: 'POST', path: '/v1/ui-actions', body, meta: { messageId } });
    dispatchChat({ type: 'answer/set', messageId, answer: { ...local, status: 'queued' } });
  };
  if (!appStore.getState().online) return enqueue();
  try {
    const res = (await chat.uiAction(body)) as { event?: AnyEvent } | undefined;
    if (res?.event) dispatchChat({ type: 'event', event: res.event });
  } catch (e) {
    if (isRetryable(e)) await enqueue();
    else {
      dispatchChat({ type: 'answer/clear', messageId });
      toast(`Could not send your answer: ${describeError(e)}`, 'error');
    }
  }
}

export function answerQuickReply(messageId: string, reply: { label: string; value: string }): Promise<void> {
  return postUiAction(messageId, 'quick_reply', { value: reply.value, label: reply.label }, { action: 'quick_reply', value: reply.value, label: reply.label, status: 'sending' });
}

export function submitForm(messageId: string, formId: string, values: Record<string, unknown>): Promise<void> {
  return postUiAction(messageId, 'form_submit', { form_id: formId, values }, { action: 'form_submit', formId, values, status: 'sending' });
}

export async function react(messageId: string, reaction: string): Promise<void> {
  const prev = appStore.getState().chat.reactions[messageId] ?? null;
  const next = prev === reaction ? null : reaction;
  dispatchChat({ type: 'reaction', messageId, reaction: next });
  if (next === null) return; // there is no "remove reaction" endpoint; keep it local
  try {
    await chat.reaction(messageId, next);
  } catch (e) {
    if (isRetryable(e)) await queue?.enqueue({ kind: 'reaction', method: 'POST', path: '/v1/reactions', body: { messageId, reaction: next } });
    else {
      dispatchChat({ type: 'reaction', messageId, reaction: prev });
      toast(`Could not save your reaction: ${describeError(e)}`, 'error');
    }
  }
}

const readSent = new Set<string>();
let readBuf = new Set<string>();
let readTimer: ReturnType<typeof setTimeout> | undefined;

/** Coach messages that scrolled into view while the app is visible. */
export function markRead(messageIds: string[]): void {
  const meId = appStore.getState().me?.athlete.id ?? '';
  const watermark = lsGet(`oc.lastRead.${meId}`) ?? '';
  for (const id of messageIds) if (!readSent.has(id) && id > watermark) readBuf.add(id);
  if (readBuf.size === 0 || readTimer) return;
  readTimer = setTimeout(async () => {
    readTimer = undefined;
    const ids = [...readBuf];
    readBuf = new Set();
    if (ids.length === 0 || !appStore.getState().online) return;
    try {
      await chat.read(ids);
      ids.forEach((i) => readSent.add(i));
      const max = ids.reduce((m, i) => (i > m ? i : m), watermark);
      lsSet(`oc.lastRead.${meId}`, max);
    } catch {
      /* will retry when the messages are seen again */
    }
  }, 1000);
}

let ackTimer: ReturnType<typeof setTimeout> | undefined;
export function ackLatest(): void {
  if (ackTimer) return;
  ackTimer = setTimeout(() => {
    ackTimer = undefined;
    const last = appStore.getState().chat.lastEventId;
    if (last && chatVisible) stream?.send({ t: 'ack', upTo: last });
  }, 500);
}

let lastTyping = 0;
export function sendTyping(): void {
  const now = clock.nowMs();
  if (now - lastTyping < 3000) return;
  lastTyping = now;
  stream?.send({ t: 'typing' });
}

// ---- safety banner ----------------------------------------------------------------------------------------------------

export function dismissSafety(): void {
  const s = appStore.getState();
  if (!s.safety) return;
  const dismissed = addDismissed(s.safetyDismissed, s.safety.key);
  lsSetJson('oc.safety.dismissed', dismissed);
  patchApp({ safety: null, safetyDismissed: dismissed });
}

// ---- navigation helpers -----------------------------------------------------------------------------------------------

export function openChat(prefill?: string): void {
  if (prefill) patchApp({ composerPrefill: { text: prefill, nonce: clock.nowMs() } });
  navigate({ name: 'chat' });
}

export function consumePrefill(): void {
  patchApp({ composerPrefill: undefined });
}

// ---- settings ----------------------------------------------------------------------------------------------------------

export async function updateSettings(patch: unknown): Promise<AthleteSettings | undefined> {
  const athleteId = appStore.getState().me?.athlete.id;
  return queueSettings(async () => {
    if (!athleteId || appStore.getState().me?.athlete.id !== athleteId) return undefined;
    try {
      const settings = await settingsApi.put(patch);
      appStore.setState((s) => {
        if (!s.me || s.me.athlete.id !== athleteId) return s;
        const next = { ...s.me, settings, athlete: { ...s.me.athlete, displayName: settings.profile?.name ?? s.me.athlete.displayName } };
        void cacheSet(ME_CACHE_KEY, next);
        return { ...s, me: next };
      });
      applyPresentation();
      return settings;
    } catch (e) {
      toast(`Could not save settings: ${describeError(e)}`, 'error');
      return undefined;
    }
  });
}
