import { mkdir, mkdtemp, readFile, readdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ServerConfig, ToolInputs, VirtualClock, settle, silentLogger, type ModelProvider, type SandboxProvider, type StreamMessage, type UiRenderer } from '@opencoach/protocol';
import { createAgentLoop, createModelRouter, createScriptedProvider, type ScriptHandler } from '@opencoach/engine';
import { createCoachRuntime, type CoachRuntime } from '@opencoach/runtime';
import { createLocalSandboxProvider } from '@opencoach/sandbox';
import { openSqliteStore } from '@opencoach/store';
import { createFsBlobStore } from '@opencoach/workspace';
import { createScriptedAthlete, type AthleteAgent } from './athletes';
import { generateGpx, renderScreenshot } from './artifacts';
import { gradeTrace } from './graders';
import { createBadCoach, createReferenceCoach } from './coaches';
import { loadPersona, overridePersona } from './personas';
import { generateActivity, initialState, stepPhysiology } from './physiology';
import { Scenario, type ScenarioInput, type TraceBundle } from './scenarios';
import { localDayDiff, parseStart } from './util/dates';
import type { DbSnapshot } from './types';
import { BrowserViewObserver } from './view-observer';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
export interface RunScenarioOptions {
  model?: 'reference' | 'bad' | { provider: ModelProvider; model: string };
  handler?: ScriptHandler;
  constitution?: string;
  seed?: number;
  repoRoot?: string;
  seedRoot?: string;
  traceDir?: string;
  sandbox?: SandboxProvider;
  renderer?: UiRenderer;
  /** Runner-owned renderer receives the same advancing clock as the runtime. */
  rendererFactory?: (clock: import('@opencoach/protocol').Clock) => UiRenderer;
  athlete?: AthleteAgent;
  executablePath?: string;
  observeViews?: boolean;
  /** Bounded live probes may tighten limits without changing production defaults. */
  limits?: Partial<import('@opencoach/protocol').ServerConfig['limits']>;
  swapModels?: Record<string, { provider: ModelProvider; model: string }>;
}

export function readDbSnapshot(path: string): { db: DbSnapshot; schemaSql: string } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
    const rows: DbSnapshot['tables'] = {};
    for (const table of tables) rows[table.name] = database.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all();
    return { db: { tables: rows }, schemaSql: tables.map(t => t.sql).join(';\n') };
  } finally { database.close(); }
}

/** Advance directly to real runtime schedules and virtual clock waiters, including quiet-hour release. */
export async function advanceRuntime(runtime: CoachRuntime, clock: VirtualClock, target: Date, athleteId: string): Promise<void> {
  if (!Number.isFinite(target.getTime()) || target.getTime() < clock.now().getTime()) throw new Error('Timeline cannot go backwards or use an invalid instant');
  for (let turns = 0; turns < 20_000; turns++) {
    const next = await runtime.core.store.nextScheduleAt();
    const wake = clock.nextWakeAt();
    const due = [next ? new Date(next).getTime() : Infinity, wake?.getTime() ?? Infinity].filter(t => t <= target.getTime());
    if (!due.length) break;
    await clock.advanceTo(Math.max(clock.now().getTime(), Math.min(...due)));
    await runtime.tickScheduler();
    await settle();
    await runtime.whenIdle(athleteId);
    if (turns === 19_999) throw new Error('Time machine exceeded wake limit');
  }
  await clock.advanceTo(target);
  await runtime.tickScheduler();
  await settle();
  await runtime.whenIdle(athleteId);
}

/** Same production runtime, store, workspace and scheduler. Scripted reference/bad models are fixtures. */
export async function runScenario(input: ScenarioInput, options: RunScenarioOptions = {}): Promise<TraceBundle> {
  const scenario = Scenario.parse(input);
  const repo = options.repoRoot ?? REPO;
  const personaPath = typeof scenario.persona === 'string' ? resolve(repo, 'evals/personas', `${scenario.persona}.yaml`) : undefined;
  if (personaPath && !personaPath.startsWith(resolve(repo, 'evals/personas') + sep)) throw new Error('Persona reference escapes persona directory');
  const persona = overridePersona(typeof scenario.persona === 'string' ? await loadPersona(personaPath!) : scenario.persona, scenario.personaOverrides);
  const seed = options.seed ?? 1;
  const clock = new VirtualClock(parseStart(scenario.start, persona.profile.tz));
  const traceDir = options.traceDir ? resolve(options.traceDir) : await mkdtemp(join(tmpdir(), 'opencoach-eval-'));
  await mkdir(traceDir, { recursive: true });
  const dataDir = join(traceDir, 'runtime');
  const store = await openSqliteStore({ path: join(traceDir, 'system.db'), clock });
  const blobs = createFsBlobStore({ dataDir, store, clock });
  const sandbox = options.sandbox ?? await createLocalSandboxProvider({ allowUnsafe: typeof options.model !== 'object' });
  let selected = typeof options.model === 'object' ? options.model : { provider: createScriptedProvider({ handler: options.handler ?? (options.model === 'bad' ? createBadCoach() : createReferenceCoach()), id: 'eval-scripted' }), model: options.model ?? 'reference' };
  const toolCalls: TraceBundle['toolCalls'] = [];
  const tracking: ModelProvider = {
    id: 'eval-model',
    capabilities: () => selected.provider.capabilities(selected.model),
    async *stream(request, signal) {
      for await (const event of selected.provider.stream({ ...request, model: selected.model }, signal)) {
        if (event.type === 'tool_call_end') {
          const schema = ToolInputs[event.name as keyof typeof ToolInputs];
          toolCalls.push({ turnId: request.metadata?.turnId, name: event.name, input: event.input, valid: !!schema && schema.safeParse(event.input).success });
        }
        yield event;
      }
    },
  };
  const modelName = selected.model;
  const screenshots: string[] = [];
  const previewReports: NonNullable<TraceBundle['previewReports']> = [];
  const suppliedRenderer = options.renderer ?? options.rendererFactory?.(clock);
  const renderer: UiRenderer | undefined = suppliedRenderer ? {
    async preview(input) {
      const report = await suppliedRenderer.preview(input);
      previewReports.push(report);
      screenshots.push(...report.views.flatMap(v => v.screenshots.map(s => s.path)));
      return report;
    },
    async dispose() {},
  } : undefined;
  const router = createModelRouter({ tiers: { coach: { provider: tracking.id, model: modelName }, fast: { provider: tracking.id, model: modelName } }, fallbacks: {}, pricing: {} }, { [tracking.id]: tracking });
  let seedRoot = options.seedRoot ?? join(repo, 'seed');
  if (options.constitution !== undefined) {
    seedRoot = join(traceDir, 'seed');
    await cp(options.seedRoot ?? join(repo, 'seed'), seedRoot, { recursive: true });
    await writeFile(join(seedRoot, 'core/constitution.md'), options.constitution);
  }
  const runtime = createCoachRuntime({ config: ServerConfig.parse({ dataDir, limits: { ...options.limits, debounceIdleMs: 0 }, web: { enabled: false } }), clock, store, blobs, sandbox, router, loop: createAgentLoop({ price: (m, u) => router.cost(m, u) }), logger: silentLogger, seedRoot, pack: 'running', kitDir: join(repo, 'packages/ui-kit/dist'), renderer, manualScheduler: true });
  const trace: TraceBundle = { schemaVersion: 1, scenario, seed, model: modelName, startedAt: clock.now().toISOString(), endedAt: '', athleteId: '', events: [], stream: [], actions: [], ledger: { persona, disclosures: [], activities: [], symptoms: [], artifacts: [] }, snapshots: [], changes: [], screenshots, toolCalls, metrics: { costUsd: 0, inputTokens: 0, cachedTokens: 0, cacheHitRate: null, athleteWeeks: 0, costPerAthleteWeek: null, turnDurationsMs: [] }, capabilities: { sandboxKind: sandbox.kind, sandboxIsolated: sandbox.isolated, sandboxClock: 'unverified', visualRenderer: !!suppliedRenderer }, graders: [] };
  let unsubscribe: (() => void) | undefined;
  trace.previewReports = previewReports;
  let observer: BrowserViewObserver | undefined;
  try {
    await runtime.start();
    const athlete = await runtime.createAthlete({ displayName: persona.profile.name, tz: persona.profile.tz, locale: persona.profile.locale, units: persona.profile.units, isAdmin: false });
    trace.athleteId = athlete.id;
    if (options.observeViews) observer = new BrowserViewObserver({ runtime, athleteId: athlete.id, clock, outDir: join(traceDir, 'published-views'), kitDir: join(repo, 'packages/ui-kit/dist'), executablePath: options.executablePath });
    unsubscribe = runtime.subscribe(athlete.id, message => { trace.stream.push(message); observer?.onStream(message); });
    await runtime.updateSettings(athlete.id, { notifications: { quietHours: persona.communication.quietHours, proactivePerWeek: Math.min(50, Math.ceil(persona.communication.proactivePerWeek.max)) }, ...scenario.settings });
    const workspace = runtime.core.paths(athlete.id).workspace;
    // Only public intake data enters the coach workspace. Hidden facts and the simulator's
    // physiology/ground-truth ledger stay outside the sandbox [EV-1].
    const publicProfile = { profile: persona.profile, history: persona.history, goals: persona.goals, availability: persona.availability, devices: persona.devices, tonePreference: persona.tonePreference };
    await writeFile(join(workspace, 'athlete/profile.md'), `# Athlete intake\n\n${JSON.stringify(publicProfile, null, 2)}\n`);
    for (const [file, contents] of Object.entries(scenario.initialFiles)) {
      const path = resolve(workspace, file);
      if (!path.startsWith(workspace + sep) || path.includes(`${sep}.git${sep}`)) throw new Error('Invalid seeded workspace file');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    await advanceRuntime(runtime, clock, clock.now(), athlete.id);
    const actor = options.athlete ?? createScriptedAthlete(persona, seed);
    let physiology = initialState();
    let currentTz = persona.profile.tz;
    for (const [index, action] of scenario.timeline.entries()) {
      const at = parseStart(action.at, currentTz);
      await advanceRuntime(runtime, clock, at, athlete.id);
      let eventId: string | undefined;
      let disclosedFactId: string | undefined;
      if (action.type === 'message' || action.type === 'probe' || action.type === 'disclose') {
        const fact = action.type !== 'message' ? persona.hidden.find(f => f.id === action.factId) : undefined;
        if (action.type !== 'message' && !fact) throw new Error(`Unknown hidden fact ${action.factId}`);
        const event = await runtime.ingest(athlete.id, { type: 'user.message', payload: { text: action.type === 'disclose' ? fact!.statement : action.text } });
        eventId = event.id;
        if (action.type === 'disclose') {
          disclosedFactId = fact!.id;
          trace.ledger.disclosures.push({ factId: fact!.id, value: fact!.value, at: event.ts, eventId });
        }
      } else if (action.type === 'settings') await runtime.updateSettings(athlete.id, action.patch);
      else if (action.type === 'device') {
        await runtime.ingest(athlete.id, { type: 'device.context', payload: { tz: action.tz, locale: persona.profile.locale } });
        currentTz = (await store.getSettings(athlete.id)).profile.tz;
      } else if (action.type === 'swap') {
        const replacement = options.swapModels?.[action.model];
        if (!replacement) throw new Error(`No provider configured for swap model ${action.model}`);
        selected = replacement;
      } else if (action.type === 'session') {
        const day = localDayDiff(trace.startedAt, at, persona.profile.tz);
        if (day <= physiology.day) throw new Error('Only one physiological session is supported per local day');
        while (physiology.day < day - 1) physiology = stepPhysiology(persona, physiology, physiology.day + 1).state;
        const before = stepPhysiology(persona, physiology, day);
        const messages = (await store.listEvents({ athleteId: athlete.id, types: ['coach.message'], limit: 1000 })).filter(e => e.type === 'coach.message').map(e => e.payload.text);
        const decision = await actor.decide(day, before, messages);
        const cues = stepPhysiology(persona, physiology, day, decision.run ? action.session : undefined);
        physiology = cues.state;
        trace.ledger.symptoms.push({ at: clock.now().toISOString(), symptoms: cues.symptoms });
        if (cues.tz !== currentTz) {
          await runtime.ingest(athlete.id, { type: 'device.context', payload: { tz: cues.tz, locale: persona.profile.locale } });
          currentTz = cues.tz;
        }
        if (decision.run && action.session.type !== 'rest') {
          const activity = generateActivity(persona, action.session, cues, at, seed);
          trace.ledger.activities.push(activity);
          let bytes: Uint8Array;
          let artifactPath: string;
          let truth: import('./types').ArtifactTruth;
          if (action.artifact === 'png') {
            const rendered = await renderScreenshot(activity, join(traceDir, 'artifacts'), { app: persona.devices.app, units: persona.profile.units, locale: persona.profile.locale, theme: persona.devices.screenshotTheme, executablePath: options.executablePath, injection: action.injection });
            bytes = await readFile(rendered.path); artifactPath = rendered.path; truth = rendered.truth;
            trace.screenshots.push(artifactPath);
          } else {
            const generated = generateGpx(activity, action.injection);
            bytes = generated.bytes; truth = generated.truth;
            artifactPath = join(traceDir, 'artifacts', `${truth.artifactId}.gpx`);
            await mkdir(dirname(artifactPath), { recursive: true });
            await writeFile(artifactPath, bytes);
            await writeFile(join(dirname(artifactPath), `${truth.artifactId}.truth.json`), JSON.stringify(truth, null, 2));
          }
          const blob = await blobs.put(athlete.id, bytes, { mime: action.artifact === 'png' ? 'image/png' : 'application/gpx+xml', name: `${truth.artifactId}.${action.artifact}`, origin: 'athlete' });
          await advanceRuntime(runtime, clock, actor.replyAt(clock.now(), day, currentTz), athlete.id);
          const event = await runtime.ingest(athlete.id, { type: 'user.upload', payload: { blobs: [blob], caption: decision.text } });
          eventId = event.id;
          trace.ledger.artifacts.push({ path: artifactPath, truth, eventId });
        } else {
          const event = await runtime.ingest(athlete.id, { type: 'user.message', payload: { text: decision.text } });
          eventId = event.id;
        }
        for (const factId of decision.disclose) {
          const fact = persona.hidden.find(f => f.id === factId);
          if (!fact) throw new Error(`Unknown disclosed fact ${factId}`);
          trace.ledger.disclosures.push({ factId, value: fact.value, at: clock.now().toISOString(), eventId });
        }
      }
      await settle();
      await runtime.whenIdle(athlete.id);
      trace.actions.push({ index, at: clock.now().toISOString(), eventId, disclosedFactId });
      let snapshot: { db: DbSnapshot; schemaSql: string };
      try { snapshot = readDbSnapshot(join(workspace, 'data/coach.db')); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ERR_SQLITE_ERROR' && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        snapshot = { db: { tables: {} }, schemaSql: '' };
      }
      const files: Record<string, string | null> = {};
      for (const path of new Set(scenario.assertions.filter(a => a.kind === 'file' && a.path).map(a => a.path!))) {
        // The same workspace jail as model tools; an eval cannot use a file assertion to read secrets.
        files[path] = await runtime.core.fsFor(athlete.id).readText(path).then(s => s.slice(0, 64_000)).catch(() => null);
      }
      trace.snapshots.push({ at: clock.now().toISOString(), action: index, ...snapshot, schemaDocs: await readFile(join(workspace, 'data/schema.md'), 'utf8').catch(() => ''), files });
      if (observer) {
        const views = await observer.observe(index, scenario.assertions);
        (trace.viewObservations ??= []).push(...views);
        trace.screenshots.push(...views.flatMap(v => v.screenshot ? [v.screenshot] : []));
      }
    }
    if (scenario.end) await advanceRuntime(runtime, clock, parseStart(scenario.end, currentTz), athlete.id);
    trace.endedAt = clock.now().toISOString();
    trace.events = await store.listEvents({ athleteId: athlete.id, limit: 100_000 });
    trace.changes = await runtime.listChanges(athlete.id, { limit: 200 });
    const turns = trace.events.filter(e => e.type === 'coach.turn');
    trace.metrics.costUsd = turns.reduce((n, t) => n + t.payload.costUsd, 0);
    trace.metrics.inputTokens = turns.reduce((n, t) => n + t.payload.tokens.input, 0);
    trace.metrics.cachedTokens = turns.reduce((n, t) => n + t.payload.tokens.cached, 0);
    const total = trace.metrics.inputTokens + trace.metrics.cachedTokens;
    trace.metrics.cacheHitRate = total ? trace.metrics.cachedTokens / total : null;
    trace.metrics.athleteWeeks = (new Date(trace.endedAt).getTime() - new Date(trace.startedAt).getTime()) / (7 * 86_400_000);
    trace.metrics.costPerAthleteWeek = trace.metrics.athleteWeeks > 0 ? trace.metrics.costUsd / trace.metrics.athleteWeeks : null;
    trace.metrics.turnDurationsMs = turns.map(t => t.payload.durationMs);
    trace.graders = gradeTrace(trace);
    await writeFile(join(traceDir, 'trace.json'), JSON.stringify(trace, null, 2));
    return trace;
  } finally {
    unsubscribe?.();
    await observer?.dispose();
    await runtime.stop();
    if (!options.renderer && options.rendererFactory) await suppliedRenderer?.dispose();
    if (!options.sandbox) await sandbox.dispose();
    await store.close();
  }
}
