import { BODY_REGIONS, type BodyRegion, type FormField, type MicroForm, type MicroUI } from '@opencoach/protocol';

/**
 * Micro-UI helpers (SPEC §9.3, Appendix C §C.3): form state, validation and the `values` object that goes into
 * `user.ui_action { action: 'form_submit', payload: { form_id, values } }`.
 *
 * `values` shape per field type (empty/untouched fields are omitted):
 *   scale → number · choice → string · multi_choice → string[] · number → number · text/date/time → string
 *   body_map → Array<{ region: BodyRegion; severity: number (0 to 10) }>
 */
export interface BodyMapEntry {
  region: BodyRegion;
  severity: number;
}
export type FieldState = number | string | string[] | BodyMapEntry[] | undefined;
export type FormState = Record<string, FieldState>;

export function initialFormState(form: MicroForm): FormState {
  const state: FormState = {};
  for (const f of form.fields) {
    switch (f.type) {
      case 'scale':
      case 'choice':
        state[f.id] = undefined;
        break;
      case 'multi_choice':
        state[f.id] = [];
        break;
      case 'body_map':
        state[f.id] = [];
        break;
      default:
        state[f.id] = '';
    }
  }
  return state;
}

export function clampScale(f: Extract<FormField, { type: 'scale' }>, raw: number): number {
  const step = f.step ?? 1;
  const snapped = Math.round((raw - f.min) / step) * step + f.min;
  const bounded = Math.min(f.max, Math.max(f.min, snapped));
  // avoid 0.30000000000000004 style noise
  return Number(bounded.toFixed(6));
}

export function parseNumber(s: string): number | undefined {
  const t = s.trim().replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Error message for a field's current state, or undefined when fine (empty is fine: fields are optional). */
export function fieldError(f: FormField, v: FieldState): string | undefined {
  if (f.type === 'number' && typeof v === 'string') {
    const n = parseNumber(v);
    if (n === undefined) return undefined;
    if (Number.isNaN(n)) return 'Enter a number';
    if (f.min != null && n < f.min) return `At least ${f.min}`;
    if (f.max != null && n > f.max) return `At most ${f.max}`;
  }
  if (f.type === 'text' && typeof v === 'string' && f.max_len != null && v.length > f.max_len) return `At most ${f.max_len} characters`;
  return undefined;
}

export function hasValue(f: FormField, v: FieldState): boolean {
  switch (f.type) {
    case 'scale':
      return typeof v === 'number';
    case 'choice':
      return typeof v === 'string' && v !== '';
    case 'multi_choice':
    case 'body_map':
      return Array.isArray(v) && v.length > 0;
    case 'number':
      return typeof v === 'string' && parseNumber(v) !== undefined;
    default:
      return typeof v === 'string' && v.trim() !== '';
  }
}

/** Submit is enabled when at least one field has a value and no field is invalid. */
export function isFormSubmittable(form: MicroForm, state: FormState): boolean {
  let any = false;
  for (const f of form.fields) {
    const v = state[f.id];
    if (fieldError(f, v)) return false;
    if (hasValue(f, v)) any = true;
  }
  return any;
}

/** Build the `values` payload from form state. */
export function assembleValues(form: MicroForm, state: FormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of form.fields) {
    const v = state[f.id];
    if (!hasValue(f, v) || fieldError(f, v)) continue;
    switch (f.type) {
      case 'scale':
        out[f.id] = clampScale(f, v as number);
        break;
      case 'number':
        out[f.id] = parseNumber(v as string);
        break;
      case 'text':
        out[f.id] = (v as string).trim().slice(0, f.max_len ?? 4000);
        break;
      case 'choice': {
        const valid = f.options.some((o) => o.value === v);
        if (valid) out[f.id] = v;
        break;
      }
      case 'multi_choice': {
        const allowed = new Set(f.options.map((o) => o.value));
        const picked = (v as string[]).filter((x) => allowed.has(x));
        // keep the options' order so the payload is stable
        out[f.id] = f.options.map((o) => o.value).filter((x) => picked.includes(x));
        break;
      }
      case 'body_map': {
        const known = new Set<string>(BODY_REGIONS);
        const entries = (v as BodyMapEntry[]).filter((e) => known.has(e.region));
        out[f.id] = entries.map((e) => ({ region: e.region, severity: Math.min(10, Math.max(0, Math.round(e.severity))) }));
        break;
      }
      default:
        out[f.id] = v;
    }
  }
  return out;
}

/** Toggle / set a body-map region (single-select replaces, multi toggles). */
export function toggleRegion(current: BodyMapEntry[], region: BodyRegion, multi: boolean): BodyMapEntry[] {
  const exists = current.find((e) => e.region === region);
  if (exists) return current.filter((e) => e.region !== region);
  const entry: BodyMapEntry = { region, severity: 5 };
  return multi ? [...current, entry] : [entry];
}

export function setSeverity(current: BodyMapEntry[], region: BodyRegion, severity: number): BodyMapEntry[] {
  return current.map((e) => (e.region === region ? { ...e, severity } : e));
}

/** `expires_at` has passed → chips/forms render disabled. */
export function isMicroUiExpired(ui: MicroUI | undefined, nowMs: number): boolean {
  if (!ui?.expires_at) return false;
  const t = Date.parse(ui.expires_at);
  return Number.isFinite(t) && t <= nowMs;
}

export function regionLabel(region: string): string {
  return region.replace(/_/g, ' ').replace(/\bitb\b/, 'IT band');
}

/** Human readable one-liners for a submitted form (shown read-only after submit). */
export function summarizeSubmission(form: MicroForm | undefined, values: Record<string, unknown> | undefined): Array<{ label: string; text: string }> {
  if (!values) return [];
  const lines: Array<{ label: string; text: string }> = [];
  for (const [id, v] of Object.entries(values)) {
    const f = form?.fields.find((x) => x.id === id);
    const label = f?.label ?? id;
    let text: string;
    if (f?.type === 'choice' && typeof v === 'string') text = f.options.find((o) => o.value === v)?.label ?? v;
    else if (f?.type === 'multi_choice' && Array.isArray(v)) text = v.map((x) => f.options.find((o) => o.value === x)?.label ?? String(x)).join(', ');
    else if (f?.type === 'body_map' && Array.isArray(v))
      text = v.map((e) => `${regionLabel(String((e as BodyMapEntry).region))} ${(e as BodyMapEntry).severity}/10`).join(', ');
    else if (f?.type === 'number' && f.unit) text = `${String(v)} ${f.unit}`;
    else text = Array.isArray(v) ? v.join(', ') : String(v);
    lines.push({ label, text });
  }
  return lines;
}
