import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COACH_TOOLS,
  CLIENT_SUBMITTABLE_TYPES,
  HARNESS_VERSION,
  ToolError,
  defaultSettings,
  mergeSettings,
  newId,
  parseEventPayload,
  randomToken,
  type AnyEvent,
  type AthleteRecord,
  type ChangeEntry,
  type CoachRuntimeAPI,
  type CreateAthleteInput,
  type InboundEventInput,
  type NewEvent,
  type PresenceState,
  type RunTurnResult,
  type SafetyScreenResult,
  type StreamListener,
  type Tier,
  type TierConfig,
  type ToolExecutor,
  type TriggerClass,
  type ViewsAPI,
  type AthleteSettings,
} from '@opencoach/protocol';
import { toolSpecsFor } from '@opencoach/tools';
import { buildSystemDir, deleteAthleteData, ensureAthleteDirs, initWorkspace, openWorkspaceGit } from '@opencoach/workspace';
import { StreamBus } from './bus';
import { closeOpenEpoch } from './context';
import { createCoreBase, type Core } from './core';
import type { CoachRuntimeDeps } from './deps';
import { HelperManager } from './helpers';
import { McpManager } from './mcp';
import { Minds } from './mind';
import { heuristicScreen, safetyBannerText } from './safety';
import { Scheduler } from './scheduler';
import { TurnRunner } from './turn';
import { UiService } from './ui-service';
import { callBriefing, callTurn, consult, lookup } from './voice-bridge';
import { createWebPort } from './web';

const ERROR_WAKE_LIMIT_MS = 60 * 60_000;

/** Extra hooks for tests and the eval simulator. */
export interface RuntimeTestHooks {
  /** Resolve when the athlete's mind (or all minds) has nothing queued or running. */
  whenIdle(athleteId?: string): Promise<void>;
  /** Fire due schedules now (normally driven by the scheduler loop). */
  tickScheduler(): Promise<number>;
  readonly core: Core;
}

export type CoachRuntime = CoachRuntimeAPI & RuntimeTestHooks;

export function createCoachRuntime(deps: CoachRuntimeDeps): CoachRuntime {
  return new Runtime(deps);
}

class Runtime implements CoachRuntimeAPI, RuntimeTestHooks {
  readonly core: Core;
  readonly views: ViewsAPI;
  private safetyFlags = new Map<string, SafetyScreenResult>();
  private lastUiError = new Map<string, number>();
  private started = false;

  constructor(private deps: CoachRuntimeDeps) {
    const bus = new StreamBus();
    const web = createWebPort(deps.config.web, deps.webSearch);
    const core = createCoreBase(deps, bus, web, HARNESS_VERSION) as Core;
    core.turns = new TurnRunner(core);
    core.minds = new Minds(core, (a, evs, cls) => this.runFromMind(a, evs, cls));
    core.scheduler = new Scheduler(core);
    core.ui = new UiService(core);
    core.helpers = new HelperManager(core);
    core.mcp = new McpManager(deps.config.mcp, deps.logger);
    this.core = core;
    const ui = core.ui;
    this.views = {
      appInfo: (a) => ui.appInfo(a),
      query: (a, v, sql, params) => ui.query(a, v, sql, params),
      readFile: (a, v, p) => ui.readFile(a, v, p),
      write: (a, v, input) => ui.write(a, v, input),
      act: async (a, v, input) => {
        await ui.validateAction(a, v, input.name);
        return this.ingest(a, { type: 'user.ui_action', payload: { source: { viewId: v }, action: input.name, payload: input.payload, wake: input.wake ?? false } });
      },
      versions: (a, v) => ui.versions(a, v),
      revert: (a, v, to) => ui.revert(a, v, to),
    };
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    const core = this.core;
    try {
      const pack = JSON.parse(await readFile(join(this.deps.seedRoot, this.deps.pack, 'pack.json'), 'utf8')) as { id?: string; version?: string; name?: string };
      core.pack = { id: pack.id ?? this.deps.pack, version: pack.version ?? '0.0.0', name: pack.name ?? this.deps.pack };
    } catch {
      core.log.warn('pack.json missing; using defaults', { pack: this.deps.pack });
    }
    core.systemDir = await buildSystemDir({
      dataDir: this.deps.config.dataDir,
      seedRoot: this.deps.seedRoot,
      pack: this.deps.pack,
      harnessVersion: HARNESS_VERSION,
      extraDocs: this.deps.extraSystemDocs,
    });
    await core.mcp.start();
    await this.recover();
    if (!this.deps.manualScheduler) core.scheduler.start();
    this.started = true;
    core.log.info('coach runtime started', { systemDir: core.systemDir, sandbox: this.deps.sandbox.kind, isolated: this.deps.sandbox.isolated });
  }

  async stop(): Promise<void> {
    const core = this.core;
    await core.scheduler.stop();
    core.turns.abortAll();
    await core.helpers.cancelAll();
    core.minds.stopAll();
    await core.mcp.stop();
    this.started = false;
  }

  /** Crash recovery: abort stale turns/tasks, refresh harness schedules, detect upgrades & external edits. */
  private async recover(): Promise<void> {
    const core = this.core;
    const store = core.store;
    for (const t of await store.listTurns({ limit: 200 })) {
      if (t.status === 'running') await store.updateTurn(t.id, { status: 'aborted', endedAt: core.clock.now().toISOString(), error: 'server restarted' });
    }
    for (const a of await store.listAthletes()) {
      if (a.status !== 'active') continue;
      for (const task of await store.listTasks(a.id, { state: 'running' })) {
        await store.updateTask(task.id, { state: 'failed', endedAt: core.clock.now().toISOString(), error: 'server restarted' });
        const e = await store.appendEvent({
          athleteId: a.id,
          type: 'task.failed',
          actor: 'harness',
          payload: { taskId: task.id, profile: task.profile, summary: 'The server restarted while this helper was running.', error: 'server restarted', originEventId: task.originEventId },
        });
        core.minds.get(a.id).enqueue(e, 'followup');
      }
      await core.scheduler.ensureHarnessSchedules(a.id);
      // harness upgrades (SPEC [WS-9])
      const vKey = `harness-version:${a.id}`;
      const prev = await store.getKv(vKey);
      if (prev && prev !== HARNESS_VERSION) {
        const e = await store.appendEvent({ athleteId: a.id, type: 'harness.upgraded', actor: 'harness', payload: { from: prev, to: HARNESS_VERSION, changelogPath: '/system/CHANGELOG-for-coach.md' } });
        core.minds.get(a.id).enqueue(e, 'followup');
      }
      await store.setKv(vKey, HARNESS_VERSION);
      await this.detectExternalEdits(a.id);
    }
  }

  private async detectExternalEdits(athleteId: string): Promise<void> {
    const core = this.core;
    const key = `last-head:${athleteId}`;
    try {
      const git = openWorkspaceGit(core.paths(athleteId).workspace, core.clock);
      const last = await core.store.getKv(key);
      if (last) {
        const foreign = await git.foreignCommitsSince(last);
        if (foreign.length) {
          const files = new Set(foreign.flatMap((c) => c.files));
          const e = await core.store.appendEvent({
            athleteId,
            type: 'workspace.external_change',
            actor: 'harness',
            payload: { commits: foreign.map((c) => c.commit), filesChanged: files.size, summary: foreign.map((c) => c.message.split('\n')[0]).join('; ').slice(0, 500) },
          });
          core.minds.get(athleteId).enqueue(e, 'followup');
        }
      }
      await core.store.setKv(key, await git.head());
    } catch (e) {
      core.log.warn('external edit detection failed', { athleteId, error: (e as Error).message });
    }
  }

  // ------------------------------------------------------------------ athletes & settings

  async createAthlete(input: CreateAthleteInput): Promise<AthleteRecord> {
    const core = this.core;
    const now = core.clock.now().toISOString();
    let settings: AthleteSettings = defaultSettings();
    if (this.deps.config.defaultSettings) settings = mergeSettings(settings, this.deps.config.defaultSettings).settings;
    settings = mergeSettings(settings, {
      profile: { name: input.displayName, coachName: input.coachName ?? settings.profile.coachName, tz: input.tz, locale: input.locale, units: input.units ?? settings.profile.units },
      consents: { healthData: input.consents?.healthData ?? now, aiDisclosure: input.consents?.aiDisclosure ?? now, ageConfirmed18: input.consents?.ageConfirmed18 ?? now },
      calendarToken: randomToken(24),
    }).settings;
    const athlete = await core.store.createAthlete({ displayName: input.displayName, isAdmin: input.isAdmin, settings });
    const paths = core.paths(athlete.id);
    await ensureAthleteDirs(paths);
    await initWorkspace({
      paths,
      seedRoot: this.deps.seedRoot,
      pack: this.deps.pack,
      clock: core.clock,
      vars: {
        athlete_name: settings.profile.name,
        coach_name: settings.profile.coachName,
        voice_id: settings.voice.voice,
        created_date: now.slice(0, 10),
      },
    });
    await core.ui.publishSeed(athlete.id);
    await core.store.setKv(`harness-version:${athlete.id}`, HARNESS_VERSION);
    await core.store.setKv(`last-head:${athlete.id}`, await openWorkspaceGit(paths.workspace, core.clock).head());
    await core.scheduler.ensureHarnessSchedules(athlete.id);
    await core.scheduler.firstContact(
      athlete.id,
      'First contact: the athlete just created their account. Greet them warmly, introduce yourself briefly, and start the intake conversation (see the intake skill). Keep the first message short.',
    );
    await core.store.audit({ athleteId: athlete.id, at: now, actor: 'harness', action: 'athlete.created', detail: { isAdmin: input.isAdmin } });
    return athlete;
  }

  async deleteAthlete(athleteId: string): Promise<void> {
    const core = this.core;
    core.minds.delete(athleteId);
    await core.helpers.cancelAll(athleteId);
    await core.releaseSandbox(athleteId);
    await core.store.deleteAthlete(athleteId);
    await deleteAthleteData(core.paths(athleteId));
  }

  async updateSettings(athleteId: string, patch: unknown): Promise<AthleteSettings> {
    const core = this.core;
    const { settings, diff } = await core.store.updateSettings(athleteId, patch);
    const keys = Object.keys(diff);
    if (keys.length) {
      if (keys.some((k) => k.startsWith('heartbeat.') || k.startsWith('consolidation.') || k === 'profile.tz')) {
        if (keys.some((k) => k.startsWith('heartbeat.time'))) await core.store.updateSettings(athleteId, { heartbeat: { setBy: 'athlete' } });
        await core.scheduler.ensureHarnessSchedules(athleteId);
      }
      const visible = Object.fromEntries(Object.entries(diff).filter(([k]) => !k.startsWith('calendarToken') && !k.startsWith('models.')));
      if (Object.keys(visible).length) {
        const e = await core.store.appendEvent({ athleteId, type: 'user.settings_changed', actor: 'athlete', payload: { diff: visible } });
        core.minds.get(athleteId).addPassive(e);
      }
    }
    return settings;
  }

  // ------------------------------------------------------------------ events

  async ingest(athleteId: string, input: InboundEventInput): Promise<AnyEvent> {
    const core = this.core;
    if (!(CLIENT_SUBMITTABLE_TYPES as readonly string[]).includes(input.type)) throw new ToolError('NOT_ALLOWED', `Event type ${input.type} cannot be submitted by clients.`);
    const athlete = await core.store.getAthlete(athleteId);
    if (!athlete || athlete.status !== 'active') throw new ToolError('NOT_FOUND', 'Unknown athlete.');
    parseEventPayload(input.type, input.payload); // validate early (throws ZodError)
    const mind = core.minds.get(athleteId);

    if (input.type === 'user.message_deleted') {
      const original = await core.store.getEvent(input.payload.messageId);
      if (original && original.athleteId === athleteId && original.actor === 'athlete') await core.store.tombstoneEvent(original.id);
    }
    if (input.type === 'user.read') await core.store.markRead(input.payload.messageIds, core.clock.now().toISOString());

    const e = (await core.store.appendEvent({ athleteId, type: input.type, actor: input.type === 'device.context' ? 'device' : 'athlete', payload: input.payload } as NewEvent)) as AnyEvent;
    if (input.type !== 'user.read') core.bus.publish(athleteId, { t: 'event', event: e });

    switch (e.type) {
      case 'user.message':
      case 'user.upload':
      case 'user.voice_note': {
        const text = e.type === 'user.message' ? e.payload.text : e.type === 'user.upload' ? (e.payload.caption ?? '') : e.payload.transcript;
        if (text.trim()) await this.screen(athleteId, e, text);
        mind.enqueue(e, 'reactive');
        break;
      }
      case 'user.ui_action':
        if (e.payload.wake) mind.enqueue(e, 'reactive');
        else mind.addPassive(e);
        break;
      case 'ui.error': {
        const key = `${athleteId}:${e.payload.viewId}`;
        const last = this.lastUiError.get(key) ?? 0;
        const now = core.clock.now().getTime();
        if (now - last > ERROR_WAKE_LIMIT_MS) {
          this.lastUiError.set(key, now);
          mind.enqueue(e, 'followup');
        }
        break;
      }
      case 'device.context': {
        const settings = await core.store.getSettings(athleteId);
        if (e.payload.tz && e.payload.tz !== settings.profile.tz) {
          try {
            new Intl.DateTimeFormat('en', { timeZone: e.payload.tz });
            await this.updateSettings(athleteId, { profile: { tz: e.payload.tz } });
            mind.addPassive(e);
          } catch {
            /* ignore invalid tz */
          }
        }
        break;
      }
      case 'user.read':
        break;
      default:
        mind.addPassive(e);
    }
    return e;
  }

  private async screen(athleteId: string, e: AnyEvent, text: string): Promise<void> {
    const core = this.core;
    let r: SafetyScreenResult;
    try {
      r = this.deps.safety ? await this.deps.safety.screen(text) : heuristicScreen(text);
    } catch {
      r = heuristicScreen(text);
    }
    if (!r.flagged) return;
    this.safetyFlags.set(e.id, r);
    const banner = safetyBannerText(r.categories, r.acute);
    const notice = await core.store.appendEvent({
      athleteId,
      type: 'harness.notice',
      actor: 'harness',
      causationId: e.id,
      payload: { kind: 'safety_flag', athleteVisible: true, text: banner, detail: { categories: r.categories, acute: r.acute, method: r.method } },
    });
    core.bus.publish(athleteId, { t: 'safety', categories: r.categories, acute: r.acute, text: banner });
    core.bus.publish(athleteId, { t: 'event', event: notice });
  }

  async appendSystemEvent(e: NewEvent): Promise<AnyEvent> {
    const core = this.core;
    const ev = (await core.store.appendEvent(e)) as AnyEvent;
    core.bus.publish(ev.athleteId, { t: 'event', event: ev });
    if (ev.type === 'call.ended') core.minds.get(ev.athleteId).enqueue(ev, 'followup');
    else if (ev.type === 'user.message' && ev.actor === 'athlete') core.minds.get(ev.athleteId).enqueue(ev, 'reactive');
    else if (ev.type === 'data.synced') core.minds.get(ev.athleteId).enqueue(ev, 'followup');
    return ev;
  }

  private async runFromMind(athleteId: string, events: AnyEvent[], cls: TriggerClass): Promise<void> {
    let safety: SafetyScreenResult | undefined;
    for (const e of events) {
      const f = this.safetyFlags.get(e.id);
      if (f) {
        safety = safety
          ? { flagged: true, categories: [...new Set([...safety.categories, ...f.categories])], acute: safety.acute || f.acute, method: f.method }
          : f;
        this.safetyFlags.delete(e.id);
      }
    }
    await this.core.turns.run(athleteId, events, cls, { safety });
  }

  subscribe(athleteId: string, listener: StreamListener): () => void {
    return this.core.bus.subscribe(athleteId, listener);
  }

  presence(athleteId: string): PresenceState {
    return this.core.bus.getPresence(athleteId);
  }

  // ------------------------------------------------------------------ workspace views for the gateway

  async listChanges(athleteId: string, opts: { before?: string; limit?: number } = {}): Promise<ChangeEntry[]> {
    const git = openWorkspaceGit(this.core.paths(athleteId).workspace, this.core.clock);
    const log = await git.log({ before: opts.before, limit: Math.min(opts.limit ?? 50, 200) });
    return log
      .filter((c) => !c.message.startsWith('wip: before helper'))
      .map((c) => {
        const kind = (c.trailers.Kind as ChangeEntry['kind'] | undefined) ?? 'external';
        return { commit: c.commit, at: c.at, turnId: c.trailers['Turn-Id'], summary: c.message.split('\n')[0] ?? '', files: c.files, kind };
      });
  }

  async calendarIcs(athleteId: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.core.paths(athleteId).workspace, 'exports', 'calendar.ics'), 'utf8');
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------------ voice

  consult(athleteId: string, question: string, context?: string): Promise<string> {
    return consult(this.core, athleteId, question, context);
  }

  lookup(athleteId: string, query: string): Promise<string> {
    return lookup(this.core, athleteId, query);
  }

  callBriefing(athleteId: string, purpose?: string): Promise<string> {
    return callBriefing(this.core, athleteId, purpose);
  }

  callTurn(athleteId: string, callId: string, utterance: string): Promise<{ replyText: string }> {
    return callTurn(this.core, athleteId, callId, utterance);
  }

  // ------------------------------------------------------------------ admin

  async forceEpoch(athleteId: string): Promise<void> {
    await closeOpenEpoch(this.core, athleteId, 'forced');
  }

  async replayTurn(turnId: string, opts: { tier?: Tier; override?: TierConfig } = {}): Promise<RunTurnResult> {
    const core = this.core;
    const ctx = (await core.store.getTurnContext(turnId)) as
      | { system: import('@opencoach/protocol').SystemBlock[]; items: import('@opencoach/protocol').ConvItem[]; tier: Tier; cls: TriggerClass }
      | undefined;
    if (!ctx) throw new ToolError('NOT_FOUND', `No stored context for turn ${turnId}.`);
    const route = core.deps.router.route(opts.tier ?? ctx.tier, opts.override);
    const dry: ToolExecutor = {
      specs: () => toolSpecsFor('coach', COACH_TOOLS),
      execute: async (call) => ({ callId: call.id, name: call.name, isError: true, content: [{ type: 'text', text: 'Replay mode: tools are not executed.' }] }),
    };
    return core.deps.loop.runTurn({
      turnId: newId('turn', core.clock),
      route,
      system: ctx.system,
      items: ctx.items,
      tools: dry,
      limits: { maxSteps: 8, maxWallMs: 120_000 },
      cacheKey: `replay:${turnId}`,
    });
  }

  // ------------------------------------------------------------------ test hooks

  async whenIdle(athleteId?: string): Promise<void> {
    if (athleteId) return this.core.minds.get(athleteId).whenIdle();
    return this.core.minds.whenAllIdle();
  }

  tickScheduler(): Promise<number> {
    return this.core.scheduler.tick();
  }
}
