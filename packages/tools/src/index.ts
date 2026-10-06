/**
 * @opencoach/tools — model-facing tool definitions (SPEC §7, Appendix C §C.2). Thin adapters over
 * the ToolContext ports implemented by the runtime.
 *
 * STUB: signatures are final; implementation in progress (runtime work package).
 */
import type { AgentKind, ToolDef, ToolName, ToolSpec } from '@opencoach/protocol';

export function allToolDefs(): ToolDef[] {
  throw new Error('not implemented: allToolDefs');
}

export function toolDef(name: ToolName): ToolDef {
  void name;
  throw new Error('not implemented: toolDef');
}

/** Specs for the tools available to an agent kind (optionally restricted to an allowlist). */
export function toolSpecsFor(kind: AgentKind, allow?: ToolName[]): ToolSpec[] {
  void kind;
  void allow;
  throw new Error('not implemented: toolSpecsFor');
}
