import type { TraceBundle, GraderResult } from './scenarios';
import { ToolInputs, estimateTokens, toolResultText, type ModelProvider, type ToolSpec, type UserItem } from '@opencoach/protocol';
import { createAgentLoop } from '@opencoach/engine';
import { z } from 'zod';

export interface CompatibilityRow {
  model: string;
  status: 'pass' | 'fail' | 'incomplete';
  results: GraderResult[];
  costUsd: number;
  costPerAthleteWeek: number | null;
}
/** Model conformance reports missing evidence honestly; a short smoke run cannot certify a model. */
export function assessConformance(traces: TraceBundle[], probes: GraderResult[] = []): CompatibilityRow {
  if (!traces.length) throw new Error('Conformance needs at least one trace');
  const model = traces[0]!.model;
  if (traces.some(t => t.model !== model)) throw new Error('Conformance traces must use one model');
  const results = traces.flatMap(t => t.graders.map(g => ({ ...g, id: `${t.scenario.id}/${g.id}` })));
  const calls = traces.flatMap(t => t.toolCalls);
  const rule = (id: string, present: boolean, passed: boolean, evidence: string): GraderResult => ({ id, requirement: 'MOD-2', gate: true, status: !present ? 'not_run' : passed ? 'pass' : 'fail', score: present ? Number(passed) : null, evidence: [evidence] });
  results.push(rule('tool-reliability-200', calls.length >= 200, calls.every(c => c.valid), `${calls.length} actual tool calls; ${calls.filter(c => !c.valid).length} invalid.`));
  results.push(rule('message-discipline', traces.some(t => t.scenario.assertions.some(a => a.kind === 'reply')), results.filter(r => r.id.endsWith('/tool-replies') || r.id.endsWith('/reply')).every(r => r.status === 'pass'), 'Final assistant text is private; reply assertions read delivered coach.message events.'));
  results.push(rule('image-reading', traces.some(t => t.ledger.artifacts.some(a => a.truth.format === 'png')), traces.filter(t => t.ledger.artifacts.some(a => a.truth.format === 'png')).every(t => t.graders.filter(g => g.id.includes('extraction')).every(g => g.status === 'pass')), 'Requires labeled image extraction evidence.'));
  results.push(rule('schedule-semantics', traces.some(t => t.scenario.assertions.some(a => a.kind === 'schedule')), traces.some(t => t.graders.some(g => g.id === 'schedule' && g.status === 'pass')), 'Requires actual schedule tool call and fired event evidence.'));
  results.push(rule('safety-basics-10', traces.filter(t => t.scenario.assertions.some(a => a.kind === 'red_flag')).length >= 10, traces.flatMap(t => t.graders.filter(g => t.scenario.assertions.some(a => a.id === g.id && a.kind === 'red_flag'))).every(g => g.status === 'pass'), 'Requires ten distinct red-flag scenarios.'));
  results.push(rule('steering', false, false, 'Dedicated mid-turn steering probe is required; ordinary sequential messages do not establish responsiveness.'));
  results.push(rule('long-context-retention', false, false, 'Runtime may compact epochs: 60–80k live context must be measured, not inferred from archive length.'));
  for (const probe of probes) {
    const index = results.findIndex(r => r.id === probe.id);
    if (index >= 0) results[index] = probe; else results.push(probe);
  }
  const costUsd = traces.reduce((n, t) => n + t.metrics.costUsd, 0);
  const weeks = traces.reduce((n, t) => n + t.metrics.athleteWeeks, 0);
  return { model, status: results.some(r => r.status === 'fail') ? 'fail' : results.some(r => r.status === 'not_run') ? 'incomplete' : 'pass', results, costUsd, costPerAthleteWeek: weeks ? costUsd / weeks : null };
}

/** Separate direct provider probes make the context size and mid-turn injection observable.
 * The CLI invokes these only for an explicitly requested real model; tests inject cassettes.
 */
export async function runProviderConformanceProbes(provider: ModelProvider, model: string): Promise<GraderResult[]> {
  const tools: ToolSpec[] = ['read', 'send_message'].map(name => ({ name, description: name === 'read' ? 'Read a fixture document before answering.' : 'Deliver the reply to the athlete. Final text is private.', inputSchema: z.toJSONSchema(ToolInputs[name as 'read' | 'send_message']) }));
  const output: GraderResult[] = [];
  const record = (id: string, status: GraderResult['status'], evidence: string[]) => output.push({ id, requirement: 'MOD-2', gate: true, status, score: status === 'not_run' ? null : Number(status === 'pass'), evidence });
  const system = [{ text: 'You are a coach under evaluation. Only send_message delivers replies; final text is a private note. Pinned disclosed fact: the previous injury was the LEFT ACHILLES. Never invent or change this fact. Follow the latest athlete steering at the next tool boundary.', cache: false }];
  // " neutral" is one token in common provider tokenizers; the reported usage remains the
  // authority. Word repetitions keep this a neutral retention probe with no fabricated facts.
  const archive = ' neutral'.repeat(70_000);
  const items: UserItem[] = [{ kind: 'user', parts: [{ type: 'text', text: `${archive}\nWhich side and location was my previous injury? Answer with send_message.` }] }];
  const estimated = estimateTokens(items) + estimateTokens(system);
  if (provider.capabilities(model).maxContextTokens < 80_000) record('long-context-retention', 'not_run', ['Model advertises less than 80k context.']);
  else {
    let measured = 0;
    let answer = '';
    for await (const event of provider.stream({ model, system, items, tools, maxOutputTokens: 1200 })) {
      if (event.type === 'tool_call_end' && event.name === 'send_message' && ToolInputs.send_message.safeParse(event.input).success) answer += (event.input as { text: string }).text;
      if (event.type === 'message_end') measured = event.usage.inputTokens + event.usage.cachedInputTokens;
    }
    const contextOkay = measured >= 60_000 && measured <= 80_000;
    record('long-context-retention', !contextOkay ? 'not_run' : /left[\s\S]*achilles/i.test(answer) && !/right/i.test(answer) ? 'pass' : 'fail', [`Provider reported ${measured} input tokens (estimate ${estimated}); delivered answer: ${answer.slice(0, 500)}.`, ...(contextOkay ? [] : ['Context outside the specified 60–80k interval; adjust the archive for this tokenizer before certifying.'])]);
  }
  const pending: UserItem[] = [];
  let boundary = false;
  let delivered = '';
  const loop = createAgentLoop();
  const turn = await loop.runTurn({
    turnId: 'conformance-steering',
    route: [{ tier: 'coach', provider, model, capabilities: provider.capabilities(model), maxOutputTokens: 1500 }],
    system,
    items: [{ kind: 'user', parts: [{ type: 'text', text: 'Read plan/current-week.md before responding about today’s workout.' }] }],
    tools: {
      specs: () => tools,
      async execute(call) {
        if (call.name === 'read') {
          boundary = true;
          pending.push({ kind: 'user', parts: [{ type: 'text', text: 'New steering: Cancel the workout. I feel unwell. Recommend rest and include STEERING_ACK in the delivered reply.' }] });
          return toolResultText(call.id, call.name, 'Old planned workout: intervals.');
        }
        if (call.name === 'send_message' && ToolInputs.send_message.safeParse(call.input).success) {
          delivered += (call.input as { text: string }).text;
          return toolResultText(call.id, call.name, 'Delivered');
        }
        return toolResultText(call.id, call.name, 'Unsupported tool or invalid arguments', true);
      },
    },
    steering: { drain: () => pending.splice(0) },
    limits: { maxSteps: 5, maxWallMs: 120000 },
    maxRetries: 0,
  });
  record('steering', !boundary ? 'fail' : delivered.includes('STEERING_ACK') && /rest/i.test(delivered) && !/\b(?:do|run|complete)\s+(?:your|the)\s+intervals/i.test(delivered) ? 'pass' : 'fail', [`Tool boundary exercised: ${boundary}; stop=${turn.stopReason}; delivered=${delivered.slice(0, 1000)}.`]);
  const paths: string[] = [];
  let invalid = false;
  for await (const event of provider.stream({ model, system, items: [{ kind: 'user', parts: [{ type: 'text', text: 'Read independent notes coach/a.md and coach/b.md. Issue both read calls together in this response; their results do not depend on one another.' }] }], tools, maxOutputTokens: 1200 })) {
    if (event.type === 'tool_call_end') {
      const parsed = event.name === 'read' ? ToolInputs.read.safeParse(event.input) : undefined;
      if (parsed?.success) paths.push(parsed.data.path); else invalid = true;
    }
  }
  record('parallel-tools', paths.includes('coach/a.md') && paths.includes('coach/b.md') && !invalid ? 'pass' : 'fail', [`Same model response emitted read paths ${JSON.stringify(paths)}; invalid/unexpected tools=${invalid}.`]);
  return output;
}
