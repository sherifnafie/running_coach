/**
 * @opencoach/sandbox — SandboxProvider implementations (SPEC §4.2, §13 [SEC-1]/[SEC-2]).
 *
 *  - LocalSandboxProvider: unprivileged Linux namespaces (user+mount+net+pid+ipc+uts) with a tmpfs root,
 *    read-only bind mounts of the host OS, and the athlete mounts at /workspace (rw), /raw, /history,
 *    /system (ro); pivot_root; all capabilities dropped; no network. Falls back to an UNSAFE subprocess
 *    mode only if allowUnsafe.
 *  - DockerSandboxProvider: one long-lived container per athlete via the Docker Engine API
 *    (unix socket), network "none", same mounts; commands via exec.
 *
 * Behaviour shared by all providers (see ExecOptions in @opencoach/protocol):
 *  - `cwd` is a VIRTUAL path (default /workspace; relative paths resolve under /workspace); anything that is
 *    not under /workspace, /raw, /history, /system or /tmp is rejected with `ToolError('EOUTOFSCOPE')`.
 *  - A command that exceeds `timeoutS` is SIGKILLed (whole process tree) and reported with
 *    `timedOut: true` and `exitCode: 124`. An aborted command reports `exitCode: 130`.
 *  - Each of stdout/stderr is capped at `maxOutputBytes` (default 1 MiB): the first and last halves are
 *    kept with a `[… truncated N bytes …]` marker in between, and `truncated: true`.
 *  - The command's environment is built from scratch (PATH, HOME=/tmp, LANG, TZ, PYTHONDONTWRITEBYTECODE,
 *    provider env, per-exec env); `process.env` is never inherited.
 *  - A sandbox setup failure (local provider) exits 125 with a message prefixed `opencoach-sandbox:` on stderr.
 */
import type { SandboxProvider, ServerConfig } from '@opencoach/protocol';
import { createDockerProvider, DockerClient } from './docker';
import { createLocalSandboxProvider as createLocal, findFaketimeLibrary, probeNamespaces, resolveHostDirs } from './local';
import type { DockerSandboxOptions, LocalSandboxOptions, SandboxSupport } from './types';

export type { DockerSandboxOptions, LocalSandboxOptions, SandboxSupport } from './types';
export { rewriteVirtualPaths } from './unsafe';
export { formatFaketime, validateCwd, VIRTUAL_ROOTS } from './common';

/**
 * Probe what isolation is available on this host: really runs the namespace entry sequence on
 * throw-away directories (so "namespaces: true" means commands will work), and pings the Docker
 * socket (default /var/run/docker.sock).
 */
export async function detectSandboxSupport(opts?: { dockerSocket?: string }): Promise<SandboxSupport> {
  const details: string[] = [];
  const ns = await probeNamespaces();
  details.push(...ns.details);

  const hostDirs = resolveHostDirs(undefined);
  const lib = findFaketimeLibrary(hostDirs);
  details.push(lib ? `libfaketime: ${lib}` : 'libfaketime: not found (ExecOptions.fakeTime is ignored by the local provider)');

  const socket = opts?.dockerSocket ?? '/var/run/docker.sock';
  const docker = await new DockerClient(socket).ping();
  details.push(docker ? `docker: daemon answers on ${socket}` : `docker: no daemon on ${socket}`);

  return { namespaces: ns.ok, docker, details };
}

/**
 * Local provider: real namespace isolation (`kind: "local-isolated"`, `isolated: true`) when the host
 * supports it; otherwise throws, unless `allowUnsafe` — then a loudly-logged, NON-isolated development
 * fallback (`kind: "local-unsafe"`, `isolated: false`).
 */
export async function createLocalSandboxProvider(opts: LocalSandboxOptions): Promise<SandboxProvider> {
  return createLocal(opts);
}

/**
 * Docker provider: one long-lived container per athlete (label `opencoach.athlete=<id>`) over the
 * Engine API on `socketPath`. Nothing is contacted until `ensure()`.
 */
export function createDockerSandboxProvider(opts: DockerSandboxOptions): SandboxProvider {
  return createDockerProvider(opts);
}

/** Build the provider selected by config (local | docker). */
export async function createSandboxProvider(config: ServerConfig['sandbox']): Promise<SandboxProvider> {
  if (config.provider === 'docker') {
    const d = config.docker;
    return createDockerSandboxProvider({ image: d.image, socketPath: d.socketPath, runtime: d.runtime, memoryMb: d.memoryMb, cpus: d.cpus });
  }
  return createLocalSandboxProvider({ allowUnsafe: config.allowUnsafe });
}
