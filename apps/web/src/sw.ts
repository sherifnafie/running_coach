/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { API_CACHE, VIEWS_CACHE, notificationActionRequest, notificationOptions, parsePushPayload, postWorkerMutation, safeTargetUrl } from './sw-shared';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// ---- app shell ------------------------------------------------------------------------------------------
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    // never serve the shell for API, admin or file routes
    denylist: [/^\/v1\//, /^\/admin\//, /^\/kit\//, /^\/v\//],
  }),
);

// ---- runtime caching ------------------------------------------------------------------------------------
// App info and chat history: network first (fresh when online, last good copy offline).
registerRoute(
  ({ url, request }) => request.method === 'GET' && url.origin === self.location.origin && /^\/v1\/(app|events|me)$/.test(url.pathname),
  new NetworkFirst({
    cacheName: API_CACHE,
    networkTimeoutSeconds: 4,
    plugins: [new ExpirationPlugin({ maxEntries: 40, maxAgeSeconds: 7 * 24 * 3600 })],
  }),
);

// Views and UI kit from the (separate) views origin: stale-while-revalidate. Requests only reach this worker
// when made by the shell itself (a sandboxed cross-origin iframe is not controlled by it), so this covers
// prefetches and any shell-level fetches of view assets; browser HTTP caching (immutable headers) covers the iframe.
registerRoute(
  ({ url }) => url.origin !== self.location.origin && (url.pathname.startsWith('/kit/') || url.pathname.startsWith('/v/')),
  new StaleWhileRevalidate({
    cacheName: VIEWS_CACHE,
    plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 30 * 24 * 3600 })],
  }),
);

// ---- lifecycle ------------------------------------------------------------------------------------------
self.skipWaiting();
clientsClaim();

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type === 'SKIP_WAITING') void self.skipWaiting();
  if (data?.type === 'CLEAR_CACHES') {
    event.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(VIEWS_CACHE)]));
  }
});

// ---- push -----------------------------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  const raw = event.data ? safeText(event.data) : undefined;
  const payload = parsePushPayload(raw ?? {});
  event.waitUntil(
    (async () => {
      // If the app is open and focused the in-app UI already shows the message.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = clients.some((c) => (c as WindowClient).focused && (c as WindowClient).visibilityState === 'visible');
      if (focused && payload.data.kind !== 'safety') return;
      await self.registration.showNotification(payload.title, notificationOptions(payload));
    })(),
  );
});

function safeText(d: PushMessageData): string | undefined {
  try {
    return d.text();
  } catch {
    return undefined;
  }
}

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  const data = parsePushPayload({ title: notification.title, body: notification.body, data: notification.data }).data;
  notification.close();
  event.waitUntil(
    (async () => {
      // An action button was tapped: send it to the gateway without opening the app when possible.
      if (event.action) {
        const { url, body } = notificationActionRequest(data, event.action);
        try {
          const res = await postWorkerMutation(url, body);
          if (res?.ok) return;
        } catch {
          /* fall through: open the app so the athlete can answer there */
        }
      }
      const target = safeTargetUrl(data.url, self.location.origin);
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of windows) {
        if (c.url.startsWith(self.location.origin)) {
          const w = c as WindowClient;
          await w.focus();
          if ('navigate' in w && target !== '/') await w.navigate(target).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // The browser rotated the subscription: re-register it (best effort; the app re-registers on next open).
  const e = event as ExtendableEvent & { oldSubscription?: PushSubscription; newSubscription?: PushSubscription };
  e.waitUntil(
    (async () => {
      const sub = e.newSubscription ?? (await self.registration.pushManager.getSubscription());
      if (!sub) return;
      const json = sub.toJSON();
      if (!json.keys) return;
      await postWorkerMutation('/v1/push/subscriptions', { endpoint: sub.endpoint, keys: json.keys }).catch(() => undefined);
    })(),
  );
});
