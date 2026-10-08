import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { push } from './endpoints';
import { currentSubscription, disablePush, enablePush, pushDeviceState, syncPushSubscription } from './push';

vi.mock('./endpoints', () => ({ push: { subscribe: vi.fn(), unsubscribe: vi.fn(), status: vi.fn(), vapidKey: vi.fn(), test: vi.fn() } }));
const key = 'AQID';
let permission: NotificationPermission;
let sub: PushSubscription | null;
let registration: ServiceWorkerRegistration;
let requestPermission: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  permission = 'granted';
  requestPermission = vi.fn(async () => 'granted');
  vi.stubGlobal('Notification', { get permission() { return permission; }, requestPermission });
  vi.stubGlobal('PushManager', class {});
  sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/device', options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }, toJSON: () => ({ keys: { p256dh: 'public', auth: 'private' } }), unsubscribe: vi.fn(async () => true) } as unknown as PushSubscription;
  registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => sub), subscribe: vi.fn(async () => sub) } } as unknown as ServiceWorkerRegistration;
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) } });
  vi.mocked(push.status).mockResolvedValue({ registered: true });
  vi.mocked(push.subscribe).mockResolvedValue(undefined);
  vi.mocked(push.unsubscribe).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker; });

describe('PWA notification enrollment [UI-1] [SEC-4]', () => {
  it('does not mistake an account preference or permission for a connected device', async () => {
    permission = 'default';
    expect(await pushDeviceState(key)).toBe('permission');
    permission = 'denied';
    expect(await pushDeviceState(key)).toBe('blocked');
    permission = 'granted'; sub = null;
    expect(await pushDeviceState(key)).toBe('unsubscribed');
    expect(push.status).not.toHaveBeenCalled();
  });
  it('detects lost server registration and restores it without prompting', async () => {
    vi.mocked(push.status).mockResolvedValue({ registered: false });
    expect(await pushDeviceState(key)).toBe('unregistered');
    await syncPushSubscription(key);
    expect(push.subscribe).toHaveBeenCalledWith({ endpoint: sub!.endpoint, keys: { p256dh: 'public', auth: 'private' } });
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it('never prompts or subscribes automatically without existing permission/enrollment', async () => {
    permission = 'default';
    await syncPushSubscription(key);
    permission = 'granted'; sub = null;
    await syncPushSubscription(key);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(push.subscribe).not.toHaveBeenCalled();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });
  it('replaces an obsolete VAPID subscription and saves the new connection', async () => {
    const old = sub!;
    const replacement = { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/new' } as PushSubscription;
    vi.mocked(registration.pushManager.subscribe).mockResolvedValue(replacement);
    expect(await enablePush('BAUG')).toEqual({ ok: true });
    expect(push.unsubscribe).toHaveBeenCalledWith(old.endpoint);
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(push.subscribe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: replacement.endpoint }));
  });
  it('unregisters the device on both sides', async () => {
    const old = await currentSubscription();
    await disablePush();
    expect(push.unsubscribe).toHaveBeenCalledWith(old!.endpoint);
    expect(old!.unsubscribe).toHaveBeenCalledOnce();
  });
});
