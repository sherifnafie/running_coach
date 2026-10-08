import { z } from 'zod';
import { ModelsConfig, Pricing } from './model';
import { VoiceConfig } from './voice';
import { Effort } from './common';
import { ImageGenerationConfig } from './image-generation';

export const HARNESS_VERSION = '0.3.7';
export const UI_KIT_MAJOR = '1';
const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid HTTP header name');

/**
 * Server configuration. Loaded from YAML (opencoach.config.yaml) + environment overrides by
 * apps/server. Secrets come from env (OPENROUTER_API_KEY, OPENAI_API_KEY, ...).
 */
export const CompatibleProviderConfig = z.object({
  /** Provider id used in tier config, e.g. "ollama", "vllm". */
  id: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  /** Deployment-supplied HTTP headers, e.g. a provider-specific User-Agent. Never model input. */
  headers: z.record(HeaderName, z.string().regex(/^[^\r\n]*$/, 'header values cannot contain newlines')).optional(),
  /** Header receiving the stable conversation id from request metadata. */
  sessionHeader: HeaderName.optional(),
  vision: z.boolean().default(false),
  contextTokens: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(8192),
  /** Some providers (DeepSeek thinking mode) want reasoning_content echoed back within a tool loop. */
  replayReasoningContent: z.boolean().default(false),
  /** Opt in only for endpoints/models that accept Chat Completions reasoning_effort. */
  reasoningEfforts: z.array(Effort).optional(),
  /** DeepSeek-style thinking toggle. Omitted for endpoints without this extension. */
  thinking: z.boolean().optional(),
});
export type CompatibleProviderConfig = z.infer<typeof CompatibleProviderConfig>;

/** OpenRouter provider routing preferences (https://openrouter.ai/docs/features/provider-routing). */
export const OpenRouterRouting = z.object({
  /** Provider slugs to try in order, e.g. ["deepinfra/fp8", "together"]. */
  order: z.array(z.string()).optional(),
  allowFallbacks: z.boolean().optional(),
  /** Only route to providers that support every request parameter (tools, reasoning). */
  requireParameters: z.boolean().optional(),
  /** "deny" excludes providers that store or train on prompts. */
  dataCollection: z.enum(['allow', 'deny']).optional(),
  /** Zero-data-retention endpoints only. */
  zdr: z.boolean().optional(),
  quantizations: z.array(z.enum(['int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32', 'unknown'])).optional(),
  ignore: z.array(z.string()).optional(),
  sort: z.enum(['price', 'throughput', 'latency']).optional(),
});
export type OpenRouterRouting = z.infer<typeof OpenRouterRouting>;

/** A model offered through OpenRouter: the picker shows these, and capabilities come from here [MOD-1] [MOD-2]. */
export const ModelCatalogEntry = z.object({
  /** OpenRouter model id, e.g. "deepseek/deepseek-v4.1-flash". */
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  vision: z.boolean().default(false),
  contextTokens: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(16_384),
  /** Reasoning efforts the model accepts; empty = no reasoning control. */
  efforts: z.array(Effort).default([]),
  /** List price, used only when a response carries no provider-reported cost. */
  pricing: Pricing.optional(),
  /** Per-model routing, merged over the provider-wide preferences. */
  routing: OpenRouterRouting.optional(),
  /**
   * Request-level prompt caching for models that need it switched on (Anthropic): the breakpoint follows the end of
   * the conversation. `1h` keeps the prefix warm between messages minutes apart (writes cost 2x instead of 1.25x).
   */
  promptCache: z.enum(['5m', '1h']).optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;
export type ModelCatalogEntryInput = z.input<typeof ModelCatalogEntry>;

export const OpenRouterConfig = z.object({
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().default('OPENROUTER_API_KEY'),
  baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
  /** Sent as X-Title so usage is attributed to this app in the OpenRouter dashboard. */
  appTitle: z.string().default('OpenCoach'),
  /** Optional HTTP-Referer for attribution. Not sent when unset. */
  appUrl: z.string().url().optional(),
  routing: OpenRouterRouting.default({ dataCollection: 'deny', requireParameters: true }),
  /** Models the server offers. Omit to use the built-in vetted catalog. */
  models: z.array(ModelCatalogEntry).optional(),
  /** Catalog id for the coach and fast tiers when `models.tiers` is not configured. */
  defaultModel: z.string().optional(),
  /** Catalog id for the deep tier (background plans, reviews, research) when `models.tiers` is not configured. */
  deepModel: z.string().optional(),
  /** Per-call output ceiling (reasoning included). High effort can use most of a 16k budget before answering. */
  maxOutputTokens: z.number().int().positive().default(32_768),
});
export type OpenRouterConfig = z.infer<typeof OpenRouterConfig>;

export const LimitsConfig = z
  .object({
    reactiveMaxSteps: z.number().int().positive().default(60),
    otherMaxSteps: z.number().int().positive().default(80),
    // Hard backstop; the model is asked to wrap up at half of it, and a stalled request is retried long before.
    reactiveMaxWallMs: z.number().int().positive().default(600_000),
    otherMaxWallMs: z.number().int().positive().default(1_200_000),
    debounceIdleMs: z.number().int().nonnegative().default(2500),
    debounceMaxMs: z.number().int().nonnegative().default(8000),
    pinnedTokenCap: z.number().int().positive().default(12_000),
    briefingTokenCap: z.number().int().positive().default(6_000),
    compactionTriggerTokens: z.number().int().positive().default(80_000),
    // Background helpers do the deep work (a plan, an analysis, research), so they get room: the reply turn stays short
    // and hands this off. They are asked to wrap up at half the wall time and keep partial work if stopped.
    helperMaxSteps: z.number().int().positive().default(150),
    helperMaxWallMs: z.number().int().positive().default(3_600_000),
    bashMaxOutputBytes: z.number().int().positive().default(1_048_576),
  })
  .prefault({});
export type LimitsConfig = z.infer<typeof LimitsConfig>;

export const ServerConfig = z.object({
  dataDir: z.string().default('./.data'),
  host: z.string().default('0.0.0.0'),
  port: z.number().int().default(8080),
  viewsPort: z.number().int().default(8081),
  /** Public origin of the app (used for CORS/Origin checks, passkeys RP id, push click URLs). */
  publicUrl: z.string().default('http://localhost:8080'),
  /** Public origin of the isolated views server (SPEC [SEC-3]). Must differ from publicUrl. */
  viewsUrl: z.string().default('http://localhost:8081'),
  /**
   * Fastify `trustProxy`: set when a reverse proxy or tunnel fronts the server, so per-client limits use
   * the forwarded client address instead of the proxy's (`true`, or trusted addresses such as `loopback` or `10.0.0.0/8`).
   */
  trustProxy: z.union([z.boolean(), z.string()]).default(false),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Run the built-in scripted demo coach (no API keys required). */
  demo: z.boolean().default(false),
  models: ModelsConfig.optional(),
  providers: z
    .object({
      openrouter: OpenRouterConfig.optional(),
      /** OpenAI: voice (speech, realtime calls) only. Chat models go through OpenRouter. */
      openai: z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional(), organization: z.string().optional() }).optional(),
      compatible: z.array(CompatibleProviderConfig).default([]),
      /** Path to a scripted cassette (tests/evals); "demo" for the built-in demo coach. */
      scripted: z.object({ script: z.string().default('demo') }).optional(),
    })
    .prefault({}),
  sandbox: z
    .object({
      provider: z.enum(['local', 'docker']).default('local'),
      /** Allow the non-isolated local fallback when namespaces are unavailable (dev only). */
      allowUnsafe: z.boolean().default(false),
      docker: z
        .object({
          image: z.string().default('opencoach/sandbox:0.1.0'),
          socketPath: z.string().default('/var/run/docker.sock'),
          runtime: z.string().optional(),
          memoryMb: z.number().int().positive().default(1024),
          cpus: z.number().positive().default(1),
        })
        .prefault({}),
      /** Optional allowlisted package mirror URL (off by default). */
      packageMirror: z.string().optional(),
    })
    .prefault({}),
  web: z
    .object({
      search: z
        .object({
          provider: z.enum(['none', 'brave', 'tavily', 'searxng']).default('none'),
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
        })
        .prefault({}),
      fetch: z.object({ enabled: z.boolean().default(true), timeoutMs: z.number().int().default(15_000), maxBytes: z.number().int().default(2_000_000) }).prefault({}),
    })
    .prefault({}),
  /** Forecasts for the `weather` tool. Open-Meteo needs no key; set `enabled: false` to turn the tool off. */
  weather: z
    .object({
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(10_000),
      forecastUrl: z.string().url().default('https://api.open-meteo.com/v1/forecast'),
      geocodingUrl: z.string().url().default('https://geocoding-api.open-meteo.com/v1/search'),
      airQualityUrl: z.string().url().default('https://air-quality-api.open-meteo.com/v1/air-quality'),
    })
    .prefault({}),
  voice: VoiceConfig.prefault({}),
  imageGeneration: ImageGenerationConfig.optional(),
  push: z.object({ vapidSubject: z.string().default('mailto:admin@localhost') }).prefault({}),
  safety: z.object({ modelScreen: z.boolean().default(false) }).prefault({}),
  limits: LimitsConfig,
  /** Default settings applied to new athletes (deep-merged). */
  defaultSettings: z.unknown().optional(),
  telegram: z.object({ botToken: z.string().optional(), botTokenEnv: z.string().default('TELEGRAM_BOT_TOKEN') }).optional(),
  /**
   * MCP servers whose tools are offered to the coach (SPEC §7, Phase 2). Deployment-level (admin).
   * Tool names are exposed as mcp__<name>__<tool>; outputs are untrusted content. Check each
   * platform's terms before connecting fitness-data servers (SPEC §10.5).
   */
  mcp: z
    .object({
      servers: z
        .array(
          z.object({
            name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
            transport: z.enum(['http', 'stdio']),
            url: z.string().url().optional(),
            headers: z.record(z.string(), z.string()).default({}),
            command: z.string().optional(),
            args: z.array(z.string()).default([]),
            env: z.record(z.string(), z.string()).default({}),
            /** Only expose these tools (default: all). */
            allowTools: z.array(z.string()).optional(),
            /** Expose to helpers too (default false: coach only). */
            helpers: z.boolean().default(false),
          }),
        )
        .default([]),
    })
    .prefault({}),
  admin: z.object({ token: z.string().optional() }).optional(),
});
export type ServerConfig = z.infer<typeof ServerConfig>;
export type ServerConfigInput = z.input<typeof ServerConfig>;

/** On-disk layout under dataDir (shared by workspace, runtime and server). */
export interface AthletePaths {
  root: string;
  /** Coach-owned git repo → /workspace */
  workspace: string;
  /** Athlete-origin immutable uploads as <sha256>.<ext> + <sha256>.json sidecars → /raw (ro) */
  raw: string;
  /** Non-athlete blobs (coach attachments, TTS audio, call audio): <sha[0:2]>/<sha256> */
  blobs: string;
  /** Rendered transcripts YYYY/MM/DD.md → /history (ro) */
  history: string;
  /** coach.db snapshots */
  snapshots: string;
  /** Immutable published view versions: <viewId>/<version>/... */
  published: string;
  /** Export bundles */
  exports: string;
  /** Preview screenshots and scratch */
  tmp: string;
  /** Call transcripts/notes before they are copied into the workspace */
  calls: string;
}

export function athletePaths(dataDir: string, athleteId: string): AthletePaths {
  const root = joinPath(dataDir, 'athletes', athleteId);
  return {
    root,
    workspace: joinPath(root, 'workspace'),
    raw: joinPath(root, 'raw'),
    blobs: joinPath(root, 'blobs'),
    history: joinPath(root, 'history'),
    snapshots: joinPath(root, 'snapshots'),
    published: joinPath(root, 'published'),
    exports: joinPath(root, 'exports'),
    tmp: joinPath(root, 'tmp'),
    calls: joinPath(root, 'calls'),
  };
}

/** Shared read-only /system mount for the current harness version. */
export function systemDir(dataDir: string, harnessVersion = HARNESS_VERSION): string {
  return joinPath(dataDir, 'system', harnessVersion);
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter((p) => p.length > 0)
    .join('/');
}
