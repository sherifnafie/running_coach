/**
 * Pure helpers shared by the service worker and its unit tests (no DOM, no worker globals).
 * Payload shape follows protocol `PushNotification`:
 *   { title, body, tag?, data: { url?, messageId?, athleteId, kind? }, actions?: [{ action, title }], silent? }
 * For robustness the fields may also be nested under `payload.data` (brief: "from payload.data").
 */
export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  silent?: boolean;
  actions?: Array<{ action: string; title: string }>;
  data: { url?: string; messageId?: string; athleteId?: string; kind?: string; [k: string]: unknown };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parsePushPayload(raw: unknown): PushPayload {
  let src: unknown = raw;
  if (typeof raw === 'string') {
    try {
      src = JSON.parse(raw);
    } catch {
      src = { title: 'OpenCoach', body: raw };
    }
  }
  const top = isObj(src) ? src : {};
  const nested = isObj(top.data) && typeof top.data.title === 'string' ? top.data : undefined;
  const p = nested ?? top;
  const dataObj = nested ? (isObj(nested.data) ? nested.data : {}) : isObj(top.data) ? top.data : {};
  const actions = Array.isArray(p.actions)
    ? p.actions
        .filter((a): a is { action: string; title: string } => isObj(a) && typeof a.action === 'string' && typeof a.title === 'string')
        .slice(0, 3)
    : undefined;
  return {
    title: typeof p.title === 'string' && p.title ? p.title : 'OpenCoach',
    body: typeof p.body === 'string' ? p.body : '',
    tag: typeof p.tag === 'string' ? p.tag : undefined,
    silent: p.silent === true,
    actions,
    data: dataObj as PushPayload['data'],
  };
}

export function notificationOptions(p: PushPayload): NotificationOptions & { actions?: Array<{ action: string; title: string }> } {
  return {
    body: p.body,
    tag: p.tag,
    silent: p.silent,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: p.data,
    actions: p.actions,
    // a replaced notification with the same tag should still alert
    ...(p.tag ? { renotify: true } : {}),
  } as NotificationOptions & { actions?: Array<{ action: string; title: string }> };
}

/** Only same-origin relative URLs are opened from a notification. */
export function safeTargetUrl(url: unknown, origin: string): string {
  if (typeof url !== 'string' || !url) return '/';
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}

/** The ui-action to POST when a notification action button is tapped (SPEC §9.3 `notification_action`). */
export function notificationActionRequest(data: PushPayload['data'], action: string): { url: string; body: unknown } {
  return {
    url: '/v1/ui-actions',
    body: {
      source: data.messageId ? { messageId: data.messageId } : {},
      action: 'notification_action',
      payload: { value: action },
      wake: true,
    },
  };
}

/** Workers cannot read document.cookie: obtain a proof for the active cookie session before each write. */
export async function postWorkerMutation(url: string, body: unknown, fetcher: typeof fetch = fetch): Promise<Response | undefined> {
  const proof = await fetcher('/v1/auth/csrf', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!proof.ok) return undefined;
  const data: unknown = await proof.json();
  const token = isObj(data) && typeof data.token === 'string' ? data.token : undefined;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return fetcher(url, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify(body),
  });
}

/** Cache names owned by the app (cleared on sign-out). */
export const API_CACHE = 'oc-api-v1';
export const VIEWS_CACHE = 'oc-views-v1';

/** Same-origin GET paths the worker serves network-first from API_CACHE (matched against `URL.pathname`). */
export const API_PATH = /^\/v1\/(app|events|me)$/;
