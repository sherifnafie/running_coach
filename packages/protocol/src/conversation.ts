/**
 * Provider-neutral conversation model used by the agent engine (SPEC §5.3, §5.7).
 *
 * An epoch transcript is an append-only list of ConvItems. Provider adapters convert these to
 * native request formats. Assistant items carry the provider-native content (`raw`) so that the
 * SAME provider+model can replay it byte-for-byte (required for reasoning/thinking blocks bound to
 * the producing model). Adapters MUST ignore `raw` from a different provider/model and rebuild
 * from `parts` instead (dropping reasoning) — SPEC [MOD-3].
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      /** base64 (no data: prefix) */
      data: string;
      /** Optional virtual path / blob ref for traceability (e.g. "/raw/<sha>.png"). */
      ref?: string;
    };

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export type AssistantPart = { type: 'text'; text: string } | ToolCallPart;

export interface UserItem {
  kind: 'user';
  parts: ContentPart[];
}

/**
 * Harness-authored context (situation report, notices, reminders). Adapters map this to the
 * strongest operator channel available: a mid-conversation system message where supported
 * (e.g. Anthropic `role: "system"` in messages), a `developer` message (OpenAI Responses), or a
 * clearly delimited <harness> block in a user message otherwise.
 */
export interface HarnessItem {
  kind: 'harness';
  text: string;
}

export interface AssistantItem {
  kind: 'assistant';
  parts: AssistantPart[];
  provider: string;
  model: string;
  /** Provider-native content for exact replay (only by the same provider+model). */
  raw?: unknown;
  /** Optional reasoning summary text for traces (never sent back to a different model). */
  reasoningSummary?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  isError: boolean;
  content: ContentPart[];
}

export interface ToolResultsItem {
  kind: 'tool_results';
  results: ToolResult[];
}

export type ConvItem = UserItem | HarnessItem | AssistantItem | ToolResultsItem;

/** Stable system prompt block. `cache: true` places a cache breakpoint after this block. */
export interface SystemBlock {
  text: string;
  cache: boolean;
}

export function textPart(text: string): ContentPart {
  return { type: 'text', text };
}

export function itemText(item: ConvItem): string {
  switch (item.kind) {
    case 'user':
      return item.parts.map((p) => (p.type === 'text' ? p.text : `[image${p.ref ? ` ${p.ref}` : ''}]`)).join('\n');
    case 'harness':
      return item.text;
    case 'assistant':
      return item.parts
        .map((p) => (p.type === 'text' ? p.text : `[tool_call ${p.name} ${JSON.stringify(p.input)}]`))
        .join('\n');
    case 'tool_results':
      return item.results
        .map((r) => `[tool_result ${r.name}${r.isError ? ' ERROR' : ''}] ${r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n')}`)
        .join('\n');
  }
}

/** Rough token estimate (chars/3.6, images ~1600). Calibrated against provider usage later. */
export function estimateTokens(input: string | ConvItem | ConvItem[] | SystemBlock[]): number {
  if (typeof input === 'string') return Math.ceil(input.length / 3.6);
  if (Array.isArray(input)) {
    let n = 0;
    for (const x of input as Array<ConvItem | SystemBlock>) n += 'kind' in x ? estimateTokens(x) : estimateTokens(x.text);
    return n;
  }
  let n = 0;
  const visit = (parts: Array<ContentPart | AssistantPart>) => {
    for (const p of parts) {
      if (p.type === 'text') n += Math.ceil(p.text.length / 3.6);
      else if (p.type === 'image') n += 1600;
      else n += Math.ceil(JSON.stringify(p.input ?? null).length / 3.6) + 10;
    }
  };
  switch (input.kind) {
    case 'user':
      visit(input.parts);
      break;
    case 'harness':
      n += Math.ceil(input.text.length / 3.6);
      break;
    case 'assistant':
      visit(input.parts);
      break;
    case 'tool_results':
      for (const r of input.results) visit(r.content);
      break;
  }
  return n + 4;
}
