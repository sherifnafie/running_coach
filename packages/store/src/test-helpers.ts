import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock, defaultSettings, type Store } from '@opencoach/protocol';
import { openSqliteStore } from './index';

export const T0 = '2026-10-07T06:00:00.000Z';

export function makeClock(start: string = T0): VirtualClock {
  return new VirtualClock(start);
}

export async function memStore(clock: VirtualClock = makeClock()): Promise<{ store: Store; clock: VirtualClock }> {
  const store = await openSqliteStore({ path: ':memory:', clock });
  return { store, clock };
}

/** A fresh temp directory removed by the returned cleanup function. */
export function tmpDir(prefix = 'oc-store-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function addAthlete(store: Store, id: string, name = id): Promise<void> {
  await store.createAthlete({ id, displayName: name, isAdmin: false, settings: defaultSettings() });
}

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
export const SHA_C = 'c'.repeat(64);
