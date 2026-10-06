/**
 * Calendar-date helpers. Training dates are *local calendar dates* ("2026-10-06"), not instants,
 * so all arithmetic here is done in UTC on the date parts and never shifts with the time zone.
 * Only `todayIn` / `dateOf` look at a time zone.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isDateStr(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v);
}

function toUtc(d: string): number {
  const m = DATE_RE.exec(d);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtc(ms: number): string {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The local calendar date of an instant (epoch ms or Date) in a time zone. */
export function dateOf(instant: number | Date, tz = 'UTC'): string {
  const d = typeof instant === 'number' ? new Date(instant) : instant;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function todayIn(nowMs: number, tz = 'UTC'): string {
  return dateOf(nowMs, tz);
}

export function addDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(date: string): number {
  return new Date(toUtc(date)).getUTCDay();
}

/** First day of the week containing `date`. weekStartsOn: 0 = Sunday, 1 = Monday. */
export function startOfWeek(date: string, weekStartsOn: 0 | 1 = 1): string {
  const back = (weekday(date) - weekStartsOn + 7) % 7;
  return addDays(date, -back);
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: string, n: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + n;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-01`;
}

export function daysInMonth(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 6 rows x 7 columns of dates covering the month of `date` (rows trimmed if the last week is entirely next month). */
export function monthGrid(date: string, weekStartsOn: 0 | 1 = 1): string[][] {
  const first = startOfMonth(date);
  let cur = startOfWeek(first, weekStartsOn);
  const rows: string[][] = [];
  const month = first.slice(0, 7);
  for (let r = 0; r < 6; r++) {
    const row = weekDates(cur);
    if (r >= 4 && row.every((d) => d.slice(0, 7) !== month)) break;
    rows.push(row);
    cur = addDays(cur, 7);
  }
  return rows;
}

/** Dates from `from` to `to` inclusive. */
export function range(from: string, to: string): string[] {
  const n = diffDays(from, to);
  return Array.from({ length: Math.max(0, n + 1) }, (_, i) => addDays(from, i));
}

/** First day of the week according to the locale (falls back to Monday except for typical Sunday-first regions). */
export function weekStartsOnFor(locale: string): 0 | 1 {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info) return info.firstDay === 7 ? 0 : 1;
    const region = loc.region ?? '';
    if (['US', 'CA', 'JP', 'BR', 'MX', 'IL', 'AU', 'IN', 'KR', 'PH', 'ZA'].includes(region)) return 0;
  } catch {
    /* ignore */
  }
  return 1;
}

export const dates = {
  isDateStr,
  dateOf,
  todayIn,
  addDays,
  diffDays,
  weekday,
  startOfWeek,
  weekDates,
  startOfMonth,
  addMonths,
  daysInMonth,
  monthGrid,
  range,
  weekStartsOnFor,
};
export type DateHelpers = typeof dates;
