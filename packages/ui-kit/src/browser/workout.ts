/**
 * Session structure model (Appendix D §D.4 "Session structure"): turns the planned_workouts.structure
 * JSON into display rows for <rc-workout>. Endurance steps (duration + target), repeats, and strength
 * "exercise" steps (sets x reps @ load) can be mixed in one session. Pure; no DOM.
 */
import { distance, duration, paceRange, pace, weight, type Units } from './format';
import { humanize, isRecord, num, parseJson } from './util';

export interface ExerciseSetGroup {
  /** "3 × 5", "1 × 8–12", "3 × 45 s", "AMRAP" */
  scheme: string;
  /** "100 kg", "70–75% 1RM", "Bodyweight" */
  load: string;
  /** "RPE 8 · 2 RIR" */
  target: string;
}

export interface WorkoutItem {
  type: 'step' | 'repeat' | 'exercise';
  kind: string;
  /** Step kind label ("Warm-up"), or the exercise name. */
  kindLabel: string;
  /** "15 min", "1 km", "open"; for exercises, the compact set scheme ("3 × 5"). */
  duration: string;
  /** "RPE 2–3 · 3:55–4:05 /km"; for exercises, load and effort ("100 kg · RPE 8"). */
  target: string;
  note?: string;
  /** For repeats: number of repetitions and the nested steps. */
  times?: number;
  children?: WorkoutItem[];
  /** For exercises: one entry per group of identical sets. */
  sets?: ExerciseSetGroup[];
  /** For exercises: "Rest 3 min · Tempo 3-1-1". */
  meta?: string;
}

export interface WorkoutModel {
  items: WorkoutItem[];
  notes: string;
  /** One-line summary, e.g. "15 min warm-up · 5 × (1 km work, 2 min recovery) · Back squat 3 × 5". */
  summary: string;
  /** Sum of explicit step times (repeats expanded), seconds. */
  totalTimeS: number;
  /** Sum of explicit step distances (repeats expanded), metres. */
  totalDistanceM: number;
  /** Working sets across exercise steps (repeats expanded). */
  totalSets: number;
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
const times = '×';

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function fmtRange(r: [number, number], suffix = ''): string {
  return r[0] === r[1] ? `${fmtNum(r[0])}${suffix}` : `${fmtNum(r[0])}${en}${fmtNum(r[1])}${suffix}`;
}

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
  if (rpe) parts.push(`RPE ${fmtRange(rpe)}`);
  const rir = range(target.rir);
  if (rir) parts.push(`${fmtRange(rir)} RIR`);
  const pct = range(target.pct_1rm);
  if (pct) parts.push(`${fmtRange(pct, '%')} 1RM`);
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

/** `{"kg": 100}` / `{"kg": [95, 102.5]}` / `{"pct_1rm": [70, 75]}` / `{"bodyweight": true}` -> display text. */
export function describeLoad(load: unknown, units: Units, locale: string): string {
  if (typeof load === 'number') return weight(load, units, { locale });
  if (!isRecord(load)) return '';
  const parts: string[] = [];
  if (load.bodyweight === true) parts.push('Bodyweight');
  const kg = range(load.kg);
  if (kg) parts.push(kg[0] === kg[1] ? weight(kg[0], units, { locale }) : `${weight(kg[0], units, { locale, unit: false })}${en}${weight(kg[1], units, { locale })}`);
  const pct = range(load.pct_1rm);
  if (pct) parts.push(`${fmtRange(pct, '%')} 1RM`);
  return parts.join(' + ');
}

function describeReps(reps: unknown): string {
  if (typeof reps === 'string' && reps.trim()) return reps.trim().toUpperCase() === 'AMRAP' ? 'AMRAP' : reps.trim();
  const r = range(reps);
  return r ? fmtRange(r) : '';
}

function setGroup(count: number, raw: Record<string, unknown>, parent: Record<string, unknown>, units: Units, locale: string): ExerciseSetGroup {
  const reps = describeReps(raw.reps ?? parent.reps);
  const dur = describeDuration(raw.duration ?? parent.duration, units, locale);
  const what = reps || dur;
  return {
    scheme: what ? `${count} ${times} ${what}` : `${count} ${count === 1 ? 'set' : 'sets'}`,
    load: describeLoad(raw.load ?? parent.load, units, locale),
    target: describeTarget(raw.target ?? parent.target, units),
  };
}

function exerciseItem(raw: Record<string, unknown>, mult: number, model: WorkoutModel, units: Units, locale: string): WorkoutItem {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Exercise';
  const groups: ExerciseSetGroup[] = [];
  if (Array.isArray(raw.sets)) {
    for (const s of raw.sets) {
      if (!isRecord(s)) {
        model.warnings.push(`ignored a set of "${name}" that is not an object`);
        continue;
      }
      const n = Math.max(1, Math.floor(num(s.times) ?? 1));
      groups.push(setGroup(n, s, raw, units, locale));
      model.totalSets += n * mult;
    }
  } else {
    const n = Math.max(1, Math.floor(num(raw.sets) ?? 1));
    groups.push(setGroup(n, {}, raw, units, locale));
    model.totalSets += n * mult;
  }
  const meta: string[] = [];
  const rest = num(raw.rest_s);
  if (rest !== null) meta.push(`Rest ${duration(rest, 'short')}`);
  if (typeof raw.tempo === 'string' && raw.tempo) meta.push(`Tempo ${raw.tempo}`);
  const first = groups[0];
  return {
    type: 'exercise',
    kind: 'exercise',
    kindLabel: name,
    duration: groups.length === 1 && first ? first.scheme : groups.map((g) => g.scheme).join(' + '),
    target: groups.length === 1 && first ? [first.load, first.target].filter(Boolean).join(' · ') : '',
    sets: groups,
    meta: meta.join(' · ') || undefined,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
}

export function buildWorkoutModel(input: unknown, units: Units = 'metric', locale = 'en-US'): WorkoutModel {
  const warnings: string[] = [];
  const root = parseJson<Record<string, unknown>>(input);
  const model: WorkoutModel = { items: [], notes: '', summary: '', totalTimeS: 0, totalDistanceM: 0, totalSets: 0, warnings };
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
        const n = Math.max(1, Math.floor(num(raw.times) ?? 1));
        const children = walk(Array.isArray(raw.steps) ? raw.steps : [], mult * n, depth + 1);
        out.push({ type: 'repeat', kind, kindLabel: 'Repeat', duration: '', target: '', times: n, children, note: typeof raw.note === 'string' ? raw.note : undefined });
        continue;
      }
      if (kind === 'exercise') {
        out.push(exerciseItem(raw, mult, model, units, locale));
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
  if (it.type === 'repeat') return `${it.times} ${times} (${(it.children ?? []).map(summarize).join(', ')})`;
  if (it.type === 'exercise') return `${it.kindLabel} ${it.duration}`.trim();
  const label = it.kindLabel.toLowerCase();
  return it.duration ? `${it.duration} ${label}` : label;
}
