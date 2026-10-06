/**
 * @opencoach/store — SQLite implementation of the system Store (SPEC §4.1, §4.5).
 * Uses node:sqlite (Node ≥ 22.13), WAL mode, FTS5 for event search.
 *
 * STUB: signatures are final; implementation provided by the platform work package.
 */
import type { Clock, Store } from '@opencoach/protocol';

export interface SqliteStoreOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  clock: Clock;
}

/** Create and migrate a SQLite-backed Store. */
export async function openSqliteStore(opts: SqliteStoreOptions): Promise<Store> {
  void opts;
  throw new Error('not implemented: openSqliteStore');
}
