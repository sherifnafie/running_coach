import { schemaSql } from '@opencoach/workspace';
import { performance } from 'node:perf_hooks';
import {
  ToolError,
  type AgentKind,
  type HelperPort,
  type HistoryPort,
  type MessagingPort,
  type SandboxPort,
  type SchedulerPort,
  type ToolCallPart,
  type ToolContext,
  type ToolExecutor,
  type ToolName,
  type ToolResult,
  type TriggerClass,
  type UiPort,
  type VirtualFS,
} from '@opencoach/protocol';
import { executeTool, toolSpecsFor } from '@opencoach/tools';
import type { Core } from './core';
import type { SpawnParent } from './helpers';
import { avatarFor, generateImage, requireIdentityPermission } from './identity';

export interface ExecutorOptions {
  athleteId: string;
  turnId: string;
  triggerClass: TriggerClass;
  agent: { kind: AgentKind; profile?: string; depth: number; taskId?: string };
  /** Allowlist of tool names exposed to the model. */
  tools: ToolName[];
  fs: VirtualFS;
  sandbox: SandboxPort;
  vision: boolean;
  /** Workspace dir used for UI previews (helpers preview their worktree). */
  workspaceDir?: string;
  /** Messaging port per tool call (coach only). */
  messagingFor?: (callId: string) => MessagingPort;
  spawnParent?: SpawnParent;
  /** Observe executions (presence/progress). */
  onStart?: (call: ToolCallPart) => void;
  onEnd?: (call: ToolCallPart, ok: boolean) => void;
}

const denied = (what: string) => () => {
  throw new ToolError('NOT_ALLOWED', `${what} is not available to helpers. Report back to the coach instead.`);
};

/** Side effects are replayed by (turn, call), including calls made by helpers [RT-6]. */
const SIDE_EFFECTS = new Set<string>([
  'write', 'edit', 'bash', 'send_message', 'no_reply', 'schedule', 'cancel_schedule', 'set_heartbeat',
  'spawn_agent', 'cancel_task', 'publish_ui', 'rollback_ui', 'set_preferences', 'generate_image',
]);

export function createExecutor(core: Core, o: ExecutorOptions): ToolExecutor & { allowed: ToolName[] } {
  const isCoach = o.agent.kind === 'coach';
  const scheduler: SchedulerPort = isCoach
    ? {
        upsert: (input) => core.scheduler.upsertCoach(o.athleteId, input, o.turnId),
        list: () => core.scheduler.list(o.athleteId),
        cancel: (id) => core.scheduler.cancel(o.athleteId, id, o.turnId),
        setHeartbeat: (input) => core.scheduler.setHeartbeat(o.athleteId, input, 'coach'),
      }
    : { upsert: denied('Scheduling'), list: denied('Scheduling'), cancel: denied('Scheduling'), setHeartbeat: denied('Scheduling') };

  const helpers: HelperPort = {
    spawn: (input, signal) => core.helpers.spawn(o.spawnParent ?? { athleteId: o.athleteId, turnId: o.turnId, depth: o.agent.depth }, input, signal),
    status: (taskId) => core.helpers.status(o.athleteId, taskId),
    cancel: (taskId) => core.helpers.cancel(o.athleteId, taskId),
  };

  const ui: UiPort = {
    preview: (views) => core.ui.preview(o.athleteId, views, o.workspaceDir),
    publish: (views, summary) => {
      if (!isCoach) throw new ToolError('NOT_ALLOWED', 'Only the coach can publish views.');
      return core.ui.publish(o.athleteId, views, summary, o.turnId);
    },
    rollback: (viewId, toVersion) => {
      if (!isCoach) throw new ToolError('NOT_ALLOWED', 'Only the coach can roll back views.');
      return core.ui.rollback(o.athleteId, viewId, toVersion, o.turnId);
    },
  };

  const history: HistoryPort = {
    search: async (q) => {
      const hits = await core.store.searchEvents({ athleteId: o.athleteId, query: q.query, from: q.from, to: q.to, types: q.types, limit: q.limit ?? 20 });
      return hits.map((h) => ({ eventId: h.event.id, ts: h.event.ts, type: h.event.type, snippet: h.snippet }));
    },
  };

  const noMessaging: MessagingPort = {
    send: async () => ({ ok: false, code: 'NOT_ALLOWED', message: 'Helpers cannot message the athlete; report back to the coach.' }),
    noReply: () => {},
  };

  const executing = new Map<string, Promise<ToolResult>>();
  const executor: ToolExecutor & { allowed: ToolName[] } = {
    allowed: o.tools,
    specs: () => [...toolSpecsFor(o.agent.kind, o.tools), ...(o.agent.kind === 'voice' ? [] : core.mcp.specs(o.agent.kind))],
    async execute(call: ToolCallPart, signal: AbortSignal): Promise<ToolResult> {
      if (!SIDE_EFFECTS.has(call.name)) return executeOnce(call, signal);
      const key = `tool:${o.athleteId}:${o.turnId}:${call.id}`;
      const pending = executing.get(key);
      if (pending) return pending;
      const job = (async () => {
        const cached = await core.store.getIdempotent(key) as ToolResult | undefined;
        if (cached) return cached;
        const result = await executeOnce(call, signal);
        // A failed postcondition or timeout can follow a completed mutation. Replaying
        // the same call must return its original result, including failures [RT-6].
        await core.store.putIdempotent(key, result, new Date(core.clock.now().getTime() + 7 * 86_400_000).toISOString());
        return result;
      })();
      executing.set(key, job);
      try {
        return await job;
      } finally {
        executing.delete(key);
      }
    },
  };
  return executor;

  async function executeOnce(call: ToolCallPart, signal: AbortSignal): Promise<ToolResult> {
      const started = performance.now();
      if (core.mcp.handles(call.name) && o.agent.kind !== 'voice') {
        o.onStart?.(call);
        const r = await core.mcp.call(call.id, call.name, call.input, o.agent.kind);
        o.onEnd?.(call, !r.isError);
        void core.store
          .audit({ athleteId: o.athleteId, at: core.clock.now().toISOString(), actor: o.agent.kind, action: `tool:${call.name}`, detail: { turnId: o.turnId, ok: !r.isError, ms: Math.round(performance.now() - started) } })
          .catch(() => {});
        return r;
      }
      if (!o.tools.includes(call.name as ToolName)) {
        return { callId: call.id, name: call.name, isError: true, content: [{ type: 'text', text: `Error [NOT_ALLOWED]: tool "${call.name}" is not available here.` }] };
      }
      o.onStart?.(call);
      const ctx: ToolContext = {
        athleteId: o.athleteId,
        turnId: o.turnId,
        callId: call.id,
        triggerClass: o.triggerClass,
        agent: o.agent,
        clock: core.clock,
        fs: o.fs,
        sandbox: o.sandbox,
        messaging: isCoach && o.messagingFor ? o.messagingFor(call.id) : noMessaging,
        scheduler,
        helpers,
        ui,
        preferences: isCoach ? { update: async (input) => {
          const identity = input.coach_name !== undefined || input.coach_avatar_sha256 !== undefined;
          if (identity) await requireIdentityPermission(core, o.athleteId, o.triggerClass);
          const avatar = input.coach_avatar_sha256 === undefined ? undefined : await avatarFor(core, o.athleteId, input.coach_avatar_sha256);
          if (identity) await requireIdentityPermission(core, o.athleteId, o.triggerClass);
          const { settings, diff } = await core.store.updateSettings(o.athleteId, {
            profile: {
              ...(input.locale === undefined ? {} : { locale: input.locale }),
              ...(input.coach_name === undefined ? {} : { coachName: input.coach_name }),
            },
            ...(avatar === undefined ? {} : { coachIdentity: { avatarSha256: avatar } }),
            appearance: {
              ...(input.theme === undefined ? {} : { theme: input.theme }),
              ...(input.accent === undefined ? {} : { accent: input.accent }),
            },
          });
          if (Object.keys(diff).length) {
            await core.store.audit({ athleteId: o.athleteId, at: core.clock.now().toISOString(), actor: 'coach', action: 'presentation.updated', detail: { turnId: o.turnId, diff } });
            core.bus.publish(o.athleteId, { t: 'settings.changed' });
          }
          return { locale: settings.profile.locale, ...settings.appearance, coachName: settings.profile.coachName, coachAvatarSha256: settings.coachIdentity.avatarSha256 };
        } } : undefined,
        images: isCoach ? { generate: (prompt, signal) => generateImage(core, o.athleteId, o.turnId, call.id, o.triggerClass, prompt, signal) } : undefined,
        web: core.web,
        weather: core.weather
          ? { forecast: async (q) => core.weather!.forecast({ ...q, units: (await core.store.getSettings(o.athleteId)).profile.units }) }
          : undefined,
        history,
        log: core.log.child({ athleteId: o.athleteId, turnId: o.turnId, tool: call.name }),
        signal,
        vision: o.vision,
        media: core.media,
      };
      const tracksSchema = isCoach && (call.name === 'bash' || call.name === 'spawn_agent');
      const readSchema = async (): Promise<string> => {
        // Validate physical containment before opening the coach-owned database on the host.
        o.fs.resolve('data/coach.db', 'read');
        return schemaSql(o.workspaceDir ?? core.paths(o.athleteId).workspace);
      };
      const beforeSchema = tracksSchema ? await readSchema().catch((error: Error) => `schema unavailable: ${error.message}`) : undefined;
      const outcome = await executeTool(call.name, call.input, ctx);
      let schemaReport: { ok: boolean; text: string } | undefined;
      if (tracksSchema && beforeSchema !== await readSchema().catch((error: Error) => `schema unavailable: ${error.message}`)) {
        schemaReport = core.deps.renderer
          ? await core.ui.revalidateAfterSchemaChange(o.athleteId).then(
              (report) => ({ ok: report.ok, text: `Database schema changed. View revalidation [UI-3]: ${report.ok ? 'passed' : 'failed; repair the affected views before publishing'}.\n${JSON.stringify(report)}` }),
              (error: Error) => ({ ok: false, text: `Database schema changed. View revalidation [UI-3] failed: ${error.message}` }),
            )
          : { ok: true, text: 'Database schema changed. Views were not re-checked [UI-3]: this server has no renderer.' };
      }
      const ms = Math.round(performance.now() - started);
      o.onEnd?.(call, outcome.ok && schemaReport?.ok !== false);
      void core.store
        .audit({
          athleteId: o.athleteId,
          at: core.clock.now().toISOString(),
          actor: o.agent.kind,
          action: `tool:${call.name}`,
          detail: { turnId: o.turnId, ok: outcome.ok, code: outcome.ok ? undefined : outcome.code, ms },
        })
        .catch(() => {});
      if (schemaReport) {
        const content = outcome.ok ? outcome.content : [{ type: 'text' as const, text: `Error [${outcome.code}]: ${outcome.message}` }];
        return { callId: call.id, name: call.name, isError: !outcome.ok || !schemaReport.ok, content: [...content, { type: 'text', text: schemaReport.text }] };
      }
      if (outcome.ok) return { callId: call.id, name: call.name, isError: false, content: outcome.content };
      return { callId: call.id, name: call.name, isError: true, content: [{ type: 'text', text: `Error [${outcome.code}]: ${outcome.message}` }] };
  }
}
