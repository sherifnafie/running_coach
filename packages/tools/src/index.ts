/**
 * @opencoach/tools — model-facing tool definitions (SPEC §7, Appendix C §C.2). Thin adapters over
 * the ToolContext ports implemented by the runtime. Input validation (zod) happens in the runtime's
 * executor via `executeTool` below.
 */
import { toToolJsonSchema, type AgentKind, type ToolContext, type ToolDef, type ToolName, type ToolOutcome, type ToolSpec } from '@opencoach/protocol';
import { bashTool, editTool, globTool, grepTool, readTool, writeTool } from './fs-tools';
import {
  cancelScheduleTool,
  cancelTaskTool,
  consultCoachTool,
  endCallTool,
  listSchedulesTool,
  lookupTool,
  noReplyTool,
  noteTool,
  previewUiTool,
  publishUiTool,
  rollbackUiTool,
  scheduleTool,
  searchHistoryTool,
  sendMessageTool,
  setHeartbeatTool,
  setPreferencesTool,
  generateImageTool,
  spawnAgentTool,
  taskStatusTool,
  webFetchTool,
  webSearchTool,
  weatherTool,
} from './coach-tools';

const DEFS: ToolDef[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  sendMessageTool,
  noReplyTool,
  scheduleTool,
  listSchedulesTool,
  cancelScheduleTool,
  setHeartbeatTool,
  setPreferencesTool,
  generateImageTool,
  spawnAgentTool,
  taskStatusTool,
  cancelTaskTool,
  previewUiTool,
  publishUiTool,
  rollbackUiTool,
  webSearchTool,
  webFetchTool,
  weatherTool,
  searchHistoryTool,
  lookupTool,
  consultCoachTool,
  noteTool,
  endCallTool,
] as ToolDef[];

const BY_NAME = new Map<string, ToolDef>(DEFS.map((d) => [d.name, d]));

export function allToolDefs(): ToolDef[] {
  return [...DEFS];
}

export function toolDef(name: ToolName): ToolDef {
  const d = BY_NAME.get(name);
  if (!d) throw new Error(`unknown tool: ${name}`);
  return d;
}

export function hasTool(name: string): name is ToolName {
  return BY_NAME.has(name);
}

/** Specs for the tools available to an agent kind (optionally restricted to an allowlist). */
export function toolSpecsFor(kind: AgentKind, allow?: ToolName[]): ToolSpec[] {
  return DEFS.filter((d) => d.availableTo.includes(kind) && (!allow || allow.includes(d.name))).map(specOf);
}

const specCache = new Map<string, ToolSpec>();
export function specOf(d: ToolDef): ToolSpec {
  let s = specCache.get(d.name);
  if (!s) {
    s = { name: d.name, description: d.description, inputSchema: toToolJsonSchema(d.input) };
    specCache.set(d.name, s);
  }
  return s;
}

/** Validate input with the tool's zod schema, then execute. Never throws. */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const def = BY_NAME.get(name);
  if (!def) return { ok: false, code: 'NOT_ALLOWED', message: `Unknown tool "${name}".` };
  if (!def.availableTo.includes(ctx.agent.kind)) return { ok: false, code: 'NOT_ALLOWED', message: `Tool "${name}" is not available to ${ctx.agent.kind} agents.` };
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, code: 'INVALID_INPUT', message: `Invalid input for ${name}: ${issues}` };
  }
  try {
    return await (def.execute as (input: unknown, ctx: ToolContext) => Promise<ToolOutcome>)(parsed.data, ctx);
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message ?? String(e) };
  }
}

export { bashTool, editTool, globTool, grepTool, readTool, writeTool };

export { formatWeather } from './coach-tools';
