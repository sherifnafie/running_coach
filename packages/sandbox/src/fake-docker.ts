/**
 * A tiny fake of the Docker Engine API on a unix socket, for the Docker provider's tests (there is no
 * Docker daemon in CI). It implements just what the provider uses: ping, list/create/inspect/start/
 * remove containers, exec create/start (with the connection upgrade + stdin half-close, or the plain
 * streaming fallback) and exec inspect, with Docker's 8-byte-header stream multiplexing.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeContainer {
  id: string;
  name: string;
  body: Record<string, any>;
  running: boolean;
}

export interface FakeExecRequest {
  containerId: string;
  cmd: string[];
  env: string[];
  workingDir?: string;
  attachStdin: boolean;
  stdin: string;
  raw: Record<string, any>;
}

export interface FakeExecResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  /** Interleaved frames instead of stdout/stderr (in order). */
  frames?: Array<{ stream: 'stdout' | 'stderr'; data: string | Buffer }>;
  exitCode?: number;
  /** Wait before answering. */
  delayMs?: number;
  /** Never finish the stream (tests the watchdog / abort). */
  hang?: boolean;
  /** Write the multiplexed stream in pieces of this many bytes (default: whole frames). */
  pieceSize?: number;
  /** Report Running: true for this many exec-inspect polls after the stream closed. */
  runningPolls?: number;
}

export type FakeExecHandler = (req: FakeExecRequest) => FakeExecResult | Promise<FakeExecResult>;

export class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly requests: Array<{ method: string; path: string; body?: any }> = [];
  readonly execRequests: FakeExecRequest[] = [];
  /** Respond to the next N exec creates with this status (e.g. 404 = container vanished). */
  failExecCreate: { status: number; times: number } | undefined;
  /** Use the plain 200 streaming response instead of the 101 upgrade. */
  upgrade = true;
  handler: FakeExecHandler = () => ({ stdout: '', exitCode: 0 });
  socketPath = '';

  private dir = '';
  private server: http.Server | undefined;
  private execs = new Map<string, { containerId: string; exitCode?: number; runningPolls: number }>();
  private seq = 0;
  private readonly sockets = new Set<Socket>();

  async listen(): Promise<string> {
    this.dir = mkdtempSync(join(tmpdir(), 'ocd-'));
    this.socketPath = join(this.dir, 'd.sock');
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on('connection', (socket: Socket) => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket: Socket, head: Buffer) => void this.onUpgrade(req, socket, head));
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
    return this.socketPath;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }

  /** Test helper: stop a container behind the provider's back. */
  stopAll(): void {
    for (const c of this.containers.values()) c.running = false;
  }

  private id(prefix: string): string {
    return `${prefix}${(this.seq++).toString(16).padStart(4, '0')}${randomBytes(6).toString('hex')}`;
  }

  private find(idOrName: string): FakeContainer | undefined {
    const decoded = decodeURIComponent(idOrName);
    return this.containers.get(decoded) ?? [...this.containers.values()].find((c) => c.name === decoded);
  }

  private async body(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : undefined;
  }

  private send(res: http.ServerResponse, status: number, json?: unknown): void {
    if (json === undefined) {
      res.writeHead(status).end();
      return;
    }
    const payload = Buffer.from(JSON.stringify(json));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length }).end(payload);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://docker');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const body = await this.body(req);
    this.requests.push({ method, path: path + url.search, body });
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/_ping') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');

    if (method === 'GET' && path === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] };
      const list = [...this.containers.values()]
        .filter((c) => (filters.label ?? []).every((l) => {
          const [k, v] = l.split('=');
          return c.body.Labels?.[k!] === v;
        }))
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.running ? 'running' : 'exited' }));
      return this.send(res, 200, list);
    }

    if (method === 'POST' && path === '/containers/create') {
      const name = url.searchParams.get('name') ?? this.id('anon');
      if (body.Image === 'missing:image') return this.send(res, 404, { message: `No such image: ${body.Image}` });
      if ([...this.containers.values()].some((c) => c.name === name)) return this.send(res, 409, { message: `Conflict. The container name "/${name}" is already in use` });
      const c: FakeContainer = { id: this.id('c'), name, body, running: false };
      this.containers.set(c.id, c);
      return this.send(res, 201, { Id: c.id, Warnings: [] });
    }

    if ((m = /^\/containers\/([^/]+)\/start$/.exec(path)) && method === 'POST') {
      const c = this.find(m[1]!);
      if (!c) return this.send(res, 404, { message: 'No such container' });
      if (c.running) return this.send(res, 304);
      c.running = true;
      return this.send(res, 204);
    }

    if ((m = /^\/containers\/([^/]+)\/stop$/.exec(path)) && method === 'POST') {
      const c = this.find(m[1]!);
      if (!c) return this.send(res, 404, { message: 'No such container' });
      c.running = false;
      return this.send(res, 204);
    }

    if ((m = /^\/containers\/([^/]+)\/json$/.exec(path)) && method === 'GET') {
      const c = this.find(m[1]!);
      if (!c) return this.send(res, 404, { message: 'No such container' });
      return this.send(res, 200, { Id: c.id, Name: `/${c.name}`, State: { Running: c.running }, Config: { Image: c.body.Image, Labels: c.body.Labels }, HostConfig: c.body.HostConfig });
    }

    if ((m = /^\/containers\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const c = this.find(m[1]!);
      if (!c) return this.send(res, 404, { message: 'No such container' });
      this.containers.delete(c.id);
      return this.send(res, 204);
    }

    if ((m = /^\/containers\/([^/]+)\/exec$/.exec(path)) && method === 'POST') {
      if (this.failExecCreate && this.failExecCreate.times > 0) {
        this.failExecCreate.times--;
        const status = this.failExecCreate.status;
        if (status === 404) this.containers.clear(); // the container really vanished
        return this.send(res, status, { message: status === 404 ? 'No such container' : 'Container is not running' });
      }
      const c = this.find(m[1]!);
      if (!c) return this.send(res, 404, { message: 'No such container' });
      if (!c.running) return this.send(res, 409, { message: `Container ${c.id} is not running` });
      const id = this.id('e');
      this.execs.set(id, { containerId: c.id, runningPolls: 0 });
      (this.execs.get(id) as any).cfg = body;
      return this.send(res, 201, { Id: id });
    }

    if ((m = /^\/exec\/([^/]+)\/start$/.exec(path)) && method === 'POST') {
      // plain (non-upgraded) streaming response
      const exec = this.execs.get(m[1]!);
      if (!exec) return this.send(res, 404, { message: 'No such exec instance' });
      const out = await this.runExec(m[1]!, '');
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      if (out.hang) return; // never ends
      for (const piece of out.pieces) res.write(piece);
      res.end();
      return;
    }

    if ((m = /^\/exec\/([^/]+)\/json$/.exec(path)) && method === 'GET') {
      const exec = this.execs.get(m[1]!);
      if (!exec) return this.send(res, 404, { message: 'No such exec instance' });
      if (exec.runningPolls > 0) {
        exec.runningPolls--;
        return this.send(res, 200, { ID: m[1], Running: true, ExitCode: null });
      }
      return this.send(res, 200, { ID: m[1], Running: false, ExitCode: exec.exitCode ?? 0 });
    }

    this.send(res, 404, { message: `fake docker: unhandled ${method} ${path}` });
  }

  private async onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://docker');
    const m = /^\/exec\/([^/]+)\/start$/.exec(url.pathname);
    const exec = m ? this.execs.get(m[1]!) : undefined;
    this.requests.push({ method: req.method ?? 'POST', path: url.pathname, body: { upgrade: true } });
    if (!m || !exec) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const cfg = (exec as any).cfg as { AttachStdin?: boolean };
    const bodyLen = Number(req.headers['content-length'] ?? 0);
    let buf: Buffer = head;
    let ended = false;
    socket.on('data', (c: Buffer) => (buf = Buffer.concat([buf, c])));
    socket.on('end', () => (ended = true));
    socket.on('error', () => {});
    if (!this.upgrade) {
      const out = await this.runExec(m[1]!, '');
      const bytes = Buffer.concat(out.pieces);
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`);
      if (!out.hang) socket.end(bytes);
      return;
    }
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    if (cfg?.AttachStdin) {
      // the client half-closes after writing stdin
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (ended || socket.destroyed) {
            clearInterval(t);
            resolve();
          }
        }, 5);
      });
    }
    const stdin = buf.subarray(bodyLen).toString('utf8');
    const out = await this.runExec(m[1]!, stdin);
    if (out.hang) return;
    for (const piece of out.pieces) {
      socket.write(piece);
      await new Promise((r) => setImmediate(r));
    }
    socket.end();
  }

  private async runExec(execId: string, stdin: string): Promise<{ pieces: Buffer[]; hang: boolean }> {
    const exec = this.execs.get(execId)!;
    const cfg = (exec as any).cfg as Record<string, any>;
    const request: FakeExecRequest = {
      containerId: exec.containerId,
      cmd: cfg.Cmd,
      env: cfg.Env ?? [],
      workingDir: cfg.WorkingDir,
      attachStdin: !!cfg.AttachStdin,
      stdin,
      raw: cfg,
    };
    this.execRequests.push(request);
    const result = await this.handler(request);
    if (result.delayMs) await new Promise((r) => setTimeout(r, result.delayMs));
    exec.exitCode = result.exitCode ?? 0;
    exec.runningPolls = result.runningPolls ?? 0;
    if (result.hang) return { pieces: [], hang: true };

    const frames = result.frames ?? [
      ...(result.stdout !== undefined ? [{ stream: 'stdout' as const, data: result.stdout }] : []),
      ...(result.stderr !== undefined ? [{ stream: 'stderr' as const, data: result.stderr }] : []),
    ];
    const bytes = Buffer.concat(
      frames.map((f) => {
        const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
        const header = Buffer.alloc(8);
        header[0] = f.stream === 'stdout' ? 1 : 2;
        header.writeUInt32BE(data.length, 4);
        return Buffer.concat([header, data]);
      }),
    );
    const size = result.pieceSize ?? Math.max(1, bytes.length);
    const pieces: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size));
    return { pieces, hang: false };
  }
}
