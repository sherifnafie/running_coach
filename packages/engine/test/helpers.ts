import type {
  ConvItem,
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ResolvedModel,
  RunTurnInput,
  ToolCallPart,
  ToolExecutor,
  ToolResult,
  TurnStreamEvent,
  UserItem,
} from '@opencoach/protocol';
import { toolResultText } from '@opencoach/protocol';

export const user = (text: string): UserItem => ({ kind: 'user', parts: [{ type: 'text', text }] });

export const CAPS: ModelCapabilities = {
  vision: true,
  maxContextTokens: 200_000,
  maxOutputTokens: 32_000,
  streamingToolInput: true,
  promptCaching: false,
  midConversationSystem: true,
  parallelToolCalls: true,
  efforts: ['low', 'medium', 'high'],
  batch: false,
};

export function resolved(provider: ModelProvider, model = 'model-a', extra: Partial<ResolvedModel> = {}): ResolvedModel {
  return { tier: 'coach', provider, model, maxOutputTokens: 4096, capabilities: CAPS, ...extra };
}

export type ToolHandler = (input: unknown, call: ToolCallPart, signal: AbortSignal) => ToolResult | string | Promise<ToolResult | string>;

export interface FakeTools extends ToolExecutor {
  calls: ToolCallPart[];
}

export function fakeTools(handlers: Record<string, ToolHandler> = {}, specs = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }]): FakeTools {
  const calls: ToolCallPart[] = [];
  return {
    calls,
    specs: () => specs,
    async execute(call, signal) {
      calls.push(call);
      const h = handlers[call.name];
      if (!h) return toolResultText(call.id, call.name, `unknown tool ${call.name}`, true);
      const r = await h(call.input, call, signal);
      return typeof r === 'string' ? toolResultText(call.id, call.name, r) : r;
    },
  };
}

export function baseInput(over: Partial<RunTurnInput> & Pick<RunTurnInput, 'route'>): RunTurnInput {
  return {
    turnId: 't1',
    system: [{ text: 'You are a coach.', cache: true }],
    items: [user('hello')],
    tools: fakeTools(),
    limits: { maxSteps: 10, maxWallMs: 600_000 },
    sleep: async () => undefined,
    ...over,
  };
}

export function collect(): { events: TurnStreamEvent[]; onEvent: (e: TurnStreamEvent) => void } {
  const events: TurnStreamEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

export async function drain(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

export async function* fromArray<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) yield e;
}

export function req(over: Partial<ModelRequest> = {}): ModelRequest {
  return { model: 'openai/gpt-6.1-sol', system: [], items: [user('hi')], tools: [], maxOutputTokens: 4096, ...over };
}

export const kinds = (items: ConvItem[]): string[] => items.map((i) => i.kind);
