import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelProvider } from '@opencoach/protocol';
import { createAnthropicProvider, createOpenAIProvider, createCompatibleProvider } from '@opencoach/engine';
import { runScenario, type RunScenarioOptions } from './runner';
import { loadScenario, type TraceBundle } from './scenarios';
import { cohortScenarios, fixtureScenarios, getSuite } from './suites';
import { assessConformance, runProviderConformanceProbes } from './conformance';
import { writeViewer } from './viewer';
import { gradeJudges } from './judges';
import { createPlaywrightRenderer } from '@opencoach/ui-kit';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
function argument(args: string[], flag: string, fallback?: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`${flag} requires a value`);
  return args[i + 1];
}
/** Provider for a `provider:model` family, using that provider's key from the environment. */
function providerFor(family: string | undefined): ModelProvider | undefined {
  const env = process.env;
  if (family === 'openai' && env.OPENAI_API_KEY) return createOpenAIProvider({ apiKey: env.OPENAI_API_KEY });
  if (family === 'anthropic' && env.ANTHROPIC_API_KEY) return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY });
  if (family === 'deepseek' && env.DEEPSEEK_API_KEY) return createCompatibleProvider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY, vision: false, contextTokens: 128000, maxOutputTokens: 8192, replayReasoningContent: true });
  if (family === 'opencode-go' && env.OPENCODE_GO_API_KEY) return createCompatibleProvider({ id: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: env.OPENCODE_GO_API_KEY, vision: false, contextTokens: 128000, maxOutputTokens: 16384, replayReasoningContent: true, thinking: true, reasoningEfforts: ['low', 'high', 'max'], sessionHeader: 'x-opencode-session' });
  return undefined;
}
const PROVIDERS = 'openai|anthropic|deepseek|opencode-go';

export async function selftest(outDir: string): Promise<void> {
  const successes: TraceBundle[] = [];
  for (const scenario of fixtureScenarios) {
    const trace = await runScenario(scenario, { model: 'reference', traceDir: join(outDir, 'reference', scenario.id) });
    successes.push(trace);
    const failures = trace.graders.filter(g => g.gate && g.status !== 'pass');
    if (failures.length) throw new Error(`Positive control ${scenario.id} failed: ${JSON.stringify(failures)}`);
    process.stdout.write(`PASS reference ${scenario.id}\n`);
  }
  for (const id of ['acute-chest-pain', 'supportive-ed-response', 'crisis-response', 'unsafe-pressure', 'uploaded-instruction', 'delayed-memory']) {
    const scenario = fixtureScenarios.find(s => s.id === id)!;
    const trace = await runScenario(scenario, { model: 'bad', traceDir: join(outDir, 'bad', scenario.id) });
    if (!trace.graders.some(g => g.gate && g.status === 'fail')) throw new Error(`Negative control ${id} was not rejected`);
    process.stdout.write(`PASS rejected bad ${scenario.id}\n`);
  }
  await writeViewer(successes, join(outDir, 'viewer.html'));
  process.stdout.write('Offline eval self-test passed against production runtime; no model API calls.\n');
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const flags = new Set(['--selftest', '--view', '--out', '--model', '--suite', '--judge', '--scenario', '--seeds', '--constitution', '--chromium', '--provider']);
  for (const arg of args.filter(a => a.startsWith('--'))) if (!flags.has(arg)) throw new Error(`Unknown option ${arg}`);
  const outDir = resolve(repo, argument(args, '--out', 'evals/runs/latest')!);
  await mkdir(outDir, { recursive: true });
  if (args.includes('--selftest')) { await selftest(outDir); return 0; }
  if (args.includes('--view')) {
    const valueFlags = new Set([...flags].filter(f => f !== '--view' && f !== '--selftest'));
    const paths = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1] ?? ''));
    const traces = await Promise.all(paths.map(async path => JSON.parse(await readFile(resolve(repo, path), 'utf8')) as TraceBundle));
    await writeViewer(traces, join(outDir, 'viewer.html')); return 0;
  }
  const modeArg = argument(args, '--model', 'reference')!;
  const [family, ...modelParts] = modeArg.split(':');
  const coachFamily = family;
  const mode = modelParts.length ? modelParts.join(':') : modeArg;
  let model: RunScenarioOptions['model'];
  if (mode === 'reference' || mode === 'bad') model = mode;
  else {
    const provider = argument(args, '--provider', modelParts.length ? family : undefined);
    const instance = providerFor(provider);
    if (!instance) throw new Error(`Real model runs require --provider ${PROVIDERS} and that provider’s API key`);
    model = { provider: instance, model: mode };
  }
  const suite = argument(args, '--suite', 'fast')!;
  const judgeArg = argument(args, '--judge');
  const judge = judgeArg ? (() => {
    const [family, ...parts] = judgeArg.split(':');
    const name = parts.join(':');
    if (!name) throw new Error('--judge must be provider:model');
    const provider = providerFor(family);
    if (!provider) throw new Error(`--judge requires one of ${PROVIDERS} and its API key`);
    return { provider, model: name, judgeFamily: family, coachFamily };
  })() : undefined;
  const path = argument(args, '--scenario');
  const scenarios = path ? [await loadScenario(resolve(repo, path))] : suite === 'cohort' ? await cohortScenarios(join(repo, 'evals/personas')) : getSuite(suite);
  const seeds = Number(argument(args, '--seeds', '1'));
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 100) throw new Error('--seeds must be an integer from 1 to 100');
  const constitutionPath = argument(args, '--constitution');
  const constitution = constitutionPath ? await readFile(resolve(repo, constitutionPath), 'utf8') : undefined;
  const traces: TraceBundle[] = [];
  for (const scenario of scenarios) for (let seed = 1; seed <= seeds; seed++) {
    const observeViews = scenario.assertions.some(a => a.kind === 'view');
    const rendererFactory: RunScenarioOptions['rendererFactory'] = scenario.suite === 'ui-agency' || observeViews
      ? clock => createPlaywrightRenderer({ clock, executablePath: argument(args, '--chromium') }) : undefined;
    const trace = await runScenario(scenario, { model, constitution, seed, rendererFactory, observeViews, traceDir: join(outDir, `${scenario.id}-${seed}`), executablePath: argument(args, '--chromium') });
    if (judge) {
      const images = await Promise.all(trace.screenshots.map(async path => ({ mediaType: 'image/png' as const, data: (await readFile(path)).toString('base64'), ref: path })));
      const results = await gradeJudges(trace, { ...judge, images });
      trace.graders = trace.graders.map(g => results.find(r => r.id === g.id) ?? g);
      await writeFile(join(outDir, `${scenario.id}-${seed}`, 'trace.json'), JSON.stringify(trace, null, 2));
    }
    traces.push(trace);
    process.stdout.write(`${scenario.id} seed=${seed}: ${trace.graders.filter(g => g.status === 'pass').length}/${trace.graders.length} pass\n`);
  }
  await writeViewer(traces, join(outDir, 'viewer.html'));
  const compatibility = suite === 'conformance' ? assessConformance(traces, typeof model === 'object' ? await runProviderConformanceProbes(model.provider, model.model) : []) : undefined;
  if (compatibility) await writeFile(join(outDir, 'compatibility.json'), JSON.stringify(compatibility, null, 2));
  const gateFailures = traces.flatMap(t => t.graders.filter(g => g.gate && g.status !== 'pass').map(g => ({ scenario: t.scenario.id, seed: t.seed, ...g })));
  const counts = { pass: 0, fail: 0, not_run: 0 };
  for (const trace of traces) for (const grade of trace.graders) counts[grade.status]++;
  await writeFile(join(outDir, 'summary.json'), JSON.stringify({ runs: traces.length, counts, gateFailures, compatibility: compatibility?.status, costUsd: traces.reduce((n, t) => n + t.metrics.costUsd, 0) }, null, 2));
  return gateFailures.length || (compatibility && compatibility.status !== 'pass') ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
}
