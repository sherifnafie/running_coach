import { isCallActive } from './calls';
import { captureInstallPrompt } from './push';

/**
 * Register the service worker (production builds only: in dev it would fight HMR). The worker calls
 * skipWaiting + clientsClaim itself, so a new version takes over as soon as it is installed.
 *
 * An installed app can stay open in the background for days and would keep running the old code, so the app
 * checks for an update whenever it comes to the foreground and reloads into the new version at a quiet moment:
 * never during a call or while the athlete is typing (drafts survive a reload, but a half-typed word shouldn't jump).
 */
export function registerServiceWorker(): void {
  captureInstallPrompt();
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', type: 'classic' })
      .then((reg) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
        });
      })
      .catch((e) => {
        console.warn('service worker registration failed', e);
      });
  });

  // No controller yet means this is the first install, not an update: nothing to reload.
  let updated = false;
  const hadController = !!navigator.serviceWorker.controller;
  const reloadIfQuiet = () => {
    if (!updated || isCallActive()) return false;
    if (document.visibilityState === 'visible' && isTyping()) return false;
    location.reload();
    return true;
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || updated) return;
    updated = true;
    if (reloadIfQuiet()) return;
    // Busy right now: switch over the next time the app goes to the background.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') reloadIfQuiet();
    });
  });
}

function isTyping(): boolean {
  const el = document.activeElement;
  return (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value !== '';
}
