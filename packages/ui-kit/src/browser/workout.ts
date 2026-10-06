/**
 * Workout structure model (Appendix D §D.4 "Workout structure"): turns the planned_workouts.structure
 * JSON into display rows for <rc-workout>. Pure; no DOM.
 */
import { distance, duration, paceRange, pace, type Units } from './format';
import { humanize, isRecord, num, parseJson } from './util';

export interface WorkoutItem {
  type: 'step' | 'repeat';
  kind: string;
  kindLabel: string;
  /** "15 min", "1 km", "open" */
  duration: string;
  /** "RPE 2–3 · 3:55–4:05 /km" */
  target: string;
  note?: string;
  /** For repeats: number of repetitions and the nested steps. */
  times?: number;
  children?: WorkoutItem[];
}

export interface WorkoutModel {
  items: WorkoutItem[];
  notes: string;
  /** One-line summary, e.g. "15 min warm-up · 5 × (1 km work, 2 min recovery) · 10 min cool-down". */
  summary: string;
  /** Sum of explicit step times (repeats expanded), seconds. */
  totalTimeS: number;
  /** Sum of explicit step distances (repeats expanded), metres. */
  totalDistanceM: number;
  warnings: string[];
}

const KIND_LABELS: Record<string, string> = {
  warmup: 'Warm-up',
  work: 'Work',
  recovery: 'Recovery',
  cooldown: 'Cool-down',
  steady: 'Steady',
  rest: 'Rest',
  strides: 'Strides',
  drill: 'Drills',
};

function range(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) {
    const a = num(v[0]);
    const b = num(v[1]);
    if (a !== null && b !== null) return [Math.min(a, b), Math.max(a, b)];
  }
  const n = num(v);
  return n === null ? null : [n, n];
}

const en = '–';

export function describeTarget(target: unknown, units: Units): string {
  if (!isRecord(target)) return '';
  const parts: string[] = [];
  const pc = range(target.pace_s_km);
  if (pc) parts.push(pc[0] === pc[1] ? pace(pc[0], units) : paceRange(pc, units));
  const hr = range(target.hr_bpm);
  if (hr) parts.push(hr[0] === hr[1] ? `${Math.round(hr[0])} bpm` : `${Math.round(hr[0])}${en}${Math.round(hr[1])} bpm`);
  const hz = range(target.hr_zone);
  if (hz) parts.push(hz[0] === hz[1] ? `Zone ${hz[0]}` : `Zones ${hz[0]}${en}${hz[1]}`);
  const rpe = range(target.rpe);
  if (rpe) parts.push(rpe[0] === rpe[1] ? `RPE ${rpe[0]}` : `RPE ${rpe[0]}${en}${rpe[1]}`);
  const tt = target.talk_test;
  if (typeof tt === 'string' && tt) parts.push(`Talk test: ${tt}`);
  else if (Array.isArray(tt) && tt.length) parts.push(`Talk test: ${tt.map(String).join(` ${en} `)}`);
  return parts.join(' · ');
}

function describeDuration(d: unknown, units: Units, locale: string): string {
  if (!isRecord(d)) return '';
  const t = num(d.time_s);
  const m = num(d.distance_m);
  if (t !== null) return duration(t, 'short');
  if (m !== null) return distance(m, units, { locale });
  if (d.open === true || d.open === 'true') return 'Open';
  return '';
}

export function buildWorkoutModel(input: unknown, units: Units = 'metric', locale = 'en-US'): WorkoutModel {
  const warnings: string[] = [];
  const root = parseJson<Record<string, unknown>>(input);
  const model: WorkoutModel = { items: [], notes: '', summary: '', totalTimeS: 0, totalDistanceM: 0, warnings };
  if (!isRecord(root)) {
    if (input != null && input !== '') warnings.push('structure is not an object');
    return model;
  }
  model.notes = typeof root.notes === 'string' ? root.notes : '';
  const steps = Array.isArray(root.steps) ? root.steps : [];
  if (!Array.isArray(root.steps)) warnings.push('structure.steps is not an array');

  const walk = (list: unknown[], mult: number, depth: number): WorkoutItem[] => {
    const out: WorkoutItem[] = [];
    for (const raw of list) {
      if (!isRecord(raw)) {
        warnings.push('ignored a step that is not an object');
        continue;
      }
      const kind = typeof raw.kind === 'string' ? raw.kind : 'work';
      if (kind === 'repeat') {
        const times = Math.max(1, Math.floor(num(raw.times) ?? 1));
        const children = walk(Array.isArray(raw.steps) ? raw.steps : [], mult * times, depth + 1);
        out.push({ type: 'repeat', kind, kindLabel: 'Repeat', duration: '', target: '', times, children, note: typeof raw.note === 'string' ? raw.note : undefined });
        continue;
      }
      const d = isRecord(raw.duration) ? raw.duration : {};
      model.totalTimeS += (num(d.time_s) ?? 0) * mult;
      model.totalDistanceM += (num(d.distance_m) ?? 0) * mult;
      out.push({
        type: 'step',
        kind,
        kindLabel: KIND_LABELS[kind] ?? humanize(kind),
        duration: describeDuration(raw.duration, units, locale),
        target: describeTarget(raw.target, units),
        note: typeof raw.note === 'string' ? raw.note : undefined,
      });
    }
    return out;
  };
  model.items = walk(steps, 1, 0);
  model.summary = model.items.map(summarize).join(' · ');
  return model;
}

function summarize(it: WorkoutItem): string {
  if (it.type === 'repeat') return `${it.times} × (${(it.children ?? []).map(summarize).join(', ')})`;
  const label = it.kindLabel.toLowerCase();
  return it.duration ? `${it.duration} ${label}` : label;
}
