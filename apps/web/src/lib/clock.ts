import { SystemClock, type Clock } from '@opencoach/protocol';

/**
 * The web app's single time source (AGENTS.md: all time goes through `Clock`).
 * Nothing else in apps/web may call `Date.now()` / `new Date()` for "now".
 */
let current: Clock = new SystemClock();

export const clock = {
  now: (): Date => current.now(),
  nowMs: (): number => current.now().getTime(),
  nowIso: (): string => current.now().toISOString(),
};

/** Tests only. */
export function setClock(c: Clock): void {
  current = c;
}
