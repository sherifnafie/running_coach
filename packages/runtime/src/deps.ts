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
  /** Overrides the configured weather service (tests, other providers). */
  weather?: import('@opencoach/protocol').WeatherPort;
  safety?: SafetyScreen;
  synthesizer?: Synthesizer;
  imageProvider?: ImageProvider;
  /** Trusted per-athlete credentials; return a stable instance until its binding changes. */
  imageProviderFor?: (athleteId: string) => ImageProvider | undefined;
  delivery?: DeliveryHook;
  /**
   * Who pays for an athlete's model calls: `managed` (the deployment's or an administrator-assigned key, with a hard
   * monthly allowance) or `byok` (the athlete's own key; their budgets are soft limits they control). Without this hook every budget is soft.
   */
  billing?: (athleteId: string) => 'managed' | 'byok';
  /** Tests/evals: don't run the background scheduler loop; call tickScheduler() explicitly. */
  manualScheduler?: boolean;
}
