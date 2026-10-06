/**
 * Pure scaling helpers for <rc-chart>: nice tick scales, linear scales, band layout, date ticks.
 */
import { addDays, addMonths, diffDays, startOfMonth } from './dates';

export interface NiceScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

const clean = (n: number): number => Number(n.toPrecision(12));

/** Smallest "nice" step >= raw. `absolute` gives a fixed ascending list (e.g. seconds for pace axes). */
export function niceStep(raw: number, absolute?: number[]): number {
  if (!(raw > 0)) return 1;
  if (absolute?.length) {
    for (const s of absolute) if (s >= raw) return s;
    const last = absolute[absolute.length - 1] as number;
    return Math.ceil(raw / last) * last;
  }
  const mag = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / mag;
  const mult = [1, 2, 2.5, 5, 10].find((m) => m >= frac - 1e-9) ?? 10;
  return clean(mult * mag);
}

/** Time-axis step candidates in seconds (for pace / duration axes). */
export const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

/** Compute a nice [min,max] domain with evenly spaced ticks covering [min,max]. */
export function niceScale(min: number, max: number, maxTicks = 5, o: { steps?: number[] } = {}): NiceScale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    if (min === 0) {
      max = 1;
    } else {
      const pad = Math.abs(min) * 0.1 || 1;
      min -= pad;
      max += pad;
    }
  }
  const step = niceStep((max - min) / Math.max(1, maxTicks - 1), o.steps);
  const nmin = clean(Math.floor(min / step + 1e-9) * step);
  const nmax = clean(Math.ceil(max / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = nmin; v <= nmax + step * 1e-6; v = clean(v + step)) ticks.push(clean(v));
  return { min: nmin, max: nmax, step, ticks };
}

export interface LinearScale {
  (v: number): number;
  invert(px: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as LinearScale;
  f.invert = (px: number) => (r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span);
  f.domain = domain;
  f.range = range;
  return f;
}

export interface Band {
  step: number;
  bandWidth: number;
  /** Left edge of band i. */
  x(i: number): number;
  /** Centre of band i. */
  center(i: number): number;
}

/** n equal bands over [r0, r1] with inner padding as a fraction of the step. */
export function bandScale(n: number, r0: number, r1: number, padding = 0.25): Band {
  const step = n > 0 ? (r1 - r0) / n : r1 - r0;
  const bandWidth = step * (1 - padding);
  const pad = (step - bandWidth) / 2;
  return { step, bandWidth, x: (i) => r0 + i * step + pad, center: (i) => r0 + i * step + step / 2 };
}

/** Day-resolution tick dates between two YYYY-MM-DD strings, at most `maxTicks` of them. */
export function dateTicks(min: string, max: string, maxTicks = 6): string[] {
  const span = diffDays(min, max);
  if (span <= 0) return [min];
  maxTicks = Math.max(2, maxTicks);
  if (span + 1 <= maxTicks) return Array.from({ length: span + 1 }, (_, i) => addDays(min, i));
  for (const step of [2, 7, 14]) {
    const count = Math.floor(span / step) + 1;
    if (count <= maxTicks) return Array.from({ length: count }, (_, i) => addDays(min, i * step));
  }
  const out: string[] = [];
  for (const mstep of [1, 2, 3, 6, 12, 24]) {
    out.length = 0;
    let cur = startOfMonth(min);
    if (cur < min) cur = addMonths(cur, 1);
    while (cur <= max) {
      out.push(cur);
      cur = addMonths(cur, mstep);
    }
    if (out.length <= maxTicks) break;
  }
  return out.length ? out : [min, max];
}

/** Evenly pick at most `max` indices from 0..n-1 (always includes first and last when max >= 2). */
export function pickEvenly(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max <= 1) return [n - 1];
  const out = new Set<number>();
  for (let k = 0; k < max; k++) out.add(Math.round((k * (n - 1)) / (max - 1)));
  return [...out].sort((a, b) => a - b);
}
