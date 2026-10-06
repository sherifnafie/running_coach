/** Data components: rc-stat, rc-trend (sparkline), rc-progress-ring, rc-list. */
import { h, num, parseJson, s, type Row } from '../util';
import { RcBound, define, emit, getCoach, observeWidth } from './base';
import { iconSvg } from './basic';
import { formatValue, pick } from './values';

// ----------------------------------------------------------------------------- rc-stat

class RcStat extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'label', 'value', 'unit', 'delta', 'delta-good', 'delta-label', 'hint', 'format', 'delta-format'];

  protected render(): void {
    const coach = getCoach();
    if (this.error) {
      this.replaceChildren(this.errorEl());
      return;
    }
    const row: Row | undefined = this.rows?.[0];
    const get = (attr: string, ...cols: string[]) => this.getAttribute(attr) ?? pick(row, ...cols);
    const label = get('label', 'label');
    const rawValue = get('value', 'value');
    const unit = get('unit', 'unit');
    const fmt = this.getAttribute('format');
    const value = rawValue == null || rawValue === '' ? (this.loading ? '' : '–') : formatValue(coach, rawValue, fmt);
    const rawDelta = get('delta', 'delta');
    const dfmt = this.getAttribute('delta-format') ?? fmt;
    const deltaNum = num(rawDelta);
    const deltaText = rawDelta == null || rawDelta === '' ? '' : deltaNum !== null && dfmt ? formatValue(coach, deltaNum, dfmt, true) : deltaNum !== null ? formatValue(coach, deltaNum, 'number', true) : String(rawDelta);
    const hint = get('hint', 'hint');

    const kids: Array<HTMLElement | null> = [];
    kids.push(label ? h('div', { class: 'rc-stat__label' }, String(label)) : null);
    kids.push(h('div', { class: 'rc-stat__value' }, h('span', { class: 'rc-stat__num' }, value), unit && !fmt ? h('span', { class: 'rc-stat__unit' }, String(unit)) : null));
    if (deltaText) {
      const dir = deltaNum !== null ? Math.sign(deltaNum) : /^[+↑▲]/.test(deltaText) ? 1 : /^[-−↓▼]/.test(deltaText) ? -1 : 0;
      const goodDir = this.attr('delta-good', 'up');
      const tone = dir === 0 || goodDir === 'neutral' ? 'flat' : (dir > 0) === (goodDir === 'up') ? 'good' : 'bad';
      const dl = this.getAttribute('delta-label');
      kids.push(
        h(
          'div',
          { class: `rc-stat__delta rc-stat__delta--${tone}` },
          h('span', { 'aria-hidden': 'true', class: 'rc-stat__arrow' }, dir > 0 ? '▲' : dir < 0 ? '▼' : '●'),
          h('span', { class: 'rc-sr' }, dir > 0 ? 'Up ' : dir < 0 ? 'Down ' : 'No change '),
          h('span', null, deltaText),
          dl ? h('span', { class: 'rc-stat__delta-label' }, ` ${dl}`) : null,
        ),
      );
    }
    kids.push(hint ? h('div', { class: 'rc-stat__hint' }, String(hint)) : null);
    this.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
  }
}

// ----------------------------------------------------------------------------- rc-trend

function parseSeries(raw: string | null): number[] {
  if (!raw) return [];
  const j = parseJson<unknown>(raw);
  const arr = Array.isArray(j) ? j : raw.split(/[\s,;]+/);
  return arr.map((v) => num(v)).filter((v): v is number => v !== null);
}

class RcTrend extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'values', 'height', 'label', 'format', 'tone', 'show-last', 'reverse'];
  private width = 0;
  private stop?: () => void;

  protected override connected(): void {
    super.connected();
    this.stop = observeWidth(this, (w) => {
      this.width = w;
      this.requestRender();
    });
  }
  protected override disconnected(): void {
    super.disconnected();
    this.stop?.();
  }

  protected render(): void {
    const coach = getCoach();
    const height = Number(this.attr('height', '36')) || 36;
    const values = this.rows ? this.rows.map((r) => num(pick(r, 'y', 'value'))).filter((v): v is number => v !== null) : parseSeries(this.getAttribute('values'));
    if (this.error) {
      this.replaceChildren(this.errorEl());
      return;
    }
    if (values.length < 2) {
      this.replaceChildren(h('span', { class: 'rc-trend__none' }, this.loading ? '' : 'Not enough data yet'));
      return;
    }
    const w = this.width || this.clientWidth || 120;
    const pad = 5;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const rev = this.hasAttribute('reverse');
    const px = (i: number) => pad + (i / (values.length - 1)) * (w - 2 * pad);
    const py = (v: number) => {
      const t = (v - lo) / span;
      return pad + (rev ? t : 1 - t) * (height - 2 * pad);
    };
    const pts = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
    const first = values[0] as number;
    const last = values[values.length - 1] as number;
    const fmt = this.getAttribute('format');
    const lbl = this.getAttribute('label') ?? 'Trend';
    const desc = `${lbl}: from ${formatValue(coach, first, fmt) || first} to ${formatValue(coach, last, fmt) || last} over ${values.length} points`;
    const tone = this.attr('tone', 'accent');
    const svg = s(
      'svg',
      { class: `rc-trend__svg rc-trend--${tone}`, width: w, height, viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': desc },
      s('polyline', { class: 'rc-trend__line', points: pts.join(' '), fill: 'none' }),
      s('circle', { class: 'rc-trend__ring', cx: px(values.length - 1), cy: py(last), r: 6 }),
      s('circle', { class: 'rc-trend__dot', cx: px(values.length - 1), cy: py(last), r: 4 }),
    );
    const wrap = h('div', { class: 'rc-trend__wrap' }, svg);
    if (this.boolAttr('show-last')) wrap.append(h('span', { class: 'rc-trend__last' }, formatValue(coach, last, fmt) || String(last)));
    this.replaceChildren(wrap);
  }
}

// ----------------------------------------------------------------------------- rc-progress-ring

class RcProgressRing extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'value', 'max', 'label', 'size', 'text', 'tone'];

  protected render(): void {
    const row = this.rows?.[0];
    const value = num(this.getAttribute('value') ?? pick(row, 'value')) ?? 0;
    const max = num(this.getAttribute('max') ?? pick(row, 'max')) ?? 100;
    const label = String(this.getAttribute('label') ?? pick(row, 'label') ?? '');
    const size = Number(this.attr('size', '96')) || 96;
    const stroke = Math.max(6, Math.round(size / 10));
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    const text = String(this.getAttribute('text') ?? pick(row, 'text') ?? `${Math.round(ratio * 100)}%`);
    const svg = s(
      'svg',
      { class: `rc-ring__svg rc-ring--${this.attr('tone', 'accent')}`, width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
      s('circle', { class: 'rc-ring__track', cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': stroke }),
      s('circle', {
        class: 'rc-ring__bar',
        cx: size / 2,
        cy: size / 2,
        r,
        fill: 'none',
        'stroke-width': stroke,
        'stroke-linecap': 'round',
        'stroke-dasharray': `${(circ * ratio).toFixed(2)} ${circ.toFixed(2)}`,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
      }),
    );
    this.setAttribute('role', 'progressbar');
    this.setAttribute('aria-valuemin', '0');
    this.setAttribute('aria-valuemax', String(max));
    this.setAttribute('aria-valuenow', String(value));
    this.setAttribute('aria-label', label || 'Progress');
    this.setAttribute('aria-valuetext', `${text}${label ? ` ${label}` : ''}`);
    this.replaceChildren(h('div', { class: 'rc-ring', style: `width:${size}px;height:${size}px` }, svg, h('div', { class: 'rc-ring__text' }, h('span', { class: 'rc-ring__value' }, text), label ? h('span', { class: 'rc-ring__label' }, label) : null)));
  }
}

// ----------------------------------------------------------------------------- rc-list

class RcList extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'empty', 'selectable', 'max', 'format'];
  private staticKids: Node[] | null = null;

  protected override setup(): void {
    // Without data binding, keep author-provided children and just style them as rows.
    if (!this.hasAttribute('sql') && this.childNodes.length) this.staticKids = [...this.childNodes];
  }

  protected render(): void {
    if (this.staticKids && !this.rows && !this.hasAttribute('sql')) {
      this.classList.add('rc-list--static');
      return;
    }
    if (this.error) {
      this.replaceChildren(this.errorEl());
      return;
    }
    const rows = (this.rows ?? []).slice(0, Number(this.attr('max', '500')) || 500);
    if (rows.length === 0) {
      this.replaceChildren(this.loading ? '' : h('p', { class: 'rc-list__empty' }, this.attr('empty', 'Nothing here yet.')));
      return;
    }
    const selectable = this.boolAttr('selectable');
    const coach = getCoach();
    const ul = h('ul', { class: 'rc-list__ul', role: 'list' });
    for (const r of rows) {
      const title = String(pick(r, 'title', 'name', 'label') ?? '');
      const sub = pick(r, 'subtitle', 'detail', 'description');
      const meta = pick(r, 'meta', 'value');
      const icon = pick(r, 'icon');
      const badge = pick(r, 'badge');
      const tone = pick(r, 'tone');
      const inner = [
        icon ? h('span', { class: 'rc-list__icon' }, iconSvg(String(icon), 20)) : null,
        h('span', { class: 'rc-list__text' }, h('span', { class: 'rc-list__title' }, title), sub != null && sub !== '' ? h('span', { class: 'rc-list__sub' }, String(sub)) : null),
        badge ? h('span', { class: `rc-badge rc-badge--${tone ?? 'default'}` }, String(badge)) : null,
        meta != null && meta !== '' ? h('span', { class: 'rc-list__meta' }, formatValue(coach, meta, this.getAttribute('format'))) : null,
      ];
      const li = h('li', { class: `rc-list__item${tone ? ` rc-list__item--${tone}` : ''}` });
      if (selectable) {
        const b = h('button', { type: 'button', class: 'rc-list__row' }, ...inner);
        b.addEventListener('click', () => emit(this, 'select', { id: r.id ?? null, item: r }));
        li.append(b);
      } else {
        li.append(h('div', { class: 'rc-list__row' }, ...inner));
      }
      ul.append(li);
    }
    this.replaceChildren(ul);
  }
}

export function registerData(): void {
  define('rc-stat', RcStat);
  define('rc-trend', RcTrend);
  define('rc-progress-ring', RcProgressRing);
  define('rc-list', RcList);
}
