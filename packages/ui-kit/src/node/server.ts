/**
 * Ephemeral localhost HTTP server for the preview renderer (ADR 0003). It serves only:
 *   /kit/<major>/*       the built UI kit
 *   /v/<viewId>/*        the view's own files, with the production CSP (Appendix C §C.4)
 *   /__host.html|.js     the bridge host page
 *   /__api/call          bridge calls forwarded by the host page (token protected)
 * and implements the bridge read-only against coach.db (or an empty-schema fixture).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BridgeParams, BridgeRequest, UI_KIT_MAJOR, type ViewManifest } from '@opencoach/protocol';
import { HOST_HTML, HOST_JS } from './host-page';
import type { SqlExecutor } from './sql';
import { globMatch, resolveInside } from './static-checks';

export interface CspOptions {
  /** Origin that serves the view files and the kit (e.g. https://views.example.com). */
  kitOrigin: string;
  /** Origin of the app shell that may embed the view. */
  appOrigin: string;
}

/** The production view CSP (Appendix C §C.4), parameterised by origin. */
export function buildViewCsp(o: CspOptions): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${o.kitOrigin}`,
    `style-src 'self' 'unsafe-inline' ${o.kitOrigin}`,
    `img-src 'self' data: blob: ${o.kitOrigin}`,
    `font-src ${o.kitOrigin}`,
    "connect-src 'none'",
    `frame-ancestors ${o.appOrigin}`,
  ].join('; ');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export interface ViewContext {
  id: string;
  manifest: ViewManifest;
  dir: string;
}

export interface VariantCollector {
  runtime: string[];
  csp: string[];
}

export interface PreviewServerOptions {
  workspaceDir: string;
  kitDir: string;
  /** Path of data/coach.db (may not exist). */
  realDb: string;
  /** Empty-schema fixture for the empty-state variant. */
  emptyDb: string;
  views: Map<string, ViewContext>;
  /** ids of all views in the workspace (for navigate checks). */
  existingViews: string[];
  exec: SqlExecutor;
}

const MAX_FILE_READ = 512 * 1024;

export class PreviewServer {
  readonly token = randomBytes(16).toString('hex');
  private server?: Server;
  private port = 0;
  private readonly collectors = new Map<string, VariantCollector>();
  private subSeq = 0;

  constructor(private readonly o: PreviewServerOptions) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  collector(view: string, variant: string): VariantCollector {
    const k = `${view}|${variant}`;
    let c = this.collectors.get(k);
    if (!c) this.collectors.set(k, (c = { runtime: [], csp: [] }));
    return c;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`preview server error: ${(e as Error).message}`);
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolveListen());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  // ------------------------------------------------------------------ http

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS-rebinding guard: only answer requests addressed to our own loopback origin.
    if (req.headers.host !== `127.0.0.1:${this.port}`) return this.send(res, 421, 'misdirected request');
    const url = new URL(req.url ?? '/', this.origin);
    const path = url.pathname;

    if (req.method === 'POST' && path === '/__api/call') return this.api(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.send(res, 405, 'method not allowed');

    if (path === '/__host.html') return this.send(res, 200, HOST_HTML, 'text/html; charset=utf-8');
    if (path === '/__host.js') return this.send(res, 200, HOST_JS, 'text/javascript; charset=utf-8');

    const kit = /^\/kit\/([^/]+)\/(.+)$/.exec(path);
    if (kit) {
      if (kit[1] !== UI_KIT_MAJOR) return this.send(res, 404, 'unsupported kit version');
      return this.file(res, this.o.kitDir, decodeURIComponent(kit[2] as string), false);
    }

    const v = /^\/v\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (v) {
      const id = decodeURIComponent(v[1] as string);
      const ctx = this.o.views.get(id);
      if (!ctx) return this.send(res, 404, 'unknown view');
      const rel = decodeURIComponent(v[2] ?? '') || ctx.manifest.entry;
      return this.file(res, ctx.dir, rel, true);
    }
    if (path === '/favicon.ico') return this.send(res, 204, '');
    return this.send(res, 404, 'not found');
  }

  private send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(body);
  }

  private async file(res: ServerResponse, root: string, rel: string, isView: boolean): Promise<void> {
    const abs = resolveInside(root, rel);
    if (!abs) return this.send(res, 400, 'bad path');
    try {
      // Refuse symlinks that escape the root.
      const real = await realpath(abs);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return this.send(res, 403, 'forbidden');
      if (!(await stat(real)).isFile()) return this.send(res, 404, 'not found');
      const data = await readFile(real);
      const ext = extname(real).toLowerCase();
      const headers: Record<string, string> = {
        // Sandboxed iframes have an opaque origin, so module scripts and fonts are fetched in CORS mode.
        // The production views origin must send this header too.
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'referrer-policy': 'no-referrer',
      };
      if (isView && (ext === '.html' || ext === '.htm')) headers['content-security-policy'] = buildViewCsp({ kitOrigin: this.origin, appOrigin: this.origin });
      this.send(res, 200, data, MIME[ext] ?? 'application/octet-stream', headers);
    } catch {
      this.send(res, 404, 'not found');
    }
  }

  // ------------------------------------------------------------------ bridge API

  private async api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers['x-preview-token'] !== this.token) return this.send(res, 403, 'forbidden');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 256 * 1024) return this.send(res, 413, 'too large');
      chunks.push(c as Buffer);
    }
    let body: { view?: string; variant?: string; empty?: boolean; method?: string; params?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.send(res, 400, 'bad json');
    }
    const out = await this.call(body).catch((e: Error) => ({ error: { code: -32603, message: e.message } }));
    this.send(res, 200, JSON.stringify(out), 'application/json');
  }

  private async call(b: { view?: string; variant?: string; empty?: boolean; method?: string; params?: unknown }): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const ctx = typeof b.view === 'string' ? this.o.views.get(b.view) : undefined;
    if (!ctx || typeof b.variant !== 'string') return { error: { code: -32602, message: 'unknown view' } };
    const col = this.collector(ctx.id, b.variant);
    const runtime = (m: string) => {
      if (!col.runtime.includes(m)) col.runtime.push(m);
    };
    const fail = (message: string, code = -32000) => ({ error: { code, message } });

    const method = String(b.method ?? '');
    const req = BridgeRequest.safeParse({ jsonrpc: '2.0', id: 1, method, params: b.params });
    if (!req.success) {
      runtime(`bridge: unknown method "${method}" (allowed: ready, env.get, db.query, db.write, files.read, act, navigate, openChat, subscribe, unsubscribe, toast, report, resize)`);
      return fail(`unknown method "${method}"`, -32601);
    }
    const schema = BridgeParams[method as keyof typeof BridgeParams];
    let params: Record<string, unknown> = {};
    if (schema) {
      const p = schema.safeParse(b.params ?? {});
      if (!p.success) {
        const msg = p.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`).join('; ');
        runtime(`bridge ${method}: invalid params: ${msg}`);
        return fail(`invalid params: ${msg}`, -32602);
      }
      params = p.data as Record<string, unknown>;
    }
    const m = ctx.manifest;

    switch (method) {
      case 'db.query': {
        const sql = String(params.sql);
        const dbPath = b.empty ? this.o.emptyDb : this.o.realDb;
        try {
          const declared = new Set(m.reads.filter((x) => x.startsWith('db:')).map((x) => x.slice(3).toLowerCase()));
          const r = await this.o.exec.query(dbPath, sql, (params.params as unknown[] | undefined) ?? [], undefined, [...declared]);
          const undeclared = r.tables.filter((t) => !declared.has(t.toLowerCase()));
          if (undeclared.length) {
            const msg = `undeclared read: query touches ${undeclared.map((t) => `"${t}"`).join(', ')} but view.json reads only [${[...declared].join(', ') || 'nothing'}]; add "db:${undeclared[0]}" to reads`;
            runtime(msg);
            return fail(msg);
          }
          return { result: r.rows };
        } catch (e) {
          const msg = `db.query failed: ${(e as Error).message} (sql: ${sql.replace(/\s+/g, ' ').slice(0, 160)})`;
          runtime(msg);
          return fail((e as Error).message);
        }
      }
      case 'db.write': {
        const target = String(params.target);
        const op = String(params.op) as 'insert' | 'update' | 'delete';
        const row = (params.row ?? {}) as Record<string, unknown>;
        const decl = m.writes.find((w) => 'db' in w && w.db === target && w.ops.includes(op));
        if (!decl || !('db' in decl)) {
          const msg = `undeclared write: ${op} on "${target}" is not allowed by view.json writes`;
          runtime(msg);
          return fail(msg);
        }
        const bad = decl.columns ? Object.keys(row).filter((k) => !decl.columns?.includes(k)) : [];
        if (bad.length) {
          const msg = `undeclared write: columns ${bad.join(', ')} are not in view.json writes for "${target}"`;
          runtime(msg);
          return fail(msg);
        }
        return { result: null };
      }
      case 'act': {
        const name = String(params.name);
        if (!m.actions.includes(name)) {
          const msg = `undeclared action "${name}": add it to view.json actions`;
          runtime(msg);
          return fail(msg);
        }
        return { result: null };
      }
      case 'files.read': {
        const path = String(params.path);
        const globs = m.reads.filter((x) => x.startsWith('file:')).map((x) => x.slice(5));
        if (!globs.some((g) => globMatch(g, path))) {
          const msg = `undeclared file read: "${path}" does not match any "file:" entry in view.json reads`;
          runtime(msg);
          return fail(msg);
        }
        if (b.empty) return fail(`ENOENT: ${path} (empty-state preview has no files)`);
        const abs = resolveInside(this.o.workspaceDir, path);
        if (!abs) return fail('bad path');
        try {
          const real = await realpath(abs);
          const root = await realpath(this.o.workspaceDir);
          if (!real.startsWith(root + sep)) return fail('forbidden');
          const data = await readFile(real);
          return { result: data.subarray(0, MAX_FILE_READ).toString('utf8') };
        } catch {
          return fail(`ENOENT: ${path}`);
        }
      }
      case 'navigate': {
        const id = String(params.viewId);
        if (!this.o.existingViews.includes(id)) runtime(`navigate to unknown view "${id}"`);
        return { result: null };
      }
      case 'subscribe':
        return { result: { subscriptionId: `sub-${++this.subSeq}` } };
      case 'report': {
        const level = String(params.level);
        const message = String(params.message);
        if (level === 'error') {
          if (message.startsWith('CSP violation:')) {
            if (!col.csp.includes(message)) col.csp.push(message);
          } else runtime(`view reported error: ${message}`);
        }
        return { result: null };
      }
      default:
        return { result: null };
    }
  }
}

export { join, resolve };
