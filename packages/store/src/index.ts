/**
 * @opencoach/store — SQLite implementation of the system Store (SPEC §4.1, §4.5).
 * Uses node:sqlite (Node ≥ 22.13), WAL mode, FTS5 for event search.
 *
 * See `sqlite-store.ts` for behavioural notes (time canonicalisation, pagination windows,
 * tombstones, ordering of list methods).
 */
import type { Clock, Store } from '@opencoach/protocol';
import { SqliteStore } from './sqlite-store';

export { isTombstoned, TOMBSTONE_PAYLOAD } from './sqlite-store';
export { extractSearchText } from './fts';

export interface SqliteStoreOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  clock: Clock;
}

/**
 * Create and migrate a SQLite-backed Store.
 *
 * File databases are created with mode 0600 (parent directories are created as needed), use WAL,
 * `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL` and `secure_delete=ON`.
 */
export async function openSqliteStore(opts: SqliteStoreOptions): Promise<Store> {
  const store = new SqliteStore(opts);
  try {
    await store.migrate();
  } catch (e) {
    await store.close();
    throw e;
  }
  return store;
}
