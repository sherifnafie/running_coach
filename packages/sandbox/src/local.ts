/**
 * LocalSandboxProvider (kind "local-isolated"): every command runs in fresh user + mount + net + pid +
 * ipc + uts namespaces created by util-linux `unshare`, inside a tmpfs root assembled by
 * `assets/enter.sh`. See ADR 0004 and the header of enter.sh for the exact mount sequence.
 *
 * Isolation properties (all verified by local.test.ts on a host that supports them):
 *  - no network: a new net namespace with only (down) loopback;
 *  - the host filesystem is unreachable: pivot_root into a tmpfs root, old root detached; only the
 *    OS dirs (read-only), the four athlete mounts and a private /tmp, /dev, /proc exist;
 *  - /raw, /history, /system are read-only and cannot be remounted rw (all capabilities are dropped
 *    before the command starts, and no_new_privs is set);
 *  - the runtime's secrets are not inherited (the environment is rebuilt from scratch) and the
 *    runtime's processes are invisible and unsignalable (new pid namespace + fresh /proc);
 *  - nothing outlives the command (pid 1 of the namespace exits => the kernel kills the rest).
 *
 * Caveat: the sandbox runs as the server's own kernel uid (uid 0 in the namespace maps to it). Run the
 * server as an unprivileged user; if it runs as root, root-readable files inside the exposed host dirs
 * (e.g. under /etc, /opt) are readable by the sandbox, and the usual shadow/ssh/ssl-private paths are masked.
 */
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleLogger, type ExecOptions, type ExecResult, type Logger, type SandboxHandle, type SandboxMounts, type SandboxProvider } from '@opencoach/protocol';
import { DEFAULT_MAX_OUTPUT_BYTES, buildEnv, containsPath, runProcess, validateCwd } from './common';
import type { LocalSandboxOptions } from './types';
import { createUnsafeProvider } from './unsafe';

export const DEFAULT_HOST_DIRS: readonly string[] = ['/usr', '/bin', '/lib', '/lib64', '/etc', '/opt', '/sbin'];

/** Mount points the provider owns inside the sandbox root; a host dir may not shadow them. */
const RESERVED_MOUNTS = ['/workspace', '/raw', '/history', '/system', '/tmp', '/dev', '/proc', '/.oldroot', '/.opencoach-command'];

/** PATH used while setting the sandbox up (host utilities: mount, pivot_root, ...). */
const HOST_TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Default PATH of commands inside the sandbox. */
export const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const ENTER_SH = fileURLToPath(new URL('../assets/enter.sh', import.meta.url));

/** Namespaces requested from `unshare`. All of them are required for the isolation claims above. */
export const UNSHARE_FLAGS = ['--user', '--map-root-user', '--mount', '--net', '--pid', '--ipc', '--uts', '--fork', '--kill-child'] as const;

/** Commands larger than this are delivered through a file instead of one argv entry (Linux caps a single argument at 128 KiB). */
const MAX_INLINE_COMMAND_BYTES = 64 * 1024;

const TOOL_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'];

const FAKETIME_CANDIDATES = [
  '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1',
  '/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1',
  '/usr/lib/faketime/libfaketime.so.1',
  '/usr/lib64/faketime/libfaketime.so.1',
  '/usr/local/lib/faketime/libfaketime.so.1',
  '/usr/local/lib/libfaketime.so.1',
  '/usr/lib/libfaketime.so.1',
  '/usr/lib/x86_64-linux-gnu/libfaketime.so.1',
];

export function findExecutable(name: string, dirs: readonly string[] = TOOL_DIRS): string | undefined {
  for (const d of dirs) {
    const p = join(d, name);
    try {
      accessSync(p, fsConstants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Validate configured host dirs: absolute, not "/", not shadowing sandbox mount points; missing ones are skipped. */
export function resolveHostDirs(dirs: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const d of dirs ?? DEFAULT_HOST_DIRS) {
    if (typeof d !== 'string' || !d.startsWith('/') || d.includes('\n') || d.includes('\0')) throw new Error(`invalid sandbox host dir: ${JSON.stringify(d)}`);
    const norm = posix.normalize(d).replace(/\/+$/, '');
    if (norm === '') throw new Error('sandbox host dir "/" would expose the whole host filesystem');
    if (RESERVED_MOUNTS.some((r) => containsPath(r, norm))) throw new Error(`sandbox host dir ${d} collides with a sandbox mount point`);
    if (existsSync(norm)) out.push(norm);
  }
  return [...new Set(out)];
}

/** Split host dirs into real directories (bind-mounted) and symlinks (recreated as links, e.g. /bin -> usr/bin). */
export function classifyHostDirs(list: readonly string[]): { dirs: string[]; links: Array<{ path: string; target: string }> } {
  const dirs: string[] = [];
  const links: Array<{ path: string; target: string }> = [];
  for (const d of list) {
    const st = lstatSync(d);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(d);
      if (target.includes('\n') || target.includes('\t')) throw new Error(`unsupported symlink target for host dir ${d}`);
      links.push({ path: d, target });
    } else if (st.isDirectory()) dirs.push(d);
  }
  return { dirs, links };
}

/** libfaketime library that is visible inside the sandbox (i.e. lives under an exposed host dir). */
export function findFaketimeLibrary(hostDirs: readonly string[], override?: string | false): string | undefined {
  if (override === false) return undefined;
  const candidates = override ? [override] : FAKETIME_CANDIDATES;
  for (const c of candidates) {
    if (existsSync(c) && hostDirs.some((d) => containsPath(d, c))) return c;
  }
  return undefined;
}

/** PATH for sandboxed commands: the standard dirs plus the directory of the running node binary when it is exposed. */
export function sandboxPath(hostDirs: readonly string[]): string {
  const pythonDir = '/opt/coach-python/bin';
  const pythonVisible = existsSync(join(pythonDir, 'python')) && hostDirs.some((d) => containsPath(d, pythonDir));
  const basePath = pythonVisible ? `${pythonDir}:${SANDBOX_PATH}` : SANDBOX_PATH;
  const nodeDir = dirname(process.execPath);
  const visible = hostDirs.some((d) => containsPath(d, nodeDir));
  return visible && !basePath.split(':').includes(nodeDir) ? `${basePath}:${nodeDir}` : basePath;
}

// -------------------------------------------------------------------------------- the runner

export interface NamespaceRunnerConfig {
  unshare: string;
  bash: string;
  /** Private scratch dir: `root/` is the mount point of the tmpfs root, command files live beside it. */
  runDir: string;
  /** Host dirs as returned by resolveHostDirs (directories and symlinks). */
  hostDirs: string[];
  tmpSize: string;
  tracker: Set<ChildProcess>;
}

export interface NamespaceRequest {
  mounts: SandboxMounts;
  cwd: string;
  command: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutS: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
}

let commandCounter = 0;

/** Run one command in fresh namespaces (see enter.sh). Rejects only if `unshare` cannot be spawned. */
export async function runInNamespaces(cfg: NamespaceRunnerConfig, req: NamespaceRequest): Promise<ExecResult> {
  const rootDir = join(cfg.runDir, 'root');
  mkdirSync(rootDir, { recursive: true, mode: 0o700 }); // survives tmp cleaners removing it between calls

  const { dirs, links } = classifyHostDirs(cfg.hostDirs);
  const outer: Record<string, string> = {
    PATH: HOST_TOOL_PATH,
    OC_ROOT: rootDir,
    OC_HOST_DIRS: dirs.join('\n'),
    OC_HOST_LINKS: links.map((l) => `${l.path}\t${l.target}`).join('\n'),
    OC_WORKSPACE: req.mounts.workspace,
    OC_RAW: req.mounts.raw,
    OC_HISTORY: req.mounts.history,
    OC_SYSTEM: req.mounts.system,
    OC_TMP_SIZE: cfg.tmpSize,
    OC_PROC: '1',
    OC_BASH: cfg.bash,
  };

  let commandArg = req.command;
  let commandFile: string | undefined;
  if (Buffer.byteLength(req.command) > MAX_INLINE_COMMAND_BYTES) {
    commandFile = join(cfg.runDir, `command-${process.pid}-${commandCounter++}.sh`);
    writeFileSync(commandFile, req.command, { mode: 0o600 });
    outer.OC_CMDFILE = commandFile;
    commandArg = '';
  }

  const envArgs = Object.entries(req.env).map(([k, v]) => `${k}=${v}`);
  try {
    return await runProcess({
      file: cfg.unshare,
      args: [...UNSHARE_FLAGS, '--', cfg.bash, ENTER_SH, req.cwd, commandArg, ...envArgs],
      env: outer,
      stdin: req.stdin,
      timeoutS: req.timeoutS,
      signal: req.signal,
      maxOutputBytes: req.maxOutputBytes,
      tracker: cfg.tracker,
    });
  } finally {
    if (commandFile) rmSync(commandFile, { force: true });
  }
}

// ------------------------------------------------------------------------------------- probe

export interface NamespaceProbe {
  ok: boolean;
  /** Human-readable lines for `SandboxSupport.details`. */
  details: string[];
  /** Why it failed (first line of stderr / the missing tool). */
  reason?: string;
  unshare?: string;
  bash?: string;
}

/**
 * Probe by really running the sandbox entry sequence (user+mount+net+pid+ipc+uts namespaces, tmpfs
 * root, binds, pivot_root, capability drop) on throw-away directories.
 */
export async function probeNamespaces(opts: { unsharePath?: string; hostDirs?: readonly string[]; tmpSize?: string } = {}): Promise<NamespaceProbe> {
  const details: string[] = [];
  if (process.platform !== 'linux') return { ok: false, reason: `namespaces need Linux (this is ${process.platform})`, details: [`platform ${process.platform}: no Linux namespaces`] };
  const unshare = opts.unsharePath ?? findExecutable('unshare');
  if (!unshare || !existsSync(unshare)) return { ok: false, reason: 'util-linux `unshare` not found', details: ['unshare: not found (install util-linux)'] };
  details.push(`unshare: ${unshare}`);
  const bash = findExecutable('bash');
  if (!bash) return { ok: false, reason: '`bash` not found', details: [...details, 'bash: not found'], unshare };
  for (const tool of ['mount', 'umount', 'pivot_root']) {
    if (!findExecutable(tool)) return { ok: false, reason: `\`${tool}\` not found (install util-linux)`, details: [...details, `${tool}: not found`], unshare, bash };
  }
  details.push(findExecutable('setpriv') ? 'setpriv: present (capabilities dropped with no_new_privs)' : 'setpriv: missing (capabilities dropped via a nested user namespace)');

  const scratch = mkdtempSync(join(tmpdir(), 'opencoach-probe-'));
  try {
    const mounts: SandboxMounts = { workspace: join(scratch, 'ws'), raw: join(scratch, 'raw'), history: join(scratch, 'hist'), system: join(scratch, 'sys') };
    for (const d of Object.values(mounts)) mkdirSync(d);
    const tracker = new Set<ChildProcess>();
    const started = performance.now();
    const res = await runInNamespaces(
      { unshare, bash, runDir: scratch, hostDirs: resolveHostDirs(opts.hostDirs), tmpSize: opts.tmpSize ?? '16m', tracker },
      {
        mounts,
        cwd: '/workspace',
        // Also proves: pid 1, no capabilities, read-only /raw, no old root left behind.
        command:
          'echo probe-ok; [ "$$" = 1 ] || exit 41; grep -q "^CapEff:.0*$" /proc/self/status || exit 42; ( : > /raw/x ) 2>/dev/null && exit 43; [ ! -e /.oldroot ] || exit 44',
        env: { PATH: SANDBOX_PATH },
        timeoutS: 20,
        maxOutputBytes: 4096,
      },
    );
    if (res.exitCode === 0 && res.stdout.startsWith('probe-ok')) {
      details.push(`namespaces user+mount+net+pid+ipc+uts: ok (probe ${Math.round(performance.now() - started)}ms)`);
      return { ok: true, details, unshare, bash };
    }
    const why = (res.stderr.trim().split('\n')[0] ?? '').slice(0, 300) || `probe exited with ${res.exitCode}`;
    details.push(`namespaces: probe failed (${why})`);
    return { ok: false, reason: why, details, unshare, bash };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    details.push(`namespaces: probe could not run (${why})`);
    return { ok: false, reason: why, details, unshare, bash };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------------- provider

interface Entry {
  athleteId: string;
  mounts: SandboxMounts;
}

/** Resolve and validate the athlete mounts: existing directories, not inside an exposed host dir. */
export function resolveMounts(mounts: SandboxMounts, hostDirs: readonly string[]): SandboxMounts {
  const out = {} as SandboxMounts;
  const realHost = hostDirs.map((d) => {
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  });
  for (const key of ['workspace', 'raw', 'history', 'system'] as const) {
    const p = mounts[key];
    if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`sandbox mount ${key} must be an absolute host path (got ${JSON.stringify(p)})`);
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new Error(`sandbox mount ${key}: directory does not exist: ${p}`);
    }
    if (!statSync(real).isDirectory()) throw new Error(`sandbox mount ${key} is not a directory: ${p}`);
    if (real.includes('\n') || real.includes('\0')) throw new Error(`sandbox mount ${key}: unsupported characters in path`);
    const clash = realHost.find((h) => containsPath(h, real));
    if (clash) {
      throw new Error(
        `sandbox mount ${key} (${real}) lies inside the exposed host dir ${clash}, which would make other athletes' data and server secrets readable in the sandbox. ` +
          'Move the data dir outside it or configure hostDirs without it.',
      );
    }
    out[key] = real;
  }
  return out;
}

class LocalIsolatedProvider implements SandboxProvider {
  readonly kind = 'local-isolated';
  readonly isolated = true;
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(
    private readonly cfg: NamespaceRunnerConfig,
    private readonly opts: { providerEnv: Record<string, string>; faketimeLibrary?: string; path: string },
    private readonly hostDirsReal: string[],
  ) {}

  async ensure(athleteId: string, mounts: SandboxMounts): Promise<SandboxHandle> {
    this.assertLive();
    const resolved = resolveMounts(mounts, this.hostDirsReal);
    const id = `local:${athleteId}`;
    this.entries.set(id, { athleteId, mounts: resolved });
    return { athleteId, id, kind: this.kind };
  }

  async exec(handle: SandboxHandle, command: string, opts: ExecOptions): Promise<ExecResult> {
    this.assertLive();
    const entry = this.entries.get(handle.id);
    if (!entry || entry.athleteId !== handle.athleteId) throw new Error(`unknown or released sandbox handle ${handle.id}; call ensure() first`);
    const cwd = validateCwd(opts.cwd);
    const env = buildEnv({ path: this.opts.path, tz: opts.tz, providerEnv: this.opts.providerEnv, env: opts.env, fakeTime: opts.fakeTime, faketimeLibrary: this.opts.faketimeLibrary });
    return runInNamespaces(this.cfg, {
      mounts: entry.mounts,
      cwd,
      command,
      env,
      stdin: opts.stdin,
      timeoutS: opts.timeoutS,
      signal: opts.signal,
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
  }

  async release(handle: SandboxHandle): Promise<void> {
    this.entries.delete(handle.id);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.cfg.tracker) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    this.cfg.tracker.clear();
    this.entries.clear();
    rmSync(this.cfg.runDir, { recursive: true, force: true });
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('sandbox provider is disposed');
  }
}

/**
 * Create the local provider. Uses real namespace isolation when the host supports it
 * (`kind: "local-isolated"`). When it does not: throws a descriptive error, unless `allowUnsafe` is
 * set, in which case it returns the non-isolated development fallback (`kind: "local-unsafe"`,
 * `isolated: false`) and logs a loud warning.
 */
export async function createLocalSandboxProvider(opts: LocalSandboxOptions): Promise<SandboxProvider> {
  const logger: Logger = opts.logger ?? consoleLogger({ component: 'sandbox' });
  const hostDirs = resolveHostDirs(opts.hostDirs);
  const providerEnv = { ...opts.env };
  buildEnv({ path: SANDBOX_PATH, providerEnv }); // validates names/values early

  const probe = await probeNamespaces({ unsharePath: opts.unsharePath, hostDirs, tmpSize: opts.tmpSize });
  if (probe.ok && probe.unshare && probe.bash) {
    const runDir = mkdtempSync(join(tmpdir(), 'opencoach-sbx-'));
    const cfg: NamespaceRunnerConfig = {
      unshare: probe.unshare,
      bash: probe.bash,
      runDir: realpathSync(runDir),
      hostDirs,
      tmpSize: opts.tmpSize ?? '256m',
      tracker: new Set(),
    };
    const hostDirsReal = hostDirs.map((d) => {
      try {
        return realpathSync(d);
      } catch {
        return d;
      }
    });
    return new LocalIsolatedProvider(cfg, { providerEnv, faketimeLibrary: findFaketimeLibrary(hostDirs, opts.faketimeLibrary), path: sandboxPath(hostDirs) }, hostDirsReal);
  }

  const reason = probe.reason ?? 'unknown reason';
  if (!opts.allowUnsafe) {
    throw new Error(
      `The local sandbox needs unprivileged Linux namespaces, but the probe failed: ${reason}. ` +
        'Fix it (enable user namespaces: sysctl kernel.unprivileged_userns_clone=1 / user.max_user_namespaces>0, install util-linux, ' +
        'allow it in the container seccomp/AppArmor profile), use sandbox.provider "docker", or - for local development ONLY - set sandbox.allowUnsafe: true.',
    );
  }
  logger.warn(
    'SANDBOX ISOLATION UNAVAILABLE: running coach commands as plain subprocesses with NO isolation (sandbox.allowUnsafe=true). ' +
      'They can read your files, use the network and see your processes. Never use this with real athlete data.',
    { reason, details: probe.details },
  );
  return createUnsafeProvider({ env: providerEnv, hostDirs, logger, faketimeLibrary: findFaketimeLibrary(hostDirs, opts.faketimeLibrary) });
}
