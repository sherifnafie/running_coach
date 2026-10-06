/**
 * Thin loader around the built-in `node:sqlite` module.
 *
 * `node:sqlite` prints an ExperimentalWarning when it is first loaded. We suppress exactly that one
 * warning (and nothing else) by wrapping `process.emitWarning` for the duration of the load.
 */
import { createRequire } from 'node:module';

export type SqliteModule = typeof import('node:sqlite');
export type { DatabaseSync, StatementSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

let cached: SqliteModule | undefined;

/** Load `node:sqlite` once, without the ExperimentalWarning. */
export function loadSqlite(): SqliteModule {
  if (cached) return cached;
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const first = rest[0];
    const type =
      typeof first === 'string' ? first : first && typeof first === 'object' && 'type' in first ? String((first as { type?: unknown }).type) : warning instanceof Error ? warning.name : '';
    const message = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    cached = require('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}
