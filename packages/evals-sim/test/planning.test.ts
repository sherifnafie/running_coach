import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenario } from '../src/runner';
import { planningScenarios } from '../src/planning-scenarios';
import { getSuite } from '../src/suites';

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
});
