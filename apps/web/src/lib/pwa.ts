import { captureInstallPrompt } from './push';

/**
 * Register the service worker (production builds only: in dev it would fight HMR). The worker calls
 * skipWaiting + clientsClaim itself, so updates apply on the next navigation.
 */
export function registerServiceWorker(): void {
  captureInstallPrompt();
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'classic' }).catch((e) => {
      console.warn('service worker registration failed', e);
    });
  });
}
