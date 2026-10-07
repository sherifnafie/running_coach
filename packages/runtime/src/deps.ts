import type {
  AgentLoop,
  BlobStore,
  Clock,
  DeliveryHook,
  Logger,
  ModelRouter,
  ImageProvider,
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
  /** Repo `seed/` directory and the pack to use (e.g. "general"). */
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
  imageProvider?: ImageProvider;
  delivery?: DeliveryHook;
  /** Tests/evals: don't run the background scheduler loop; call tickScheduler() explicitly. */
  manualScheduler?: boolean;
}
