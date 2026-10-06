import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SystemClock,
  athletePaths,
  type AthletePaths,
  type AthleteSettings,
  type Clock,
  type Logger,
  type MediaPort,
  type SandboxHandle,
  type SandboxPort,
  type ServerConfig,
  type Store,
  type VirtualFS,
  type WebPort,
} from '@opencoach/protocol';
import { createMountedFS, prepareImageForModel } from '@opencoach/workspace';
import type { StreamBus } from './bus';
import type { CoachRuntimeDeps } from './deps';

/** Shared internals passed between runtime modules. Modules are late-bound after construction. */
export interface Core {
  deps: CoachRuntimeDeps;
  config: ServerConfig;
  clock: Clock;
  store: Store;
  log: Logger;
  bus: StreamBus;
  harnessVersion: string;
  pack: { id: string; version: string; name: string };
  /** Host path of the /system mount (set in start()). */
  systemDir: string;
  paths(athleteId: string): AthletePaths;
  fsFor(athleteId: string, writeScope?: string[] | null, workspaceOverride?: string): VirtualFS;
  sandboxFor(athleteId: string, workspaceOverride?: { key: string; dir: string }): Promise<SandboxPort>;
  releaseSandbox(key: string): Promise<void>;
  readSystemFile(rel: string): Promise<string>;
  addendum(name: string, vars?: Record<string, string>): Promise<string>;
  settings(athleteId: string): Promise<AthleteSettings>;
  media: MediaPort;
  web: WebPort;
  // late-bound modules
  minds: import('./mind').Minds;
  scheduler: import('./scheduler').Scheduler;
  ui: import('./ui-service').UiService;
  helpers: import('./helpers').HelperManager;
  turns: import('./turn').TurnRunner;
  mcp: import('./mcp').McpManager;
}

export function createCoreBase(deps: CoachRuntimeDeps, bus: StreamBus, web: WebPort, harnessVersion: string): Omit<Core, 'minds' | 'scheduler' | 'ui' | 'helpers' | 'turns' | 'mcp'> {
  const handles = new Map<string, SandboxHandle>();
  const isVirtualClock = !(deps.clock instanceof SystemClock);
  const base = {
    deps,
    config: deps.config,
    clock: deps.clock,
    store: deps.store,
    log: deps.logger,
    bus,
    harnessVersion,
    pack: { id: deps.pack, version: '0.0.0', name: deps.pack },
    systemDir: '',
    paths: (athleteId: string) => athletePaths(deps.config.dataDir, athleteId),
    fsFor(athleteId: string, writeScope: string[] | null = null, workspaceOverride?: string): VirtualFS {
      const p = athletePaths(deps.config.dataDir, athleteId);
      return createMountedFS({
        workspace: workspaceOverride ?? p.workspace,
        raw: p.raw,
        history: p.history,
        system: base.systemDir,
        writeScope,
      });
    },
    async sandboxFor(athleteId: string, workspaceOverride?: { key: string; dir: string }): Promise<SandboxPort> {
      const p = athletePaths(deps.config.dataDir, athleteId);
      const key = workspaceOverride?.key ?? athleteId;
      let h = handles.get(key);
      if (!h) {
        h = await deps.sandbox.ensure(key, {
          workspace: workspaceOverride?.dir ?? p.workspace,
          raw: p.raw,
          history: p.history,
          system: base.systemDir,
        });
        handles.set(key, h);
      }
      const handle = h;
      return {
        exec: async (command, opts) => {
          const settings = await deps.store.getSettings(athleteId).catch(() => undefined);
          return deps.sandbox.exec(handle, command, {
            timeoutS: opts.timeoutS,
            cwd: opts.cwd,
            signal: opts.signal,
            tz: settings?.profile.tz,
            maxOutputBytes: deps.config.limits.bashMaxOutputBytes,
            fakeTime: isVirtualClock ? deps.clock.now().toISOString() : undefined,
          });
        },
      };
    },
    async releaseSandbox(key: string) {
      const h = handles.get(key);
      handles.delete(key);
      if (h && deps.sandbox.release) await deps.sandbox.release(h).catch(() => {});
    },
    async readSystemFile(rel: string): Promise<string> {
      return readFile(join(base.systemDir, rel), 'utf8');
    },
    async addendum(name: string, vars: Record<string, string> = {}): Promise<string> {
      let text: string;
      try {
        text = await readFile(join(base.systemDir, 'addenda', `${name}.md`), 'utf8');
      } catch {
        return '';
      }
      return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
    },
    settings: (athleteId: string) => deps.store.getSettings(athleteId),
    media: {
      prepareImage: (data: Uint8Array, mime: string) => prepareImageForModel(data, mime),
      readHostFile: async (path: string) => new Uint8Array(await readFile(path)),
    } satisfies MediaPort,
    web,
  };
  return base;
}
