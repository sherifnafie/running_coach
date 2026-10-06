/**
 * Formatters exposed as `coach.format`. Pure functions take explicit locale/units/tz; `createFormat`
 * binds them to the live `coach.env` so views can just call `coach.format.pace(285)`.
 */
import { dateOf, isDateStr, todayIn, diffDays } from './dates';

export type Units = 'metric' | 'imperial';
export const KM_PER_MI = 1.609344;
export const M_PER_MI = 1609.344;

export interface FormatDefaults {
  locale: string;
  units: Units;
  tz: string;
  nowMs: () => number;
}

const nfCache = new Map<string, Intl.NumberFormat>();
export function nf(locale: string, min = 0, max = min): Intl.NumberFormat {
  const k = `${locale}|${min}|${max}`;
  let f = nfCache.get(k);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    } catch {
      f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    }
    nfCache.set(k, f);
  }
  return f;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DASH = '–';

export interface DistanceOpts {
  /** Decimals for km/mi (default 1; 2 below 1 mi). */
  digits?: number;
  /** Show metres (or feet-free miles) for sub-kilometre distances in metric. Default true. */
  metres?: boolean;
  /** Append the unit (default true). */
  unit?: boolean;
  locale?: string;
}

/** 10250 -> "10.3 km" (metric) or "6.4 mi" (imperial). Sub-km metric distances show as "400 m". */
export function distance(m: number | null | undefined, units: Units = 'metric', opts: DistanceOpts = {}): string {
  if (!isNum(m)) return DASH;
  const locale = opts.locale ?? 'en-US';
  const showUnit = opts.unit !== false;
  if (units === 'imperial') {
    const mi = m / M_PER_MI;
    const digits = opts.digits ?? (mi < 1 ? 2 : 1);
    return nf(locale, 0, digits).format(mi) + (showUnit ? ' mi' : '');
  }
  if (m < 1000 && opts.metres !== false) return nf(locale, 0, 0).format(Math.round(m)) + (showUnit ? ' m' : '');
  const km = m / 1000;
  const digits = opts.digits ?? (km >= 100 ? 0 : 1);
  return nf(locale, 0, digits).format(km) + (showUnit ? ' km' : '');
}

/** Convert metres to the display unit's number (km or mi). */
export function distanceValue(m: number, units: Units = 'metric'): number {
  return units === 'imperial' ? m / M_PER_MI : m / 1000;
}

export type DurationStyle = 'clock' | 'short' | 'long';

/** 3725 -> "1:02:05" (clock) | "1h 02m" (short) | "1 hour 2 minutes" (long). */
export function duration(seconds: number | null | undefined, style: DurationStyle = 'clock'): string {
  if (!isNum(seconds)) return DASH;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (style === 'clock') return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`;
  if (style === 'short') {
    if (h > 0) return `${h}h ${p2(m)}m`;
    if (m > 0) return sec >= 30 && m < 10 ? `${m}:${p2(sec)} min` : `${m} min`;
    return `${sec} s`;
  }
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (!h && !m) parts.push(`${sec} ${sec === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/** Pace seconds -> "m:ss" (minutes can exceed 59 for very slow paces; carries correctly). */
export function clockMinSec(sec: number): string {
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function paceValue(sPerKm: number, units: Units = 'metric'): number {
  return units === 'imperial' ? sPerKm * KM_PER_MI : sPerKm;
}

/** 285 -> "4:45 /km" (metric) or "7:38 /mi" (imperial). Input is always seconds per km. */
export function pace(sPerKm: number | null | undefined, units: Units = 'metric', opts: { unit?: boolean } = {}): string {
  if (!isNum(sPerKm) || sPerKm <= 0) return DASH;
  const t = clockMinSec(paceValue(sPerKm, units));
  return opts.unit === false ? t : `${t} /${units === 'imperial' ? 'mi' : 'km'}`;
}

/** [235, 245] -> "3:55–4:05 /km" */
export function paceRange(range: [number, number] | number[], units: Units = 'metric'): string {
  const [a, b] = range;
  if (!isNum(a) || !isNum(b)) return DASH;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${pace(lo, units, { unit: false })}${DASH}${pace(hi, units)}`;
}

/** Speed helper: m/s -> "12.4 km/h" or "7.7 mph". */
export function speed(mPerS: number | null | undefined, units: Units = 'metric', locale = 'en-US'): string {
  if (!isNum(mPerS)) return DASH;
  return units === 'imperial' ? `${nf(locale, 0, 1).format((mPerS * 3600) / M_PER_MI)} mph` : `${nf(locale, 0, 1).format(mPerS * 3.6)} km/h`;
}

export type DateStyle = 'short' | 'medium' | 'long' | 'weekday' | 'weekday-short' | 'month' | 'month-short' | 'day' | 'iso';

const DATE_OPTS: Record<Exclude<DateStyle, 'iso'>, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric' },
  medium: { weekday: 'short', month: 'short', day: 'numeric' },
  long: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
  weekday: { weekday: 'long' },
  'weekday-short': { weekday: 'short' },
  month: { month: 'long', year: 'numeric' },
  'month-short': { month: 'short' },
  day: { day: 'numeric' },
};

/** Parse a date-only string, ISO instant, epoch ms or Date. Date-only strings are calendar dates (tz-independent). */
export function toDate(v: unknown): { date: Date; dateOnly: boolean } | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { date: v, dateOnly: false };
  if (typeof v === 'number') return Number.isFinite(v) ? { date: new Date(v), dateOnly: false } : null;
  if (typeof v !== 'string' || !v) return null;
  if (isDateStr(v)) return { date: new Date(`${v}T00:00:00Z`), dateOnly: true };
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : { date: d, dateOnly: false };
}

function dtf(locale: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, o);
  } catch {
    const { timeZone: _tz, ...rest } = o;
    return new Intl.DateTimeFormat('en-US', { ...rest, timeZone: 'UTC' });
  }
}

/** Format a date or instant. Locale and time zone aware. */
export function date(v: unknown, style: DateStyle = 'medium', loc: { locale?: string; tz?: string } = {}): string {
  const p = toDate(v);
  if (!p) return '';
  const locale = loc.locale ?? 'en-US';
  const tz = p.dateOnly ? 'UTC' : (loc.tz ?? 'UTC');
  if (style === 'iso') {
    return p.dateOnly ? String(v) : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(p.date);
  }
  return dtf(locale, { ...DATE_OPTS[style], timeZone: tz }).format(p.date);
}

/** "6:58 AM" / "06:58" depending on locale; instants only (date-only strings return ''). */
export function time(v: unknown, loc: { locale?: string; tz?: string } = {}): string {
  const p = toDate(v);
  if (!p || p.dateOnly) return '';
  return dtf(loc.locale ?? 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: loc.tz ?? 'UTC' }).format(p.date);
}

/** "Today" / "Tomorrow" / "Yesterday" / weekday name within a week / short date. `today` is a YYYY-MM-DD string. */
export function relativeDay(v: unknown, today: string, loc: { locale?: string; tz?: string } = {}): string {
  const p = toDate(v);
  if (!p) return '';
  const d = p.dateOnly ? String(v) : dateOf(p.date, loc.tz ?? 'UTC');
  const diff = diffDays(today, d);
  const locale = loc.locale ?? 'en-US';
  if (diff >= -1 && diff <= 1) {
    try {
      const s = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day');
      return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
    } catch {
      return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : 'Yesterday';
    }
  }
  if (diff > 1 && diff < 7) return date(d, 'weekday', { locale });
  return date(d, 'short', { locale });
}

/** Plain number with locale separators. */
export function number(v: number | null | undefined, digits = 0, locale = 'en-US'): string {
  return isNum(v) ? nf(locale, 0, digits).format(v) : DASH;
}

/** 4.123 -> "+4.1" / "-4.1" (explicit sign; zero is "0"). */
export function signed(v: number | null | undefined, digits = 1, locale = 'en-US'): string {
  if (!isNum(v)) return DASH;
  const s = nf(locale, 0, digits).format(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function percent(v: number | null | undefined, digits = 0, locale = 'en-US'): string {
  return isNum(v) ? `${nf(locale, 0, digits).format(v)}%` : DASH;
}

/** Bind all formatters to the live environment. */
export function createFormat(getDefaults: () => FormatDefaults) {
  return {
    distance: (m: number | null | undefined, units?: Units, o?: DistanceOpts) => {
      const d = getDefaults();
      return distance(m, units ?? d.units, { locale: d.locale, ...o });
    },
    duration: (s: number | null | undefined, style?: DurationStyle) => duration(s, style),
    pace: (sPerKm: number | null | undefined, units?: Units, o?: { unit?: boolean }) => pace(sPerKm, units ?? getDefaults().units, o),
    paceRange: (r: number[], units?: Units) => paceRange(r, units ?? getDefaults().units),
    speed: (mPerS: number | null | undefined, units?: Units) => {
      const d = getDefaults();
      return speed(mPerS, units ?? d.units, d.locale);
    },
    date: (v: unknown, style?: DateStyle) => {
      const d = getDefaults();
      return date(v, style, d);
    },
    time: (v: unknown) => time(v, getDefaults()),
    relativeDay: (v: unknown, today?: string) => {
      const d = getDefaults();
      return relativeDay(v, today ?? todayIn(d.nowMs(), d.tz), d);
    },
    number: (v: number | null | undefined, digits?: number) => number(v, digits, getDefaults().locale),
    signed: (v: number | null | undefined, digits?: number) => signed(v, digits, getDefaults().locale),
    percent: (v: number | null | undefined, digits?: number) => percent(v, digits, getDefaults().locale),
    /** Distance unit label for the current units ("km" | "mi"). */
    distanceUnit: () => (getDefaults().units === 'imperial' ? 'mi' : 'km'),
  };
}
export type Formatters = ReturnType<typeof createFormat>;
