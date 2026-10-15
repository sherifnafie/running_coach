import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenario } from '../src/runner';
import { planningScenarios } from '../src/planning-scenarios';
import { getSuite } from '../src/suites';
import { planningQualityScenarios } from '../src/planning-quality-scenarios';
import { judgeEvidence } from '../src/judges';

const dirs: string[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'planning-eval-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('[EV-1] planning commitment evidence', () => {
  it('keeps sparse intake sparse and observes delivered screening across the conversation', async () => {
    const intake: string[] = [];
    const trace = await runScenario(planningScenarios[0]!, { traceDir: await temporary(), handler: req => {
      const last = req.items.at(-1);
      if (last?.kind !== 'tool_results') return { toolCalls: [{ name: 'read', input: { path: 'athlete/profile.md' } }] };
      if (last.results.some(result => result.name === 'send_message')) return { text: 'Waiting for intake.' };
      intake.push(JSON.stringify(last.results));
      return { toolCalls: [{ name: 'send_message', input: { text: 'What is comfortably manageable now, and any pain, illness or health constraints?' } }] };
    } });
    expect(intake.length).toBeGreaterThan(0);
    expect(intake.join('\n')).toContain('have not been provided');
    expect(intake.join('\n')).not.toContain('weeklyKm');
    expect(trace.graders.filter(result => result.gate && result.status !== 'pass')).toEqual([]);
    expect(trace.graders.find(result => result.id === 'commitment-quality')?.status).toBe('not_run');
  }, 60_000);

  it('does not count a delivered claim of completion as saved, reviewed planning evidence', async () => {
    expect(getSuite('planning')).toHaveLength(3);
    const trace = await runScenario(planningScenarios[2]!, { traceDir: await temporary(), handler: req => req.items.at(-1)?.kind === 'tool_results'
      ? { text: 'Done.' }
      : { toolCalls: [{ name: 'send_message', input: { text: 'Your checked four-week plan and review are ready.' } }] } });
    expect(trace.graders.find(result => result.id === 'delivered')?.status).toBe('pass');
    for (const id of ['requested-horizon', 'design-evidence', 'review-evidence']) expect(trace.graders.find(result => result.id === id)?.status).not.toBe('pass');
  }, 60_000);

  it('keeps substantive quality unverified when only replies and plan files exist', async () => {
    expect(getSuite('planning-quality')).toHaveLength(4);
    expect(planningQualityScenarios.every(s => s.assertions.some(a => a.kind === 'judge' && a.gate))).toBe(true);
    for (const scenario of planningQualityScenarios) expect(getSuite('gates').map(s => s.id)).toContain(scenario.id);
    expect(getSuite('fast').map(s => s.id)).toContain(planningQualityScenarios[0]!.id);
    const scenario = planningQualityScenarios[0]!;
    const trace = await runScenario(scenario, { traceDir: await temporary(), handler: req => req.items.at(-1)?.kind === 'tool_results'
      ? { text: 'Finished.' }
      : { toolCalls: [{ name: 'send_message', input: { text: 'The old plan is perfect; just trust it.' } }] } });
    expect(trace.graders.find(r => r.id === 'reply-0')?.status).toBe('pass');
    expect(trace.graders.find(r => r.id === 'saved-plan')?.status).toBe('pass');
    expect(trace.graders.find(r => r.id === 'goal-adequacy')).toMatchObject({ status: 'not_run', gate: true });
    const evidence = judgeEvidence(trace, scenario.assertions.find(a => a.kind === 'judge')!) as { scenario: { initialFiles: unknown } };
    expect(evidence.scenario.initialFiles).toEqual(scenario.initialFiles);
    // The later-update cases cross epochs and contain actual performance or an explicit lack of evidence.
    expect(planningQualityScenarios[2]!.timeline).toHaveLength(3);
    expect(planningQualityScenarios[3]!.timeline).toHaveLength(2);
  }, 60_000);
});
