/**
 * Test workspaces: the actual seed migration (Appendix D §D.4), the seed UI
 * (seed/running/workspace/ui) and, optionally, three weeks of realistic sample data.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { addDays } from '../../src/browser/dates';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(here, '..', '..');
export const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
export const SEED_UI = join(REPO_ROOT, 'seed', 'running', 'workspace', 'ui');
export const SCHEMA_SQL = join(REPO_ROOT, 'seed', 'running', 'workspace', 'data', 'migrations', '0001_init.sql');

/** "Now" for the sample data: Tuesday 2026-10-06, 09:30 local (UTC+2). */
export const NOW = new Date('2026-10-06T07:30:00Z');
export const TODAY = '2026-10-06';

export function createSchemaDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA_SQL, 'utf8'));
  return db;
}

export interface WorkspaceOptions {
  data: 'empty' | 'sample';
  /** Copy the seed UI (default true). */
  seedUi?: boolean;
}

export function makeWorkspace(root: string, opts: WorkspaceOptions): string {
  mkdirSync(root, { recursive: true });
  if (opts.seedUi !== false) cpSync(SEED_UI, join(root, 'ui'), { recursive: true });
  mkdirSync(join(root, 'plan'), { recursive: true });
  const db = createSchemaDb(join(root, 'data', 'coach.db'));
  if (opts.data === 'sample') {
    writeFileSync(
      join(root, 'plan', 'athlete-summary.md'),
      ['# Half marathon build', '', 'Goal: **City Half Marathon**, 6 December.', '', '## This block (Base 2)', '', '- Build easy volume to ~45 km a week', '- One quality session a week, long run on Sundays', '- Strides after two easy runs', '', '| Week | Focus |', '|---|---|', '| 1-3 | Aerobic base |', '| 4-6 | Add tempo |', ''].join('\n'),
    );
    insertSample(db);
  } else {
    writeFileSync(join(root, 'plan', 'athlete-summary.md'), 'No plan yet — complete intake first.\n');
  }
  writeFileSync(join(root, 'plan', 'current.md'), 'Coach working notes: reconcile data/coach.db with planned_workouts. Not view copy.\n');
  db.close();
  return root;
}

// ------------------------------------------------------------------ sample data

type Day = 'rest' | 'easy' | 'quality' | 'long';
const WEEK: Day[] = ['rest', 'easy', 'quality', 'easy', 'rest', 'easy', 'long']; // Mon..Sun

const INTERVALS = {
  steps: [
    { kind: 'warmup', duration: { time_s: 900 }, target: { rpe: [2, 3] } },
    { kind: 'repeat', times: 5, steps: [{ kind: 'work', duration: { distance_m: 1000 }, target: { pace_s_km: [235, 245] } }, { kind: 'recovery', duration: { time_s: 120 }, target: { rpe: [1, 2] } }] },
    { kind: 'cooldown', duration: { time_s: 600 }, target: { rpe: [2, 3] } },
  ],
  notes: 'Even effort; stop the reps if the calf tightens.',
};
const TEMPO = {
  steps: [
    { kind: 'warmup', duration: { time_s: 900 }, target: { rpe: [2, 3] } },
    { kind: 'work', duration: { time_s: 1200 }, target: { pace_s_km: [265, 275], hr_zone: [3, 4] } },
    { kind: 'cooldown', duration: { time_s: 600 }, target: { rpe: [2, 3] } },
  ],
  notes: 'Comfortably hard. You should be able to say a short sentence.',
};
const easy = (m: number) => ({ steps: [{ kind: 'steady', duration: { distance_m: m }, target: { rpe: [2, 3], talk_test: 'conversational' } }], notes: 'Keep it relaxed.' });
const long = (m: number) => ({ steps: [{ kind: 'steady', duration: { distance_m: m }, target: { rpe: [3, 4], hr_zone: [2, 3] } }], notes: 'Fuel and hydrate. Last 2 km can be a little faster if you feel good.' });

export function insertSample(db: DatabaseSync): void {
  const iso = (d: string, time = '07:15:00') => `${d}T${time}+02:00`;
  const stamp = '2026-09-01T10:00:00Z';
  const block = db.prepare('INSERT INTO blocks (id, name, start_date, end_date, focus, notes) VALUES (?,?,?,?,?,?)');
  block.run('blk_base1', 'Base 1', '2026-08-03', '2026-09-13', 'Easy aerobic running, build the habit', null);
  block.run('blk_base2', 'Base 2', '2026-09-14', '2026-10-25', 'Raise weekly volume, introduce one quality session', null);
  block.run('blk_build1', 'Build 1', '2026-10-26', '2026-12-06', 'Half-marathon specific work', null);

  const planned = db.prepare('INSERT INTO planned_workouts (id, date, slot, type, title, description, structure, target_distance_m, target_duration_s, status, block_id, coach_notes, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const act = db.prepare('INSERT INTO activities (id, started_at, sport, title, distance_m, duration_s, moving_s, elev_gain_m, avg_hr, max_hr, avg_cadence_spm, avg_pace_s_km, rpe, feel, laps, hr_zones, planned_id, source, source_refs, extracted_by, confidence, confirmed, extra, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

  const start = '2026-09-14'; // Monday, three weeks before the current week
  let n = 0;
  for (let w = 0; w < 7; w++) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const kind = WEEK[d] as Day;
      const quality = w % 2 === 0 ? 'intervals' : 'tempo';
      const type = kind === 'quality' ? quality : kind;
      const dist = kind === 'easy' ? 8000 : kind === 'quality' ? (quality === 'intervals' ? 9000 : 10000) : kind === 'long' ? 14000 + 1000 * Math.min(w, 5) : 0;
      const title = { rest: 'Rest day', easy: 'Easy run', intervals: '5 x 1 km', tempo: 'Tempo 20 min', long: 'Long run' }[type] ?? 'Run';
      const structure = type === 'intervals' ? INTERVALS : type === 'tempo' ? TEMPO : type === 'long' ? long(dist) : type === 'easy' ? easy(dist) : null;
      const id = `pw_${String(++n).padStart(3, '0')}`;
      const past = date < TODAY;
      let status = 'planned';
      if (past && type !== 'rest') status = 'done';
      if (type === 'rest' && past) status = 'done';
      if (date === '2026-09-23') status = 'skipped'; // a missed easy day
      if (date === '2026-09-27') status = 'partial'; // long run cut short
      if (date === '2026-10-01') status = 'moved';
      planned.run(id, date, 'am', type, title, type === 'rest' ? 'Full rest. Walk if you like.' : type === 'long' ? 'Time on feet. Stay relaxed and fuel early.' : type === 'easy' ? 'Conversational pace, shake out the legs.' : 'Quality day: warm up well.', structure ? JSON.stringify(structure) : null, dist || null, null, status, w < 6 ? 'blk_base2' : 'blk_build1', 'private rationale', stamp);
      if ((status === 'done' || status === 'partial') && type !== 'rest') {
        const factor = status === 'partial' ? 0.65 : 1 + ((n % 5) - 2) * 0.01;
        const meters = Math.round(dist * factor);
        const pace = (type === 'easy' ? 352 - w * 4 : type === 'long' ? 345 : type === 'tempo' ? 292 : 305) + (n % 3);
        const hr = type === 'easy' ? 141 + (n % 4) : type === 'long' ? 148 : type === 'tempo' ? 164 : 160;
        act.run(`act_${String(n).padStart(3, '0')}`, iso(date), 'run', title, meters, Math.round((meters / 1000) * pace + 60), Math.round((meters / 1000) * pace), 40 + (n % 7) * 12, hr, hr + 18, 168, pace, type === 'easy' ? 3 : 6, type === 'long' ? 'Legs got heavy near the end but fine.' : null, JSON.stringify([{ distance_m: 1000, duration_s: pace, avg_hr: hr }]), JSON.stringify({ z2_s: 1800 }), id, 'screenshot', '[]', 'athlete', 0.95, 1, null, stamp, stamp);
      }
    }
  }
  // an unplanned jog
  act.run('act_extra', iso('2026-09-25', '18:05:00'), 'run', 'Evening jog', 5000, 1800, 1780, 20, 138, 150, 166, 360, 2, 'Easy evening shake-out.', null, null, null, 'manual', '[]', 'athlete', 1, 1, null, stamp, stamp);

  const race = db.prepare('INSERT INTO races (id, date, name, distance_m, priority, goal, result, notes) VALUES (?,?,?,?,?,?,?,?)');
  race.run('race_half', '2026-12-06', 'City Half Marathon', 21097.5, 'A', JSON.stringify({ time_s: 6300 }), null, 'Flat and fast. Target 1:45.');
  race.run('race_10k', '2026-05-10', 'Spring 10K', 10000, 'B', null, JSON.stringify({ time_s: 2820, place: 41 }), 'First race back.');

  const chk = db.prepare('INSERT INTO checkins (id, at, kind, value, source, ref_event) VALUES (?,?,?,?,?,?)');
  chk.run('chk_1', '2026-10-04T20:00:00+02:00', 'sleep', '{"score":3}', 'form', null);
  chk.run('chk_2', '2026-10-05T07:00:00+02:00', 'energy', '{"score":4}', 'view', null);
  chk.run('chk_3', '2026-10-05T07:00:00+02:00', 'pain', '{"region":"left_achilles","severity":3,"behavior":"warms up"}', 'view', null);

  const metric = db.prepare('INSERT INTO metrics (date, name, value, unit, source, source_refs) VALUES (?,?,?,?,?,?)');
  for (const [d, v] of [['2026-09-20', 52], ['2026-09-27', 51], ['2026-10-04', 50]] as const) metric.run(d, 'resting_hr', v, 'bpm', 'screenshot', '[]');

  const gear = db.prepare('INSERT INTO gear (id, name, kind, started_at, retired_at, distance_offset_m, notes) VALUES (?,?,?,?,?,?,?)');
  gear.run('gear_1', 'Daily trainers', 'shoe', '2026-06-01', null, 120000, null);
  gear.run('gear_2', 'Race flats', 'shoe', '2026-04-01', null, 30000, 'Races and intervals only');
}
