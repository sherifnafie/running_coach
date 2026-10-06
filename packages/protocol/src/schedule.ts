import { z } from 'zod';
import { IsoDateTime, LocalTime } from './common';

/**
 * Schedules (SPEC §5.5). One-shot (`at`) or recurring (RFC 5545 RRULE body + local time-of-day,
 * evaluated in the athlete's time zone unless `tz` is given).
 * Examples: { at: "2026-10-07T20:30:00+02:00" }
 *           { rrule: "FREQ=WEEKLY;BYDAY=SU", time: "18:00" }
 */
export const ScheduleSpec = z.union([
  z.object({ at: IsoDateTime }),
  z.object({
    rrule: z.string().min(5).max(500),
    time: LocalTime,
    tz: z.string().optional(),
    until: IsoDateTime.optional(),
  }),
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

export function isOneShot(s: ScheduleSpec): s is { at: string } {
  return 'at' in s;
}

/** Schedule kinds: coach-created wakes plus harness-owned recurring jobs. */
export const ScheduleKind = z.enum(['coach', 'heartbeat', 'consolidation', 'release']);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

export const ScheduleStatus = z.enum(['active', 'cancelled', 'done']);
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

export interface ScheduleRecord {
  id: string;
  athleteId: string;
  kind: ScheduleKind;
  spec: ScheduleSpec;
  purpose: string;
  payload?: unknown;
  /** Fires even while the athlete has paused the coach (SPEC §5.5). */
  duringPause: boolean;
  /** Next fire instant (UTC ISO) or null when exhausted. */
  nextFireAt: string | null;
  status: ScheduleStatus;
  createdAt: string;
  createdInTurn?: string;
  lastFiredAt?: string;
}

/** Limits (SPEC §7 / Appendix C §C.2). */
export const SCHEDULE_LIMITS = {
  maxActive: 50,
  minIntervalMinutes: 15,
  maxPurposeChars: 1000,
} as const;
