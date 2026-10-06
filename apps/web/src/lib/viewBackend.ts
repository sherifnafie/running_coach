import { NetworkError } from './api';
import type { BridgeBackend } from './bridge';
import { cacheGet, cacheSet, snapshotKey } from './cache';
import { views } from './endpoints';
import type { OfflineQueue } from './offlineQueue';

/**
 * The bridge's data backend: gateway calls plus the offline behaviour from SPEC §9.9.
 *  - reads: remember the last result per (view, query); when the network is down serve that snapshot;
 *  - direct writes ([UI-1]) and acts: queued offline and replayed on reconnect.
 */
export interface ViewBackendDeps {
  queue: () => OfflineQueue | undefined;
  isOnline: () => boolean;
}

export function createViewBackend(deps: ViewBackendDeps): BridgeBackend {
  const enc = encodeURIComponent;

  async function cachedRead(viewId: string, kind: 'q' | 'f', input: unknown, fetcher: () => Promise<unknown>): Promise<unknown> {
    const key = snapshotKey(viewId, kind, input);
    if (!deps.isOnline()) {
      const hit = await cacheGet<unknown>(key);
      if (hit !== undefined) return hit;
      throw new NetworkError('offline and no cached snapshot');
    }
    try {
      const res = await fetcher();
      void cacheSet(key, res);
      return res;
    } catch (e) {
      if (e instanceof NetworkError) {
        const hit = await cacheGet<unknown>(key);
        if (hit !== undefined) return hit;
      }
      throw e;
    }
  }

  async function writeOrQueue(kind: 'view_write' | 'view_act', path: string, body: unknown, send: () => Promise<unknown>): Promise<unknown> {
    const queue = deps.queue();
    if (!deps.isOnline() && queue) {
      await queue.enqueue({ kind, method: 'POST', path, body });
      return { queued: true };
    }
    try {
      return await send();
    } catch (e) {
      if (e instanceof NetworkError && queue) {
        await queue.enqueue({ kind, method: 'POST', path, body });
        return { queued: true };
      }
      throw e;
    }
  }

  return {
    query: (viewId, sql, params) => cachedRead(viewId, 'q', { sql, params }, () => views.query(viewId, sql, params)),
    file: (viewId, path) => cachedRead(viewId, 'f', { path }, () => views.file(viewId, path)),
    write: (viewId, body) => writeOrQueue('view_write', `/v1/views/${enc(viewId)}/write`, body, () => views.write(viewId, body)),
    act: (viewId, body) => writeOrQueue('view_act', `/v1/views/${enc(viewId)}/act`, body, () => views.act(viewId, body)),
    error: (viewId, body) => views.error(viewId, body),
  };
}
