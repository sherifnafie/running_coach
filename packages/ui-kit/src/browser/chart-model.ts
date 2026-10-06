/**
 * Chart geometry: turns rows (x, y, series) into pixel positions, ticks and bar layout. Pure and
 * DOM-free so it can be unit tested; <rc-chart> renders the model as SVG.
 */
import { diffDays, isDateStr } from './dates';
import { bandScale, dateTicks, linearScale, niceScale, pickEvenly, type NiceScale } from './scale';
import { num, type Row } from './util';

export type ChartType = 'bar' | 'line' | 'area' | 'scatter';
export type XKind = 'category' | 'time' | 'number';

export interface ChartSpec {
  type: ChartType;
  rows: Row[];
  width: number;
  height: number;
  stacked?: boolean;
  xKey?: string;
  yKey?: string;
  seriesKey?: string;
  yMin?: number | null;
  yMax?: number | null;
  yReverse?: boolean;
  /** Raw y -> plotted y (e.g. metres -> km, s/km -> s/mi). */
  yConvert?: (v: number) => number;
  /** Tick label formatter, in plotted units. */
  yFormat: (v: number) => string;
  /** Absolute tick-step candidates (e.g. TIME_STEPS) for time-like y axes. */
  yStepsAbsolute?: number[];
  xFormat: (v: string | number, kind: XKind) => string;
  /** Average glyph width in px used to size margins and thin x labels (default 6.6 for 12px text). */
  charWidth?: number;
  /** Reserve room above the plot for a y-axis caption. */
  yTitle?: boolean;
  xTitle?: boolean;
}

export interface Pt {
  /** Series index. */
  s: number;
  /** Category index (band modes) or ordinal. */
  i: number;
  x: string | number;
  xLabel: string;
  /** Plotted y (converted, stacked values are NOT cumulative here). */
  y: number;
  yRaw: number;
  px: number;
  py: number;
  /** Pixel y of the segment base (baseline, or the top of the stack below). */
  y0py: number;
  row: Row;
}

export interface ChartModel {
  empty: boolean;
  xKind: XKind;
  type: ChartType;
  stacked: boolean;
  series: string[];
  points: Pt[][];
  categories: string[];
  plot: { x0: number; y0: number; x1: number; y1: number };
  yTicks: Array<{ value: number; py: number; label: string }>;
  xTicks: Array<{ px: number; label: string; index: number }>;
  bar: { bandWidth: number; barWidth: number; step: number } | null;
  baselinePy: number;
  yDomain: [number, number];
  width: number;
  height: number;
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}T/;

export function inferXKind(xs: unknown[]): XKind {
  const vals = xs.filter((x) => x != null && x !== '');
  if (vals.length === 0) return 'category';
  if (vals.every((x) => typeof x === 'string' && (isDateStr(x) || ISO_DT.test(x)))) return 'time';
  if (vals.every((x) => num(x) !== null && !(typeof x === 'string' && isDateStr(x)))) return 'number';
  return 'category';
}

const dayKey = (x: unknown): string => String(x).slice(0, 10);
const epochDay = (d: string): number => diffDays('1970-01-01', d);

export function buildChartModel(spec: ChartSpec): ChartModel {
  const { type, width, height } = spec;
  const xKey = spec.xKey ?? 'x';
  const yKey = spec.yKey ?? 'y';
  const sKey = spec.seriesKey ?? 'series';
  const cw = spec.charWidth ?? 6.6;
  const stacked = !!spec.stacked && (type === 'bar' || type === 'area');
  const conv = spec.yConvert ?? ((v: number) => v);

  const usable = spec.rows.filter((r) => r[xKey] != null && num(r[yKey]) !== null);
  const xKind = inferXKind(usable.map((r) => r[xKey]));
  const seriesNames: string[] = [];
  for (const r of usable) {
    const n = r[sKey] == null ? '' : String(r[sKey]);
    if (!seriesNames.includes(n)) seriesNames.push(n);
  }

  const empty: ChartModel = {
    empty: true,
    xKind,
    type,
    stacked,
    series: [],
    points: [],
    categories: [],
    plot: { x0: 0, y0: 0, x1: width, y1: height },
    yTicks: [],
    xTicks: [],
    bar: null,
    baselinePy: height,
    yDomain: [0, 1],
    width,
    height,
  };
  if (usable.length === 0) return empty;

  // Normalised x key per row.
  const keyOf = (r: Row): string => (xKind === 'time' ? dayKey(r[xKey]) : String(r[xKey]));
  const bandMode = type === 'bar';
  const pointMode = !bandMode && xKind === 'category';

  let categories: string[] = [];
  if (bandMode || pointMode) {
    const seen = new Set<string>();
    for (const r of usable) seen.add(keyOf(r));
    categories = [...seen];
    if (xKind === 'time') categories.sort();
    else if (xKind === 'number') categories.sort((a, b) => Number(a) - Number(b));
  }

  // ---- y domain
  const yOf = (r: Row): number => conv(num(r[yKey]) as number);
  let lo = Infinity;
  let hi = -Infinity;
  if (stacked) {
    const sums = new Map<string, { pos: number; neg: number }>();
    for (const r of usable) {
      const k = keyOf(r);
      const v = yOf(r);
      const cur = sums.get(k) ?? { pos: 0, neg: 0 };
      if (v >= 0) cur.pos += v;
      else cur.neg += v;
      sums.set(k, cur);
    }
    for (const { pos, neg } of sums.values()) {
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  } else {
    for (const r of usable) {
      const v = yOf(r);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (type === 'bar' || type === 'area') {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (spec.yMin != null) lo = spec.yMin;
  if (spec.yMax != null) hi = spec.yMax;

  // ---- margins
  const plotHForTicks = Math.max(40, height - 40);
  const maxTicks = Math.max(3, Math.min(6, Math.round(plotHForTicks / 42)));
  const nice: NiceScale = niceScale(lo, hi, maxTicks, { steps: spec.yStepsAbsolute });
  const dMin = spec.yMin != null ? Math.min(spec.yMin, nice.min) : nice.min;
  const dMax = spec.yMax != null ? Math.max(spec.yMax, nice.max) : nice.max;
  const yTickVals = nice.ticks.filter((t) => t >= dMin - 1e-9 && t <= dMax + 1e-9);
  const yLabels = yTickVals.map((v) => spec.yFormat(v));
  const maxLabelLen = yLabels.reduce((m, l) => Math.max(m, l.length), 1);
  const left = Math.min(86, Math.max(30, Math.ceil(maxLabelLen * cw) + 12));
  const right = 14;
  const top = spec.yTitle ? 26 : 10;
  const bottom = 26 + (spec.xTitle ? 16 : 0);
  const plot = { x0: left, y0: top, x1: Math.max(left + 40, width - right), y1: Math.max(top + 40, height - bottom) };

  const ys = linearScale([dMin, dMax], spec.yReverse ? [plot.y0, plot.y1] : [plot.y1, plot.y0]);
  const baselinePy = ys(Math.min(Math.max(0, dMin), dMax));

  // ---- x layout
  let xPos: (key: string, idx: number) => number;
  let barInfo: ChartModel['bar'] = null;
  const xTicks: ChartModel['xTicks'] = [];

  if (bandMode || pointMode) {
    const n = categories.length;
    const band = bandScale(n, plot.x0, plot.x1, bandMode ? 0.3 : 0);
    const index = new Map(categories.map((c, i) => [c, i]));
    xPos = (k) => band.center(index.get(k) ?? 0);
    if (bandMode) {
      const groups = stacked ? 1 : Math.max(1, seriesNames.length);
      const gap = 2;
      const barW = Math.max(2, Math.min(24, (band.bandWidth - gap * (groups - 1)) / groups));
      barInfo = { bandWidth: band.bandWidth, barWidth: barW, step: band.step };
    }
    const maxLabels = Math.max(1, Math.floor((plot.x1 - plot.x0) / (Math.max(...categories.map((c) => spec.xFormat(xKind === 'number' ? Number(c) : c, xKind).length), 1) * cw + 10)));
    for (const i of pickEvenly(n, maxLabels)) {
      const c = categories[i] as string;
      xTicks.push({ px: band.center(i), label: spec.xFormat(xKind === 'number' ? Number(c) : c, xKind), index: i });
    }
  } else if (xKind === 'time') {
    const days = usable.map((r) => epochDay(dayKey(r[xKey])));
    const mn = Math.min(...days);
    const mx = Math.max(...days);
    const inset = mn === mx ? 0 : 6;
    const xs = linearScale([mn, mx], [plot.x0 + inset, plot.x1 - inset]);
    xPos = (k) => xs(epochDay(k));
    const minD = new Date(mn * 86_400_000).toISOString().slice(0, 10);
    const maxD = new Date(mx * 86_400_000).toISOString().slice(0, 10);
    const maxT = Math.max(2, Math.floor((plot.x1 - plot.x0) / (spec.xFormat(minD, 'time').length * cw + 18)));
    dateTicks(minD, maxD, maxT).forEach((d, i) => xTicks.push({ px: xs(epochDay(d)), label: spec.xFormat(d, 'time'), index: i }));
  } else {
    const vals = usable.map((r) => num(r[xKey]) as number);
    const nx = niceScale(Math.min(...vals), Math.max(...vals), Math.max(2, Math.floor((plot.x1 - plot.x0) / 70)));
    const useNice = type === 'scatter' || nx.ticks.length > 1;
    const dom: [number, number] = useNice ? [nx.min, nx.max] : [Math.min(...vals), Math.max(...vals)];
    const xs = linearScale(dom, [plot.x0 + 6, plot.x1 - 6]);
    xPos = (k) => xs(Number(k));
    nx.ticks.forEach((v, i) => xTicks.push({ px: xs(v), label: spec.xFormat(v, 'number'), index: i }));
  }

  // ---- points
  const points: Pt[][] = seriesNames.map(() => []);
  const stackPos = new Map<string, number>();
  const stackNeg = new Map<string, number>();
  const sorted = [...usable];
  if (!bandMode && !pointMode) sorted.sort((a, b) => (xKind === 'time' ? epochDay(dayKey(a[xKey])) - epochDay(dayKey(b[xKey])) : Number(a[xKey]) - Number(b[xKey])));
  const catIndex = new Map(categories.map((c, i) => [c, i]));
  const linIndex = new Map<string, number>();
  if (!bandMode && !pointMode) for (const r of sorted) if (!linIndex.has(keyOf(r))) linIndex.set(keyOf(r), linIndex.size);
  for (const r of sorted) {
    const sName = r[sKey] == null ? '' : String(r[sKey]);
    const s = seriesNames.indexOf(sName);
    const k = keyOf(r);
    const yRaw = num(r[yKey]) as number;
    const y = conv(yRaw);
    let y0py = baselinePy;
    let py = ys(y);
    if (stacked) {
      const map = y >= 0 ? stackPos : stackNeg;
      const base = map.get(k) ?? 0;
      y0py = ys(base);
      py = ys(base + y);
      map.set(k, base + y);
    }
    const idx = bandMode || pointMode ? (catIndex.get(k) as number) : (linIndex.get(k) as number);
    let px = xPos(k, idx);
    if (bandMode && barInfo && !stacked && seriesNames.length > 1) {
      const groups = seriesNames.length;
      const gap = 2;
      const totalW = groups * barInfo.barWidth + (groups - 1) * gap;
      px = px - totalW / 2 + barInfo.barWidth / 2 + s * (barInfo.barWidth + gap);
    }
    const xv: string | number = xKind === 'number' ? Number(r[xKey]) : k;
    (points[s] as Pt[]).push({ s, i: idx, x: xv, xLabel: spec.xFormat(xv, xKind), y, yRaw, px, py, y0py, row: r });
  }

  return {
    empty: false,
    xKind,
    type,
    stacked,
    series: seriesNames,
    points,
    categories,
    plot,
    yTicks: yTickVals.map((v, i) => ({ value: v, py: ys(v), label: yLabels[i] as string })),
    xTicks,
    bar: barInfo,
    baselinePy,
    yDomain: [dMin, dMax],
    width,
    height,
  };
}

/** The x column (all series) nearest to `px`: drives crosshair tooltips and keyboard stepping. */
export function nearestColumn(model: ChartModel, px: number): { px: number; points: Pt[] } | null {
  const cols = columns(model);
  let best: { px: number; points: Pt[] } | null = null;
  let bestD = Infinity;
  for (const c of cols) {
    const d = Math.abs(c.px - px);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** All x columns left to right, each with the points of every series at that x. */
export function columns(model: ChartModel): Array<{ px: number; points: Pt[] }> {
  const map = new Map<number, Pt[]>();
  for (const ser of model.points) {
    for (const p of ser) {
      let arr = map.get(p.i);
      if (!arr) map.set(p.i, (arr = []));
      arr.push(p);
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, pts]) => ({ px: pts.reduce((a, p) => a + p.px, 0) / pts.length, points: pts }));
}

/** Nearest scatter point within `radius` px (24px hit target by default). */
export function nearestPoint(model: ChartModel, px: number, py: number, radius = 24): Pt | null {
  let best: Pt | null = null;
  let bestD = radius * radius;
  for (const ser of model.points) {
    for (const p of ser) {
      const d = (p.px - px) ** 2 + (p.py - py) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}
