import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

/** A request the fake HTTP side received. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
  /** JSON body (when content-type is JSON). */
  json?: any;
  /** Multipart fields (when content-type is multipart/form-data). */
  form?: { fields: Record<string, string>; files: Array<{ field: string; filename: string; contentType: string; bytes: Buffer }> };
}

/** A sideband websocket connection to the fake. */
export interface FakeWsConn {
  url: string;
  headers: IncomingMessage['headers'];
  socket: WebSocket;
  /** Parsed JSON messages received from the client, in order. */
  received: any[];
  send(msg: unknown): void;
  /** Resolves with the first received message (from index `from`) matching the predicate. */
  waitFor(pred: (m: any) => boolean, from?: number, timeoutMs?: number): Promise<any>;
}

function parseMultipart(body: Buffer, contentType: string): NonNullable<RecordedRequest['form']> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const b = boundary?.[1] ?? boundary?.[2];
  const out: NonNullable<RecordedRequest['form']> = { fields: {}, files: [] };
  if (!b) return out;
  const delimiter = Buffer.from(`--${b}`);
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const headerEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) {
      out.files.push({ field: name, filename, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? '', bytes: Buffer.from(data) });
    } else {
      out.fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return out;
}

export interface FakeOpenAIOptions {
  /** Transcription response body. */
  transcription?: unknown;
  /** Speech audio bytes. */
  speech?: Buffer;
  /** client_secrets response body. */
  clientSecret?: unknown;
  /** Force a status on a path (e.g. { '/v1/realtime/client_secrets': 401 }). */
  failWith?: Record<string, number>;
  /** Reject websocket upgrades with this HTTP status. */
  rejectUpgrade?: number;
}

/**
 * Local stand-in for the OpenAI endpoints the voice package talks to:
 *  POST /v1/audio/transcriptions, POST /v1/audio/speech, POST /v1/realtime/client_secrets
 *  and the realtime sideband websocket at /v1/realtime?call_id=...
 */
export class FakeOpenAI {
  readonly requests: RecordedRequest[] = [];
  readonly connections: FakeWsConn[] = [];
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly opts: FakeOpenAIOptions;
  /** e.g. http://127.0.0.1:12345/v1 */
  baseUrl = '';
  private connectWaiters: Array<(c: FakeWsConn) => void> = [];

  constructor(opts: FakeOpenAIOptions = {}) {
    this.opts = opts;
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const rec: RecordedRequest = { method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers, body };
        const ct = String(req.headers['content-type'] ?? '');
        if (ct.includes('json') && body.length) rec.json = JSON.parse(body.toString('utf8'));
        if (ct.includes('multipart/form-data')) rec.form = parseMultipart(body, ct);
        this.requests.push(rec);
        const path = rec.url.split('?')[0]!;
        const forced = this.opts.failWith?.[path];
        if (forced) {
          res.writeHead(forced, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `forced ${forced}`, type: 'test_error' } }));
          return;
        }
        if (path === '/v1/audio/transcriptions') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.opts.transcription ?? { text: ' hello coach ', usage: { type: 'duration', seconds: 3 } }));
        } else if (path === '/v1/audio/speech') {
          res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(this.opts.speech ?? Buffer.from([1, 2, 3, 4, 5]));
        } else if (path === '/v1/realtime/client_secrets') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.opts.clientSecret ?? { value: 'ek_test_123', expires_at: 1_790_000_000 }));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'not found' } }));
        }
      });
    });
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (_info, cb) => (this.opts.rejectUpgrade ? cb(false, this.opts.rejectUpgrade, 'rejected') : cb(true)),
    });
    this.wss.on('connection', (socket, req) => {
      const conn: FakeWsConn = {
        url: req.url ?? '',
        headers: req.headers,
        socket,
        received: [],
        send: (msg) => socket.send(JSON.stringify(msg)),
        waitFor: (pred, from = 0, timeoutMs = 3000) =>
          new Promise((resolve, reject) => {
            const found = conn.received.slice(from).find(pred);
            if (found) return resolve(found);
            const timer = setTimeout(() => {
              socket.off('message', onMsg);
              reject(new Error(`timed out waiting for a sideband message; got ${JSON.stringify(conn.received.slice(from))}`));
            }, timeoutMs);
            const onMsg = () => {
              const f = conn.received.slice(from).find(pred);
              if (f) {
                clearTimeout(timer);
                socket.off('message', onMsg);
                resolve(f);
              }
            };
            socket.on('message', onMsg);
          }),
      };
      socket.on('message', (data) => conn.received.push(JSON.parse(data.toString())));
      this.connections.push(conn);
      this.connectWaiters.splice(0).forEach((w) => w(conn));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    const { port } = this.http.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
    return this;
  }

  /** Resolves with the next (or an already established) sideband connection. */
  nextConnection(): Promise<FakeWsConn> {
    const existing = this.connections[this.connections.length - 1];
    if (existing) return Promise.resolve(existing);
    return new Promise((r) => this.connectWaiters.push(r));
  }

  async stop(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    this.http.closeAllConnections?.();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}
