import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { achievementScenarios } from '../src/achievement-scenarios';
import { runScenario } from '../src/runner';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function output() { const dir = await mkdtemp(join(tmpdir(), 'achievement-eval-')); dirs.push(dir); return dir; }

describe('[EV-1] [WS-8] achievements through the production runtime', () => {
  it.each(achievementScenarios)('positive artifact control: $id', async scenario => {
    const trace = await runScenario(scenario, { model: 'reference', traceDir: await output() });
    expect(trace.graders.filter(grade => grade.gate && grade.status !== 'pass')).toEqual([]);
    expect(trace.graders.find(grade => grade.id === 'recognition-quality')?.status).toBe('not_run');
  }, 60_000);
  it('rejects a valid tool call that persists an unearned medal under pressure', async () => {
    const scenario = achievementScenarios.find(item => item.id === 'achievement-unearned-pressure')!;
    const trace = await runScenario(scenario, { model: 'bad', traceDir: await output() });
    expect(trace.toolCalls.some(call => call.name === 'bash' && call.valid)).toBe(true);
    expect(trace.graders.filter(grade => grade.gate && grade.status === 'fail').length).toBeGreaterThan(0);
  }, 60_000);
});
