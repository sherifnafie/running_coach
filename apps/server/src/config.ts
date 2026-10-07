import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ServerConfig, type ModelsConfig } from '@opencoach/protocol';
import { DEFAULT_OPENROUTER_MODEL } from '@opencoach/engine';

/**
 * Server configuration loader (SPEC §4.4, docs/self-hosting.md).
 *
 *   YAML (OPENCOACH_CONFIG or ./opencoach.config.yaml, optional)  +  environment overrides  →  ServerConfig.parse
 *
 * Environment variables win over YAML. Secrets (API keys) are expected to come from the environment.
 * When `models` is absent and an OpenRouter key is available, every tier uses the default catalog model (the coach's
 * reasoning effort follows the trigger class; deep work runs at max effort); with no
 * key the server falls back to the scripted demo coach and says so loudly.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Explicit YAML path (overrides OPENCOACH_CONFIG). A missing explicit file is an error. */
  path?: string;
  /** Environment (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Base directory for relative paths (defaults to process.cwd()). */
  cwd?: string;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** Human-readable startup warnings (demo mode, insecure exposure, ...). */
  warnings: string[];
  /** YAML file that was read, if any. */
  configPath?: string;
}

type Raw = Record<string, unknown>;

const DEFAULT_YAML = 'opencoach.config.yaml';

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Get-or-create a nested plain object. */
function sub(parent: Raw, key: string): Raw {
  const cur = parent[key];
  if (isObj(cur)) return cur;
  const next: Raw = {};
  parent[key] = next;
  return next;
}

function truthy(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function intEnv(env: Record<string, string | undefined>, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`${name} must be an integer between 0 and 65535 (got "${v}")`);
  return n;
}

function present(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

function readYamlFile(path: string): Raw {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read config file ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    // YAML parser diagnostics quote source lines, which may contain credentials or private headers.
    throw new ConfigError(`Invalid YAML in ${path}. Check the YAML syntax.`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isObj(parsed)) throw new ConfigError(`Config file ${path} must contain a YAML mapping at the top level`);
  return parsed;
}

/** Environment overrides, applied onto the raw (pre-validation) config object. */
function applyEnv(raw: Raw, env: Record<string, string | undefined>): void {
  const dataDir = present(env.OPENCOACH_DATA_DIR);
  if (dataDir) raw.dataDir = dataDir;
  const port = intEnv(env, 'PORT');
  if (port !== undefined) raw.port = port;
  const viewsPort = intEnv(env, 'VIEWS_PORT');
  if (viewsPort !== undefined) raw.viewsPort = viewsPort;
  const publicUrl = present(env.PUBLIC_URL);
  if (publicUrl) raw.publicUrl = publicUrl;
  const viewsUrl = present(env.VIEWS_URL);
  if (viewsUrl) raw.viewsUrl = viewsUrl;
  const trustProxy = present(env.OPENCOACH_TRUST_PROXY);
  if (trustProxy) raw.trustProxy = /^(true|false)$/i.test(trustProxy) ? trustProxy.toLowerCase() === 'true' : trustProxy;
  const host = present(env.HOST);
  if (host) raw.host = host;
  const logLevel = present(env.LOG_LEVEL);
  if (logLevel) raw.logLevel = logLevel.toLowerCase();
  const demo = truthy(env.OPENCOACH_DEMO);
  if (demo !== undefined) raw.demo = demo;

  const providers = sub(raw, 'providers');
  // OpenRouter: chat models. The key env name can be changed in YAML (apiKeyEnv).
  const openrouter = isObj(providers.openrouter) ? providers.openrouter : undefined;
  const openrouterKeyEnv = typeof openrouter?.apiKeyEnv === 'string' ? openrouter.apiKeyEnv : 'OPENROUTER_API_KEY';
  const openrouterKey = present(env[openrouterKeyEnv]);
  if (openrouterKey) sub(providers, 'openrouter').apiKey = openrouterKey;
  // OpenAI: voice only.
  const openaiKey = present(env.OPENAI_API_KEY);
  if (openaiKey) sub(providers, 'openai').apiKey = openaiKey;

  // Web search: an explicit provider in YAML wins (env only supplies its credentials); otherwise pick from env.
  const search = sub(sub(raw, 'web'), 'search');
  const brave = present(env.BRAVE_API_KEY);
  const tavily = present(env.TAVILY_API_KEY);
  const searx = present(env.SEARXNG_URL);
  if (search.provider === undefined) {
    if (brave) Object.assign(search, { provider: 'brave', apiKey: brave });
    else if (tavily) Object.assign(search, { provider: 'tavily', apiKey: tavily });
    else if (searx) Object.assign(search, { provider: 'searxng', baseUrl: searx });
  } else {
    if (search.provider === 'brave' && brave) search.apiKey = brave;
    if (search.provider === 'tavily' && tavily) search.apiKey = tavily;
    if (search.provider === 'searxng' && searx) search.baseUrl = searx;
  }

  const tg = present(env.TELEGRAM_BOT_TOKEN);
  if (tg) sub(raw, 'telegram').botToken = tg;

  const sandbox = sub(raw, 'sandbox');
  const sb = present(env.OPENCOACH_SANDBOX);
  if (sb) {
    if (sb !== 'local' && sb !== 'docker') throw new ConfigError(`OPENCOACH_SANDBOX must be "local" or "docker" (got "${sb}")`);
    sandbox.provider = sb;
  }
  const unsafe = truthy(env.OPENCOACH_ALLOW_UNSAFE_SANDBOX);
  if (unsafe !== undefined) sandbox.allowUnsafe = unsafe;

  const adminToken = present(env.OPENCOACH_ADMIN_TOKEN);
  if (adminToken) sub(raw, 'admin').token = adminToken;
}

/** Normalize an origin-style URL: http(s), no path/query/hash. Returns it without a trailing slash. */
function normalizeUrl(value: string, label: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a valid URL: "${value}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${label} must be http:// or https:// (got "${value}")`);
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new ConfigError(`${label} must be a bare origin without a path (got "${value}")`);
  }
  return u.origin;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

const SCRIPTED_TIERS = {
  coach: { provider: 'scripted', model: 'scripted-coach' },
  deep: { provider: 'scripted', model: 'scripted-deep' },
  fast: { provider: 'scripted', model: 'scripted-fast' },
} as const;

/** Tier defaults when `models` is not configured (SPEC §5.7). Undefined → no OpenRouter key → demo mode. */
export function defaultModels(config: ServerConfig): ModelsConfig | undefined {
  const openrouter = config.providers.openrouter;
  if (!openrouter?.apiKey) return undefined;
  const model = openrouter.defaultModel ?? DEFAULT_OPENROUTER_MODEL;
  return {
    tiers: {
      // No coach effort: it follows the trigger class (high for replies and check-ins, max overnight, low on calls).
      coach: { provider: 'openrouter', model },
      deep: { provider: 'openrouter', model, effort: 'max' },
      fast: { provider: 'openrouter', model, effort: 'medium' },
    },
    fallbacks: {},
    pricing: {},
  };
}

export const DEMO_WARNING =
  'DEMO MODE: no model API key is configured, so a scripted demo coach answers instead of a real model. ' +
  'Set OPENROUTER_API_KEY (see docs/self-hosting.md) for the real coach.';

/** Load, merge and validate the server configuration. Pure apart from reading the YAML file. */
function loadConfigDetailedUnchecked(opts: LoadConfigOptions, secrets: string[]): LoadedConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];

  const explicit = opts.path ?? present(env.OPENCOACH_CONFIG);
  let configPath: string | undefined;
  let raw: Raw = {};
  if (explicit) {
    configPath = resolve(cwd, explicit);
    if (!existsSync(configPath)) throw new ConfigError(`Config file not found: ${configPath}`);
    raw = readYamlFile(configPath);
  } else {
    const fallback = resolve(cwd, DEFAULT_YAML);
    if (existsSync(fallback)) {
      configPath = fallback;
      raw = readYamlFile(fallback);
    }
  }

  applyEnv(raw, env);
  collectSecrets(raw, secrets);

  // Demo mode wires the scripted provider. Decide before validation so the schema sees a consistent object.
  const demoRequested = raw.demo === true;
  if (demoRequested) sub(raw, 'providers').scripted = { script: 'demo' };

  let config: ServerConfig;
  try {
    config = ServerConfig.parse(raw);
  } catch (e) {
    throw new ConfigError(`Invalid configuration: ${(e as Error).message}`);
  }

  // ---- URLs & origins
  const publicUrl = normalizeUrl(config.publicUrl, 'publicUrl');
  const viewsUrl = normalizeUrl(config.viewsUrl, 'viewsUrl');
  if (new URL(publicUrl).origin === new URL(viewsUrl).origin) {
    throw new ConfigError(
      `viewsUrl (${viewsUrl}) must be a different origin than publicUrl (${publicUrl}): coach-authored views run on their own origin ([SEC-3]). ` +
        'Use another port or hostname (e.g. https://views.example.com).',
    );
  }
  const publicHost = new URL(publicUrl).hostname;
  if (!isLoopbackHost(publicHost) && isLoopbackHost(new URL(viewsUrl).hostname)) {
    warnings.push(`viewsUrl (${viewsUrl}) points at localhost but publicUrl does not: views will not load on other devices. Set VIEWS_URL.`);
  }
  if (new URL(publicUrl).protocol === 'http:' && !isLoopbackHost(publicHost)) {
    const publicBind = !isLoopbackHost(config.host);
    warnings.push(
      `publicUrl (${publicUrl}) is plain http on a non-loopback host${publicBind ? ` and the gateway binds ${config.host}` : ''}. ` +
        'Traffic is not encrypted and PWA features (push, passkeys, install) need https. Put Tailscale or a Cloudflare Tunnel in front; never port-forward raw.',
    );
  }

  const dataDir = resolve(cwd, config.dataDir);

  // ---- API keys referenced by env name (compatible providers)
  const compatible = config.providers.compatible.map((p) => ({ ...p, apiKey: p.apiKey ?? (p.apiKeyEnv ? present(env[p.apiKeyEnv]) : undefined) }));

  // ---- telegram token (materialize from botTokenEnv)
  let telegram = config.telegram;
  if (telegram && !telegram.botToken) {
    const t = present(env[telegram.botTokenEnv]);
    telegram = { ...telegram, botToken: t };
  }

  if (config.admin?.token !== undefined && config.admin.token.length < 16) {
    throw new ConfigError('admin.token must be at least 16 characters (or remove it)');
  }

  let next: ServerConfig = { ...config, publicUrl, viewsUrl, dataDir, providers: { ...config.providers, compatible }, telegram };

  // ---- models
  if (demoRequested) {
    if (next.models) warnings.push('OPENCOACH_DEMO is on: the configured `models` are ignored and the scripted demo coach is used.');
    next = { ...next, models: { tiers: { ...SCRIPTED_TIERS }, fallbacks: {}, pricing: {} } };
    warnings.push(DEMO_WARNING);
  } else if (!next.models) {
    const chosen = defaultModels(next);
    if (chosen) {
      next = { ...next, models: chosen };
    } else {
      next = {
        ...next,
        demo: true,
        providers: { ...next.providers, scripted: { script: 'demo' } },
        models: { tiers: { ...SCRIPTED_TIERS }, fallbacks: {}, pricing: {} },
      };
      warnings.push(DEMO_WARNING);
    }
  }

  return { config: next, warnings, configPath };
}

/** Credential values are used by adapters only; configuration errors must not echo them [SEC-1]. */
export function loadConfigDetailed(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const secrets = Object.entries(env).filter(([name, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && (value?.length ?? 0) >= 8).map(([, value]) => value!);
  try { return loadConfigDetailedUnchecked(opts, secrets); }
  catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    let message = error.message;
    for (const secret of secrets.sort((a, b) => b.length - a.length)) if (secret) message = message.split(secret).join('[redacted]');
    throw new ConfigError(message);
  }
}

function collectSecrets(value: unknown, secrets: string[]): void {
  if (Array.isArray(value)) { for (const item of value) collectSecrets(item, secrets); return; }
  if (!isObj(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (['apiKey', 'botToken', 'token'].includes(key) && typeof item === 'string') secrets.push(item);
    else if (key === 'headers' && isObj(item)) {
      for (const header of Object.values(item)) if (typeof header === 'string') secrets.push(header);
    } else collectSecrets(item, secrets);
  }
}

/** Load the configuration (see {@link loadConfigDetailed} for warnings). */
export function loadConfig(opts: LoadConfigOptions = {}): ServerConfig {
  return loadConfigDetailed(opts).config;
}

/** True when the configured coach is the scripted demo coach. */
export function isDemoConfig(config: ServerConfig): boolean {
  if (config.demo) return true;
  const tiers = config.models?.tiers;
  return !!tiers && tiers.coach.provider === 'scripted';
}
