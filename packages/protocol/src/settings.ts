import { z } from 'zod';
import { Effort, IsoDateTime, LocalTime, Units } from './common';

/**
 * Per-athlete settings (harness-owned, athlete-configurable). SPEC §5.5, §13, §16.
 * `parseSettings` fills defaults so stored partial objects stay forward-compatible.
 */
export const QuietHours = z.object({ start: LocalTime, end: LocalTime });
export type QuietHours = z.infer<typeof QuietHours>;

export const TierOverride = z.object({ provider: z.string(), model: z.string(), effort: Effort.optional() });
export type TierOverride = z.infer<typeof TierOverride>;

export const AthleteSettings = z.object({
  profile: z
    .object({
      name: z.string().min(1).max(80).default('Athlete'),
      coachName: z.string().min(1).max(40).default('Coach'),
      locale: z.string().default('en'),
      tz: z.string().default('UTC'),
      units: Units.default('metric'),
    })
    .prefault({}),
  notifications: z
    .object({
      quietHours: QuietHours.nullable().default({ start: '22:00', end: '07:00' }),
      proactivePerDay: z.number().int().min(0).max(10).default(3),
      proactivePerWeek: z.number().int().min(0).max(50).default(12),
      minGapMinutes: z.number().int().min(0).max(720).default(120),
      pauseUntil: IsoDateTime.nullable().default(null),
      push: z.boolean().default(true),
    })
    .prefault({}),
  heartbeat: z
    .object({ enabled: z.boolean().default(true), time: LocalTime.default('07:30'), setBy: z.enum(['default', 'coach', 'athlete']).default('default') })
    .prefault({}),
  consolidation: z.object({ enabled: z.boolean().default(true), time: LocalTime.default('03:00') }).prefault({}),
  epoch: z.object({ dayBoundary: LocalTime.default('04:00') }).prefault({}),
  budgets: z
    .object({
      dailyUsd: z.number().min(0).default(2),
      monthlyUsd: z.number().min(0).default(30),
    })
    .prefault({}),
  /** Per-athlete tier overrides (self-host admin). Empty = deployment defaults. */
  models: z.object({ coach: TierOverride.optional(), deep: TierOverride.optional(), fast: TierOverride.optional() }).prefault({}),
  voice: z
    .object({
      callMode: z.enum(['realtime', 'cascaded']).default('realtime'),
      voice: z.string().default('alloy'),
      replyWithVoiceNotes: z.enum(['never', 'when_athlete_does', 'always']).default('when_athlete_does'),
    })
    .prefault({}),
  privacy: z
    .object({
      keepImageLocation: z.boolean().default(false),
      shareFeedbackWithDevelopers: z.boolean().default(false),
    })
    .prefault({}),
  consents: z
    .object({
      healthData: IsoDateTime.nullable().default(null),
      aiDisclosure: IsoDateTime.nullable().default(null),
      ageConfirmed18: IsoDateTime.nullable().default(null),
    })
    .prefault({}),
  /** Secret token for the ICS subscribe URL (SPEC §9.8); rotate to revoke. */
  calendarToken: z.string().nullable().default(null),
});
export type AthleteSettings = z.infer<typeof AthleteSettings>;
export type AthleteSettingsInput = z.input<typeof AthleteSettings>;

export function parseSettings(input: unknown): AthleteSettings {
  return AthleteSettings.parse(input ?? {});
}

export function defaultSettings(): AthleteSettings {
  return AthleteSettings.parse({});
}

/** Deep-merge a partial patch into settings (arrays/null replace). Returns new object + flat diff. */
export function mergeSettings(
  current: AthleteSettings,
  patch: unknown,
): { settings: AthleteSettings; diff: Record<string, { from: unknown; to: unknown }> } {
  const merged = deepMerge(current as unknown as Record<string, unknown>, (patch ?? {}) as Record<string, unknown>);
  const settings = AthleteSettings.parse(merged);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  flatDiff('', current, settings, diff);
  return { settings, diff };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

function flatDiff(prefix: string, a: unknown, b: unknown, out: Record<string, { from: unknown; to: unknown }>): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) flatDiff(prefix ? `${prefix}.${k}` : k, a[k], b[k], out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out[prefix] = { from: a, to: b };
}
