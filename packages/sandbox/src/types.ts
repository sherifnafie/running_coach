import type { Logger } from '@opencoach/protocol';

export interface SandboxSupport {
  namespaces: boolean;
  docker: boolean;
  details: string[];
}

export interface LocalSandboxOptions {
  /** Permit the non-isolated fallback when namespaces are unavailable (dev only). */
  allowUnsafe: boolean;
  /** Host dirs bind-mounted read-only into the sandbox root (default: /usr /bin /lib /lib64 /etc /opt /sbin). */
  hostDirs?: string[];
  /** Extra env vars for every command (never secrets). */
  env?: Record<string, string>;
  /** Where warnings go (default: a console logger). The unsafe fallback logs loudly through it. */
  logger?: Logger;
  /** Path of util-linux `unshare` (default: searched in /usr/bin, /bin, /usr/sbin, /sbin, /usr/local/bin). */
  unsharePath?: string;
  /** libfaketime shared object for `fakeTime` (default: searched in common locations; `false` disables). */
  faketimeLibrary?: string | false;
  /** Size limit of the private /tmp tmpfs (tmpfs `size=` syntax, default "256m"). It is memory-backed. */
  tmpSize?: string;
}

export interface DockerSandboxOptions {
  image: string;
  socketPath: string;
  runtime?: string;
  memoryMb: number;
  cpus: number;
  /** `uid:gid` the container processes run as (default: this process's uid:gid, so files created in /workspace stay owned by the server user). */
  user?: string;
  /** Path of libfaketime inside the image; `fakeTime` is ignored unless set. */
  faketimeLibrary?: string;
  /** Max processes in the container (default 512). */
  pidsLimit?: number;
  /** Size limit of the /tmp tmpfs (default "512m"). */
  tmpSize?: string;
  logger?: Logger;
}
