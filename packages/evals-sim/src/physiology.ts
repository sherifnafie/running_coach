import type { LifeEvent, Persona } from './personas';
import { defaultHrMax, defaultHrRest } from './personas';
import type { SessionSpec, TrueActivity } from './types';
import { isoWithOffset } from './util/dates';
import { clamp, rngFor, round } from './util/rng';

/** Stylized simulation, deliberately not a clinical or training prescription model (E.2). */
export interface PhysiologyState {
  day: number;
  fitness: number;
  fatigue: number;
  injuryRisk: number;
  pain: number;
  readiness: number;
  recentLoads: number[];
}
export interface DailyCues {
  state: PhysiologyState;
  symptoms: string[];
  lifeEvents: LifeEvent[];
  tz: string;
}
export function initialState(): PhysiologyState {
  return { day: -1, fitness: 0, fatigue: 0, injuryRisk: 0, pain: 0, readiness: 1, recentLoads: [] };
}
export function lifeEventsOn(persona: Persona, day: number): LifeEvent[] {
  return persona.timeline.filter(e => day >= e.startDay && day < e.startDay + e.days);
}
/** One daily update: impulse-response time constants 42 d / 7 d, plus a load-spike storyline. */
export function stepPhysiology(persona: Persona, previous: PhysiologyState, day: number, session?: SessionSpec): DailyCues {
  if (day !== previous.day + 1) throw new Error('Physiology must advance one day at a time');
  if (session && (!Number.isFinite(session.durationMin) || session.durationMin < 0 || !Number.isFinite(session.rpe) || session.rpe < 1 || session.rpe > 10)) throw new Error('Invalid session load');
  const lifeEvents = lifeEventsOn(persona, day);
  const load = !session || session.type === 'rest' ? 0 : session.durationMin * session.rpe / 10;
  const baseline = Math.max(8, persona.history.weeklyKm * persona.physiology.thresholdPaceSecPerKm / 60 * 0.4 / 7);
  const recent = previous.recentLoads.length ? previous.recentLoads.reduce((a, b) => a + b, 0) / previous.recentLoads.length : baseline;
  const spike = Math.max(0, load / Math.max(baseline * 0.5, recent) - 1.8);
  const injuryRisk = clamp(previous.injuryRisk * 0.86 + spike * 0.23 * persona.physiology.injuryProneness + (previous.pain > 0 && load > 0 ? 0.16 : 0), 0, 3);
  const pain = clamp(previous.pain + (injuryRisk > 0.8 ? 0.7 : load === 0 ? -0.5 : -0.12), 0, 10);
  const fitness = previous.fitness * Math.exp(-1 / 42) + load / 42;
  const fatigue = previous.fatigue * Math.exp(-1 / 7) + load / 7;
  const stress = lifeEvents.reduce((n, e) => n + (e.type === 'illness' ? e.fever ? 0.45 : 0.25 : e.type === 'poor_sleep' ? 0.18 : 0.05), 0);
  const readiness = clamp(1 + fitness * 0.006 - fatigue * 0.012 - stress - pain * 0.03, 0.2, 1.15);
  const symptoms: string[] = [];
  if (readiness < 0.7) symptoms.push('legs feel heavy');
  if (pain > 0) symptoms.push(`${persona.physiology.vulnerableRegion.replaceAll('_', ' ')} pain ${round(pain, 1)}/10`);
  for (const e of lifeEvents) {
    if (e.type === 'illness') symptoms.push(...e.symptoms, ...(e.fever ? ['fever'] : []));
    if (e.type === 'poor_sleep') symptoms.push(`slept ${e.hours} hours`);
    if (e.type === 'work_crunch') symptoms.push(`only ${e.maxSessionMin} minutes free`);
  }
  const travel = lifeEvents.find(e => e.type === 'travel');
  return { state: { day, fitness, fatigue, injuryRisk, pain, readiness, recentLoads: [...previous.recentLoads, load].slice(-28) }, symptoms, lifeEvents, tz: travel?.type === 'travel' ? travel.tz : persona.profile.tz };
}

export function generateActivity(persona: Persona, session: SessionSpec, cues: DailyCues, startedAt: Date | string, seed: number): TrueActivity {
  if (session.type === 'rest' || session.durationMin <= 0) throw new Error('Rest has no activity artifact');
  const rng = rngFor(seed, persona.id, cues.state.day, 'activity');
  const durationS = Math.round(session.durationMin * 60);
  const pace = persona.physiology.thresholdPaceSecPerKm * (1.48 - session.rpe * 0.055) / Math.max(0.65, cues.state.readiness) * rng.range(0.98, 1.02);
  const distanceM = Math.round(session.distanceKm ? session.distanceKm * 1000 : durationS / pace * 1000);
  if (distanceM <= 0) throw new Error('Activity distance must be positive');
  const avgPaceSecPerKm = durationS / distanceM * 1000;
  const avgHr = persona.devices.hasHr ? Math.round(defaultHrRest(persona) + (defaultHrMax(persona) - defaultHrRest(persona)) * clamp(0.36 + session.rpe * 0.052, 0, 0.98)) : null;
  const elevGainM = Math.round(distanceM * ({ flat: 0.002, rolling: 0.01, hilly: 0.025, mountain: 0.06 }[persona.physiology.terrain]));
  const splits = Array.from({ length: Math.ceil(distanceM / 1000) }, (_, i) => {
    const distance = Math.min(1000, distanceM - i * 1000);
    return { index: i + 1, distanceM: distance, durationS: round(durationS * distance / distanceM, 2), paceSecPerKm: avgPaceSecPerKm, avgHr, elevGainM: round(elevGainM * distance / distanceM, 1) };
  });
  const home = persona.profile.home ?? { lat: 52, lon: 5 };
  const route = Array.from({ length: Math.ceil(durationS / 30) + 1 }, (_, i) => {
    const tS = Math.min(i * 30, durationS);
    const distM = distanceM * tS / durationS;
    return { tS, distM, lat: home.lat + distM / 111_320, lon: home.lon, eleM: round(elevGainM * tS / durationS, 1), hr: avgHr === null ? null : Math.round(avgHr + Math.sin(i / 5) * 3), cadence: persona.devices.hasCadence ? 170 + rng.int(-4, 4) : null };
  });
  const hrZonesS: [number, number, number, number, number] | null = avgHr === null ? null : [0, 0, 0, 0, 0];
  if (hrZonesS) hrZonesS[clamp(Math.floor(session.rpe / 2), 0, 4)] = durationS;
  return { id: `sim-${persona.id}-${cues.state.day}`, startedAt: isoWithOffset(startedAt, cues.tz), tz: cues.tz, sport: 'run', title: `${session.type} run`, plannedType: session.type, distanceM, durationS, movingS: durationS, elevGainM, avgPaceSecPerKm, avgHr, maxHr: avgHr === null ? null : avgHr + 3, avgCadenceSpm: persona.devices.hasCadence ? 170 : null, rpe: session.rpe, splits, hrSeries: avgHr === null ? null : route.map(p => ({ tS: p.tS, hr: p.hr! })), hrZonesS, caloriesKcal: Math.round((persona.profile.weightKg ?? 70) * distanceM / 1000), ranThroughPain: cues.state.pain > 0, route };
}
