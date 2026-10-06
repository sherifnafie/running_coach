import { DateTime } from 'luxon';

/**
 * Athlete-local calendar helpers (luxon, DST-correct). Pure functions of instants; "now" always
 * comes from the injected Clock, never from here.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayId = (typeof WEEKDAYS)[number];

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  /** minutes since local midnight */
  minutes: number;
  weekday: WeekdayId;
}

function dt(instant: Date | string, tz: string): DateTime {
  return DateTime.fromJSDate(typeof instant === 'string' ? new Date(instant) : instant, { zone: tz });
}

export function localParts(instant: Date | string, tz: string): LocalParts {
  const d = dt(instant, tz);
  return {
    date: d.toISODate() ?? '1970-01-01',
    hour: d.hour,
    minute: d.minute,
    minutes: d.hour * 60 + d.minute,
    weekday: WEEKDAYS[d.weekday - 1] as WeekdayId,
  };
}

export function localDate(instant: Date | string, tz: string): string {
  return localParts(instant, tz).date;
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map((x) => Number.parseInt(x, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

export function formatHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Instant for a local wall-clock date + time in a zone. */
export function zonedInstant(date: string, time: string, tz: string): Date {
  const [h, m] = time.split(':').map((x) => Number.parseInt(x, 10));
  const d = DateTime.fromISO(date, { zone: tz }).set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
  if (!d.isValid) throw new Error(`invalid local time ${date} ${time} in ${tz}`);
  return d.toJSDate();
}

/** ISO 8601 string with the zone's UTC offset ("2026-10-07T06:58:00+02:00"). */
export function isoWithOffset(instant: Date | string, tz: string): string {
  return dt(instant, tz).toISO({ suppressMilliseconds: true }) ?? new Date(instant).toISOString();
}

export function addDays(date: string, n: number): string {
  return (DateTime.fromISO(date, { zone: 'utc' }).plus({ days: n }).toISODate() ?? date) as string;
}

export function diffDays(a: string, b: string): number {
  return Math.round(DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'days').days);
}

export function weekdayOf(date: string): WeekdayId {
  return WEEKDAYS[DateTime.fromISO(date, { zone: 'utc' }).weekday - 1] as WeekdayId;
}

/** Monday of the ISO week containing `date`. */
export function weekStart(date: string): string {
  const d = DateTime.fromISO(date, { zone: 'utc' });
  return d.minus({ days: d.weekday - 1 }).toISODate() as string;
}

/** Whether a minute-of-day lies inside the [start, end) window (which may wrap midnight). */
export function inWindow(minutes: number, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** Whole local days between two instants' local dates (b - a). */
export function localDayDiff(a: Date | string, b: Date | string, tz: string): number {
  return diffDays(localDate(a, tz), localDate(b, tz));
}

export function addMinutes(instant: Date | string, minutes: number): Date {
  return new Date(new Date(instant).getTime() + minutes * 60_000);
}

export function addHours(instant: Date | string, hours: number): Date {
  return addMinutes(instant, hours * 60);
}

export function isValidZone(tz: string): boolean {
  return DateTime.fromMillis(0, { zone: tz }).isValid;
}

/** Parse "YYYY-MM-DD HH:mm" (local, in tz) or any ISO string with offset/Z. */
export function parseStart(input: string, tz: string): Date {
  const iso = DateTime.fromISO(input.replace(' ', 'T'), { setZone: true, zone: tz });
  if (!iso.isValid) throw new Error(`invalid start time "${input}"`);
  return iso.toJSDate();
}
