/**
 * <rc-chart>: bar, line, area and scatter charts as pure SVG. Rows use the columns
 *   x, y and (optional) series, e.g. SELECT week AS x, km AS y FROM ...
 * Accessible name/description, hairline grid, tooltips on hover/tap/arrow keys, colour-blind-safe
 * palette (CSS --rc-series-1..8), hidden data table for screen readers.
 */
import { buildChartModel, columns, nearestColumn, nearestPoint, type ChartModel, type ChartType, type Pt, type XKind } from '../chart-model';
import { TIME_STEPS } from '../scale';
import { clamp, h, num, parseJson, s, uid } from '../util';
import { KM_PER_MI, LB_PER_KG, M_PER_MI, clockMinSec } from '../format';
import { RcBound, define, emit, getCoach, observeWidth } from './base';
import { formatValue } from './values';

interface YSpec {
  convert: (v: number) => number;
  tick: (v: number) => string;
  tip: (raw: number) => string;
  steps?: number[];
  unit: string;
}

function ySpec(kind: string, unitSuffix: string): YSpec {
  const coach = getCoach();
  const f = coach.format;
  const units = coach.env.units;
  const locale = coach.env.locale;
  switch (kind) {
    case 'distance':
      return {
        convert: (m) => (units === 'imperial' ? m / M_PER_MI : m / 1000),
        tick: (v) => f.number(v, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0),
        tip: (m) => f.distance(m),
        unit: f.distanceUnit(),
      };
    case 'weight':
      return {
        convert: (kg) => (units === 'imperial' ? kg * LB_PER_KG : kg),
        tick: (v) => f.number(v, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0),
        tip: (kg) => f.weight(kg),
        unit: f.weightUnit(),
      };
    case 'duration':
      return { convert: (v) => v, tick: (v) => f.duration(v, v >= 3600 ? 'short' : 'clock'), tip: (v) => f.duration(v, 'clock'), steps: TIME_STEPS, unit: '' };
    case 'pace':
      return {
        convert: (v) => (units === 'imperial' ? v * KM_PER_MI : v),
        tick: (v) => clockMinSec(v),
        tip: (v) => f.pace(v),
        steps: TIME_STEPS,
        unit: units === 'imperial' ? 'min/mi' : 'min/km',
      };
    case 'percent':
      return { convert: (v) => v, tick: (v) => f.percent(v, 0), tip: (v) => f.percent(v, 1), unit: '' };
    case 'integer':
      return { convert: (v) => v, tick: (v) => f.number(v, 0), tip: (v) => f.number(v, 0) + (unitSuffix ? ` ${unitSuffix}` : ''), unit: unitSuffix };
    default:
      return {
        convert: (v) => v,
        tick: (v) => f.number(v, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0),
        tip: (v) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v)}${unitSuffix ? ` ${unitSuffix}` : ''}`,
        unit: unitSuffix,
      };
  }
}

const SERIES_SLOTS = 8;

class RcChart extends RcBound {
  static observedAttributes = [
    ...RcBound.baseAttrs,
    'type',
    'label',
    'description',
    'height',
    'y-format',
    'y-unit',
    'x-format',
    'x-label',
    'y-label',
    'stacked',
    'y-min',
    'y-max',
    'y-reverse',
    'legend',
    'show-values',
    'refs',
    'series-order',
    'empty',
  ];

  private width = 0;
  private stop?: () => void;
  private model?: ChartModel;
  private tip?: HTMLElement;
  private cross?: SVGLineElement;
  private marks: SVGElement[] = [];
  private activeCol = -1;
  private colIndexMap: Array<{ px: number; points: Pt[] }> = [];
  private ys!: YSpec;
  private uid = uid('chart');
  private slotClass: string[] = [];

  protected override connected(): void {
    super.connected();
    this.stop = observeWidth(this, (w) => {
      if (Math.abs(w - this.width) >= 2) {
        this.width = w;
        this.requestRender();
      }
    });
  }
  protected override disconnected(): void {
    super.disconnected();
    this.stop?.();
  }

  private get type(): ChartType {
    const t = this.getAttribute('type');
    return t === 'line' || t === 'area' || t === 'scatter' ? t : 'bar';
  }

  protected render(): void {
    if (this.error) {
      this.replaceChildren(this.errorEl());
      return;
    }
    const coach = getCoach();
    const rows = this.rows ?? [];
    if (this.loading && rows.length === 0) {
      this.replaceChildren(h('div', { class: 'rc-chart__ph', style: `height:${this.attr('height', '200')}px`, 'aria-hidden': 'true' }));
      return;
    }
    const width = this.width || this.clientWidth || 320;
    const height = Math.max(120, Number(this.attr('height', '200')) || 200);
    const yKind = this.attr('y-format', 'number');
    const ys = ySpec(yKind, this.attr('y-unit'));
    this.ys = ys;
    const f = coach.format;
    const xf = this.getAttribute('x-format');
    const yLabel = this.getAttribute('y-label') ?? ys.unit;
    const xLabel = this.getAttribute('x-label') ?? '';
    const type = this.type;

    // Fixed series slots keep colours stable when a filter removes a series.
    const order = this.attr('series-order')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    const model = buildChartModel({
      type,
      rows,
      width,
      height,
      stacked: this.boolAttr('stacked'),
      yMin: num(this.getAttribute('y-min')),
      yMax: num(this.getAttribute('y-max')),
      yReverse: this.boolAttr('y-reverse'),
      yConvert: ys.convert,
      yFormat: ys.tick,
      yStepsAbsolute: ys.steps,
      yTitle: !!yLabel,
      xTitle: !!xLabel,
      xFormat: (v, kind: XKind) => {
        if (kind === 'time') return xf === 'month' ? f.date(v, 'month-short') : xf === 'weekday' ? f.date(v, 'weekday-short') : f.date(v, 'short');
        if (kind === 'number') return xf ? formatValue(coach, v, xf) : f.number(Number(v), Number(v) % 1 === 0 ? 0 : 1);
        return String(v);
      },
    });
    this.model = model;
    this.colIndexMap = columns(model);

    const label = this.attr('label', 'Chart');
    const desc = this.getAttribute('description') ?? this.autoDescription(model, ys);
    if (model.empty) {
      this.replaceChildren(h('div', { class: 'rc-chart__empty', style: `min-height:${Math.min(height, 120)}px` }, h('p', null, this.attr('empty', 'No data to chart yet.'))));
      return;
    }

    const slot = (name: string, i: number): number => {
      const k = order.indexOf(name);
      return (k >= 0 ? k : order.length + i) % SERIES_SLOTS;
    };
    const cls = (si: number) => `rc-s${slot(model.series[si] ?? '', si)}`;
    this.slotClass = model.series.map((_, si) => cls(si));

    const titleId = `${this.uid}-t`;
    const descId = `${this.uid}-d`;
    const svg = s('svg', { class: 'rc-chart__svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': `${titleId} ${descId}` });
    svg.append(s('title', { id: titleId }, label), s('desc', { id: descId }, desc));

    const { plot } = model;
    // grid + y ticks
    const grid = s('g', { class: 'rc-chart__grid' });
    for (const t of model.yTicks) {
      grid.append(s('line', { class: 'rc-chart__gl', x1: plot.x0, x2: plot.x1, y1: t.py, y2: t.py }), s('text', { class: 'rc-chart__yt', x: plot.x0 - 8, y: t.py, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, t.label));
    }
    svg.append(grid);
    if (yLabel) svg.append(s('text', { class: 'rc-chart__title', x: plot.x0 - 8, y: 12, 'text-anchor': 'start' }, yLabel));
    // baseline
    svg.append(s('line', { class: 'rc-chart__base', x1: plot.x0, x2: plot.x1, y1: model.baselinePy, y2: model.baselinePy }));
    // x ticks
    const xg = s('g', { class: 'rc-chart__x' });
    for (const t of model.xTicks) xg.append(s('text', { class: 'rc-chart__xt', x: t.px, y: plot.y1 + 17, 'text-anchor': 'middle' }, t.label));
    svg.append(xg);
    if (xLabel) svg.append(s('text', { class: 'rc-chart__title', x: (plot.x0 + plot.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, xLabel));

    // reference lines
    const refs = parseJson<Array<{ y: number; label?: string }>>(this.getAttribute('refs'), []) ?? [];
    const yLin = (v: number) => {
      const [d0, d1] = model.yDomain;
      const t = (v - d0) / (d1 - d0 || 1);
      return this.boolAttr('y-reverse') ? plot.y0 + t * (plot.y1 - plot.y0) : plot.y1 - t * (plot.y1 - plot.y0);
    };
    for (const r of refs) {
      const v = ys.convert(Number(r.y));
      if (!Number.isFinite(v) || v < model.yDomain[0] || v > model.yDomain[1]) continue;
      svg.append(s('line', { class: 'rc-chart__ref', x1: plot.x0, x2: plot.x1, y1: yLin(v), y2: yLin(v) }));
      if (r.label) svg.append(s('text', { class: 'rc-chart__reflabel', x: plot.x1, y: yLin(v) - 4, 'text-anchor': 'end' }, r.label));
    }

    // marks
    this.marks = [];
    const marks = s('g', { class: 'rc-chart__marks' });
    if (type === 'bar' && model.bar) {
      const bw = model.bar.barWidth;
      model.points.forEach((pts, si) => {
        for (const p of pts) {
          const x = p.px - bw / 2;
          const top = Math.min(p.py, p.y0py);
          const hgt = Math.max(1, Math.abs(p.y0py - p.py) - (model.stacked && si > 0 ? 2 : 0));
          const positive = p.py <= p.y0py;
          const r = Math.min(4, bw / 2, hgt);
          const d = positive ? `M${x},${top + hgt} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + hgt} Z` : `M${x},${top} V${top + hgt - r} Q${x},${top + hgt} ${x + r},${top + hgt} H${x + bw - r} Q${x + bw},${top + hgt} ${x + bw},${top + hgt - r} V${top} Z`;
          const bar = s('path', { class: `rc-chart__bar ${cls(si)}`, d, 'data-col': p.i });
          marks.append(bar);
          this.marks.push(bar);
          if (this.boolAttr('show-values') && bw >= 18 && !model.stacked && model.series.length === 1) marks.append(s('text', { class: 'rc-chart__val', x: p.px, y: positive ? top - 4 : top + hgt + 12, 'text-anchor': 'middle' }, ys.tick(p.y)));
        }
      });
    } else {
      model.points.forEach((pts, si) => {
        if (pts.length === 0) return;
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(' ');
        if (type === 'area') {
          const first = pts[0] as Pt;
          const last = pts[pts.length - 1] as Pt;
          const lower = model.stacked ? [...pts].reverse().map((p) => `L${p.px.toFixed(1)},${p.y0py.toFixed(1)}`).join(' ') : `L${last.px.toFixed(1)},${model.baselinePy.toFixed(1)} L${first.px.toFixed(1)},${model.baselinePy.toFixed(1)}`;
          marks.append(s('path', { class: `rc-chart__area ${cls(si)}`, d: `${line} ${lower} Z` }));
        }
        if (type === 'line' || type === 'area') marks.append(s('path', { class: `rc-chart__line ${cls(si)}`, d: line, fill: 'none' }));
        const showAll = type === 'scatter' || pts.length <= 16;
        pts.forEach((p, i) => {
          if (!showAll && i !== pts.length - 1) return;
          marks.append(s('circle', { class: `rc-chart__dot ${cls(si)}`, cx: p.px, cy: p.py, r: type === 'scatter' ? 4.5 : 4 }));
        });
        if (type !== 'scatter' && this.boolAttr('show-values')) {
          const last = pts[pts.length - 1] as Pt;
          marks.append(s('text', { class: 'rc-chart__val', x: Math.min(last.px, plot.x1 - 2), y: last.py - 9, 'text-anchor': 'end' }, ys.tick(last.y)));
        }
      });
    }
    svg.append(marks);

    // interaction layer
    this.cross = s('line', { class: 'rc-chart__cross', y1: plot.y0, y2: plot.y1, x1: 0, x2: 0, visibility: 'hidden' });
    svg.append(this.cross);
    const hit = s('rect', { class: 'rc-chart__hit', x: plot.x0, y: plot.y0, width: plot.x1 - plot.x0, height: plot.y1 - plot.y0, fill: 'transparent' });
    svg.append(hit);

    const wrap = h('div', { class: 'rc-chart__plot', tabindex: 0, role: 'group', 'aria-label': `${label}. Use the left and right arrow keys to read values.` }, svg);
    this.tip = h('div', { class: 'rc-chart__tip', role: 'status', hidden: true });
    wrap.append(this.tip);
    this.activeCol = -1;

    const pointer = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / (r.width || width)) * width;
      const py = ((ev.clientY - r.top) / (r.height || height)) * height;
      if (type === 'scatter') {
        const p = nearestPoint(model, px, py, 24);
        if (p) this.showPoints([p], p.px);
        else this.hideTip();
      } else {
        const col = nearestColumn(model, px);
        if (col) this.showPoints(col.points, col.px);
      }
    };
    hit.addEventListener('pointermove', pointer);
    hit.addEventListener('pointerdown', pointer);
    hit.addEventListener('pointerleave', (e) => {
      if ((e as PointerEvent).pointerType === 'mouse') this.hideTip();
    });
    hit.addEventListener('click', () => {
      const pts = this.colIndexMap[this.activeCol]?.points;
      const p = pts?.[0];
      if (p) emit(this, 'select', { x: p.x, y: p.yRaw, row: p.row });
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const n = this.colIndexMap.length;
        if (!n) return;
        const next = this.activeCol < 0 ? (e.key === 'ArrowRight' ? 0 : n - 1) : clamp(this.activeCol + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1);
        const c = this.colIndexMap[next];
        if (c) {
          this.activeCol = next;
          this.showPoints(c.points, c.px, true);
        }
      } else if (e.key === 'Escape') this.hideTip();
    });
    wrap.addEventListener('blur', () => this.hideTip());
    document.addEventListener('pointerdown', this.outside, { passive: true });

    const fig = h('figure', { class: 'rc-chart' });
    if (model.series.length >= 2 && this.getAttribute('legend') !== 'off') {
      fig.append(
        h(
          'ul',
          { class: 'rc-chart__legend', 'aria-label': 'Legend' },
          ...model.series.map((name, si) => h('li', null, h('span', { class: `rc-chart__key ${type === 'line' || type === 'area' ? 'is-line' : ''} ${cls(si)}`, 'aria-hidden': 'true' }), h('span', null, name || 'Series'))),
        ),
      );
    }
    fig.append(wrap, this.dataTable(model, ys, label));
    this.replaceChildren(fig);
  }

  private outside = (e: Event): void => {
    if (!this.isConnected) {
      document.removeEventListener('pointerdown', this.outside);
      return;
    }
    if (!this.contains(e.target as Node)) this.hideTip();
  };

  private autoDescription(model: ChartModel, ys: YSpec): string {
    if (model.empty) return 'No data';
    const all = model.points.flat();
    const ysr = all.map((p) => p.yRaw);
    const first = all[0] as Pt;
    const last = all[all.length - 1] as Pt;
    return `${this.type} chart with ${all.length} values${model.series.length > 1 ? ` in ${model.series.length} series` : ''}. From ${first.xLabel} to ${last.xLabel}. Lowest ${ys.tip(Math.min(...ysr))}, highest ${ys.tip(Math.max(...ysr))}.`;
  }

  private dataTable(model: ChartModel, ys: YSpec, label: string): HTMLElement {
    const cols = columns(model);
    if (cols.length > 60) return h('span');
    const multi = model.series.length > 1;
    const table = h('table', { class: 'rc-sr' }, h('caption', null, `${label}: data`));
    table.append(h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Date'), ...(multi ? model.series.map((n) => h('th', { scope: 'col' }, n || 'Value')) : [h('th', { scope: 'col' }, 'Value')]))));
    const body = h('tbody');
    for (const c of cols) {
      const first = c.points[0] as Pt;
      body.append(h('tr', null, h('th', { scope: 'row' }, first.xLabel), ...(multi ? model.series.map((_, si) => h('td', null, ((p) => (p ? ys.tip(p.yRaw) : ''))(c.points.find((q) => q.s === si)))) : [h('td', null, ys.tip(first.yRaw))])));
    }
    table.append(body);
    return table;
  }

  private hideTip(): void {
    if (!this.tip) return;
    this.tip.hidden = true;
    this.cross?.setAttribute('visibility', 'hidden');
    for (const m of this.marks) m.classList.remove('is-hover');
  }

  private showPoints(points: Pt[], px: number, fromKeyboard = false): void {
    const model = this.model;
    const tip = this.tip;
    if (!model || !tip || points.length === 0) return;
    const first = points[0] as Pt;
    this.activeCol = this.colIndexMap.findIndex((c) => c.points.includes(first));
    const showCross = model.type === 'line' || model.type === 'area';
    if (this.cross) {
      this.cross.setAttribute('x1', String(px));
      this.cross.setAttribute('x2', String(px));
      this.cross.setAttribute('visibility', showCross ? 'visible' : 'hidden');
    }
    for (const m of this.marks) m.classList.toggle('is-hover', m.getAttribute('data-col') === String(first.i));
    tip.replaceChildren(
      h('div', { class: 'rc-chart__tipx' }, first.xLabel),
      ...points.map((p) =>
        h('div', { class: 'rc-chart__tiprow' }, h('span', { class: `rc-chart__key is-line ${this.slotClass[p.s] ?? 'rc-s0'}`, 'aria-hidden': 'true' }), h('strong', null, this.ys.tip(p.yRaw)), model.series.length > 1 ? h('span', { class: 'rc-chart__tipname' }, model.series[p.s] || '') : null),
      ),
    );
    tip.hidden = false;
    const wrapW = this.clientWidth || model.width;
    const tw = tip.offsetWidth || 120;
    const left = clamp(px - tw / 2, 4, Math.max(4, wrapW - tw - 4));
    tip.style.left = `${left}px`;
    const topPy = Math.min(...points.map((p) => p.py));
    tip.style.top = `${Math.max(0, topPy - (tip.offsetHeight || 40) - 10)}px`;
    if (fromKeyboard) tip.setAttribute('aria-live', 'polite');
  }
}

export function registerChart(): void {
  define('rc-chart', RcChart);
}
