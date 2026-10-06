import { DateTime } from 'luxon';
import { RRule } from 'rrule';
import { isOneShot, ToolError, type ScheduleSpec } from '@opencoach/protocol';

/** Athlete-local helpers (all DST-correct via luxon). */

export function localDateTime(now: Date, tz: string): DateTime {
  return DateTime.fromJSDate(now, { zone: tz });
}

/** "2026-10-07 06:58 Tue" */
export function formatLocal(at: Date | string, tz: string): string {
  const dt = DateTime.fromJSDate(typeof at === 'string' ? new Date(at) : at, { zone: tz });
  return dt.isValid ? dt.toFormat('yyyy-LL-dd HH:mm ccc') : String(at);
}

export function formatLocalTime(at: Date | string, tz: string): string {
  const dt = DateTime.fromJSDate(typeof at === 'string' ? new Date(at) : at, { zone: tz });
  return dt.isValid ? dt.toFormat('HH:mm') : String(at);
}

export function parseHHMM(s: string): { hour: number; minute: number } {
  const [h, m] = s.split(':').map((x) => Number.parseInt(x, 10));
  return { hour: h ?? 0, minute: m ?? 0 };
}

/**
 * The athlete-local "epoch date": the local calendar date of (now - dayBoundary), so activity after
 * midnight but before the boundary (default 04:00) still belongs to the previous day.
 */
export function epochDate(now: Date, tz: string, dayBoundary: string): string {
  const { hour, minute } = parseHHMM(dayBoundary);
  return localDateTime(now, tz).minus({ hours: hour, minutes: minute }).toISODate() ?? '1970-01-01';
}

/** Start of the athlete-local calendar day containing `now`, as an ISO instant. */
export function localDayStartIso(now: Date, tz: string): string {
  return localDateTime(now, tz).startOf('day').toUTC().toISO() ?? now.toISOString();
}

export function localMonthStartIso(now: Date, tz: string): string {
  return localDateTime(now, tz).startOf('month').toUTC().toISO() ?? now.toISOString();
}

/** Whether local `now` is inside the [start, end) quiet window (which may wrap midnight); returns window end instant. */
export function quietHoursEnd(now: Date, tz: string, quiet: { start: string; end: string } | null): Date | null {
  if (!quiet || quiet.start === quiet.end) return null;
  const local = localDateTime(now, tz);
  const s = parseHHMM(quiet.start);
  const e = parseHHMM(quiet.end);
  const minutes = local.hour * 60 + local.minute;
  const startM = s.hour * 60 + s.minute;
  const endM = e.hour * 60 + e.minute;
  const inside = startM < endM ? minutes >= startM && minutes < endM : minutes >= startM || minutes < endM;
  if (!inside) return null;
  let end = local.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
  if (end <= local) end = end.plus({ days: 1 });
  return end.toJSDate();
}

/** Next local occurrence of HH:MM strictly after `now` in tz. */
export function nextDailyAt(now: Date, tz: string, hhmm: string): Date {
  const { hour, minute } = parseHHMM(hhmm);
  const local = localDateTime(now, tz);
  let next = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (next <= local) next = next.plus({ days: 1 });
  return next.toJSDate();
}

/**
 * Next fire instant for a schedule spec strictly after `after`. Recurring rules are evaluated in
 * "floating" local wall time (RRULE over wall-clock values) and converted to instants in the zone,
 * which keeps "every Sunday 18:00" correct across DST changes.
 */
export function nextFire(spec: ScheduleSpec, after: Date, athleteTz: string): Date | null {
  if (isOneShot(spec)) {
    const at = new Date(spec.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  const tz = spec.tz ?? athleteTz;
  const { hour, minute } = parseHHMM(spec.time);
  const localAfter = localDateTime(after, tz);
  // Floating representation: wall-clock fields encoded as if UTC.
  const floatingAfter = new Date(Date.UTC(localAfter.year, localAfter.month - 1, localAfter.day, localAfter.hour, localAfter.minute, localAfter.second));
  const dtstart = new Date(Date.UTC(localAfter.year, localAfter.month - 1, localAfter.day, hour, minute, 0));
  dtstart.setUTCDate(dtstart.getUTCDate() - 1);
  let rule: RRule;
  try {
    const opts = RRule.parseString(spec.rrule.replace(/^RRULE:/i, ''));
    rule = new RRule({ ...opts, dtstart, byhour: [hour], byminute: [minute], bysecond: [0], tzid: undefined });
  } catch (e) {
    throw new ToolError('INVALID_INPUT', `Invalid rrule "${spec.rrule}": ${(e as Error).message}`);
  }
  for (let guard = 0; guard < 5; guard++) {
    const occ = rule.after(floatingAfter, false);
    if (!occ) return null;
    const instant = DateTime.fromObject(
      { year: occ.getUTCFullYear(), month: occ.getUTCMonth() + 1, day: occ.getUTCDate(), hour: occ.getUTCHours(), minute: occ.getUTCMinutes() },
      { zone: tz },
    );
    const at = instant.toJSDate();
    if (spec.until && at.getTime() > new Date(spec.until).getTime()) return null;
    if (at.getTime() > after.getTime()) return at;
    floatingAfter.setTime(occ.getTime());
  }
  return null;
}

/** Minimum gap (minutes) between the next two occurrences of a recurring spec (for the 15-min floor). */
export function minRecurrenceGapMinutes(spec: ScheduleSpec, from: Date, tz: string): number | null {
  if (isOneShot(spec)) return null;
  const a = nextFire(spec, from, tz);
  if (!a) return null;
  const b = nextFire(spec, a, tz);
  if (!b) return null;
  return (b.getTime() - a.getTime()) / 60_000;
}
