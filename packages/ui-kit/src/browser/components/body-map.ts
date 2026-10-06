/**
 * <rc-body-map>: front and back body figure whose regions use the BODY_REGIONS ids from the
 * protocol (the same ids as the micro-UI body_map field). The drawing is pointer-only; an
 * equivalent list of native checkboxes is always available underneath (accessible alternative).
 *
 * Attributes: value (comma list or JSON array of region ids), multi (default true), readonly,
 * heat (JSON {region: 0-10} for colouring), view (both | front | back).
 * Events: change {regions}.
 */
import { h, humanize, parseJson, s, uid } from '../util';
import { RcElement, define, emit } from './base';

/** Keep in sync with BODY_REGIONS in @opencoach/protocol (a unit test enforces equality). */
export const BODY_REGION_IDS = [
  'head', 'neck', 'left_shoulder', 'right_shoulder', 'chest', 'upper_back', 'lower_back', 'abdomen',
  'left_hip', 'right_hip', 'left_glute', 'right_glute', 'groin',
  'left_quad', 'right_quad', 'left_hamstring', 'right_hamstring', 'left_itb', 'right_itb',
  'left_knee', 'right_knee', 'left_shin', 'right_shin', 'left_calf', 'right_calf',
  'left_achilles', 'right_achilles', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel',
  'left_arch', 'right_arch', 'left_forefoot', 'right_forefoot', 'left_toes', 'right_toes',
] as const;

type Shape = { k: 'rect'; x: number; y: number; w: number; h: number; r: number } | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number };
const rect = (x: number, y: number, w: number, h: number, r = 6): Shape => ({ k: 'rect', x, y, w, h, r });
const ell = (cx: number, cy: number, rx: number, ry: number): Shape => ({ k: 'ellipse', cx, cy, rx, ry });

const mirror = (sh: Shape): Shape => (sh.k === 'rect' ? { ...sh, x: 160 - (sh.x + sh.w) } : { ...sh, cx: 160 - sh.cx });

/** Geometry per view: `center` regions have a single id; `side` regions are given for the viewer-right side. */
const FRONT = {
  center: { head: ell(80, 22, 15, 19), neck: rect(72, 43, 16, 13, 5), chest: rect(62, 58, 36, 32), abdomen: rect(64, 92, 32, 34), groin: rect(75, 134, 10, 16, 5) },
  side: {
    shoulder: ell(112, 67, 15, 12),
    hip: rect(86, 128, 20, 24, 8),
    quad: rect(86, 154, 20, 68, 9),
    itb: rect(107, 156, 8, 62, 4),
    knee: rect(86, 224, 20, 16, 7),
    shin: rect(87, 242, 18, 62, 8),
    ankle: rect(88, 306, 16, 14, 6),
    arch: rect(86, 322, 20, 14, 5),
    forefoot: rect(85, 338, 22, 12, 5),
    toes: rect(86, 352, 20, 9, 4),
  },
  /** Which side of the viewer a "left_*" region sits on. */
  leftIs: 'right' as const,
};
const BACK = {
  center: { head: ell(80, 22, 15, 19), neck: rect(72, 43, 16, 13, 5), upper_back: rect(62, 58, 36, 32), lower_back: rect(64, 92, 36 - 4, 22) },
  side: {
    shoulder: ell(112, 67, 15, 12),
    glute: rect(81, 116, 24, 32, 10),
    hamstring: rect(86, 150, 20, 70, 9),
    knee: rect(86, 222, 20, 16, 7),
    calf: rect(87, 240, 18, 52, 8),
    achilles: rect(91, 294, 10, 24, 4),
    heel: rect(88, 320, 16, 14, 6),
  },
  leftIs: 'left' as const,
};

function shapeEl(sh: Shape, region: string): SVGElement {
  const common = { class: 'rc-bm__r', 'data-region': region };
  return sh.k === 'rect' ? s('rect', { ...common, x: sh.x, y: sh.y, width: sh.w, height: sh.h, rx: sh.r }) : s('ellipse', { ...common, cx: sh.cx, cy: sh.cy, rx: sh.rx, ry: sh.ry });
}

function buildFigure(view: typeof FRONT | typeof BACK, name: 'front' | 'back'): SVGSVGElement {
  const svg = s('svg', { class: 'rc-bm__svg', viewBox: '0 0 160 366', 'aria-hidden': 'true', focusable: 'false', 'data-view': name });
  for (const [id, sh] of Object.entries(view.center)) svg.append(shapeEl(sh, id));
  for (const [id, sh] of Object.entries(view.side)) {
    const viewerRight = sh;
    const viewerLeft = mirror(sh);
    const leftShape = view.leftIs === 'right' ? viewerRight : viewerLeft;
    const rightShape = view.leftIs === 'right' ? viewerLeft : viewerRight;
    svg.append(shapeEl(leftShape, `left_${id}`), shapeEl(rightShape, `right_${id}`));
  }
  return svg;
}

const GROUPS: Array<[string, string[]]> = [
  ['Head and neck', ['head', 'neck']],
  ['Shoulders and trunk', ['left_shoulder', 'right_shoulder', 'chest', 'upper_back', 'lower_back', 'abdomen']],
  ['Hips and thighs', ['left_hip', 'right_hip', 'left_glute', 'right_glute', 'groin', 'left_quad', 'right_quad', 'left_hamstring', 'right_hamstring', 'left_itb', 'right_itb']],
  ['Knees and lower legs', ['left_knee', 'right_knee', 'left_shin', 'right_shin', 'left_calf', 'right_calf']],
  ['Ankles and feet', ['left_achilles', 'right_achilles', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_arch', 'right_arch', 'left_forefoot', 'right_forefoot', 'left_toes', 'right_toes']],
];

export function regionLabel(id: string): string {
  return humanize(id.replace('itb', 'IT band'));
}

class RcBodyMap extends RcElement {
  static observedAttributes = ['value', 'multi', 'readonly', 'heat', 'view', 'label'];
  private sel = new Set<string>();
  private root!: HTMLElement;
  private figures: SVGSVGElement[] = [];
  private checks = new Map<string, HTMLInputElement>();
  private uid = uid('bm');
  private live!: HTMLElement;

  get selected(): string[] {
    return [...this.sel];
  }
  set selected(v: string[]) {
    this.sel = new Set(v.filter((r) => (BODY_REGION_IDS as readonly string[]).includes(r)));
    this.paint();
  }

  protected override attrChanged(name: string): void {
    if (name === 'value') this.readValue();
  }

  private readValue(): void {
    const raw = this.getAttribute('value');
    if (raw == null) return;
    const parsed = parseJson<unknown>(raw);
    const list = Array.isArray(parsed) ? parsed.map((x) => (typeof x === 'object' && x ? String((x as { region?: unknown }).region ?? '') : String(x))) : raw.split(',').map((x) => x.trim());
    this.sel = new Set(list.filter((r) => (BODY_REGION_IDS as readonly string[]).includes(r)));
  }

  protected override setup(): void {
    this.readValue();
    this.live = h('div', { class: 'rc-sr', 'aria-live': 'polite', role: 'status' });
    const views = h('div', { class: 'rc-bm__views' });
    const mk = (name: 'front' | 'back') => {
      const fig = buildFigure(name === 'front' ? FRONT : BACK, name);
      this.figures.push(fig);
      fig.addEventListener('click', (e) => {
        const r = (e.target as Element).closest('[data-region]')?.getAttribute('data-region');
        if (r) this.toggle(r);
      });
      return h('figure', { class: 'rc-bm__fig', 'data-view': name }, fig, h('figcaption', null, name === 'front' ? 'Front' : 'Back'));
    };
    views.append(mk('front'), mk('back'));

    const list = h('details', { class: 'rc-bm__list' }, h('summary', null, 'Choose from a list'));
    for (const [title, ids] of GROUPS) {
      const fs = h('fieldset', { class: 'rc-bm__group' }, h('legend', null, title));
      for (const id of ids) {
        const input = h('input', { type: 'checkbox', value: id, id: `${this.uid}-${id}` });
        input.addEventListener('change', () => this.toggle(id, input.checked));
        this.checks.set(id, input);
        fs.append(h('label', { class: 'rc-pick', for: `${this.uid}-${id}` }, input, h('span', null, regionLabel(id))));
      }
      list.append(fs);
    }
    this.root = h('div', { class: 'rc-bm' }, views, list, this.live);
    this.replaceChildren(this.root);
  }

  private toggle(id: string, force?: boolean): void {
    if (this.boolAttr('readonly')) return;
    const multi = this.getAttribute('multi') !== 'false';
    const on = force ?? !this.sel.has(id);
    if (!multi) this.sel.clear();
    if (on) this.sel.add(id);
    else this.sel.delete(id);
    this.paint();
    this.live.textContent = `${regionLabel(id)} ${on ? 'selected' : 'cleared'}`;
    this.setAttribute('value', [...this.sel].join(','));
    emit(this, 'change', { regions: [...this.sel] });
  }

  protected render(): void {
    this.paint();
  }

  private paint(): void {
    if (!this.root) return;
    const heat = parseJson<Record<string, number>>(this.getAttribute('heat'), {}) ?? {};
    const ro = this.boolAttr('readonly');
    this.root.classList.toggle('is-readonly', ro);
    const view = this.attr('view', 'both');
    for (const fig of this.root.querySelectorAll<HTMLElement>('.rc-bm__fig')) fig.hidden = view !== 'both' && fig.getAttribute('data-view') !== view;
    for (const el of this.root.querySelectorAll<SVGElement>('[data-region]')) {
      const id = el.getAttribute('data-region') as string;
      el.classList.toggle('is-selected', this.sel.has(id));
      const v = heat[id];
      for (const c of ['is-heat-1', 'is-heat-2', 'is-heat-3', 'is-heat-4']) el.classList.remove(c);
      if (typeof v === 'number' && v > 0) el.classList.add(`is-heat-${v >= 8 ? 4 : v >= 5 ? 3 : v >= 3 ? 2 : 1}`);
    }
    for (const [id, input] of this.checks) {
      input.checked = this.sel.has(id);
      input.disabled = ro;
    }
    const list = this.root.querySelector('.rc-bm__list') as HTMLDetailsElement | null;
    if (list) list.hidden = ro && this.sel.size === 0 && Object.keys(heat).length === 0;
  }
}

export function registerBodyMap(): void {
  define('rc-body-map', RcBodyMap);
}
