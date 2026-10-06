/**
 * DockerSandboxProvider (kind "docker"): one long-lived container per athlete, driven through the
 * Docker Engine API over its unix socket with plain `node:http` (no dockerode).
 *
 * Container: `sleep infinity` under an init process, network "none", all capabilities dropped,
 * no-new-privileges, memory/CPU/pids limits, /workspace rw and /raw /history /system read-only binds,
 * a size-limited tmpfs /tmp. Commands run via exec as `timeout -s KILL <n> bash -lc <command>`.
 *
 * The container is found by the label `opencoach.athlete=<id>`. A label also records a hash of the
 * full create configuration, so a changed image, limit or mount path (e.g. a new /system version
 * after a harness upgrade) recreates the container instead of silently running a stale one.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { ToolError, type ExecOptions, type ExecResult, type SandboxHandle, type SandboxMounts, type SandboxProvider } from '@opencoach/protocol';
import { ABORTED_EXIT_CODE, DEFAULT_MAX_OUTPUT_BYTES, OutputCollector, TIMED_OUT_EXIT_CODE, buildEnv, validateCwd } from './common';
import type { DockerSandboxOptions } from './types';

const DOCKER_PATH = '/opt/coach-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const LABEL_ATHLETE = 'opencoach.athlete';
const LABEL_CONFIG = 'opencoach.config';
/** How long past the in-container `timeout` we wait for the stream before giving up on the exec. */
const WATCHDOG_GRACE_MS = 15_000;

// ------------------------------------------------------------------------------ API client

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DockerApiError';
  }
}

interface ApiResponse {
  status: number;
  body: Buffer;
}

/** Minimal Docker Engine API client over a unix socket. */
export class DockerClient {
  constructor(private readonly socketPath: string) {}

  request(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          agent: false,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API request timed out: ${method} ${path}`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  /** JSON request; throws DockerApiError for status >= 400. */
  async json<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const res = await this.request(method, path, body);
    if (res.status >= 400 && !okStatuses.includes(res.status)) {
      let message = res.body.toString('utf8').trim();
      try {
        const parsed = JSON.parse(message) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        /* plain text */
      }
      throw new DockerApiError(res.status, `Docker API ${method} ${path} failed (${res.status}): ${message}`);
    }
    if (res.body.length === 0) return undefined as T;
    try {
      return JSON.parse(res.body.toString('utf8')) as T;
    } catch {
      return undefined as T;
    }
  }

  /** True when the daemon answers `GET /_ping`. */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await this.request('GET', '/_ping', undefined, timeoutMs);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Start an exec and hand back the multiplexed output stream. Uses the connection-upgrade
   * ("hijack") protocol so stdin can be written; falls back to the plain streaming response.
   */
  startExec(execId: string, stdin: string | undefined, signal?: AbortSignal, timeoutMs = 30_000): Promise<{ stream: NodeJS.ReadableStream & { destroy(): void }; initial: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
      const req = http.request({
        socketPath: this.socketPath,
        path: `/exec/${execId}/start`,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length), Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const onAbort = (): void => { req.destroy(new Error('Docker exec start aborted')); };
      const timer = setTimeout(() => req.destroy(new Error('Docker exec start timed out')), timeoutMs);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      req.on('error', (error) => { cleanup(); reject(error); });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      req.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
        cleanup();
        if (stdin !== undefined) socket.end(stdin); // half-close: the exec's stdin sees EOF, output keeps flowing
        resolve({ stream: socket, initial: head });
      });
      req.on('response', (res) => {
        cleanup();
        if ((res.statusCode ?? 0) >= 400) {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => reject(new DockerApiError(res.statusCode ?? 0, `Docker exec start failed (${res.statusCode}): ${Buffer.concat(chunks).toString('utf8').trim()}`)));
          return;
        }
        if (stdin !== undefined && stdin.length > 0) {
          res.destroy();
          reject(new Error('Docker daemon did not upgrade the exec connection, so stdin cannot be delivered'));
          return;
        }
        resolve({ stream: res, initial: Buffer.alloc(0) });
      });
      req.end(payload);
    });
  }
}

// ------------------------------------------------------------------------------- demux

/** Demultiplexes Docker's 8-byte-header stream format (Tty: false): [type,0,0,0,len32be][payload]. */
export class DockerDemuxer {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (stream: 'stdout' | 'stderr', data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 8) return;
      const type = this.buf[0]!;
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) return;
      const payload = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      if (type === 1) this.onFrame('stdout', payload);
      else if (type === 2) this.onFrame('stderr', payload);
      // type 0 (stdin echo) and unknown types are ignored
    }
  }
}

// ------------------------------------------------------------------------------ provider

interface InspectInfo {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
}

interface ExecInspect {
  Running?: boolean;
  ExitCode?: number | null;
}

interface Entry {
  athleteId: string;
  containerId: string;
  mounts: SandboxMounts;
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
}

export function createDockerProvider(opts: DockerSandboxOptions): SandboxProvider {
  return new DockerSandboxProvider(opts);
}

class DockerSandboxProvider implements SandboxProvider {
  readonly kind = 'docker';
  readonly isolated = true;
  private readonly client: DockerClient;
  private readonly byContainer = new Map<string, Entry>();
  private readonly byAthlete = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<SandboxHandle>>();
  private disposed = false;
  private readonly active = new Map<NodeJS.ReadableStream & { destroy(): void }, string>();

  constructor(private readonly opts: DockerSandboxOptions) {
    if (!opts.image.trim()) throw new ToolError('INVALID_INPUT', 'sandbox image must not be empty');
    if (!(opts.memoryMb > 0) || !Number.isFinite(opts.memoryMb)) throw new ToolError('INVALID_INPUT', 'memoryMb must be positive and finite');
    if (!(opts.cpus > 0) || !Number.isFinite(opts.cpus)) throw new ToolError('INVALID_INPUT', 'cpus must be positive and finite');
    if (opts.pidsLimit !== undefined && (!Number.isInteger(opts.pidsLimit) || opts.pidsLimit < 1)) throw new ToolError('INVALID_INPUT', 'pidsLimit must be a positive integer');
    this.client = new DockerClient(opts.socketPath);
  }

  // -------------------------------------------------------------------------- lifecycle

  async ensure(athleteId: string, mounts: SandboxMounts): Promise<SandboxHandle> {
    this.assertLive();
    if (!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,255}$/.test(athleteId)) throw new ToolError('INVALID_INPUT', 'invalid athlete id');
    for (const key of ['workspace', 'raw', 'history', 'system'] as const) {
      const p = mounts[key];
      if (typeof p !== 'string' || !p.startsWith('/') || p.includes(':') || p.includes('\0')) throw new Error(`sandbox mount ${key} must be an absolute host path without ":" (got ${JSON.stringify(p)})`);
    }
    const pending = this.inflight.get(athleteId);
    const p = (pending ?? Promise.resolve()).catch(() => undefined).then(() => {
      this.assertLive();
      return this.doEnsure(athleteId, mounts);
    }).finally(() => { if (this.inflight.get(athleteId) === p) this.inflight.delete(athleteId); });
    this.inflight.set(athleteId, p);
    return p;
  }

  private createBody(athleteId: string, mounts: SandboxMounts): { body: Record<string, unknown>; hash: string } {
    const o = this.opts;
    const gitPath = join(mounts.workspace, '.git');
    if (existsSync(gitPath) && lstatSync(gitPath).isSymbolicLink()) throw new Error('workspace .git must not be a symlink');
    const body = {
      Image: o.image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/workspace',
      User: o.user ?? defaultUser(),
      Labels: { [LABEL_ATHLETE]: athleteId, 'opencoach.managed': 'true' } as Record<string, string>,
      HostConfig: {
        Binds: [`${mounts.workspace}:/workspace:rw`, `${mounts.raw}:/raw:ro`, `${mounts.history}:/history:ro`, `${mounts.system}:/system:ro`, ...(existsSync(gitPath) ? [`${gitPath}:/workspace/.git:ro`] : [])],
        NetworkMode: 'none',
        Memory: Math.round(o.memoryMb * 1024 * 1024),
        MemorySwap: Math.round(o.memoryMb * 1024 * 1024),
        NanoCpus: Math.round(o.cpus * 1e9),
        ...(o.runtime ? { Runtime: o.runtime } : {}),
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${o.tmpSize ?? '512m'}` },
        ReadonlyRootfs: true,
        PidsLimit: o.pidsLimit ?? 512,
        Init: true,
      },
    };
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    body.Labels[LABEL_CONFIG] = hash;
    return { body, hash };
  }

  private async doEnsure(athleteId: string, mounts: SandboxMounts): Promise<SandboxHandle> {
    const { body, hash } = this.createBody(athleteId, mounts);
    const found = await this.findContainers(athleteId);
    let containerId: string | undefined;
    for (const c of found) {
      const info = await this.client.json<InspectInfo>('GET', `/containers/${c.Id}/json`);
      const current = info.Config?.Labels?.[LABEL_CONFIG] === hash;
      if (current && containerId === undefined) {
        containerId = c.Id;
        if (!info.State?.Running) await this.start(c.Id);
      } else {
        // stale configuration (or a duplicate): replace it
        await this.client.json('DELETE', `/containers/${c.Id}?force=true`, undefined, [404]);
      }
    }
    if (containerId === undefined) containerId = await this.createAndStart(athleteId, body);
    const entry: Entry = { athleteId, containerId, mounts };
    const previous = this.byAthlete.get(athleteId);
    if (previous && previous.containerId !== containerId) this.byContainer.delete(previous.containerId);
    this.byContainer.set(containerId, entry);
    this.byAthlete.set(athleteId, entry);
    return { athleteId, id: containerId, kind: this.kind };
  }

  private async findContainers(athleteId: string): Promise<Array<{ Id: string }>> {
    const filters = encodeURIComponent(JSON.stringify({ label: ['opencoach.managed=true', `${LABEL_ATHLETE}=${athleteId}`] }));
    return (await this.client.json<Array<{ Id: string }>>('GET', `/containers/json?all=true&filters=${filters}`)) ?? [];
  }

  private async createAndStart(athleteId: string, body: Record<string, unknown>): Promise<string> {
    const suffix = createHash('sha256').update(athleteId).digest('hex').slice(0, 8);
    const name = `opencoach-${sanitizeName(athleteId)}-${suffix}`;
    const create = (): Promise<{ Id: string }> => this.client.json<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    let created: { Id: string };
    try {
      created = await create();
    } catch (e) {
      if (e instanceof DockerApiError && e.status === 409) {
        // A name collision must never delete a container owned by someone else.
        throw new Error(`Docker container name ${name} is already in use; refusing to remove an unmanaged container (${e.message})`);
      } else if (e instanceof DockerApiError && e.status === 404) {
        throw new Error(`Docker image ${String(body.Image)} not found on the daemon; build or pull it first (${e.message})`);
      } else {
        throw e;
      }
    }
    await this.start(created.Id);
    return created.Id;
  }

  private async start(id: string): Promise<void> {
    await this.client.json('POST', `/containers/${id}/start`, undefined, [304]);
  }

  // ------------------------------------------------------------------------------- exec

  async exec(handle: SandboxHandle, command: string, opts: ExecOptions): Promise<ExecResult> {
    this.assertLive();
    const entry = this.byContainer.get(handle.id);
    if (!entry || entry.athleteId !== handle.athleteId) throw new Error(`unknown or released sandbox handle ${handle.id}; call ensure() first`);
    const cwd = validateCwd(opts.cwd);
    const env = buildEnv({ path: DOCKER_PATH, tz: opts.tz, env: opts.env, fakeTime: opts.fakeTime, faketimeLibrary: this.opts.faketimeLibrary });
    try {
      return await this.execOnce(entry.containerId, command, opts, cwd, env);
    } catch (e) {
      // The container vanished or was stopped behind our back: bring it back once and retry.
      if (e instanceof DockerApiError && (e.status === 404 || e.status === 409) && this.byContainer.has(handle.id)) {
        const fresh = await this.doEnsure(entry.athleteId, entry.mounts);
        // Preserve only this previously issued handle after an automatic recovery.
        this.byContainer.set(handle.id, this.byContainer.get(fresh.id)!);
        return this.execOnce(fresh.id, command, opts, cwd, env);
      }
      throw e;
    }
  }

  private async execOnce(containerId: string, command: string, opts: ExecOptions, cwd: string, env: Record<string, string>): Promise<ExecResult> {
    if (!(opts.timeoutS > 0) || !Number.isFinite(opts.timeoutS)) throw new ToolError('INVALID_INPUT', 'timeoutS must be a positive number');
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const timeoutArg = String(Number(opts.timeoutS.toFixed(3)));
    if (opts.signal?.aborted) return { stdout: '', stderr: '', exitCode: ABORTED_EXIT_CODE, timedOut: false, truncated: false, durationMs: 0 };

    const hasStdin = opts.stdin !== undefined;
    const created = await this.client.json<{ Id: string }>('POST', `/containers/${containerId}/exec`, {
      // Docker merges exec Env with the image environment; env -i removes inherited entries.
      Cmd: ['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'timeout', '-s', 'KILL', timeoutArg, 'bash', '--noprofile', '--norc', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: hasStdin,
      Tty: false,
      WorkingDir: cwd,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    });

    const started = performance.now();
    const out = new OutputCollector(maxBytes);
    const err = new OutputCollector(maxBytes);
    const demux = new DockerDemuxer((s, d) => (s === 'stdout' ? out : err).push(d));

    let connection: Awaited<ReturnType<DockerClient['startExec']>>;
    try {
      connection = await this.client.startExec(created.Id, opts.stdin, opts.signal, opts.timeoutS * 1000 + WATCHDOG_GRACE_MS);
    } catch (error) {
      if (!opts.signal?.aborted) throw error;
      await this.stopCommand(containerId);
      return { stdout: '', stderr: '', exitCode: ABORTED_EXIT_CODE, timedOut: false, truncated: false, durationMs: Math.round(performance.now() - started) };
    }
    const { stream, initial } = connection;
    this.active.set(stream, containerId);
    let watchdogFired = false;
    let aborted = false;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        aborted = true;
        stream.destroy();
        finish();
      };
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        stream.destroy();
        finish();
      }, opts.timeoutS * 1000 + WATCHDOG_GRACE_MS);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('data', (c: Buffer) => demux.push(c));
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
      if (initial.length > 0) demux.push(initial);
      if (opts.signal?.aborted) onAbort();
    });

    this.active.delete(stream);
    // Closing an attached stream does not stop Docker exec. Stop the container so
    // an aborted command cannot keep mutating the athlete's workspace.
    if (this.disposed) aborted = true;
    if (aborted || watchdogFired) await this.stopCommand(containerId);
    const durationMs = Math.round(performance.now() - started);
    const o = out.finish();
    const e = err.finish();
    if (aborted) return { stdout: o.text, stderr: e.text, exitCode: ABORTED_EXIT_CODE, timedOut: false, truncated: o.truncated || e.truncated, durationMs };
    if (watchdogFired) return { stdout: o.text, stderr: e.text, exitCode: TIMED_OUT_EXIT_CODE, timedOut: true, truncated: o.truncated || e.truncated, durationMs };

    const exitCode = await this.exitCodeOf(created.Id);
    // `timeout -s KILL` reports 137 when it fires (124 with other signals); a command that ran the whole
    // budget and died that way timed out.
    const ranWholeBudget = durationMs >= opts.timeoutS * 1000 * 0.98;
    const timedOut = (exitCode === 137 || exitCode === TIMED_OUT_EXIT_CODE) && ranWholeBudget;
    return { stdout: o.text, stderr: e.text, exitCode: timedOut ? TIMED_OUT_EXIT_CODE : exitCode, timedOut, truncated: o.truncated || e.truncated, durationMs };
  }

  /** Exit code of a finished exec (polls briefly: the daemon may report it a few ms after the stream closes). */
  private async exitCodeOf(execId: string): Promise<number> {
    let info: ExecInspect = {};
    for (let i = 0; i < 100; i++) {
      info = await this.client.json<ExecInspect>('GET', `/exec/${execId}/json`);
      if (info.Running !== true) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return typeof info.ExitCode === 'number' ? info.ExitCode : -1;
  }

  private async stopCommand(containerId: string): Promise<void> {
    await this.client.json('POST', `/containers/${containerId}/stop?t=0`, undefined, [304, 404]);
  }

  /** Force removal kills detached children and relinquishes every athlete bind [SEC-6]. */
  async release(handle: SandboxHandle): Promise<void> {
    const entry = this.byContainer.get(handle.id);
    if (!entry) return;
    if (entry.athleteId !== handle.athleteId) throw new Error(`sandbox handle ${handle.id} belongs to a different athlete`);
    await this.removeContainer(entry.containerId);
  }

  async releaseAthlete(athleteId: string): Promise<void> {
    this.assertLive();
    // Query the daemon, not only this process's maps: containers can survive a server crash.
    const filters = encodeURIComponent(JSON.stringify({ label: ['opencoach.managed=true'] }));
    const containers = await this.client.json<Array<{ Id: string; Labels?: Record<string, string> }>>('GET', `/containers/json?all=true&filters=${filters}`);
    for (const container of containers ?? []) {
      const key = container.Labels?.[LABEL_ATHLETE];
      if (key === athleteId || key?.startsWith(`${athleteId}:`)) await this.removeContainer(container.Id);
    }
  }

  private async removeContainer(containerId: string): Promise<void> {
    // Keep all bookkeeping if the daemon refuses removal; the caller must fail closed.
    await this.client.json('DELETE', `/containers/${containerId}?force=true`, undefined, [404]);
    for (const [stream, id] of this.active) if (id === containerId) { stream.destroy(); this.active.delete(stream); }
    for (const [id, entry] of this.byContainer) if (entry.containerId === containerId) this.byContainer.delete(id);
    for (const [athleteId, entry] of this.byAthlete) if (entry.containerId === containerId) this.byAthlete.delete(athleteId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const runningContainers = new Set(this.active.values());
    for (const stream of this.active.keys()) stream.destroy();
    await Promise.all([...runningContainers].map((id) => this.stopCommand(id)));
    this.active.clear();
    this.byContainer.clear();
    this.byAthlete.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('sandbox provider is disposed');
  }
}

function defaultUser(): string | undefined {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  return uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;
}
