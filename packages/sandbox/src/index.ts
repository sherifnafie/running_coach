/**
 * @opencoach/sandbox — SandboxProvider implementations (SPEC §4.2, §13 [SEC-1]/[SEC-2]).
 *
 *  - LocalSandboxProvider: unprivileged Linux namespaces (user+mount+net[+pid]) with a tmpfs root,
 *    read-only bind mounts of the host OS, and the athlete mounts at /workspace (rw), /raw, /history,
 *    /system (ro); chroot; no network. Falls back to an UNSAFE subprocess mode only if allowUnsafe.
 *  - DockerSandboxProvider: one long-lived container per athlete via the Docker Engine API
 *    (unix socket), network "none", same mounts; commands via exec.
 *
 * STUB: signatures are final; implementation provided by the platform work package.
 */
import type { SandboxProvider, ServerConfig } from '@opencoach/protocol';

export interface SandboxSupport {
  namespaces: boolean;
  docker: boolean;
  details: string[];
}

/** Probe what isolation is available on this host. */
export async function detectSandboxSupport(opts?: { dockerSocket?: string }): Promise<SandboxSupport> {
  void opts;
  throw new Error('not implemented: detectSandboxSupport');
}

export interface LocalSandboxOptions {
  /** Permit the non-isolated fallback when namespaces are unavailable (dev only). */
  allowUnsafe: boolean;
  /** Host dirs bind-mounted read-only into the sandbox root (default: /usr /bin /lib /lib64 /etc /opt /sbin). */
  hostDirs?: string[];
  /** Extra env vars for every command (never secrets). */
  env?: Record<string, string>;
}

export async function createLocalSandboxProvider(opts: LocalSandboxOptions): Promise<SandboxProvider> {
  void opts;
  throw new Error('not implemented: createLocalSandboxProvider');
}

export interface DockerSandboxOptions {
  image: string;
  socketPath: string;
  runtime?: string;
  memoryMb: number;
  cpus: number;
}

export function createDockerSandboxProvider(opts: DockerSandboxOptions): SandboxProvider {
  void opts;
  throw new Error('not implemented: createDockerSandboxProvider');
}

/** Build the provider selected by config (local | docker). */
export async function createSandboxProvider(config: ServerConfig['sandbox']): Promise<SandboxProvider> {
  void config;
  throw new Error('not implemented: createSandboxProvider');
}
