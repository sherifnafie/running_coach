import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { Persona, type Persona as PersonaType } from './personas';

const At = z.string().min(1);
export const ScenarioAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), at: At, text: z.string().max(20_000) }),
  z.object({ type: z.literal('disclose'), at: At, factId: z.string() }),
  z.object({ type: z.literal('probe'), at: At, text: z.string(), factId: z.string() }),
  z.object({ type: z.literal('settings'), at: At, patch: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('device'), at: At, tz: z.string() }),
  z.object({ type: z.literal('wait'), at: At }),
  z.object({ type: z.literal('swap'), at: At, model: z.string().min(1) }),
  z.object({ type: z.literal('session'), at: At, session: z.object({ type: z.enum(['easy', 'recovery', 'long', 'tempo', 'intervals', 'hills', 'race', 'strength', 'cross', 'rest', 'other']), durationMin: z.number().positive(), rpe: z.number().min(1).max(10), distanceKm: z.number().positive().optional() }), artifact: z.enum(['gpx', 'png']).default('gpx'), injection: z.string().optional() }),
]);
export type ScenarioAction = z.infer<typeof ScenarioAction>;

export const Assertion = z.object({
  id: z.string().min(1),
  requirement: z.string().min(1),
  kind: z.enum(['reply', 'red_flag', 'eating_disorder', 'crisis', 'unsafe_refusal', 'memory', 'injection', 'quiet_hours', 'proactivity', 'extraction', 'plan', 'integrity', 'schedule', 'db', 'judge']),
  action: z.number().int().nonnegative().optional(),
  gate: z.boolean().default(true),
  acute: z.boolean().default(false),
  expected: z.string().optional(),
  forbidden: z.array(z.string()).default([]),
  table: z.string().optional(),
  column: z.string().optional(),
  artifactIndex: z.number().int().nonnegative().optional(),
  rubric: z.string().optional(),
});
export type Assertion = z.infer<typeof Assertion>;
export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().default(''),
  suite: z.string().default('focused'),
  persona: z.union([z.string().min(1), Persona]),
  personaOverrides: z.record(z.string(), z.unknown()).optional(),
  start: z.string().default('2026-10-07T08:00:00Z'),
  end: z.string().optional(),
  initialFiles: z.record(z.string(), z.string()).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
  timeline: z.array(ScenarioAction),
  assertions: z.array(Assertion).min(1),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;
export async function loadScenario(path: string): Promise<Scenario> { return Scenario.parse(parse(await readFile(path, 'utf8'))); }
export interface GraderResult { id: string; requirement: string; gate: boolean; status: 'pass' | 'fail' | 'not_run'; score: number | null; evidence: string[]; }
export interface ActionRecord { index: number; at: string; eventId?: string; disclosedFactId?: string; }
export interface FactDisclosure { factId: string; value: string; at: string; eventId: string; }
export interface Ledger { persona: PersonaType; disclosures: FactDisclosure[]; activities: import('./types').TrueActivity[]; symptoms: Array<{ at: string; symptoms: string[] }>; artifacts: Array<{ path: string; truth: import('./types').ArtifactTruth; eventId: string }>; }
export interface TraceBundle {
  schemaVersion: 1;
  scenario: Scenario;
  seed: number;
  model: string;
  startedAt: string;
  endedAt: string;
  athleteId: string;
  events: import('@opencoach/protocol').AnyEvent[];
  stream: import('@opencoach/protocol').StreamMessage[];
  actions: ActionRecord[];
  ledger: Ledger;
  snapshots: Array<{ at: string; action: number; db: import('./types').DbSnapshot; schemaDocs: string; schemaSql: string }>;
  changes: import('@opencoach/protocol').ChangeEntry[];
  screenshots: string[];
  toolCalls: Array<{ turnId?: string; name: string; input: unknown; valid: boolean }>;
  metrics: { costUsd: number; inputTokens: number; cachedTokens: number; cacheHitRate: number | null; athleteWeeks: number; costPerAthleteWeek: number | null; turnDurationsMs: number[] };
  capabilities: { sandboxKind: string; sandboxIsolated: boolean; sandboxClock: 'unverified' | 'verified'; visualRenderer: boolean };
  graders: GraderResult[];
}
