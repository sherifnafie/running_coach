/**
 * Pieces shared by the sandbox providers: virtual-path validation, environment construction,
 * libfaketime formatting, bounded output capture and a child-process runner with timeout/abort.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { posix } from 'node:path';
import { ToolError, isValidTimeZone, type ExecResult } from '@opencoach/protocol';

/** Virtual directories a command may use as cwd: the four athlete mounts plus the private /tmp. */
export const VIRTUAL_ROOTS = ['/workspace', '/raw', '/history', '/system', '/tmp'] as const;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** `timeout(1)` convention: a command killed by the timeout reports 124 (and `timedOut: true`). */
export const TIMED_OUT_EXIT_CODE = 124;
/** A command killed through its AbortSignal reports 130 (SIGINT convention). */
export const ABORTED_EXIT_CODE = 130;
/** Hard ceiling for setTimeout (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Validate and normalise a virtual cwd. Defaults to /workspace; a relative path is resolved under
 * /workspace (like VirtualFS). Anything that normalises to a location outside the mounts (including
 * `..` escapes) is rejected with `ToolError('EOUTOFSCOPE')`.
 */
export function validateCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '/workspace';
  if (cwd.includes('\0')) throw new ToolError('INVALID_INPUT', 'cwd contains a NUL byte');
  const abs = cwd.startsWith('/') ? cwd : posix.join('/workspace', cwd);
  const norm = posix.normalize(abs).replace(/\/+$/, '') || '/';
  if (VIRTUAL_ROOTS.some((r) => norm === r || norm.startsWith(`${r}/`))) return norm;
  throw new ToolError('EOUTOFSCOPE', `cwd ${JSON.stringify(cwd)} is outside the sandbox mounts (${VIRTUAL_ROOTS.join(', ')})`);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws if an env var name/value cannot be passed safely. */
export function assertEnvEntry(name: string, value: string): void {
  if (!ENV_NAME.test(name)) throw new ToolError('INVALID_INPUT', `invalid environment variable name: ${JSON.stringify(name)}`);
  if (typeof value !== 'string' || value.includes('\0')) throw new ToolError('INVALID_INPUT', `invalid value for environment variable ${name}`);
}

/**
 * libfaketime absolute-start spec for `FAKETIME`: `@YYYY-MM-DD HH:MM:SS`.
 *
 * libfaketime parses absolute timestamps with the process's local time zone, and the sandbox sets
 * `TZ` to `tz`, so the wall time is formatted in `tz` (UTC by default, which is what the evals use).
 */
export function formatFaketime(iso: string, tz = 'UTC'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new ToolError('INVALID_INPUT', `fakeTime is not a valid timestamp: ${iso}`);
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `@${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export interface EnvInput {
  /** PATH inside the sandbox. */
  path: string;
  tz?: string;
  /** Provider-level extras (never secrets). */
  providerEnv?: Record<string, string>;
  /** Per-exec extras (win over everything). */
  env?: Record<string, string>;
  fakeTime?: string;
  /** libfaketime .so reachable from inside the sandbox; fakeTime is ignored without it. */
  faketimeLibrary?: string;
  /** Provider-specific fixed entries (e.g. HOME for the unsafe fallback). */
  base?: Record<string, string>;
}

/**
 * The COMPLETE environment of a sandboxed command. It is built from scratch and never inherits
 * `process.env` (which holds API keys): PATH, HOME, LANG, TZ, PYTHONDONTWRITEBYTECODE, then provider
 * extras, then per-exec extras, then libfaketime variables.
 */
export function buildEnv(i: EnvInput): Record<string, string> {
  const tz = i.tz && isValidTimeZone(i.tz) ? i.tz : 'UTC';
  const env: Record<string, string> = {
    PATH: i.path,
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    TZ: tz,
    PYTHONDONTWRITEBYTECODE: '1',
    OPENCOACH_SANDBOX: '1',
    ...i.base,
  };
  for (const src of [i.providerEnv, i.env]) {
    for (const [k, v] of Object.entries(src ?? {})) {
      assertEnvEntry(k, v);
      env[k] = v;
    }
  }
  if (i.fakeTime !== undefined && i.faketimeLibrary) {
    env.LD_PRELOAD = i.faketimeLibrary;
    env.FAKETIME = formatFaketime(i.fakeTime, tz);
    // Keep monotonic clocks real so timers, sleep and event loops keep working.
    env.FAKETIME_DONT_FAKE_MONOTONIC = '1';
  }
  return env;
}

/** True when `child` is `parent` or lies below it (both absolute, normalised). */
export function containsPath(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, '');
  return child === p || child.startsWith(`${p}/`);
}

// ---------------------------------------------------------------------------- output capture

function trimIncompleteEnd(b: Buffer): Buffer {
  // Drop a UTF-8 sequence cut in the middle at the end of the buffer.
  for (let back = 1; back <= 3 && back <= b.length; back++) {
    const c = b[b.length - back]!;
    if ((c & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead byte
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return need > back ? b.subarray(0, b.length - back) : b;
  }
  return b;
}

function trimIncompleteStart(b: Buffer): Buffer {
  let i = 0;
  while (i < 3 && i < b.length && (b[i]! & 0xc0) === 0x80) i++; // stray continuation bytes
  return i > 0 ? b.subarray(i) : b;
}

/**
 * Keeps at most `cap` bytes of a stream: the first half and the last half, with a marker in between
 * when the middle had to be dropped. Memory use is bounded by `cap` no matter how much is written.
 */
export class OutputCollector {
  private readonly headCap: number;
  private readonly tailCap: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;

  constructor(cap: number) {
    const c = Math.max(2, Math.floor(cap));
    this.headCap = Math.ceil(c / 2);
    this.tailCap = c - this.headCap;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headCap) {
      const take = Math.min(rest.length, this.headCap - this.headBytes);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.tailCap) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  finish(): { text: string; truncated: boolean } {
    const tailAll = Buffer.concat(this.tail);
    if (this.total <= this.headCap + this.tailCap) {
      return { text: Buffer.concat([...this.head, tailAll]).toString('utf8'), truncated: false };
    }
    let head: Buffer = Buffer.concat(this.head);
    let tail: Buffer = tailAll.length > this.tailCap ? tailAll.subarray(tailAll.length - this.tailCap) : tailAll;
    head = trimIncompleteEnd(head);
    tail = trimIncompleteStart(tail);
    const omitted = this.total - head.length - tail.length;
    return { text: `${head.toString('utf8')}\n[… truncated ${omitted} bytes …]\n${tail.toString('utf8')}`, truncated: true };
  }
}

// -------------------------------------------------------------------------------- process run

export interface RunRequest {
  file: string;
  args: string[];
  /** Environment of the spawned (outer) process. */
  env: Record<string, string>;
  /** Host cwd of the spawned process. */
  cwd?: string;
  stdin?: string;
  timeoutS: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
  /** Live children, so the provider can kill them on dispose. */
  tracker?: Set<ChildProcess>;
}

/** SIGKILL the child's whole process group (it is spawned detached, so it leads its own group). */
export function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawn a command, feed stdin, capture bounded stdout/stderr, enforce the timeout (SIGKILL to the
 * whole process group; result has `timedOut: true`, exit code 124) and the abort signal (exit code 130).
 * Rejects only when the process cannot be spawned at all.
 */
export function runProcess(req: RunRequest): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    if (req.signal?.aborted) {
      resolve({ stdout: '', stderr: '', exitCode: ABORTED_EXIT_CODE, timedOut: false, truncated: false, durationMs: 0 });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(req.file, req.args, { env: req.env, cwd: req.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    req.tracker?.add(child);

    const out = new OutputCollector(req.maxOutputBytes);
    const err = new OutputCollector(req.maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      aborted = true;
      killGroup(child);
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      req.signal?.removeEventListener('abort', onAbort);
      req.tracker?.delete(child);
      const o = out.finish();
      const e = err.finish();
      const code = timedOut ? TIMED_OUT_EXIT_CODE : aborted ? ABORTED_EXIT_CODE : (exitCode ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1));
      resolve({ stdout: o.text, stderr: e.text, exitCode: code, timedOut, truncated: o.truncated || e.truncated, durationMs: elapsed() });
    };

    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => err.push(c));
    child.stdin!.on('error', () => {
      /* the command exited without reading stdin (EPIPE): not an error */
    });
    child.stdin!.end(req.stdin ?? '');

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      req.signal?.removeEventListener('abort', onAbort);
      req.tracker?.delete(child);
      reject(e);
    });

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Nothing may outlive the command: reap stragglers in its group, then give the pipes a moment to drain.
      killGroup(child);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle();
      }, 1000);
    });
    child.on('close', settle);

    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, Math.min(MAX_TIMER_MS, Math.max(1, Math.round(req.timeoutS * 1000))));
    req.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
