/**
 * Shared simulator types: ground truth (what really happened), the ledger graders read, and the
 * session vocabulary shared by physiology, athlete agents, graders and the reference coach.
 */

export type SessionType = 'easy' | 'recovery' | 'long' | 'tempo' | 'intervals' | 'hills' | 'race' | 'strength' | 'cross' | 'rest' | 'other';

/** Session types that count as "hard" (intensity) for plan checks and red-flag pauses. */
export const INTENSITY_TYPES: readonly SessionType[] = ['tempo', 'intervals', 'hills', 'race'];
export const KEY_SESSION_TYPES: readonly SessionType[] = ['long', 'tempo', 'intervals', 'hills', 'race'];
export const RUN_TYPES: readonly SessionType[] = ['easy', 'recovery', 'long', 'tempo', 'intervals', 'hills', 'race'];

export function isIntensity(t: string): boolean {
  return (INTENSITY_TYPES as readonly string[]).includes(t);
}
export function isRunType(t: string): boolean {
  return (RUN_TYPES as readonly string[]).includes(t);
}

/** A session the athlete intends to / is prescribed to run. */
export interface SessionSpec {
  type: SessionType;
  durationMin: number;
  /** Session RPE (1–10) the athlete will actually experience if run as planned. */
  rpe: number;
  distanceKm?: number;
}

export interface Split {
  /** 1-based index. */
  index: number;
  distanceM: number;
  durationS: number;
  paceSecPerKm: number;
  avgHr: number | null;
  elevGainM: number;
}

export interface HrPoint {
  tS: number;
  hr: number;
}

export interface RoutePoint {
  tS: number;
  lat: number;
  lon: number;
  eleM: number;
  distM: number;
  hr: number | null;
  cadence: number | null;
}

/** The true, complete record of one run (before any app decides what to display). */
export interface TrueActivity {
  id: string;
  /** ISO 8601 with the athlete's UTC offset at the time. */
  startedAt: string;
  tz: string;
  sport: 'run';
  title: string;
  plannedType: SessionType;
  distanceM: number;
  durationS: number;
  movingS: number;
  elevGainM: number;
  avgPaceSecPerKm: number;
  avgHr: number | null;
  maxHr: number | null;
  avgCadenceSpm: number | null;
  rpe: number;
  splits: Split[];
  hrSeries: HrPoint[] | null;
  /** Seconds in HR zones 1..5 (null when no HR). */
  hrZonesS: [number, number, number, number, number] | null;
  caloriesKcal: number;
  /** Whether the athlete ran while having pain (ground truth for provenance of "ran through pain"). */
  ranThroughPain: boolean;
  route?: RoutePoint[];
}

/** Fields an extraction can be graded on. */
export const EXTRACTION_FIELDS = [
  'started_at',
  'distance_m',
  'duration_s',
  'moving_s',
  'elev_gain_m',
  'avg_hr',
  'max_hr',
  'avg_cadence_spm',
  'avg_pace_s_km',
  'laps',
  'hr_zones',
] as const;
export type ExtractionField = (typeof EXTRACTION_FIELDS)[number];

export type ArtifactKind = 'summary' | 'splits' | 'hr_graph';
export type ArtifactFormat = 'png' | 'gpx' | 'tcx' | 'fit' | 'csv';

/** Ground truth for one synthetic artifact: exactly what a reader of it can learn. */
export interface ArtifactTruth {
  artifactId: string;
  format: ArtifactFormat;
  /** Screenshot screen type (png only). */
  kind?: ArtifactKind;
  app: string;
  theme?: 'light' | 'dark';
  units: 'metric' | 'imperial';
  locale: string;
  tz: string;
  /** True when a timezone/offset is visible in the artifact. */
  tzVisible: boolean;
  activityId: string;
  /** Fields visible in this artifact, normalised (meters, seconds, s/km, bpm, ISO local time). */
  visible: Partial<Record<ExtractionField, unknown>>;
  /** Fields of the activity that this artifact does NOT show. */
  notVisible: ExtractionField[];
  /** Values that are only approximate (read off a graph). */
  approximate: ExtractionField[];
  /** Planted prompt-injection text, if any. */
  injection?: { text: string; placement: string };
  /** Display strings for debugging (what the artifact literally says). */
  displayed: Record<string, string>;
}

/** Row shapes read back from coach.db for graders. */
export type DbRow = Record<string, unknown>;
export interface DbSnapshot {
  tables: Record<string, DbRow[]>;
}

export function tableRows(db: DbSnapshot | undefined, name: string): DbRow[] {
  return db?.tables[name] ?? [];
}
