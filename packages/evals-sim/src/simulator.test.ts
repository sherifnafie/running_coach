import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createScriptedProvider } from '@opencoach/engine';
import { loadPersona, loadPersonas } from './personas';
import { generateActivity, initialState, stepPhysiology } from './physiology';
import { generateGpx, renderScreenshot, screenshotTemplate } from './artifacts';
import { createModelAthlete } from './athletes';
import { fixtureScenarios, focusedSuites, getSuite } from './suites';
import { runScenario } from './runner';
import { gradeTrace } from './graders';
import { assessConformance, runProviderConformanceProbes } from './conformance';
import { parseStart, localParts } from './util/dates';
import { writeViewer } from './viewer';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const dirs: string[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'eval-check-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('[EV-1] seeded physiology and truthful artifacts', () => {
  it('ships at least ten distinct personas and derives local dates across DST', async () => {
    const personas = await loadPersonas(join(repo, 'evals/personas'));
    expect(personas.length).toBeGreaterThanOrEqual(10);
    expect(new Set(personas.map(p => p.id)).size).toBe(personas.length);
    expect(parseStart('2026-10-25 09:00', 'Europe/Amsterdam').toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(localParts('2026-10-24T23:30:00Z', 'Europe/Amsterdam').date).toBe('2026-10-25');
  });
  it('decays fatigue faster than fitness and a sharp spike creates a pain storyline', async () => {
    const p = await loadPersona(join(repo, 'evals/personas/no-hr-runner.yaml'));
    const a = stepPhysiology(p, initialState(), 0, { type: 'easy', durationMin: 30, rpe: 3 });
    const b = stepPhysiology(p, a.state, 1);
    expect(b.state.fatigue / a.state.fatigue).toBeLessThan(b.state.fitness / a.state.fitness);
    const spike = stepPhysiology(p, initialState(), 0, { type: 'long', durationMin: 180, rpe: 10 });
    expect(spike.state.injuryRisk).toBeGreaterThan(a.state.injuryRisk);
    expect(spike.symptoms.some(s => s.includes('pain'))).toBe(true);
    expect(() => stepPhysiology(p, b.state, 9)).toThrow('one day');
  });
  it('has deterministic generation and never labels absent heart rate as visible', async () => {
    const p = await loadPersona(join(repo, 'evals/personas/no-hr-runner.yaml'));
    const session = { type: 'easy' as const, durationMin: 30, rpe: 3 };
    const cues = stepPhysiology(p, initialState(), 0, session);
    const activity = generateActivity(p, session, cues, '2026-10-07T10:00:00Z', 42);
    expect(generateActivity(p, session, cues, '2026-10-07T10:00:00Z', 42)).toEqual(activity);
    const screenshot = screenshotTemplate(activity, { units: 'imperial', locale: 'de-DE', injection: '<script>bad()</script>' });
    expect(screenshot.truth.visible.avg_hr).toBeUndefined();
    expect(screenshot.truth.notVisible).toContain('avg_hr');
    expect(screenshot.html).not.toContain('<script>bad()</script>');
    const gpx = generateGpx(activity);
    expect(new TextDecoder().decode(gpx.bytes)).toContain('http://www.topografix.com/GPX/1/1');
    expect(gpx.truth.visible.distance_m).toBeGreaterThan(0);
    expect(gpx.truth.visible.moving_s).toBeUndefined();
    const image = await renderScreenshot(activity, await temporary());
    expect((await readFile(image.path)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
  it('optional LLM athlete uses an explicit cassette provider and validates disclosures', async () => {
    const p = await loadPersona(join(repo, 'evals/personas/no-hr-runner.yaml'));
    const provider = createScriptedProvider({ handler: [{ text: '{"run":false,"text":"Rest today","disclose":[]}' }] });
    const actor = createModelAthlete(p, 1, provider, 'cassette');
    expect(await actor.decide(0, stepPhysiology(p, initialState(), 0), [])).toEqual({ run: false, text: 'Rest today', disclose: [] });
    expect(provider.requests).toHaveLength(1);
  });
});

describe('[EV-1] runtime-backed positive and negative controls', () => {
  it('passes acute red flags and rejects an unsafe coach using observed replies', async () => {
    const scenario = fixtureScenarios.find(s => s.id === 'acute-chest-pain')!;
    const positive = await runScenario(scenario, { traceDir: await temporary() });
    const negative = await runScenario(scenario, { model: 'bad', traceDir: await temporary() });
    expect(positive.graders[0]!.status).toBe('pass');
    expect(negative.graders[0]!.status).toBe('fail');
    expect(positive.toolCalls.some(t => t.name === 'schedule')).toBe(true);
    expect(assessConformance([positive]).status).toBe('incomplete');
    const viewer = join(await temporary(), 'viewer.html');
    await writeViewer([positive, negative], viewer);
    const html = await readFile(viewer, 'utf8');
    expect(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!)).not.toThrow();
  });
  it('escalates swollen-calf and indirect suicidal wording from the full gate catalog', async () => {
    for (const scenario of [focusedSuites['red-flags']!.find(s => s.id === 'red-flag-5-1')!, focusedSuites.crisis!.find(s => s.id === 'crisis-2-1')!]) {
      const trace = await runScenario(scenario, { traceDir: await temporary() });
      expect(trace.graders[0]!.status).toBe('pass');
    }
  });
  it('grades actual GPX imports and catches a fabricated field even when later corrected', async () => {
    const trace = await runScenario(fixtureScenarios.find(s => s.id === 'file-provenance')!, { traceDir: await temporary() });
    expect(trace.graders.map(g => g.status)).toEqual(['pass', 'pass']);
    expect(trace.snapshots[0]!.db.tables.activities![0]!.moving_s).toBeNull();
    trace.snapshots[0]!.db.tables.activities![0]!.moving_s = 12345;
    expect(gradeTrace(trace)[0]!.status).toBe('fail');
  });
  it('keeps hard availability constraints distinct from coach-rationale flags', async () => {
    const trace = await runScenario(fixtureScenarios.find(s => s.id === 'plan-availability')!, { traceDir: await temporary() });
    expect(trace.graders[0]!.status).toBe('pass');
    const row = trace.snapshots[0]!.db.tables.planned_workouts!.find(r => r.type !== 'rest')!;
    row.target_duration_s = 100000;
    expect(gradeTrace(trace)[0]!.status).toBe('fail');
  });
  it('versions focused suite coverage and excludes missing judge evidence from passes', () => {
    expect(focusedSuites['red-flags']).toHaveLength(56);
    expect(focusedSuites['ed-reds']).toHaveLength(15);
    expect(focusedSuites.crisis).toHaveLength(10);
    expect(focusedSuites.unsafe).toHaveLength(35);
    expect(focusedSuites.injection).toHaveLength(20);
    expect(focusedSuites.disciplines).toHaveLength(3);
    expect(getSuite('fast')).toHaveLength(25);
    expect(focusedSuites.unsafe!.every(s => s.timeline.length === 3)).toBe(true);
  });
  it('measures provider context and injects steering at an actual engine tool boundary', async () => {
    const provider = createScriptedProvider({ handler: [
      { toolCalls: [{ name: 'send_message', input: { text: 'Your left Achilles.' } }], usage: { inputTokens: 70_000 } },
      { toolCalls: [{ name: 'read', input: { path: 'plan/current-week.md' } }] },
      { toolCalls: [{ name: 'send_message', input: { text: 'STEERING_ACK. Rest today.' } }] },
      { text: 'Private note.' },
      { toolCalls: [{ name: 'read', input: { path: 'coach/a.md' } }, { name: 'read', input: { path: 'coach/b.md' } }] },
    ] });
    const results = await runProviderConformanceProbes(provider, 'cassette');
    expect(results.map(r => r.status)).toEqual(['pass', 'pass', 'pass']);
    expect(provider.requests[2]!.items.some(i => i.kind === 'user' && i.parts.some(p => p.type === 'text' && p.text.includes('New steering')))).toBe(true);
  });
});
