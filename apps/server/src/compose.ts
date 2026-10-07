import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SystemClock, consoleLogger, type Clock, type Logger, type ModelProvider, type ServerConfig, type UiRenderer, type ImageProvider } from '@opencoach/protocol';
import { createAgentLoop, createAnthropicProvider, createCompatibleProvider, createImageProvider, createModelRouter, createOpenAIProvider, createScriptedProvider, demoCoachHandler } from '@opencoach/engine';
import { createCoachRuntime, createSafetyScreen, createWebSearchBackend } from '@opencoach/runtime';
import { createSandboxProvider } from '@opencoach/sandbox';
import { openSqliteStore } from '@opencoach/store';
import { createPlaywrightRenderer, chromiumAvailable, kitDistDir, kitDocsDir } from '@opencoach/ui-kit';
import { createCallService, createOpenAIRealtimeProvider, createSynthesizer, createTranscriber } from '@opencoach/voice';
import { createFsBlobStore, exportAthlete, stripImageLocation } from '@opencoach/workspace';
import { isDemoConfig, loadConfigDetailed, type LoadConfigOptions } from './config';
import { createGateway } from './gateway';
import { DEFAULT_SEED_ROOT, DEFAULT_WEB_DIST } from './paths';
import { createPushDelivery, createWebPushProvider } from './push';
import { SetupCodeManager } from './setup-code';
import { createTelegramAdapter } from './telegram';

export interface ComposeOptions {
  config?: ServerConfig;
  loadConfig?: LoadConfigOptions;
  clock?: Clock;
  logger?: Logger;
  seedRoot?: string;
  webDist?: string;
  /** Tests can disable Chromium; production detects installed Chromium. */
  renderer?: UiRenderer | false;
  /** Tests can inject a controlled image service; credentials never enter the runtime sandbox. */
  imageProvider?: ImageProvider;
  manualScheduler?: boolean;
  printSetupCode?: (text: string) => void;
}

/** Trusted composition root. Provider credentials are never passed into sandbox configuration [SEC-2]. */
export async function composeServer(opts: ComposeOptions = {}) {
  const loaded = opts.config ? { config: opts.config, warnings: [] } : loadConfigDetailed(opts.loadConfig);
  const config = loaded.config;
  const clock = opts.clock ?? new SystemClock();
  const logger = opts.logger ?? consoleLogger({ component: 'server' }, config.logLevel);
  for (const warning of loaded.warnings) logger.warn(warning);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = await openSqliteStore({ path: join(config.dataDir, 'system.db'), clock });
  const cleanup: Array<() => Promise<unknown>> = [() => store.close()];
  try {
    const blobs = createFsBlobStore({ dataDir: config.dataDir, store, clock });
    const sandbox = await createSandboxProvider(config.sandbox);
    cleanup.unshift(() => sandbox.dispose());
    const providers: Record<string, ModelProvider> = {};
    if (isDemoConfig(config)) providers.scripted = createScriptedProvider({ handler: demoCoachHandler() });
    else {
      if (config.providers.anthropic?.apiKey) providers.anthropic = createAnthropicProvider({ ...config.providers.anthropic, apiKey: config.providers.anthropic.apiKey });
      if (config.providers.openai?.apiKey) providers.openai = createOpenAIProvider({ ...config.providers.openai, apiKey: config.providers.openai.apiKey });
      for (const provider of config.providers.compatible) providers[provider.id] = createCompatibleProvider(provider);
      if (config.providers.scripted) providers.scripted = createScriptedProvider({ handler: demoCoachHandler() });
    }
    if (!config.models) throw new Error('No model tiers configured; load configuration through loadConfig()');
    const router = createModelRouter(config.models, providers);
    for (const tier of ['coach', 'deep', 'fast'] as const) router.route(tier);
    const kitDir = await kitDistDir();
    const docs = kitDocsDir();
    const extraSystemDocs = Object.fromEntries(['ui-kit', 'bridge', 'views'].map((name) => [`${name}.md`, join(docs, `${name}.md`)]).filter(([, file]) => existsSync(file!)));
    const browserPath = process.env.OPENCOACH_CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    const renderer = opts.renderer === false ? undefined : opts.renderer ?? (chromiumAvailable(browserPath) ? createPlaywrightRenderer({ executablePath: browserPath }) : undefined);
    if (renderer) cleanup.unshift(() => renderer.dispose());
    else logger.warn('Chromium unavailable: UI previews and publication are disabled. Install Chromium or set OPENCOACH_CHROMIUM_PATH.');
    const apiKey = config.providers.openai?.apiKey;
    const transcriber = createTranscriber(config.voice.stt, apiKey);
    const synthesizer = createSynthesizer(config.voice.tts, apiKey);
    const realtime = apiKey ? createOpenAIRealtimeProvider({ apiKey, baseUrl: config.providers.openai?.baseUrl, clock, logger }) : undefined;
    const push = await createWebPushProvider({ dataDir: config.dataDir, subject: config.push.vapidSubject });
    const pushDelivery = createPushDelivery({ store, provider: push, logger });
    let telegram: ReturnType<typeof createTelegramAdapter> | undefined;
    const webSearch = createWebSearchBackend(config.web.search);
    const imageProvider = opts.imageProvider ?? createImageProvider(config.imageGeneration);
    const runtime = createCoachRuntime({ config, clock, logger, store, blobs, sandbox, router,
      loop: createAgentLoop({ price: (model, usage) => router.cost(model, usage) }),
      seedRoot: opts.seedRoot ?? DEFAULT_SEED_ROOT, pack: 'general', kitDir, extraSystemDocs, renderer,
      webSearch, safety: createSafetyScreen({ router, useModel: config.safety.modelScreen }), synthesizer,
      imageProvider,
      delivery: async (athleteId, message, context) => {
        await pushDelivery(athleteId, message, context);
        await telegram?.delivery(athleteId, message);
      }, manualScheduler: opts.manualScheduler,
    });
    cleanup.unshift(() => runtime.stop());
    const calls = createCallService({ runtime, store, blobs, clock, logger, dataDir: config.dataDir, config: config.voice, realtime, transcriber, synthesizer });
    cleanup.unshift(() => calls.dispose());
    if (config.telegram?.botToken) {
      telegram = createTelegramAdapter({ token: config.telegram.botToken, store, clock, runtime, logger });
      cleanup.unshift(() => telegram!.stop());
    }
    const setupCodes = new SetupCodeManager({ store, clock, dataDir: config.dataDir, logger, publicUrl: config.publicUrl, print: opts.printSetupCode });
    const gateway = await createGateway({ config, clock, logger, store, blobs, runtime, callService: calls,
      setupCodes, kitDir, webDist: opts.webDist ?? DEFAULT_WEB_DIST, features: { demoMode: isDemoConfig(config), webSearch: !!webSearch, imageGeneration: !!imageProvider },
      vapidPublicKey: push.publicKey?.(), exportAthlete, stripImageLocation,
      telegram, onAthleteDeleting: async (athleteId) => { await telegram?.unlink(athleteId); },
    });
    cleanup.unshift(() => gateway.views.close(), () => gateway.app.close());
    await runtime.start();
    await setupCodes.ensure();
    telegram?.start();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const fn of cleanup) try { await fn(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Server shutdown failed');
    };
    return { config, clock, logger, store, blobs, sandbox, renderer, runtime, calls, push, gateway,
      async listen() {
        try {
          await gateway.views.listen({ host: config.host, port: config.viewsPort });
          await gateway.app.listen({ host: config.host, port: config.port });
          logger.info('OpenCoach listening', { publicUrl: config.publicUrl, viewsUrl: config.viewsUrl, demoMode: isDemoConfig(config), sandbox: sandbox.kind });
        } catch (error) { await close(); throw error; }
      }, close,
    };
  } catch (error) {
    for (const fn of cleanup) await fn().catch(() => {});
    throw error;
  }
}

export type ComposedServer = Awaited<ReturnType<typeof composeServer>>;
