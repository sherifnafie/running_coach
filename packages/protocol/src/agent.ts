import type { ContentPart, ConvItem, HarnessItem, SystemBlock, ToolCallPart, ToolResult, UserItem } from './conversation';
import type { Effort } from './common';
import type { ResolvedModel, ToolSpec, Usage } from './model';

/**
 * AgentLoop contract (SPEC §5.2, §5.8, Appendix C §C.6). The engine runs one TURN: repeated model
 * calls with tool execution in between, until the model ends its turn or a limit is hit.
 * The runtime owns context assembly, policies, persistence; the engine owns the loop mechanics.
 */

export interface ToolExecutor {
  /** Tool specs exposed to the model for this turn. */
  specs(): ToolSpec[];
  /** Execute one call. MUST NOT throw: failures become isError results. */
  execute(call: ToolCallPart, signal: AbortSignal): Promise<ToolResult>;
}

/** Athlete events that arrived during a turn, injected at the next tool boundary (SPEC [RT-3]). */
export interface SteeringSource {
  /** Pending athlete input plus trusted runtime notes about the updated tool context. */
  drain(): Array<UserItem | HarnessItem>;
}

export interface TurnLimits {
  maxSteps: number;
  maxWallMs: number;
  /** Optional hard USD cap for this turn. */
  maxCostUsd?: number;
}

export type TurnStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; name: string; partialJson: string }
  | { type: 'tool_call_end'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; isError: boolean }
  | { type: 'item'; item: ConvItem }
  | { type: 'step_end'; step: number; usage: Usage; costUsd: number; provider: string; model: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string };

export interface RunTurnInput {
  turnId: string;
  /** Primary model first, then fallbacks (SPEC [RT-7]). */
  route: ResolvedModel[];
  system: SystemBlock[];
  /** Existing context (epoch transcript incl. this turn's trigger items). Not mutated. */
  items: ConvItem[];
  tools: ToolExecutor;
  limits: TurnLimits;
  steering?: SteeringSource;
  effort?: Effort;
  cacheKey?: string;
  signal?: AbortSignal;
  onEvent?: (e: TurnStreamEvent) => void;
  /**
   * Called before each model call after the first; may return extra harness items to append
   * (e.g. "you are near the step limit" or reply reminders). Must be append-only.
   */
  beforeStep?: (info: { step: number; elapsedMs: number; costUsd: number; items: ConvItem[] }) => ConvItem[] | undefined;
  /** Sleep function for retry backoff (inject for tests). Defaults to setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Max retries per model before falling back (default 2). */
  maxRetries?: number;
}

export type TurnStopReason = 'end_turn' | 'max_steps' | 'max_wall' | 'max_cost' | 'aborted' | 'error' | 'refusal' | 'max_tokens';

export interface RunTurnResult {
  /** Items appended during this turn (assistant, tool_results, steering user items, harness notes). */
  newItems: ConvItem[];
  stopReason: TurnStopReason;
  /** Concatenated assistant text of the final model message (the private "turn note", SPEC [MSG-1]). */
  finalText: string;
  usage: Usage;
  costUsd: number;
  steps: number;
  provider: string;
  model: string;
  /** "provider:model" entries that were used as fallbacks. */
  fallbacks: string[];
  error?: string;
}

export interface AgentLoop {
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
}

/** Helper to build a text-only tool result. */
export function toolResultText(callId: string, name: string, text: string, isError = false): ToolResult {
  return { callId, name, isError, content: [{ type: 'text', text }] };
}

export function toolResultParts(callId: string, name: string, content: ContentPart[], isError = false): ToolResult {
  return { callId, name, isError, content };
}
