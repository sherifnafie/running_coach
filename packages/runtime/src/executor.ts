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
    spawn: (input) => core.helpers.spawn(o.spawnParent ?? { athleteId: o.athleteId, turnId: o.turnId, depth: o.agent.depth }, input),
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

  return {
    allowed: o.tools,
    specs: () => toolSpecsFor(o.agent.kind, o.tools),
    async execute(call: ToolCallPart, signal: AbortSignal): Promise<ToolResult> {
      const started = performance.now();
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
        web: core.web,
        history,
        log: core.log.child({ athleteId: o.athleteId, turnId: o.turnId, tool: call.name }),
        signal,
        vision: o.vision,
        media: core.media,
      };
      const outcome = await executeTool(call.name, call.input, ctx);
      const ms = Math.round(performance.now() - started);
      o.onEnd?.(call, outcome.ok);
      void core.store
        .audit({
          athleteId: o.athleteId,
          at: core.clock.now().toISOString(),
          actor: o.agent.kind,
          action: `tool:${call.name}`,
          detail: { turnId: o.turnId, ok: outcome.ok, code: outcome.ok ? undefined : outcome.code, ms },
        })
        .catch(() => {});
      if (outcome.ok) return { callId: call.id, name: call.name, isError: false, content: outcome.content };
      return { callId: call.id, name: call.name, isError: true, content: [{ type: 'text', text: `Error [${outcome.code}]: ${outcome.message}` }] };
    },
  };
}
