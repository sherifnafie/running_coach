import { parse as parsePartial } from 'partial-json';
import {
  COACH_TOOLS,
  accountUsable,
  newId,
  type AnyEvent,
  type Channel,
  type ContentPart,
  type ConvItem,
  type Effort,
  type HarnessItem,
  type ResolvedModel,
  type RunTurnResult,
  type SafetyScreenResult,
  type SteeringSource,
  type Tier,
  type ToolName,
  type TriggerClass,
  type TurnLimits,
  type TurnStreamEvent,
  type Usage,
  addUsage,
  estimateTokens,
} from '@opencoach/protocol';
import { dumpDb, openWorkspaceGit, readPinnedList, renderHistory, snapshotDb } from '@opencoach/workspace';
import { closeOpenEpoch, ensureEpoch, type EpochState } from './context';
import type { Core } from './core';
import { createExecutor } from './executor';
import { createMessagingPort, isProactiveTurn, type TurnMessagingState } from './messaging';
import { buildTriggerItem, isImage, rawPath } from './render';
import { buildSituation } from './situation';
import { epochDate, localDayStartIso, localMonthStartIso } from './time';

export interface TurnOptions {
  channel?: Channel;
  allowMessaging?: boolean;
  tools?: ToolName[];
  tier?: Tier;
  effort?: Effort;
  limits?: Partial<TurnLimits>;
  /** Extra text appended to the trigger user item (e.g. cascaded-call utterance & style). */
  extraTriggerText?: string;
  /** Extra lines for the situation report. */
  situationExtra?: string[];
  replyRequired?: boolean;
  safety?: SafetyScreenResult;
  /** Consume signals from athlete events injected during this turn [RT-3, SAFE-2]. */
  steeringSafety?: (events: AnyEvent[]) => SafetyScreenResult | undefined;
  /** Skip epoch persistence of this turn's items (never used for normal turns). */
  ephemeral?: boolean;
}

export interface TurnOutcome {
  turnId: string;
  status: 'ok' | 'error' | 'limit' | 'aborted' | 'skipped';
  finalText: string;
  replyTexts: string[];
  costUsd: number;
}

/**
 * Reasoning effort per trigger class when the tier doesn't pin one. Replies and check-ins think hard; live calls stay
 * quick to keep speech responsive. Consolidation first sizes the day and does a short pass on quiet days, so it runs
 * at high rather than max; deep analysis goes to deep-tier helpers, whose own effort is max.
 */
const DEFAULT_EFFORT: Record<TriggerClass, Effort> = {
  reactive: 'high',
  call: 'low',
  followup: 'high',
  scheduled: 'high',
  consolidation: 'high',
};

const BACKGROUND_LABEL = 'Working on it in the background…';

const PROGRESS_LABELS: Record<string, string> = {
  read: 'Looking through notes…',
  grep: 'Looking through notes…',
  glob: 'Looking through notes…',
  search_history: 'Checking our history…',
  bash: 'Crunching the numbers…',
  write: 'Updating notes…',
  edit: 'Updating notes…',
  spawn_agent: 'Asking a helper…',
  preview_ui: 'Updating your app…',
  publish_ui: 'Updating your app…',
  web_search: 'Researching…',
  web_fetch: 'Researching…',
  schedule: 'Planning check-ins…',
};

const MAX_IMAGES_PER_TURN = 6;
const NUDGE_AFTER_TURNS = 8;

export function partialText(json: string): string | undefined {
  try {
    const v = parsePartial(json) as { text?: unknown } | undefined;
    return typeof v?.text === 'string' ? v.text : undefined;
  } catch {
    return undefined;
  }
}

export class TurnRunner {
  private active = new Map<string, { athleteId: string; abort: AbortController }>();

  constructor(private core: Core) {}

  abortAll(): void {
    for (const a of this.active.values()) a.abort.abort();
  }

  abortAthlete(athleteId: string): void {
    for (const a of this.active.values()) if (a.athleteId === athleteId) a.abort.abort();
  }

  async run(athleteId: string, triggers: AnyEvent[], cls: TriggerClass, opts: TurnOptions = {}): Promise<TurnOutcome> {
    const core = this.core;
    const store = core.store;
    const skipped: TurnOutcome = { turnId: '', status: 'skipped', finalText: '', replyTexts: [], costUsd: 0 };
    const athlete = await store.getAthlete(athleteId);
    if (!accountUsable(athlete)) return skipped; // deleted or suspended: no model calls, no messages
    const settings = await store.getSettings(athleteId);
    const now = core.clock.now();
    const tz = settings.profile.tz;
    const proactive = isProactiveTurn(cls, triggers);
    let replyRequired = opts.replyRequired ?? (cls === 'reactive' || cls === 'call');

    // ---- budgets [COST-1]
    const dayCost = (await store.sumUsage(athleteId, localDayStartIso(now, tz))).costUsd;
    const monthCost = (await store.sumUsage(athleteId, localMonthStartIso(now, tz))).costUsd;
    const overBudget = dayCost >= settings.budgets.dailyUsd || monthCost >= settings.budgets.monthlyUsd;
    const managed = core.deps.billing?.(athleteId) === 'managed';
    if (managed && monthCost >= settings.budgets.monthlyUsd) {
      // Managed keys: the monthly budget is a hard allowance set by an administrator. No model call at all [COST-1].
      if (replyRequired) {
        await this.noticeOnce(athleteId, 'allowance_exhausted', `Your monthly AI allowance is used up ($${monthCost.toFixed(2)} of $${settings.budgets.monthlyUsd.toFixed(2)}), so your coach is paused until next month. Ask your administrator to raise it, or connect your own OpenRouter key in Settings.`);
      }
      return skipped;
    }
    if (overBudget && !replyRequired && cls !== 'followup') {
      await this.noticeOnce(athleteId, 'budget_exhausted', `Daily or monthly AI budget reached ($${dayCost.toFixed(2)} today, $${monthCost.toFixed(2)} this month). Scheduled check-ins are paused until the budget resets; replies continue on a smaller model.`);
      return skipped;
    }

    // ---- model routing
    let tier: Tier = opts.tier ?? 'coach';
    if (overBudget) tier = 'fast';
    let route: ResolvedModel[];
    try {
      route = core.deps.router.route(tier, settings.models[tier], { athleteId });
    } catch (e) {
      core.log.error('no model route', { athleteId, tier, error: (e as Error).message });
      if (replyRequired) await this.replyFallback(athleteId, triggers, 'No AI model is configured or reachable.');
      return { ...skipped, status: 'error' };
    }
    const model = route[0]!;
    const effort = opts.effort ?? model.effort ?? DEFAULT_EFFORT[cls];

    // ---- context
    const ep = await ensureEpoch(core, athleteId, model);
    const firstContact = (await store.listEvents({ athleteId, types: ['coach.message'], limit: 1 })).length === 0;
    const mind = core.minds.get(athleteId);
    const passive = mind.takePassive();
    const images = model.capabilities.vision ? await this.collectImages(athleteId, triggers) : [];
    const visionNote =
      !model.capabilities.vision && triggers.some((t) => imageBlobsOf(t).length > 0)
        ? 'Note: your current model cannot see images. Check the situation report for image-capable helper tiers. When one is configured, use an extractor helper with the /raw paths as inputs; otherwise disclose the missing image capability instead of claiming extraction.'
        : undefined;
    const heartbeat = triggers.some((t) => t.type === 'system.heartbeat') ? await this.readWorkspaceFile(athleteId, 'HEARTBEAT.md') : undefined;
    const consolidation = cls === 'consolidation' ? await core.addendum('consolidation', { coach_name: settings.profile.coachName, athlete_name: settings.profile.name }) : undefined;
    const triggerItem = buildTriggerItem(triggers, passive, {
      tz,
      heartbeat,
      consolidation,
      images,
      extraText: [opts.extraTriggerText, visionNote].filter(Boolean).join('\n\n') || undefined,
    });
    const limits: TurnLimits = {
      maxSteps: cls === 'reactive' || cls === 'call' ? core.config.limits.reactiveMaxSteps : core.config.limits.otherMaxSteps,
      maxWallMs: cls === 'reactive' || cls === 'call' ? core.config.limits.reactiveMaxWallMs : core.config.limits.otherMaxWallMs,
      ...opts.limits,
    };
    const nudge = await this.nudge(athleteId, triggers);
    const firstContactText = firstContact && cls !== 'consolidation' ? await core.addendum('first-contact', { coach_name: settings.profile.coachName, athlete_name: settings.profile.name }) : '';
    const allowMessaging = opts.allowMessaging ?? cls !== 'consolidation';
    let tools: ToolName[] = opts.tools ?? [...COACH_TOOLS];
    if (!allowMessaging) tools = tools.filter((t) => t !== 'send_message' && t !== 'no_reply');
    const situation = await buildSituation(core, {
      athleteId,
      settings,
      cls,
      triggers,
      model,
      tools,
      epoch: { localDate: ep.epoch.localDate, seq: ep.epoch.seq },
      pinned: ep.pinned,
      replyRequired,
      proactive,
      limits,
      safety: opts.safety,
      firstContact,
      nudge,
      extra: opts.situationExtra,
    });
    const harnessItem: HarnessItem = { kind: 'harness', text: firstContactText ? `${situation}\n\n${firstContactText}` : situation };
    const newItems: ConvItem[] = [triggerItem, harnessItem];

    // ---- turn record
    const turnId = newId('turn', core.clock);
    const startedAt = core.clock.now();
    await store.insertTurn({
      id: turnId,
      athleteId,
      epochId: ep.epoch.id,
      agent: 'coach',
      triggerClass: cls,
      triggerEventIds: triggers.map((t) => t.id),
      tier,
      provider: model.provider.id,
      model: model.model,
      status: 'running',
      startedAt: startedAt.toISOString(),
      steps: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      costUsd: 0,
      fallbacks: [],
    });
    let seq = ep.items.length;
    const persist = async (items: ConvItem[]) => {
      if (opts.ephemeral || items.length === 0) return;
      await store.appendEpochItems(items.map((item) => ({ epochId: ep.epoch.id, seq: seq++, turnId, item, tokens: estimateTokens(item), createdAt: core.clock.now().toISOString() })));
    };
    await persist(newItems);
    await store.saveTurnContext(turnId, { system: ep.system, items: compactForStorage([...ep.items, ...newItems]), tier, cls, model: model.model, provider: model.provider.id, effort }).catch(() => {});

    // ---- messaging & tools
    const firstAthlete = triggers.find((t) => t.actor === 'athlete');
    const msgState: TurnMessagingState = {
      athleteId,
      turnId,
      cls,
      triggers: [...triggers],
      proactive,
      allowMessaging,
      channel: opts.channel ?? 'app',
      replied: false,
      sentTexts: [],
      streamed: new Set(),
    };
    const streamable = () => !msgState.proactive && msgState.allowMessaging;
    const executor = createExecutor(core, {
      athleteId,
      turnId,
      // Steering can turn background work into an athlete-requested chat turn.
      // Tools must see that current context, not just how the turn started [RT-3].
      get triggerClass() { return msgState.cls; },
      agent: { kind: 'coach', depth: 0 },
      tools,
      fs: core.fsFor(athleteId),
      sandbox: await core.sandboxFor(athleteId),
      vision: model.capabilities.vision,
      messagingFor: (callId) => createMessagingPort(core, msgState, { current: callId }),
      spawnParent: { athleteId, turnId, depth: 0, originEventId: firstAthlete?.id },
      onStart: (call) => {
        if (call.name !== 'send_message') core.bus.setPresence(athleteId, 'working');
        const label = PROGRESS_LABELS[call.name];
        if (label && streamable()) core.bus.publish(athleteId, { t: 'progress', turnId, label });
      },
      onEnd: () => core.bus.setPresence(athleteId, 'thinking'),
    });

    const steering: SteeringSource = {
      drain: () => {
        const evs = mind.drainSteering();
        if (evs.length === 0) return [];
        msgState.cls = 'reactive';
        msgState.proactive = false;
        // A previous proactive send/no_reply does not answer the newly arrived athlete message.
        msgState.replied = false;
        msgState.noReplyReason = undefined;
        msgState.triggers.push(...evs);
        replyRequired = true;
        const safety = opts.steeringSafety?.(evs);
        const safetyText = safety?.flagged
          ? `SAFETY: the harness flagged a possible ${safety.categories.join(', ')} signal${safety.acute ? ' (possibly happening now)' : ''}. Apply the safety protocol in your constitution. The athlete is also being shown a safety banner.`
          : '';
        return [
          buildTriggerItem(evs, [], { tz, extraText: ['The athlete sent this while you were working. Take it into account; they expect a reply.', safetyText].filter(Boolean).join('\n') }),
          { kind: 'harness', text: 'Current tool context: reactive (athlete input received during this turn). Requested-chat image generation and identity changes are available subject to the athlete’s current permissions and budgets. Work does not require an open app or another message from the athlete.' },
        ];
      },
    };

    // ---- run
    const abort = new AbortController();
    this.active.set(turnId, { athleteId, abort });
    const streamText = new Map<string, string>();
    let lastPromptTokens = 0;
    const usageKind = cls === 'consolidation' ? 'consolidation' : 'turn';
    const onEvent = (e: TurnStreamEvent) => {
      switch (e.type) {
        case 'tool_call_start':
          if (e.name === 'send_message' && streamable()) {
            msgState.streamed.add(e.id);
            core.bus.publish(athleteId, { t: 'message.start', streamId: e.id, replyTo: firstAthlete?.id });
            core.bus.setPresence(athleteId, 'typing');
          }
          break;
        case 'tool_input_delta':
          if (msgState.streamed.has(e.id)) {
            const text = partialText(e.partialJson);
            const prev = streamText.get(e.id) ?? '';
            if (text && text.length > prev.length && text.startsWith(prev)) {
              streamText.set(e.id, text);
              core.bus.publish(athleteId, { t: 'message.delta', streamId: e.id, textDelta: text.slice(prev.length) });
            }
          }
          break;
        case 'retry':
        case 'fallback':
          // the engine discards the failed attempt: retract its provisional bubbles
          for (const id of [...msgState.streamed]) {
            msgState.streamed.delete(id);
            streamText.delete(id);
            core.bus.publish(athleteId, { t: 'message.cancel', streamId: id, reason: 'retrying' });
          }
          break;
        case 'progress':
          if (streamable() && e.text.trim()) core.bus.publish(athleteId, { t: 'progress', turnId, label: e.text.trim().slice(0, 140) });
          break;
        case 'step_end':
          lastPromptTokens = 0;
          lastPromptTokens = e.usage.inputTokens + e.usage.cachedInputTokens + e.usage.cacheWriteTokens;
          void store
            .recordUsage({ athleteId, turnId, at: core.clock.now().toISOString(), provider: e.provider, model: e.model, tier, kind: usageKind, usage: e.usage, costUsd: e.costUsd })
            .catch(() => {});
          break;
        default:
          break;
      }
    };

    core.bus.setPresence(athleteId, 'thinking');
    let result: RunTurnResult;
    let totalCost = 0;
    let totalUsage: Usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    let steps = 0;
    const fallbacks: string[] = [];
    try {
      result = await core.deps.loop.runTurn({
        turnId,
        route,
        system: ep.system,
        items: [...ep.items, ...newItems],
        tools: executor,
        limits,
        steering,
        effort,
        cacheKey: athleteId,
        signal: abort.signal,
        onEvent,
        beforeStep: ({ step }) =>
          step === limits.maxSteps - 3
            ? [{ kind: 'harness', text: `You have 3 steps left in this turn.${replyRequired && !msgState.replied ? ' Make sure the athlete gets your reply now.' : ' Wrap up.'}` }]
            : undefined,
      });
      await persist(result.newItems);
      totalCost += result.costUsd;
      totalUsage = addUsage(totalUsage, result.usage);
      steps += result.steps;
      fallbacks.push(...result.fallbacks);

      // ---- reply guarantee [RT-4]
      if (replyRequired && !msgState.replied && msgState.allowMessaging && result.stopReason !== 'aborted' && result.stopReason !== 'error') {
        const reminder: HarnessItem = {
          kind: 'harness',
          text: "You haven't replied to the athlete yet and they are waiting. Reply now with send_message, or call no_reply with a short reason if no reply is needed.",
        };
        await persist([reminder]);
        const r2 = await core.deps.loop.runTurn({
          turnId,
          route,
          system: ep.system,
          items: [...ep.items, ...newItems, ...result.newItems, reminder],
          tools: executor,
          limits: { maxSteps: 4, maxWallMs: 90_000 },
          effort,
          cacheKey: athleteId,
          signal: abort.signal,
          onEvent,
          steering,
        });
        await persist(r2.newItems);
        totalCost += r2.costUsd;
        totalUsage = addUsage(totalUsage, r2.usage);
        steps += r2.steps;
        fallbacks.push(...r2.fallbacks);
        result = { ...r2, newItems: [...result.newItems, reminder, ...r2.newItems], costUsd: totalCost, usage: totalUsage, steps };
      }
    } catch (e) {
      core.log.error('agent loop threw', { athleteId, turnId, error: (e as Error).stack ?? String(e) });
      result = {
        newItems: [],
        stopReason: 'error',
        finalText: '',
        usage: totalUsage,
        costUsd: totalCost,
        steps,
        provider: model.provider.id,
        model: model.model,
        fallbacks,
        error: (e as Error).message,
      };
    } finally {
      this.active.delete(turnId);
    }

    // provisional bubbles that never resolved
    for (const id of msgState.streamed) core.bus.publish(athleteId, { t: 'message.cancel', streamId: id, reason: 'not sent' });

    if (replyRequired && !msgState.replied && msgState.allowMessaging && result.stopReason !== 'aborted') {
      await this.replyFallback(athleteId, msgState.triggers, result.error ?? `turn ended (${result.stopReason}) without a reply`);
    }

    // ---- finalize
    const status: 'ok' | 'error' | 'limit' | 'aborted' =
      result.stopReason === 'end_turn' ? 'ok' : result.stopReason === 'aborted' ? 'aborted' : result.stopReason === 'error' || result.stopReason === 'refusal' ? 'error' : 'limit';
    let commit: string | undefined;
    let changedFiles: string[] = [];
    try {
      const git = openWorkspaceGit(core.paths(athleteId).workspace, core.clock);
      const pending = await git.status();
      const summary = describeChanges(pending);
      const c = await git.commitAll(summary, { 'Turn-Id': turnId, Kind: 'turn', Trigger: cls });
      if (c) {
        commit = c.commit;
        changedFiles = c.files;
      }
      await snapshotDb(core.paths(athleteId), core.clock).catch(() => null);
    } catch (e) {
      core.log.warn('commit failed', { athleteId, turnId, error: (e as Error).message });
    }
    await this.trackPinnedWrites(athleteId, changedFiles);

    const durationMs = core.clock.now().getTime() - startedAt.getTime();
    await store.updateTurn(turnId, {
      status,
      endedAt: core.clock.now().toISOString(),
      steps: result.steps,
      usage: result.usage,
      costUsd: result.costUsd,
      provider: result.provider,
      model: result.model,
      commit,
      note: result.finalText.slice(0, 8000),
      error: result.error,
      fallbacks: result.fallbacks,
    });
    await store.appendEvent({
      athleteId,
      type: 'coach.turn',
      actor: 'harness',
      turnId,
      payload: {
        turnId,
        triggerClass: cls,
        triggerEventIds: triggers.map((t) => t.id),
        tier,
        provider: result.provider,
        model: result.model,
        steps: result.steps,
        tokens: { input: result.usage.inputTokens, cached: result.usage.cachedInputTokens, cacheWrite: result.usage.cacheWriteTokens, output: result.usage.outputTokens },
        costUsd: result.costUsd,
        durationMs,
        commit,
        fallbacks: result.fallbacks,
        note: result.finalText.slice(0, 2000),
        status,
        error: result.error,
      },
    });
    for (const f of result.fallbacks) {
      core.log.warn('model fallback used', { athleteId, turnId, fallback: f });
    }
    // Background helpers keep working after the turn: show that, so "I'm building your plan" is visibly true.
    if (core.helpers.runningCount(athleteId) > 0) {
      core.bus.setPresence(athleteId, 'working');
      core.bus.publish(athleteId, { t: 'progress', turnId, label: BACKGROUND_LABEL });
    } else core.bus.setPresence(athleteId, 'idle');

    // history (best effort)
    const days = new Set<string>([epochDate(now, tz, '00:00'), ...triggers.map((t) => epochDate(new Date(t.ts), tz, '00:00'))]);
    void renderHistory({ paths: core.paths(athleteId), store, athleteId, tz, days: [...days] }).catch((e) => core.log.warn('history render failed', { error: (e as Error).message }));

    // nightly consolidation closes the day's epoch so tomorrow starts from the new briefing
    if (cls === 'consolidation' && status === 'ok') {
      await dumpDb(core.paths(athleteId).workspace).catch(() => '');
      await openWorkspaceGit(core.paths(athleteId).workspace, core.clock)
        .commitAll('nightly: database dump', { Kind: 'turn', 'Turn-Id': turnId })
        .catch(() => null);
      await closeOpenEpoch(core, athleteId, 'day_boundary');
    } else if (lastPromptTokens > core.config.limits.compactionTriggerTokens) {
      await this.compact(athleteId, ep, route, [...ep.items, ...newItems, ...result.newItems], executor.specs()).catch((e) =>
        core.log.warn('compaction failed', { athleteId, error: (e as Error).message }),
      );
    }

    return { turnId, status, finalText: result.finalText, replyTexts: msgState.sentTexts, costUsd: result.costUsd };
  }

  // ------------------------------------------------------------------ helpers

  private async collectImages(athleteId: string, triggers: AnyEvent[]): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];
    for (const t of triggers) {
      for (const b of imageBlobsOf(t)) {
        if (parts.length >= MAX_IMAGES_PER_TURN * 2) break;
        try {
          const data = await this.core.deps.blobs.read(athleteId, b.sha256);
          const prepared = await this.core.media.prepareImage(data, b.mime);
          parts.push({ type: 'text', text: `Image ${rawPath(b)}:` });
          parts.push({ type: 'image', mediaType: prepared.mediaType, data: Buffer.from(prepared.data).toString('base64'), ref: rawPath(b) });
        } catch (e) {
          parts.push({ type: 'text', text: `(Could not load image ${rawPath(b)}: ${(e as Error).message})` });
        }
      }
    }
    return parts;
  }

  private async readWorkspaceFile(athleteId: string, rel: string): Promise<string | undefined> {
    try {
      return await this.core.fsFor(athleteId).readText(`/workspace/${rel}`);
    } catch {
      return undefined;
    }
  }

  private async nudge(athleteId: string, triggers: AnyEvent[]): Promise<string | undefined> {
    if (triggers.some((t) => t.type === 'call.ended')) return 'You just had a call. Record anything that matters for later in your notes (pinned files, journal).';
    const n = Number((await this.core.store.getKv(`turns-since-pinned-write:${athleteId}`)) ?? '0');
    if (n >= NUDGE_AFTER_TURNS) return `${n} turns since you last updated your pinned files. Consider whether anything you learned recently belongs in them.`;
    return undefined;
  }

  private async trackPinnedWrites(athleteId: string, files: string[]): Promise<void> {
    const key = `turns-since-pinned-write:${athleteId}`;
    let pinned: string[] = [];
    try {
      pinned = await readPinnedList(this.core.paths(athleteId).workspace);
    } catch {
      pinned = [];
    }
    const touched = files.some((f) => pinned.includes(f) || f === 'AGENTS.md');
    const n = Number((await this.core.store.getKv(key)) ?? '0');
    await this.core.store.setKv(key, String(touched ? 0 : n + 1));
  }

  private async noticeOnce(athleteId: string, kind: 'budget_exhausted' | 'allowance_exhausted', text: string): Promise<void> {
    const settings = await this.core.store.getSettings(athleteId);
    const day = epochDate(this.core.clock.now(), settings.profile.tz, '00:00');
    const key = `notice:${kind}:${athleteId}`;
    if ((await this.core.store.getKv(key)) === day) return;
    await this.core.store.setKv(key, day);
    const e = await this.core.store.appendEvent({ athleteId, type: 'harness.notice', actor: 'harness', payload: { kind, athleteVisible: true, text } });
    this.core.bus.publish(athleteId, { t: 'event', event: e });
    this.core.bus.publish(athleteId, { t: 'notice', kind, text });
  }

  /** [RT-4]: harness-authored fallback + a retry wake. */
  private async replyFallback(athleteId: string, triggers: AnyEvent[], reason: string): Promise<void> {
    const core = this.core;
    const text = "Your coach couldn't respond just now and will follow up shortly.";
    const e = await core.store.appendEvent({ athleteId, type: 'harness.notice', actor: 'harness', payload: { kind: 'reply_fallback', athleteVisible: true, text, detail: { reason } } });
    core.bus.publish(athleteId, { t: 'event', event: e });
    core.bus.publish(athleteId, { t: 'notice', kind: 'reply_fallback', text });
    const ref = triggers.find((t) => t.actor === 'athlete');
    await core.scheduler.harnessWake(
      athleteId,
      new Date(core.clock.now().getTime() + 10 * 60_000),
      `Follow-up (set by the harness): your previous turn ended without replying to the athlete${ref ? ` (event ${ref.id})` : ''}. Reply to them now. Reason: ${reason.slice(0, 300)}`,
    );
  }

  /** Harness compaction (SPEC [CTX-2]): summarize the epoch and roll over to a new one. */
  private async compact(athleteId: string, ep: EpochState, route: ResolvedModel[], items: ConvItem[], tools: ReturnType<ReturnType<typeof createExecutor>['specs']>): Promise<void> {
    const model = route[0]!;
    const ask: HarnessItem = {
      kind: 'harness',
      text:
        'Your context for today is getting long. Write a concise summary (at most ~600 words) of this context so far: what happened, what you decided and why, ' +
        "open threads and commitments, anything you must not forget. It replaces the detailed transcript for the rest of today. Reply with the summary text only; don't call tools.",
    };
    let summary = '';
    for await (const ev of model.provider.stream({ model: model.model, system: ep.system, items: [...items, ask], tools, effort: 'low', maxOutputTokens: 2500, cacheKey: athleteId })) {
      if (ev.type === 'text_delta') summary += ev.text;
      if (ev.type === 'message_end') {
        void this.core.store.recordUsage({
          athleteId,
          at: this.core.clock.now().toISOString(),
          provider: model.provider.id,
          model: model.model,
          tier: model.tier,
          kind: 'turn',
          usage: ev.usage,
          costUsd: this.core.deps.router.cost(model.model, ev.usage),
        });
      }
    }
    if (!summary.trim()) summary = '(Automatic compaction produced no summary. Use search_history and /history for earlier details from today.)';
    await closeOpenEpoch(this.core, athleteId, 'compaction', summary.trim());
  }
}

export function imageBlobsOf(e: AnyEvent) {
  if (e.type === 'user.upload') return e.payload.blobs.filter(isImage);
  if (e.type === 'user.message') return e.payload.attachments.filter(isImage);
  return [];
}

/** Commit subject shown in the athlete's "coach's changes" feed (never the private turn note). */
export function describeChanges(files: string[]): string {
  if (files.length === 0) return 'Coach turn';
  const nice = files.map((f) => f.replace(/^\.\//, ''));
  const head = nice.slice(0, 3).join(', ');
  return `Updated ${head}${nice.length > 3 ? ` (+${nice.length - 3} more)` : ''}`;
}

/** Drop large base64 image payloads from stored turn contexts (replay keeps placeholders). */
function compactForStorage(items: ConvItem[]): ConvItem[] {
  const json = JSON.stringify(items);
  if (json.length < 4_000_000) return items;
  return items.map((it) =>
    it.kind === 'user'
      ? { ...it, parts: it.parts.map((p) => (p.type === 'image' ? { type: 'text' as const, text: `[image ${p.ref ?? ''} omitted from stored context]` } : p)) }
      : it,
  );
}
