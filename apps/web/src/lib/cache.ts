import { clear as idbClear, createStore, del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';

/**
 * Small IndexedDB key/value cache for offline use: last AppInfo, last MeResponse, the latest chat page and
 * read-only snapshots of what views last queried (SPEC §9.9). Every call is best effort and never throws.
 */
let store: ReturnType<typeof createStore> | null = null;
const memory = new Map<string, unknown>();
let broken = false;

function getStore() {
  return (store ??= createStore('opencoach-cache', 'kv'));
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!broken) {
    try {
      return await idbGet<T>(key, getStore());
    } catch {
      broken = true;
    }
  }
  return memory.get(key) as T | undefined;
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!broken) {
    try {
      await idbSet(key, value, getStore());
      return;
    } catch {
      broken = true;
    }
  }
  memory.set(key, value);
}

export async function cacheDelete(key: string): Promise<void> {
  memory.delete(key);
  if (broken) return;
  try {
    await idbDel(key, getStore());
  } catch {
    /* ignore */
  }
}

/** Sign-out / delete account: forget everything cached for this athlete. */
export async function cacheClear(): Promise<void> {
  memory.clear();
  if (broken) return;
  try {
    await idbClear(getStore());
  } catch {
    /* ignore */
  }
}

/** Stable short key for a query snapshot. */
export function snapshotKey(viewId: string, kind: 'q' | 'f', input: unknown): string {
  const s = JSON.stringify(input);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `view:${viewId}:${kind}:${(h >>> 0).toString(36)}:${s.length}`;
}
