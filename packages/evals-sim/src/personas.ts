import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { isValidZone, WEEKDAYS } from './util/dates';

/**
 * Persona (Appendix E §E.2 component 1): everything the simulated athlete "is". YAML on disk
 * (evals/personas/*.yaml), validated with zod. The persona never talks to the coach directly: the
 * AthleteAgent turns it (plus the hidden physiological state) into messages and uploads.
 */

export const Weekday = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof Weekday>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const IanaTz = z.string().refine((s) => isValidZone(s), 'unknown IANA time zone');

export const PersonaProfile = z.object({
  name: z.string().min(1),
  age: z.number().int().min(18).max(100),
  sex: z.enum(['female', 'male', 'other']).optional(),
  tz: IanaTz,
  locale: z.string().default('en'),
  units: z.enum(['metric', 'imperial']).default('metric'),
  heightCm: z.number().optional(),
  weightKg: z.number().optional(),
  /** Rough home location (for synthetic GPS tracks). */
  home: z.object({ lat: z.number(), lon: z.number() }).optional(),
});
export type PersonaProfile = z.infer<typeof PersonaProfile>;

export const InjuryHistory = z.object({
  /** BodyRegion id, e.g. "left_achilles" (protocol/microui BODY_REGIONS). */
  location: z.string(),
  year: z.number().int().optional(),
  status: z.enum(['past', 'recovering', 'chronic']).default('past'),
  notes: z.string().optional(),
});
export type InjuryHistory = z.infer<typeof InjuryHistory>;

export const RunningHistory = z.object({
  yearsRunning: z.number().min(0),
  /** Typical weekly volume before the scenario starts. */
  weeklyKm: z.number().min(0),
  runsPerWeek: z.number().min(0).max(7),
  longestRunKm: z.number().min(0),
  injuries: z.array(InjuryHistory).default([]),
  recentRaces: z.array(z.object({ name: z.string(), distanceKm: z.number(), time: z.string(), date: z.string().optional() })).default([]),
  notes: z.string().default(''),
});
export type RunningHistory = z.infer<typeof RunningHistory>;

export const Goal = z.object({
  race: z.string(),
  distanceKm: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  target: z.string().optional(),
  priority: z.enum(['A', 'B', 'C']).default('A'),
});
export type Goal = z.infer<typeof Goal>;

/** Hard constraints beyond the allowed weekday list. */
export const Constraint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never_weekday'), weekday: Weekday, reason: z.string().optional() }),
  z.object({ kind: z.literal('max_session_min'), minutes: z.number().positive(), reason: z.string().optional() }),
  z.object({ kind: z.literal('not_before'), time: HHMM, reason: z.string().optional() }),
  z.object({ kind: z.literal('not_after'), time: HHMM, reason: z.string().optional() }),
]);
export type Constraint = z.infer<typeof Constraint>;

export const Availability = z.object({
  /** Weekdays the athlete can run (anything else is an unavailable day: planning a session there is a violation). */
  days: z.array(Weekday).min(1),
  preferredTimes: z.object({ weekday: HHMM.default('18:30'), weekend: HHMM.default('08:30') }).prefault({}),
  constraints: z.array(Constraint).default([]),
});
export type Availability = z.infer<typeof Availability>;

export const AppId = z.enum(['samsung_health', 'garmin', 'strava', 'apple', 'none']);
export type AppId = z.infer<typeof AppId>;

export const Devices = z.object({
  hasHr: z.boolean(),
  app: AppId,
  watch: z.string().optional(),
  hasCadence: z.boolean().optional(),
  screenshotTheme: z.enum(['light', 'dark']).default('light'),
});
export type Devices = z.infer<typeof Devices>;

export const Communication = z.object({
  style: z.enum(['terse', 'chatty']).default('terse'),
  emoji: z.enum(['none', 'some', 'lots']).default('some'),
  language: z.string().default('en'),
  /** Reply latency to a coach message, minutes (log-normal: median / p90). */
  replyLatencyMin: z.object({ median: z.number().positive(), p90: z.number().positive() }).default({ median: 20, p90: 180 }),
  /** The athlete only reads/replies inside this local window. */
  activeHours: z.object({ start: HHMM, end: HHMM }).default({ start: '07:00', end: '22:30' }),
  /** Applied to the athlete's notification settings at account creation. */
  quietHours: z.object({ start: HHMM, end: HHMM }).nullable().default({ start: '22:00', end: '07:00' }),
  /** Acceptable number of proactive coach messages per week (annoyance/ghosting reference). */
  proactivePerWeek: z.object({ min: z.number().min(0), max: z.number().min(0) }).default({ min: 3, max: 10 }),
});
export type Communication = z.infer<typeof Communication>;

export const HiddenFact = z.object({
  id: z.string(),
  category: z.enum(['pb', 'injury', 'schedule', 'health', 'preference', 'other']).default('other'),
  /** What the athlete says when volunteering the fact (disclosure events). */
  statement: z.string(),
  /** What the athlete says when asked directly. */
  answer: z.string(),
  /** Case-insensitive regexes over coach messages that count as "asking" for it. */
  askedPatterns: z.array(z.string()).default([]),
  /** Canonical value graders look for in a recall (e.g. "52:30"). */
  value: z.string(),
  /** Alternative acceptable renderings (regex strings). */
  accept: z.array(z.string()).default([]),
});
export type HiddenFact = z.infer<typeof HiddenFact>;

export const LifeEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('illness'),
    startDay: z.number().int().min(0),
    days: z.number().int().min(1),
    symptoms: z.array(z.string()).default(['sore throat', 'congested']),
    fever: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('travel'),
    startDay: z.number().int().min(0),
    days: z.number().int().min(1),
    tz: IanaTz,
    destination: z.string().optional(),
  }),
  z.object({
    type: z.literal('work_crunch'),
    startDay: z.number().int().min(0),
    days: z.number().int().min(1),
    /** Max minutes the athlete can spare per day during the crunch. */
    maxSessionMin: z.number().positive().default(30),
  }),
  z.object({
    type: z.literal('poor_sleep'),
    startDay: z.number().int().min(0),
    days: z.number().int().min(1),
    hours: z.number().min(2).max(8).default(5),
  }),
]);
export type LifeEvent = z.infer<typeof LifeEvent>;

export const PhysiologyParams = z.object({
  /** Threshold pace (≈ 1 h race effort) in s/km at day 0. */
  thresholdPaceSecPerKm: z.number().min(150).max(600),
  hrMax: z.number().min(140).max(220).optional(),
  hrRest: z.number().min(35).max(90).optional(),
  /** Multiplier on injury-risk accumulation (1 = average). */
  injuryProneness: z.number().min(0.2).max(3).default(1),
  /** Where the pain storyline lands (BodyRegion id). */
  vulnerableRegion: z.string().default('right_knee'),
  terrain: z.enum(['flat', 'rolling', 'hilly', 'mountain']).default('rolling'),
});
export type PhysiologyParams = z.infer<typeof PhysiologyParams>;

export const Quirks = z.object({
  /** 0–1: probability of running harder/longer than prescribed. */
  pushesHarder: z.number().min(0).max(1).default(0),
  /** Wants to double mileage (unsafe-request persona). */
  wantsToDoubleMileage: z.boolean().default(false),
  /** Occasionally dropped into conversation (disordered-eating risk signals). */
  edSignals: z.array(z.string()).default([]),
  /** Skips rest days voluntarily (runs on days that were not planned). */
  extraRuns: z.number().min(0).max(1).default(0),
});
export type Quirks = z.infer<typeof Quirks>;

export const Persona = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().default(''),
  profile: PersonaProfile,
  history: RunningHistory,
  goals: z.array(Goal).default([]),
  availability: Availability,
  devices: Devices,
  communication: Communication.prefault({}),
  /** Probability (0–1) the athlete does the session the coach prescribed. */
  compliance: z.number().min(0).max(1),
  /** Probability (0–1) the athlete volunteers/admits pain when it exists. */
  painHonesty: z.number().min(0).max(1),
  tonePreference: z.enum(['gentle', 'neutral', 'tough_love']).default('neutral'),
  hidden: z.array(HiddenFact).default([]),
  timeline: z.array(LifeEvent).default([]),
  physiology: PhysiologyParams,
  quirks: Quirks.prefault({}),
});
export type Persona = z.infer<typeof Persona>;
export type PersonaInput = z.input<typeof Persona>;

export function parsePersona(raw: unknown, source = 'persona'): Persona {
  const r = Persona.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${source}: ${msg}`);
  }
  return r.data;
}

export async function loadPersona(path: string): Promise<Persona> {
  const text = await readFile(path, 'utf8');
  const p = parsePersona(parseYaml(text), path);
  const expected = basename(path, extname(path));
  if (p.id !== expected) throw new Error(`Persona id "${p.id}" must match its file name "${expected}" (${path})`);
  return p;
}

export async function loadPersonas(dir: string): Promise<Persona[]> {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  return Promise.all(files.map((f) => loadPersona(join(dir, f))));
}

/** Maximum heart rate default (Tanaka). */
export function defaultHrMax(p: Persona): number {
  return Math.round(p.physiology.hrMax ?? 208 - 0.7 * p.profile.age);
}

export function defaultHrRest(p: Persona): number {
  if (p.physiology.hrRest) return p.physiology.hrRest;
  const fit = Math.min(p.history.weeklyKm / 100, 0.6);
  return Math.round(68 - 18 * fit);
}

/** Weekday ids the athlete cannot run on (not in `days`, or hard-excluded). */
export function unavailableWeekdays(p: Persona): Weekday[] {
  const never = new Set(p.availability.constraints.filter((c) => c.kind === 'never_weekday').map((c) => (c as { weekday: Weekday }).weekday));
  return WEEKDAYS.filter((d) => !p.availability.days.includes(d) || never.has(d));
}

export function isAvailableWeekday(p: Persona, d: Weekday): boolean {
  return !unavailableWeekdays(p).includes(d);
}

/** Merge shallow overrides (scenario `personaOverrides`) over a loaded persona and re-validate. */
export function overridePersona(base: Persona, overrides: Record<string, unknown> | undefined): Persona {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const merged = deepMerge(structuredClone(base) as unknown as Record<string, unknown>, overrides);
  return parsePersona(merged, `${base.id} (with overrides)`);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isObj(prev) && isObj(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Directory holding the shipped personas (evals/personas relative to the repo root). */
export function defaultPersonaDir(repoRoot: string): string {
  return resolve(repoRoot, 'evals', 'personas');
}
