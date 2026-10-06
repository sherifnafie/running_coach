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
import type { Duplex } from 'node:stream';
import { ToolError, type ExecOptions, type ExecResult, type SandboxHandle, type SandboxMounts, type SandboxProvider } from '@opencoach/protocol';
import { ABORTED_EXIT_CODE, DEFAULT_MAX_OUTPUT_BYTES, OutputCollector, TIMED_OUT_EXIT_CODE, buildEnv, validateCwd } from './common';
import type { DockerSandboxOptions } from './types';

const DOCKER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
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
  startExec(execId: string, stdin: string | undefined): Promise<{ stream: NodeJS.ReadableStream & { destroy(): void }; initial: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
      const req = http.request({
        socketPath: this.socketPath,
        path: `/exec/${execId}/start`,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length), Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      req.on('error', reject);
      req.on('upgrade', (_res, socket: Duplex, head: Buffer) => {
        if (stdin !== undefined) socket.end(stdin); // half-close: the exec's stdin sees EOF, output keeps flowing
        resolve({ stream: socket, initial: head });
      });
      req.on('response', (res) => {
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

  constructor(private readonly opts: DockerSandboxOptions) {
    this.client = new DockerClient(opts.socketPath);
  }

  // -------------------------------------------------------------------------- lifecycle

  async ensure(athleteId: string, mounts: SandboxMounts): Promise<SandboxHandle> {
    this.assertLive();
    for (const key of ['workspace', 'raw', 'history', 'system'] as const) {
      const p = mounts[key];
      if (typeof p !== 'string' || !p.startsWith('/') || p.includes(':') || p.includes('\0')) throw new Error(`sandbox mount ${key} must be an absolute host path without ":" (got ${JSON.stringify(p)})`);
    }
    const key = `${athleteId}\n${JSON.stringify(mounts)}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.doEnsure(athleteId, mounts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private createBody(athleteId: string, mounts: SandboxMounts): { body: Record<string, unknown>; hash: string } {
    const o = this.opts;
    const body = {
      Image: o.image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/workspace',
      User: o.user ?? defaultUser(),
      Labels: { [LABEL_ATHLETE]: athleteId, 'opencoach.managed': 'true' } as Record<string, string>,
      HostConfig: {
        Binds: [`${mounts.workspace}:/workspace:rw`, `${mounts.raw}:/raw:ro`, `${mounts.history}:/history:ro`, `${mounts.system}:/system:ro`],
        NetworkMode: 'none',
        Memory: Math.round(o.memoryMb * 1024 * 1024),
        MemorySwap: Math.round(o.memoryMb * 1024 * 1024),
        NanoCpus: Math.round(o.cpus * 1e9),
        ...(o.runtime ? { Runtime: o.runtime } : {}),
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${o.tmpSize ?? '512m'}` },
        ReadonlyRootfs: false,
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
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL_ATHLETE}=${athleteId}`] }));
    return (await this.client.json<Array<{ Id: string }>>('GET', `/containers/json?all=true&filters=${filters}`)) ?? [];
  }

  private async createAndStart(athleteId: string, body: Record<string, unknown>): Promise<string> {
    const name = `opencoach-${sanitizeName(athleteId)}`;
    const create = (): Promise<{ Id: string }> => this.client.json<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    let created: { Id: string };
    try {
      created = await create();
    } catch (e) {
      if (e instanceof DockerApiError && e.status === 409) {
        // a container of that name exists but did not carry our label: replace it
        await this.client.json('DELETE', `/containers/${encodeURIComponent(name)}?force=true`, undefined, [404]);
        created = await create();
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
    const entry = this.byContainer.get(handle.id) ?? this.byAthlete.get(handle.athleteId);
    if (!entry) throw new Error(`unknown or released sandbox handle ${handle.id}; call ensure() first`);
    const cwd = validateCwd(opts.cwd);
    const env = buildEnv({ path: DOCKER_PATH, tz: opts.tz, env: opts.env, fakeTime: opts.fakeTime, faketimeLibrary: this.opts.faketimeLibrary });
    try {
      return await this.execOnce(entry.containerId, command, opts, cwd, env);
    } catch (e) {
      // The container vanished or was stopped behind our back: bring it back once and retry.
      if (e instanceof DockerApiError && (e.status === 404 || e.status === 409)) {
        const fresh = await this.doEnsure(entry.athleteId, entry.mounts);
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
      Cmd: ['timeout', '-s', 'KILL', timeoutArg, 'bash', '-lc', command],
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

    const { stream, initial } = await this.client.startExec(created.Id, opts.stdin);
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
    });

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

  /** The container is deliberately kept (long-lived per athlete); only our bookkeeping is dropped. */
  async release(handle: SandboxHandle): Promise<void> {
    const entry = this.byContainer.get(handle.id);
    if (entry && this.byAthlete.get(entry.athleteId) === entry) this.byAthlete.delete(entry.athleteId);
    this.byContainer.delete(handle.id);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
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
