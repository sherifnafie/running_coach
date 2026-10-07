import { z } from 'zod';
import { AgentKind, Effort, IsoDateTime, LocalTime, Tier, TriggerClass, type Logger, type MountRoot } from './common';
import type { Clock } from './clock';
import type { ContentPart } from './conversation';
import { MicroUI } from './microui';
import { PresentationPatch } from './settings';
import { ScheduleSpec, type ScheduleRecord } from './schedule';
import type { PreviewReport } from './views';
import type { ExecResult } from './sandbox';

/**
 * Tools (SPEC §7, Appendix C §C.2). Input schemas are MODEL-FACING → snake_case keys.
 * Tool implementations live in @opencoach/tools; they are thin adapters over the Ports below,
 * which the runtime implements (policies, persistence, delivery).
 */

// ------------------------------------------------------------------ input schemas

export const ToolInputs = {
  read: z.object({
    path: z.string().describe('Virtual path. Absolute under /workspace, /raw, /history, /system, or relative to /workspace.'),
    offset: z.number().int().min(0).optional().describe('Line offset (0-based) for text files.'),
    limit: z.number().int().min(1).max(5000).optional().describe('Max lines to return.'),
  }),
  write: z.object({ path: z.string(), content: z.string() }),
  edit: z.object({
    path: z.string(),
    old: z.string().min(1).describe('Exact text to replace (must be unique unless replace_all).'),
    new: z.string(),
    replace_all: z.boolean().optional(),
  }),
  glob: z.object({ pattern: z.string().describe('Glob, e.g. "journal/**/*.md"'), path: z.string().optional().describe('Base dir (default /workspace)') }),
  grep: z.object({
    pattern: z.string().describe('JavaScript regular expression'),
    path: z.string().optional(),
    glob: z.string().optional(),
    context: z.number().int().min(0).max(10).optional(),
    max: z.number().int().min(1).max(500).optional(),
    case_insensitive: z.boolean().optional(),
  }),
  bash: z.object({
    command: z.string().min(1),
    timeout_s: z.number().int().min(1).max(300).optional(),
    cwd: z.string().optional().describe('Virtual dir, default /workspace'),
  }),
  send_message: z.object({
    text: z.string().max(8000).describe('Markdown subset: bold, italic, lists, links, inline code. Keep it short and phone-friendly.'),
    attachments: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('blob'), sha256: z.string() }),
          z.object({ kind: z.literal('file'), path: z.string() }),
          z.object({ kind: z.literal('view_card'), view_id: z.string(), params: z.record(z.string(), z.string()).optional() }),
        ]),
      )
      .max(10)
      .optional(),
    ui: MicroUI.optional(),
    voice_note: z.boolean().optional().describe('Also deliver as a TTS audio note in your voice.'),
    notify: z.enum(['none', 'silent', 'normal']).optional(),
    reply_to: z.string().optional().describe('Event id of the athlete message this answers.'),
    during_pause: z.boolean().optional().describe('Only for safety follow-ups or the agreed return date while paused.'),
  }),
  no_reply: z.object({ reason: z.string().min(1).max(500) }),
  schedule: z.object({
    id: z.string().max(64).optional().describe('Upsert key; reuse to update an existing wake.'),
    spec: ScheduleSpec,
    purpose: z.string().min(1).max(1000).describe('Note to your future self, including any conditions to check at wake time.'),
    payload: z.unknown().optional(),
    during_pause: z.boolean().optional(),
  }),
  list_schedules: z.object({}),
  cancel_schedule: z.object({ id: z.string() }),
  set_heartbeat: z.object({ time: LocalTime.optional(), enabled: z.boolean().optional() }),
  set_preferences: PresentationPatch,
  spawn_agent: z.object({
    task: z.string().min(1).max(20_000),
    profile: z.string().max(64).optional().describe('Helper profile name in /workspace/agents/<profile>.md'),
    tier: Tier.optional(),
    effort: Effort.optional().describe('Requested reasoning effort. Used only where the selected provider supports it.'),
    inputs: z.array(z.string()).max(50).optional(),
    write_scope: z.array(z.string()).max(20).optional().describe('Globs under /workspace the helper may modify. Default: read-only.'),
    tools: z.array(z.string()).max(20).optional(),
    background: z.boolean().optional(),
    budget_usd: z.number().positive().max(20).optional(),
  }),
  task_status: z.object({ task_id: z.string() }),
  cancel_task: z.object({ task_id: z.string() }),
  preview_ui: z.object({ views: z.array(z.string()).max(20).optional() }),
  publish_ui: z.object({ views: z.array(z.string()).max(20).optional(), summary: z.string().min(1).max(500) }),
  rollback_ui: z.object({ view_id: z.string(), to_version: z.string().optional() }),
  web_search: z.object({ query: z.string().min(1).max(400), max_results: z.number().int().min(1).max(10).optional() }),
  web_fetch: z.object({ url: z.string().url(), prompt: z.string().max(1000).optional() }),
  search_history: z.object({
    query: z.string().min(1).max(400),
    from: IsoDateTime.optional(),
    to: IsoDateTime.optional(),
    types: z.array(z.string()).max(20).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  // voice-session toolset (realtime front-end only)
  lookup: z.object({ query: z.string().min(1).max(500) }),
  consult_coach: z.object({ question: z.string().min(1).max(2000), context: z.string().max(4000).optional() }),
  note: z.object({ text: z.string().min(1).max(4000) }),
  end_call: z.object({ reason: z.string().max(200).optional() }),
} as const;

export type ToolName = keyof typeof ToolInputs;
export type ToolInput<N extends ToolName> = z.infer<(typeof ToolInputs)[N]>;

export const COACH_TOOLS: ToolName[] = [
  'read', 'write', 'edit', 'glob', 'grep', 'bash',
  'send_message', 'no_reply',
  'schedule', 'list_schedules', 'cancel_schedule', 'set_heartbeat', 'set_preferences',
  'spawn_agent', 'task_status', 'cancel_task',
  'preview_ui', 'publish_ui', 'rollback_ui',
  'web_search', 'web_fetch', 'search_history',
];
/** Tools a helper may be granted (never messaging/scheduling/spawning beyond depth/publish). */
export const HELPER_GRANTABLE_TOOLS: ToolName[] = ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search', 'web_fetch', 'preview_ui', 'search_history'];
export const VOICE_TOOLS: ToolName[] = ['lookup', 'consult_coach', 'note', 'end_call'];

// ------------------------------------------------------------------ errors

export const ToolErrorCode = z.enum([
  'INVALID_INPUT',
  'EACCES',
  'ENOENT',
  'EISDIR',
  'ETOOBIG',
  'EOUTOFSCOPE',
  'NOT_UNIQUE',
  'TIMEOUT',
  'NOT_ALLOWED',
  'NOT_CONFIGURED',
  'PROACTIVE_BUDGET_EXHAUSTED',
  'MIN_GAP',
  'PAUSED',
  'LIMIT',
  'GATES_FAILED',
  'NOT_FOUND',
  'INTERNAL',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  constructor(code: ToolErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type ToolOutcome =
  | { ok: true; content: ContentPart[]; data?: unknown }
  | { ok: false; code: ToolErrorCode; message: string; retryable?: boolean };

// ------------------------------------------------------------------ virtual filesystem

export interface ResolvedPath {
  virtual: string;
  host: string;
  mount: MountRoot;
}

export interface GrepMatch {
  path: string; // virtual
  line: number; // 1-based
  text: string;
  context?: { before: string[]; after: string[] };
}

/**
 * Path-jailed view over the athlete's mounts (SPEC §6.1). Relative paths resolve under /workspace.
 * /raw, /history, /system are read-only. Helpers get a write-scoped instance (SPEC [SUB-3]).
 * Errors are ToolError with codes EACCES / ENOENT / EISDIR / ETOOBIG / EOUTOFSCOPE / INVALID_INPUT.
 */
export interface VirtualFS {
  resolve(path: string, mode: 'read' | 'write'): ResolvedPath;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number; isDir: boolean; mtimeMs: number } | null>;
  glob(pattern: string, base?: string): Promise<string[]>;
  grep(opts: { pattern: string; path?: string; glob?: string; context?: number; max?: number; caseInsensitive?: boolean }): Promise<GrepMatch[]>;
  toVirtual(hostPath: string): string | null;
  /** Same mounts, restricted writes (globs relative to /workspace). null = unrestricted. */
  withWriteScope(scope: string[] | null): VirtualFS;
  readonly writeScope: string[] | null;
}

// ------------------------------------------------------------------ ports (implemented by the runtime)

export interface SandboxPort {
  exec(command: string, opts: { timeoutS: number; cwd?: string; signal?: AbortSignal }): Promise<ExecResult>;
}

export type SendMessageResult =
  | { ok: true; messageId: string; delivery: 'sent' | 'held'; heldUntil?: string }
  | { ok: false; code: ToolErrorCode; message: string };

export interface MessagingPort {
  send(input: ToolInput<'send_message'>): Promise<SendMessageResult>;
  noReply(reason: string): void;
}

export interface SchedulerPort {
  upsert(input: ToolInput<'schedule'>): Promise<{ scheduleId: string; nextFireAt: string | null }>;
  list(): Promise<ScheduleRecord[]>;
  cancel(id: string): Promise<void>;
  setHeartbeat(input: ToolInput<'set_heartbeat'>): Promise<{ enabled: boolean; time: string }>;
}

export type SpawnAgentResult =
  | { ok: true; taskId: string; background: true }
  | { ok: true; taskId: string; background: false; summary: string; outputs: string[]; costUsd: number; reverted?: string[] }
  | { ok: false; code: ToolErrorCode; message: string };

export interface HelperPort {
  spawn(input: ToolInput<'spawn_agent'>, signal?: AbortSignal): Promise<SpawnAgentResult>;
  status(taskId: string): Promise<{ state: 'running' | 'done' | 'failed' | 'cancelled'; summary?: string; outputs?: string[]; error?: string } | null>;
  cancel(taskId: string): Promise<boolean>;
}

export type PublishResult =
  | { ok: true; published: Array<{ viewId: string; version: string }>; report: PreviewReport }
  | { ok: false; report: PreviewReport; message: string };

export interface UiPort {
  preview(views?: string[]): Promise<PreviewReport>;
  publish(views: string[] | undefined, summary: string): Promise<PublishResult>;
  rollback(viewId: string, toVersion?: string): Promise<{ viewId: string; version: string }>;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebPort {
  search(query: string, maxResults: number): Promise<WebSearchResult[]>;
  fetch(url: string, prompt?: string): Promise<{ url: string; title?: string; text: string }>;
}

export interface HistoryHit {
  eventId: string;
  ts: string;
  type: string;
  snippet: string;
}

export interface HistoryPort {
  search(input: ToolInput<'search_history'>): Promise<HistoryHit[]>;
}

export interface VoiceCallPort {
  lookup(query: string): Promise<string>;
  consult(question: string, context?: string): Promise<string>;
  note(text: string): Promise<void>;
  endCall(reason?: string): Promise<void>;
}

/** Everything a tool can touch. Built per call by the runtime. */
export interface ToolContext {
  athleteId: string;
  turnId: string;
  callId: string;
  triggerClass: TriggerClass;
  agent: { kind: AgentKind; profile?: string; depth: number; taskId?: string };
  clock: Clock;
  fs: VirtualFS;
  sandbox: SandboxPort;
  messaging: MessagingPort;
  scheduler: SchedulerPort;
  helpers: HelperPort;
  ui: UiPort;
  preferences?: { update(input: import('./settings').PresentationPatch): Promise<{ locale: string; theme: string; accent: string | null }> };
  web: WebPort;
  history: HistoryPort;
  voice?: VoiceCallPort;
  log: Logger;
  signal: AbortSignal;
  /** Whether the coach's model can see images (capability routing, SPEC [MOD-1]). */
  vision: boolean;
  /** Image preparation for model input (downscale/convert). Absent → images are passed through. */
  media?: MediaPort;
}

export interface MediaPort {
  prepareImage(data: Uint8Array, mime: string): Promise<{ data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' }>;
  /** Read a host file produced by the harness itself (e.g. preview screenshots). */
  readHostFile(path: string): Promise<Uint8Array>;
}

export interface ToolDef<N extends ToolName = ToolName> {
  name: N;
  description: string;
  input: (typeof ToolInputs)[N];
  availableTo: AgentKind[];
  execute(input: ToolInput<N>, ctx: ToolContext): Promise<ToolOutcome>;
}

export const SpawnLimits = { maxDepth: 2, maxConcurrentPerAthlete: 4 } as const;

export { Effort, AgentKind, TriggerClass };
