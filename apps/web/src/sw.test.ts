import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('workbox-core', () => ({ clientsClaim: vi.fn() }));
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class {} }));
vi.mock('workbox-precaching', () => ({ cleanupOutdatedCaches: vi.fn(), createHandlerBoundToURL: vi.fn(), precacheAndRoute: vi.fn() }));
vi.mock('workbox-routing', () => ({ NavigationRoute: class {}, registerRoute: vi.fn() }));
vi.mock('workbox-strategies', () => ({ NetworkFirst: class {}, StaleWhileRevalidate: class {} }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('visible Web Push delivery [UI-1]', () => {
  it.each([
    { focused: true, kind: 'message', silent: true },
    { focused: false, kind: 'message', silent: false },
    { focused: true, kind: 'system', silent: false },
  ])('always displays $kind pushes when focused=$focused', async ({ focused, kind, silent }) => {
    const listeners = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn(async () => undefined);
    vi.stubGlobal('self', { __WB_MANIFEST: [], skipWaiting: vi.fn(),
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
      registration: { showNotification }, clients: { matchAll: vi.fn(async () => [{ focused, visibilityState: focused ? 'visible' : 'hidden' }]) } });
    await import('./sw');
    let pending: Promise<void> | undefined;
    listeners.get('push')!({ data: { text: () => JSON.stringify({ title: 'Coach', body: 'A message', data: { kind } }) },
      waitUntil: (value: Promise<void>) => { pending = value; } });
    await pending;
    expect(showNotification).toHaveBeenCalledExactlyOnceWith('Coach', expect.objectContaining({ body: 'A message', silent }));
  });
});
