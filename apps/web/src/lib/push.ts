import { push as pushApi } from './endpoints';

/** Web Push helpers (SPEC §14): permission, VAPID subscribe, install guidance. */

export type PushSupport = 'supported' | 'needs-install' | 'unsupported';

export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** iOS only delivers Web Push to installed (home-screen) web apps. */
export function pushSupport(): PushSupport {
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return 'needs-install';
  return hasApis ? 'supported' : 'unsupported';
}

export function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export type PushDeviceState = PushSupport | 'blocked' | 'permission' | 'unsubscribed' | 'unregistered' | 'ready';

export async function pushDeviceState(vapidKey?: string): Promise<PushDeviceState> {
  const support = pushSupport();
  if (support !== 'supported') return support;
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'permission';
  const sub = await currentSubscription();
  if (!sub) return 'unsubscribed';
  if (vapidKey && !matchesKey(sub, vapidKey)) return 'unregistered';
  return (await pushApi.status(sub.endpoint)).registered ? 'ready' : 'unregistered';
}

function matchesKey(sub: PushSubscription, key: string): boolean {
  const current = sub.options.applicationServerKey;
  return !!current && toBase64Url(current) === key;
}

async function registerSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh ?? toBase64Url(sub.getKey('p256dh'));
  const auth = json.keys?.auth ?? toBase64Url(sub.getKey('auth'));
  await pushApi.subscribe({ endpoint: sub.endpoint, keys: { p256dh, auth } });
}

/** Restore an existing device connection without ever prompting for permission. */
export async function syncPushSubscription(vapidKey?: string): Promise<void> {
  if (pushSupport() !== 'supported' || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub && (!vapidKey || matchesKey(sub, vapidKey))) await registerSubscription(sub);
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg?.active) return reg;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The app is still getting ready. Reopen it and try again.')), 12_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Ask permission, subscribe with the gateway's VAPID key and register the subscription. */
export async function enablePush(vapidKey?: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const support = pushSupport();
  if (support === 'unsupported') return { ok: false, reason: 'This browser does not support push notifications.' };
  if (support === 'needs-install') return { ok: false, reason: 'On iPhone and iPad, add OpenCoach to your Home Screen first, then enable notifications.' };
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'Notifications are blocked. You can allow them in your browser or device settings.' };
    const key = vapidKey || (await pushApi.vapidKey()).key;
    if (!key) return { ok: false, reason: 'Push is not configured on this server.' };
    const reg = await activeRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !matchesKey(sub, key)) {
      await pushApi.unsubscribe(sub.endpoint);
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await registerSubscription(sub);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not enable notifications.' };
  }
}

export async function disablePush(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (sub) await pushApi.unsubscribe(sub.endpoint).catch(() => undefined);
    await sub?.unsubscribe();
  } catch {
    /* ignore */
  }
}

export async function testPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Enable notifications on this device first.');
  await pushApi.test(sub.endpoint);
}

/** Chromium's install prompt, captured so onboarding can offer a button. */
type BeforeInstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    installListeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installListeners.forEach((l) => l());
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export function onInstallStateChange(l: () => void): () => void {
  installListeners.add(l);
  return () => installListeners.delete(l);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  installListeners.forEach((l) => l());
  return outcome === 'accepted';
}
