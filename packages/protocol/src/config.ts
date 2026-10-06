import { z } from 'zod';
import { ModelsConfig } from './model';
import { VoiceConfig } from './voice';

export const HARNESS_VERSION = '0.1.0';
export const UI_KIT_MAJOR = '1';
const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'invalid HTTP header name');

/**
 * Server configuration. Loaded from YAML (opencoach.config.yaml) + environment overrides by
 * apps/server. Secrets come from env (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, ...).
 */
export const CompatibleProviderConfig = z.object({
  /** Provider id used in tier config, e.g. "deepseek", "ollama", "openrouter". */
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
});
export type CompatibleProviderConfig = z.infer<typeof CompatibleProviderConfig>;

export const LimitsConfig = z
  .object({
    reactiveMaxSteps: z.number().int().positive().default(60),
    otherMaxSteps: z.number().int().positive().default(80),
    reactiveMaxWallMs: z.number().int().positive().default(300_000),
    otherMaxWallMs: z.number().int().positive().default(1_200_000),
    debounceIdleMs: z.number().int().nonnegative().default(2500),
    debounceMaxMs: z.number().int().nonnegative().default(8000),
    pinnedTokenCap: z.number().int().positive().default(12_000),
    briefingTokenCap: z.number().int().positive().default(6_000),
    compactionTriggerTokens: z.number().int().positive().default(80_000),
    helperMaxSteps: z.number().int().positive().default(40),
    helperMaxWallMs: z.number().int().positive().default(900_000),
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
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Run the built-in scripted demo coach (no API keys required). */
  demo: z.boolean().default(false),
  models: ModelsConfig.optional(),
  providers: z
    .object({
      anthropic: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          /** Server-side refusal fallbacks (beta) — on by default per Anthropic guidance. */
          serverSideFallbacks: z.boolean().default(true),
          /** "updates" streams short progress notes between tool calls (beta). */
          thinkingDisplay: z.enum(['omitted', 'summarized', 'updates']).default('updates'),
        })
        .optional(),
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
  voice: VoiceConfig.prefault({}),
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
