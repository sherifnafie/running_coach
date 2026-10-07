import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ServerConfig,
  VirtualClock,
  silentLogger,
  type AnyEvent,
  type ModelRequest,
  type StreamMessage,
  type UiRenderer,
  type PreviewReport,
  type ModelCapabilities,
  type WebSearchBackend,
  type ImageProvider,
} from '@opencoach/protocol';
import { createAgentLoop, createModelRouter, createScriptedProvider, type ScriptHandler, type ScriptedStep } from '@opencoach/engine';
import { createLocalSandboxProvider } from '@opencoach/sandbox';
import { openSqliteStore } from '@opencoach/store';
import { createFsBlobStore } from '@opencoach/workspace';
import { createCoachRuntime, type CoachRuntime } from '../src';

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** A renderer that passes every view without launching a browser. */
export const passRenderer: UiRenderer = {
  async preview(input): Promise<PreviewReport> {
    return {
      ok: true,
      globalErrors: [],
      views: input.views.map((viewId) => ({
        viewId,
        ok: true,
        staticErrors: [],
        runtimeErrors: [],
        cspViolations: [],
        a11y: { critical: 0, serious: 0, details: [] },
        perf: { firstRenderMs: 10, bundleKb: 1 },
        screenshots: [],
      })),
    };
  },
  async dispose() {},
};

export interface Harness {
  runtime: CoachRuntime;
  clock: VirtualClock;
  dataDir: string;
  stream: StreamMessage[];
  requests: ModelRequest[];
  setHandler(h: ScriptHandler): void;
  events(athleteId: string, types?: string[]): Promise<AnyEvent[]>;
  settle(athleteId?: string): Promise<void>;
  close(): Promise<void>;
}

/** Last user-item text in a request (the rendered trigger events). */
export function lastUserText(req: ModelRequest): string {
  for (let i = req.items.length - 1; i >= 0; i--) {
    const it = req.items[i]!;
    if (it.kind === 'user') return it.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return '';
}

export function lastItemKind(req: ModelRequest): string {
  return req.items[req.items.length - 1]?.kind ?? '';
}

export function situationText(req: ModelRequest): string {
  for (let i = req.items.length - 1; i >= 0; i--) {
    const it = req.items[i]!;
    if (it.kind === 'harness' && it.text.startsWith('<situation>')) return it.text;
  }
  return '';
}

export function send(text: string, extra: Record<string, unknown> = {}): ScriptedStep {
  return { toolCalls: [{ name: 'send_message', input: { text, ...extra } }] };
}

export async function makeHarness(opts: { start?: string; renderer?: UiRenderer | null; webSearch?: WebSearchBackend; imageProvider?: ImageProvider; capabilities?: Partial<ModelCapabilities>; config?: Record<string, unknown>; billing?: (athleteId: string) => 'managed' | 'byok' } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'oc-rt-'));
  const clock = new VirtualClock(opts.start ?? '2026-10-07T08:00:00Z');
  const store = await openSqliteStore({ path: ':memory:', clock });
  const blobs = createFsBlobStore({ dataDir, store, clock });
  const sandbox = await createLocalSandboxProvider({ allowUnsafe: true });
  let handler: ScriptHandler = () => ({ text: 'ok' });
  const scripted = createScriptedProvider({ id: 'scripted', capabilities: opts.capabilities, handler: (req, ctx) => handler(req, ctx) });
  const router = createModelRouter(
    { tiers: { coach: { provider: 'scripted', model: 'scripted-coach' }, fast: { provider: 'scripted', model: 'scripted-fast' } }, fallbacks: {}, pricing: {} },
    { scripted },
  );
  const config = ServerConfig.parse({ dataDir, limits: { debounceIdleMs: 0 }, ...(opts.config ?? {}) });
  const runtime = createCoachRuntime({
    config,
    clock,
    store,
    blobs,
    sandbox,
    router,
    loop: createAgentLoop({ price: (m, u) => router.cost(m, u) }),
    logger: silentLogger,
    seedRoot: join(REPO, 'seed'),
    pack: 'running',
    kitDir: join(REPO, 'packages/ui-kit/dist'),
    renderer: opts.renderer === null ? undefined : opts.renderer ?? passRenderer,
    webSearch: opts.webSearch,
    imageProvider: opts.imageProvider,
    billing: opts.billing,
    manualScheduler: true,
  });
  await runtime.start();
  const stream: StreamMessage[] = [];
  const subs: Array<() => void> = [];
  const h: Harness = {
    runtime,
    clock,
    dataDir,
    stream,
    requests: scripted.requests,
    setHandler: (fn) => (handler = fn),
    events: async (athleteId, types) => store.listEvents({ athleteId, types, limit: 1000 }),
    settle: async (athleteId) => {
      for (let i = 0; i < 5; i++) {
        await runtime.whenIdle(athleteId);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close: async () => {
      for (const s of subs) s();
      await runtime.stop();
      await sandbox.dispose();
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  const origCreate = runtime.createAthlete.bind(runtime);
  runtime.createAthlete = async (input) => {
    const a = await origCreate(input);
    subs.push(runtime.subscribe(a.id, (m) => stream.push(m)));
    return a;
  };
  return h;
}
