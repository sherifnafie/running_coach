/**
 * <rc-form>: renders the same field types as the micro-UI schema (Appendix C §C.3):
 * scale, choice, multi_choice, number, text, date, time, body_map.
 *
 *   form.fields = [{ id: 'rpe', type: 'scale', label: 'How hard was it?', min: 1, max: 10 }, ...]
 *   form.addEventListener('submit', e => e.detail.values)   // { rpe: 7, ... }
 *
 * Extra (beyond micro-UI): `required: true` on any field, `value` for an initial value.
 */
import { h, isRecord, num, parseJson, uid } from '../util';
import { BODY_REGION_IDS, regionLabel } from './body-map';
import { RcElement, define, emit } from './base';

type Opt = { label: string; value: string };
export interface FormFieldSpec {
  id: string;
  type: 'scale' | 'choice' | 'multi_choice' | 'number' | 'text' | 'date' | 'time' | 'body_map';
  label: string;
  min?: number;
  max?: number;
  step?: number;
  anchors?: Record<string, string>;
  options?: Opt[];
  unit?: string;
  multiline?: boolean;
  max_len?: number;
  multi?: boolean;
  required?: boolean;
  value?: unknown;
}

type Getter = () => unknown;

class RcForm extends RcElement {
  static observedAttributes = ['fields', 'submit-label', 'busy'];
  private getters = new Map<string, Getter>();
  private setters = new Map<string, (v: unknown) => void>();
  private _fields: FormFieldSpec[] | null = null;
  private formEl!: HTMLFormElement;
  private errorEl?: HTMLElement;
  private submitBtn?: HTMLButtonElement;
  private uid = uid('f');
  private pending: Record<string, unknown> | null = null;

  get fields(): FormFieldSpec[] {
    if (this._fields) return this._fields;
    const p = parseJson<unknown>(this.getAttribute('fields'));
    return Array.isArray(p) ? (p.filter((f) => isRecord(f) && typeof f.id === 'string' && typeof f.type === 'string') as unknown as FormFieldSpec[]) : [];
  }
  set fields(v: FormFieldSpec[]) {
    this._fields = v;
    this.rebuild();
  }

  /** Current values keyed by field id (omits unanswered fields). */
  get values(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, get] of this.getters) {
      const v = get();
      if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) out[id] = v;
    }
    return out;
  }
  set values(v: Record<string, unknown>) {
    this.pending = v;
    for (const [id, set] of this.setters) if (id in v) set(v[id]);
  }

  reset(): void {
    this.formEl?.reset();
    this.rebuild();
  }

  protected override attrChanged(name: string): void {
    if (name === 'fields') {
      this._fields = null;
      this.rebuild();
    }
  }

  protected override setup(): void {
    this.formEl = h('form', { class: 'rc-form', novalidate: true });
    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation(); // only the rc-form 'submit' CustomEvent (with detail.values) should reach listeners
      this.submit();
    });
    this.replaceChildren(this.formEl);
    this.rebuild();
  }

  protected render(): void {
    const busy = this.boolAttr('busy');
    if (this.submitBtn) {
      this.submitBtn.disabled = busy;
      this.submitBtn.setAttribute('aria-busy', String(busy));
    }
    const lbl = this.submitBtn?.querySelector('.rc-btn__label');
    if (lbl) lbl.textContent = this.attr('submit-label', 'Save');
  }

  submit(): void {
    const values = this.values;
    const missing = this.fields.filter((f) => f.required && !(f.id in values));
    const bad = this.fields.filter((f) => f.type === 'number' && f.id in values && ((f.min != null && (values[f.id] as number) < f.min) || (f.max != null && (values[f.id] as number) > f.max)));
    this.errorEl?.remove();
    if (missing.length || bad.length) {
      const msg = missing.length ? `Please answer: ${missing.map((f) => f.label).join(', ')}` : `Check the value for: ${bad.map((f) => f.label).join(', ')}`;
      this.errorEl = h('p', { class: 'rc-error', role: 'alert' }, msg);
      this.formEl.insertBefore(this.errorEl, this.submitBtn?.parentElement ?? null);
      return;
    }
    emit(this, 'submit', { id: this.id || null, values });
  }

  private rebuild(): void {
    if (!this.isSetup) return;
    this.getters.clear();
    this.setters.clear();
    const kids: HTMLElement[] = [];
    for (const f of this.fields) {
      const el = this.field(f);
      if (el) kids.push(el);
    }
    this.submitBtn = h('button', { type: 'submit', class: 'rc-btn rc-btn--primary rc-btn--block' }, h('span', { class: 'rc-btn__label' }, this.attr('submit-label', 'Save')));
    this.formEl.replaceChildren(...kids, h('div', { class: 'rc-form__actions' }, this.submitBtn));
    if (this.pending) this.values = this.pending;
    this.render();
  }

  private changed(): void {
    emit(this, 'change', { id: this.id || null, values: this.values });
  }

  private field(f: FormFieldSpec): HTMLElement | null {
    const id = `${this.uid}-${f.id}`;
    const wrap = h('div', { class: `rc-field rc-field--${f.type}` });
    const labelText = f.label + (f.required ? ' *' : '');
    const legend = (): HTMLElement => h('div', { class: 'rc-field__label', id: `${id}-l` }, labelText);
    const group = (role: string, labelledBy = `${id}-l`) => h('div', { class: 'rc-field__ctl', role, 'aria-labelledby': labelledBy });

    switch (f.type) {
      case 'scale': {
        const min = f.min ?? 1;
        const max = f.max ?? 10;
        const step = f.step && f.step > 0 ? f.step : 1;
        const g = group('radiogroup');
        g.classList.add('rc-scale');
        let val: number | undefined = num(f.value) ?? undefined;
        const btns: HTMLButtonElement[] = [];
        const paint = () => btns.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.v) === val)));
        for (let v = min; v <= max + 1e-9; v += step) {
          const vv = Math.round(v * 1000) / 1000;
          const anchor = f.anchors?.[String(vv)];
          const b = h('button', { type: 'button', role: 'radio', class: 'rc-scale__opt', 'data-v': vv, 'aria-checked': 'false', 'aria-label': anchor ? `${vv}, ${anchor}` : String(vv) }, String(vv));
          b.addEventListener('click', () => {
            val = val === vv ? undefined : vv;
            paint();
            this.changed();
          });
          btns.push(b);
          g.append(b);
        }
        this.getters.set(f.id, () => val);
        this.setters.set(f.id, (v) => {
          val = num(v) ?? undefined;
          paint();
        });
        paint();
        wrap.append(legend(), g);
        if (f.anchors && Object.keys(f.anchors).length) {
          wrap.append(h('p', { class: 'rc-field__hint' }, Object.entries(f.anchors).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k} = ${v}`).join(' · ')));
        }
        return wrap;
      }
      case 'choice':
      case 'multi_choice': {
        const multi = f.type === 'multi_choice';
        const g = group(multi ? 'group' : 'radiogroup');
        g.classList.add('rc-choices');
        const inputs: HTMLInputElement[] = [];
        for (const [i, o] of (f.options ?? []).entries()) {
          const input = h('input', { type: multi ? 'checkbox' : 'radio', name: id, value: o.value, id: `${id}-${i}` });
          if (f.value === o.value || (Array.isArray(f.value) && f.value.includes(o.value))) input.checked = true;
          input.addEventListener('change', () => this.changed());
          inputs.push(input);
          g.append(h('label', { class: 'rc-pick', for: `${id}-${i}` }, input, h('span', null, o.label)));
        }
        this.getters.set(f.id, () => (multi ? inputs.filter((i) => i.checked).map((i) => i.value) : inputs.find((i) => i.checked)?.value));
        this.setters.set(f.id, (v) => inputs.forEach((i) => (i.checked = multi ? Array.isArray(v) && v.includes(i.value) : v === i.value)));
        wrap.append(legend(), g);
        return wrap;
      }
      case 'number': {
        const input = h('input', { type: 'number', inputmode: 'decimal', step: 'any', class: 'rc-input', id, min: f.min, max: f.max, 'aria-describedby': f.unit ? `${id}-u` : null });
        if (f.value != null) input.value = String(f.value);
        input.addEventListener('input', () => this.changed());
        this.getters.set(f.id, () => num(input.value) ?? undefined);
        this.setters.set(f.id, (v) => (input.value = v == null ? '' : String(v)));
        wrap.append(h('label', { class: 'rc-field__label', for: id }, labelText), h('div', { class: 'rc-input-row' }, input, f.unit ? h('span', { class: 'rc-input-unit', id: `${id}-u` }, f.unit) : null));
        return wrap;
      }
      case 'text': {
        const input = f.multiline ? h('textarea', { class: 'rc-input', id, rows: 3, maxlength: f.max_len }) : h('input', { type: 'text', class: 'rc-input', id, maxlength: f.max_len });
        if (f.value != null) input.value = String(f.value);
        input.addEventListener('input', () => this.changed());
        this.getters.set(f.id, () => input.value.trim() || undefined);
        this.setters.set(f.id, (v) => (input.value = v == null ? '' : String(v)));
        wrap.append(h('label', { class: 'rc-field__label', for: id }, labelText), input);
        return wrap;
      }
      case 'date':
      case 'time': {
        const input = h('input', { type: f.type, class: 'rc-input', id });
        if (typeof f.value === 'string') input.value = f.value;
        input.addEventListener('input', () => this.changed());
        this.getters.set(f.id, () => input.value || undefined);
        this.setters.set(f.id, (v) => (input.value = v == null ? '' : String(v)));
        wrap.append(h('label', { class: 'rc-field__label', for: id }, labelText), input);
        return wrap;
      }
      case 'body_map': {
        const map = document.createElement('rc-body-map') as HTMLElement & { selected: string[] };
        if (f.multi === false) map.setAttribute('multi', 'false');
        const sev = new Map<string, number | null>();
        const sevBox = h('div', { class: 'rc-sev' });
        const redraw = () => {
          sevBox.replaceChildren(
            ...map.selected.map((r) => {
              const sid = `${id}-sev-${r}`;
              const sel = h('select', { class: 'rc-input rc-input--sm', id: sid }, h('option', { value: '' }, 'Not set'), ...Array.from({ length: 11 }, (_, n) => h('option', { value: n }, String(n))));
              sel.value = sev.get(r) == null ? '' : String(sev.get(r));
              sel.addEventListener('change', () => {
                sev.set(r, sel.value === '' ? null : Number(sel.value));
                this.changed();
              });
              return h('div', { class: 'rc-sev__row' }, h('label', { for: sid }, `${regionLabel(r)}: severity (0–10)`), sel);
            }),
          );
        };
        map.addEventListener('change', () => {
          for (const k of [...sev.keys()]) if (!map.selected.includes(k)) sev.delete(k);
          redraw();
          this.changed();
        });
        this.getters.set(f.id, () => map.selected.map((r) => ({ region: r, ...(sev.get(r) != null ? { severity: sev.get(r) } : {}) })));
        this.setters.set(f.id, (v) => {
          const arr = Array.isArray(v) ? v : [];
          map.selected = arr.map((x) => (isRecord(x) ? String(x.region) : String(x))).filter((r) => (BODY_REGION_IDS as readonly string[]).includes(r));
          for (const x of arr) if (isRecord(x) && typeof x.severity === 'number') sev.set(String(x.region), x.severity);
          redraw();
        });
        wrap.append(legend(), map, sevBox);
        return wrap;
      }
      default:
        return null;
    }
  }
}

export function registerForm(): void {
  define('rc-form', RcForm);
}
