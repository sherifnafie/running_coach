import { z } from 'zod';

/**
 * Shared primitive schemas.
 *
 * Naming convention (see docs/adr/0002-naming-conventions.md):
 *  - Model-facing tool inputs and coach-authored files (view.json, app.json, micro-UI) use snake_case,
 *    exactly as specified in SPEC Appendix C.
 *  - Everything else (event payloads, HTTP JSON, TypeScript) uses camelCase.
 *  - SQL columns use snake_case.
 */

/** RFC 3339 timestamp with offset or Z. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Local date YYYY-MM-DD. */
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type LocalDate = z.infer<typeof LocalDate>;

/** Local wall-clock time HH:MM (24h). */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');
export type LocalTime = z.infer<typeof LocalTime>;

/** IANA time zone name, e.g. "Europe/Amsterdam". Validated at runtime with Intl. */
export const IanaTimeZone = z.string().min(1).refine((tz) => isValidTimeZone(tz), 'unknown IANA time zone');
export type IanaTimeZone = z.infer<typeof IanaTimeZone>;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase hex sha256');

/** Reference to an immutable blob in the athlete's blob store. */
export const BlobRef = z.object({
  sha256: Sha256,
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  name: z.string().optional(),
});
export type BlobRef = z.infer<typeof BlobRef>;

/** Where an athlete message came from / where a coach message goes. */
export const Channel = z.enum(['app', 'telegram', 'whatsapp', 'email', 'call']);
export type Channel = z.infer<typeof Channel>;

export const Actor = z.enum(['athlete', 'coach', 'helper', 'harness', 'device', 'voice']);
export type Actor = z.infer<typeof Actor>;

/** SPEC §5.2 trigger classes. `call` = cascaded voice call utterance turns (SPEC §11.3). */
export const TriggerClass = z.enum(['reactive', 'scheduled', 'followup', 'consolidation', 'call']);
export type TriggerClass = z.infer<typeof TriggerClass>;

/** Who is running a loop: the head coach, a helper (subagent), or the realtime voice front-end. */
export const AgentKind = z.enum(['coach', 'helper', 'voice']);
export type AgentKind = z.infer<typeof AgentKind>;

export const Tier = z.enum(['coach', 'deep', 'fast']);
export type Tier = z.infer<typeof Tier>;

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

export const Units = z.enum(['metric', 'imperial']);
export type Units = z.infer<typeof Units>;

/** Virtual mount roots visible to the coach (SPEC §6.1). */
export const MOUNTS = ['/workspace', '/raw', '/history', '/system'] as const;
export type MountRoot = (typeof MOUNTS)[number];

export type DeepPartial<T> = T extends object
  ? T extends Array<infer _U>
    ? T
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Minimal console-backed logger; servers may provide a structured one. */
export function consoleLogger(bindings: Record<string, unknown> = {}, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const emit = (lvl: keyof typeof order, msg: string, data?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const line = JSON.stringify({ level: lvl, msg, ...bindings, ...(data ?? {}) });
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (b) => consoleLogger({ ...bindings, ...b }, level),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
