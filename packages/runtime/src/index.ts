/**
 * @opencoach/runtime — the coach runtime ("mind loop", SPEC §5): per-athlete serialized event
 * loop, turn lifecycle, context assembly & epochs, policies, scheduler & heartbeat, consolidation,
 * helpers, safety screen, delivery.
 *
 * STUB: signatures are final; implementation in progress (runtime work package).
 */
import type {
  AgentLoop,
  BlobStore,
  Clock,
  CoachRuntimeAPI,
  DeliveryHook,
  Logger,
  ModelRouter,
  SafetyScreen,
  SandboxProvider,
  ServerConfig,
  Store,
  Synthesizer,
  UiRenderer,
  WebSearchBackend,
} from '@opencoach/protocol';

export interface CoachRuntimeDeps {
  config: ServerConfig;
  clock: Clock;
  store: Store;
  blobs: BlobStore;
  sandbox: SandboxProvider;
  router: ModelRouter;
  loop: AgentLoop;
  logger: Logger;
  /** Repo `seed/` directory and the pack to use (e.g. "running"). */
  seedRoot: string;
  pack: string;
  /** Built UI kit dir (served at /kit/<major>/ and used by the preview renderer). */
  kitDir: string;
  /** Extra docs to place under /system/docs (e.g. the UI kit docs). name → host path. */
  extraSystemDocs?: Record<string, string>;
  renderer?: UiRenderer;
  webSearch?: WebSearchBackend;
  safety?: SafetyScreen;
  synthesizer?: Synthesizer;
  delivery?: DeliveryHook;
}

export function createCoachRuntime(deps: CoachRuntimeDeps): CoachRuntimeAPI {
  void deps;
  throw new Error('not implemented: createCoachRuntime');
}

/** Web search backends (SPEC §7 web_search): brave | tavily | searxng; undefined for 'none'. */
export function createWebSearchBackend(cfg: ServerConfig['web']['search']): WebSearchBackend | undefined {
  void cfg;
  throw new Error('not implemented: createWebSearchBackend');
}

/** Keyword/regex red-flag screen (SPEC [SAFE-2]); optionally upgraded with a fast-tier model check. */
export function createSafetyScreen(opts: { router?: ModelRouter; useModel: boolean }): SafetyScreen {
  void opts;
  throw new Error('not implemented: createSafetyScreen');
}
