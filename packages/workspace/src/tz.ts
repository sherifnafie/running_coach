/**
 * Time-zone arithmetic on top of Intl (no dependency). All inputs are instants (ms since epoch)
 * or local calendar dates (YYYY-MM-DD); nothing here reads the system clock.
 */
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      f = formatter('UTC'); // unknown zone: degrade to UTC instead of throwing from a renderer
    }
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/** Offset of `tz` from UTC (ms, east positive) at instant `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock reading in `tz` at instant `ms`, expressed as a UTC-epoch number. */
function wallMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function localDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.y).padStart(4, '0')}-${pad2(p.m)}-${pad2(p.d)}`;
}

export function localHm(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

export function localDateTime(ms: number, tz: string): string {
  return `${localDate(ms, tz)} ${localHm(ms, tz)}`;
}

export function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`invalid local date "${ymd}" (expected YYYY-MM-DD)`);
  const y = +m[1]!;
  const mo = +m[2]!;
  const d = +m[3]!;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error(`invalid local date "${ymd}"`);
  return { y, m: mo, d };
}

export function addDays(ymd: string, n: number): string {
  const { y, m, d } = parseYmd(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function weekdayName(ymd: string): string {
  const { y, m, d } = parseYmd(ymd);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/**
 * The instant at which local calendar day `ymd` begins in `tz` (its first valid instant when local
 * midnight does not exist because of a DST gap; its first occurrence when it happens twice).
 */
export function startOfLocalDay(ymd: string, tz: string): number {
  const { y, m, d } = parseYmd(ymd);
  const W = Date.UTC(y, m - 1, d);
  const H36 = 36 * 3600_000;
  const before = tzOffsetMs(W - H36, tz);
  const offsets = new Set([before, tzOffsetMs(W, tz), tzOffsetMs(W + H36, tz)]);
  const valid: number[] = [];
  for (const o of offsets) {
    const c = W - o;
    if (wallMs(c, tz) === W) valid.push(c);
  }
  if (valid.length) return Math.min(...valid);
  return W - before; // gap: the day starts at the transition instant
}

/** [start, end) of a local day as instants (ms). */
export function localDayRange(ymd: string, tz: string): { start: number; end: number } {
  return { start: startOfLocalDay(ymd, tz), end: startOfLocalDay(addDays(ymd, 1), tz) };
}
