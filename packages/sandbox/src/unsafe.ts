/**
 * UNSAFE local fallback (kind "local-unsafe", isolated=false). Development only, and only reachable
 * when `sandbox.allowUnsafe: true` AND namespaces are unavailable.
 *
 * Commands run as plain `bash -c` subprocesses of the server in the athlete's host workspace with a
 * sanitized environment (still no secrets from process.env). There is NO isolation: they can read any
 * file the server user can read, use the network, see and signal other processes, and write outside
 * the mounts. To keep the coach's virtual paths working we rewrite leading `/workspace/`, `/raw/`,
 * `/history/` and `/system/` prefixes in the command string to host paths and export
 * WORKSPACE/RAW/HISTORY/SYSTEM. `/tmp` is the host's /tmp (HOME and TMPDIR point to a private dir).
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { consoleLogger, type ExecOptions, type ExecResult, type Logger, type SandboxHandle, type SandboxMounts, type SandboxProvider } from '@opencoach/protocol';
import { DEFAULT_MAX_OUTPUT_BYTES, buildEnv, runProcess, validateCwd } from './common';

const HOST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SAFE_PATH_CHARS = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Rewrite virtual mount prefixes at the start of a shell word (after whitespace, quotes, `=`, `:`,
 * `;`, `|`, `&`, `(`, `<`, `>` or a backtick) to host paths: `cat /raw/a.txt` -> `cat /data/.../raw/a.txt`.
 * A bare `/workspace` (followed by `/`, end of string, or a delimiter) is rewritten too.
 */
export function rewriteVirtualPaths(command: string, mounts: SandboxMounts): string {
  const map: Record<string, string> = { workspace: mounts.workspace, raw: mounts.raw, history: mounts.history, system: mounts.system };
  return command.replace(/(^|[\s"'=:;|&(<>`])\/(workspace|raw|history|system)(?=\/|$|[\s"';|&)<>`:])/g, (_m, pre: string, name: string) => `${pre}${map[name]!}`);
}

export interface UnsafeProviderOptions {
  env?: Record<string, string>;
  hostDirs?: string[];
  logger?: Logger;
  faketimeLibrary?: string;
}

/** Build the non-isolated fallback provider. Prefer `createLocalSandboxProvider({ allowUnsafe: true })`, which only uses it when needed. */
export function createUnsafeProvider(opts: UnsafeProviderOptions = {}): SandboxProvider {
  return new UnsafeLocalSandboxProvider(opts);
}

interface Entry {
  athleteId: string;
  mounts: SandboxMounts;
  privateTmp: string;
}

class UnsafeLocalSandboxProvider implements SandboxProvider {
  readonly kind = 'local-unsafe';
  readonly isolated = false;
  private readonly entries = new Map<string, Entry>();
  private readonly tracker = new Set<ChildProcess>();
  private readonly logger: Logger;
  private disposed = false;

  constructor(private readonly opts: UnsafeProviderOptions) {
    this.logger = opts.logger ?? consoleLogger({ component: 'sandbox' });
    buildEnv({ path: HOST_PATH, providerEnv: opts.env }); // validate early
  }

  async ensure(athleteId: string, mounts: SandboxMounts): Promise<SandboxHandle> {
    if (this.disposed) throw new Error('sandbox provider is disposed');
    const resolved = {} as SandboxMounts;
    for (const key of ['workspace', 'raw', 'history', 'system'] as const) {
      const p = mounts[key];
      if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`sandbox mount ${key} must be an absolute host path`);
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        throw new Error(`sandbox mount ${key}: directory does not exist: ${p}`);
      }
      if (!statSync(real).isDirectory()) throw new Error(`sandbox mount ${key} is not a directory: ${p}`);
      if (!SAFE_PATH_CHARS.test(real)) this.logger.warn(`unsafe sandbox: host path ${real} contains characters that break virtual-path rewriting; commands using /${key}/ may fail`);
      resolved[key] = real;
    }
    const id = `unsafe:${athleteId}`;
    const existing = this.entries.get(id);
    this.entries.set(id, { athleteId, mounts: resolved, privateTmp: existing?.privateTmp ?? mkdtempSync(join(tmpdir(), 'opencoach-unsafe-')) });
    return { athleteId, id, kind: this.kind };
  }

  async exec(handle: SandboxHandle, command: string, opts: ExecOptions): Promise<ExecResult> {
    if (this.disposed) throw new Error('sandbox provider is disposed');
    const entry = this.entries.get(handle.id);
    if (!entry || entry.athleteId !== handle.athleteId) throw new Error(`unknown or released sandbox handle ${handle.id}; call ensure() first`);
    const virtualCwd = validateCwd(opts.cwd);
    const hostCwd = this.toHostPath(virtualCwd, entry);
    const nodeDir = dirname(process.execPath);
    const env = buildEnv({
      path: HOST_PATH.split(':').includes(nodeDir) ? HOST_PATH : `${HOST_PATH}:${nodeDir}`,
      tz: opts.tz,
      providerEnv: this.opts.env,
      env: opts.env,
      fakeTime: opts.fakeTime,
      faketimeLibrary: this.opts.faketimeLibrary,
      base: {
        HOME: entry.privateTmp,
        TMPDIR: entry.privateTmp,
        WORKSPACE: entry.mounts.workspace,
        RAW: entry.mounts.raw,
        HISTORY: entry.mounts.history,
        SYSTEM: entry.mounts.system,
      },
    });
    return runProcess({
      file: '/bin/bash',
      args: ['-c', rewriteVirtualPaths(command, entry.mounts)],
      env,
      cwd: hostCwd,
      stdin: opts.stdin,
      timeoutS: opts.timeoutS,
      signal: opts.signal,
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      tracker: this.tracker,
    });
  }

  async release(handle: SandboxHandle): Promise<void> {
    const entry = this.entries.get(handle.id);
    if (entry) rmSync(entry.privateTmp, { recursive: true, force: true });
    this.entries.delete(handle.id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.tracker) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    this.tracker.clear();
    for (const e of this.entries.values()) rmSync(e.privateTmp, { recursive: true, force: true });
    this.entries.clear();
  }

  private toHostPath(virtual: string, entry: Entry): string {
    const roots: Array<[string, string]> = [
      ['/workspace', entry.mounts.workspace],
      ['/raw', entry.mounts.raw],
      ['/history', entry.mounts.history],
      ['/system', entry.mounts.system],
      ['/tmp', entry.privateTmp],
    ];
    for (const [v, host] of roots) {
      if (virtual === v) return host;
      if (virtual.startsWith(`${v}/`)) return posix.join(host, virtual.slice(v.length + 1));
    }
    throw new Error(`unreachable: cwd ${virtual} not under a mount`); // validateCwd already ruled this out
  }
}
