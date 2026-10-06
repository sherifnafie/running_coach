import { useMemo, useSyncExternalStore } from 'react';

/**
 * Tiny hash router (no server fallback needed):
 *   #/chat · #/view/<id>?k=v · #/settings · #/settings/<section> · #/call
 */
export type Route =
  | { name: 'chat' }
  | { name: 'view'; viewId: string; params: Record<string, string> }
  | { name: 'settings'; section?: string }
  | { name: 'call' };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/chat';
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const q = new URLSearchParams(queryPart);
  switch (parts[0]) {
    case 'view':
      if (parts[1]) return { name: 'view', viewId: decodeURIComponent(parts[1]), params: Object.fromEntries(q.entries()) };
      return { name: 'chat' };
    case 'settings':
      return { name: 'settings', section: parts[1] };
    case 'call':
      return { name: 'call' };
    default:
      return { name: 'chat' };
  }
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case 'chat':
      return '#/chat';
    case 'call':
      return '#/call';
    case 'settings':
      return r.section ? `#/settings/${r.section}` : '#/settings';
    case 'view': {
      const q = new URLSearchParams(r.params);
      const qs = q.toString();
      return `#/view/${encodeURIComponent(r.viewId)}${qs ? `?${qs}` : ''}`;
    }
  }
}

export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const hash = formatRoute(r);
  if (location.hash === hash) return;
  if (opts.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
  };
}

const getHash = () => location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}
