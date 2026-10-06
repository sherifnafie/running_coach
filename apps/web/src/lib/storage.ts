/**
 * Per-viewer conveniences in localStorage. Every access is wrapped: storage can be missing,
 * full or blocked (private windows, previews), and the app must work without it.
 */
export function lsGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function lsRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function lsGetJson<T>(key: string, fallback: T): T {
  const raw = lsGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function lsSetJson(key: string, value: unknown): void {
  lsSet(key, JSON.stringify(value));
}

/** Wipe everything this app stored (sign-out / account deletion). */
export function lsClearApp(): void {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    for (const k of Object.keys(ls)) if (k.startsWith('oc.')) ls.removeItem(k);
  } catch {
    /* ignore */
  }
}
