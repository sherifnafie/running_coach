/**
 * Sandbox (SPEC §4.2 trust split, §13 [SEC-1]/[SEC-2]). Tool EXECUTION (bash) runs here; the agent
 * loop and all secrets stay in the trusted runtime. File tools use VirtualFS on the host volume.
 *
 * Inside a sandbox the coach sees:
 *   /workspace (rw)  /raw (ro)  /history (ro)  /system (ro)  /tmp (rw, ephemeral)
 * and has NO network (except an optional allowlisted package mirror) and NO credentials.
 */

export interface SandboxMounts {
  workspace: string; // host path → /workspace (rw)
  raw: string; // host path → /raw (ro)
  history: string; // host path → /history (ro)
  system: string; // host path → /system (ro)
}

export interface SandboxHandle {
  athleteId: string;
  id: string;
  kind: string;
}

export interface ExecOptions {
  timeoutS: number;
  /** Virtual cwd (default /workspace). */
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  /** Eval time machine: the sandbox should report this as the current time where possible (libfaketime). */
  fakeTime?: string;
  /** Default 1 MiB per stream before truncation. */
  maxOutputBytes?: number;
  /** IANA tz for the TZ env var. */
  tz?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface SandboxProvider {
  /** e.g. "local-isolated", "local-unsafe", "docker" */
  readonly kind: string;
  /** False for dev fallbacks without real isolation (logged loudly at startup). */
  readonly isolated: boolean;
  ensure(athleteId: string, mounts: SandboxMounts): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: string, opts: ExecOptions): Promise<ExecResult>;
  /** Stop execution and remove resources for this sandbox before its files can be deleted. */
  release?(handle: SandboxHandle): Promise<void>;
  /** Remove every persisted sandbox for an athlete, including orphan helper sandboxes after restart. */
  releaseAthlete?(athleteId: string): Promise<void>;
  dispose(): Promise<void>;
}
