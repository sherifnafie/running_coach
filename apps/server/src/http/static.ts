import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Content types for files the gateway and the views origin serve. Unknown → application/octet-stream. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.ics': 'text/calendar; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve a URL-relative path under `root`, refusing traversal (`..`, NUL, backslashes, absolute paths) and
 * symlinks that escape the root. Returns the real absolute path of an existing regular file, else undefined.
 */
export async function resolveSafeFile(root: string, relPath: string): Promise<{ path: string; size: number; mtimeMs: number } | undefined> {
  let rel: string;
  try {
    rel = decodeURIComponent(relPath);
  } catch {
    return undefined;
  }
  if (rel.includes('\0') || rel.includes('\\')) return undefined;
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return undefined;
  const absRoot = resolve(root);
  const candidate = resolve(absRoot, ...parts);
  if (candidate !== absRoot && !candidate.startsWith(absRoot + sep)) return undefined;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(absRoot), realpath(candidate)]);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return undefined;
    const st = await stat(realFile);
    if (!st.isFile()) return undefined;
    return { path: realFile, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

export interface SendFileOptions {
  contentType?: string;
  cacheControl?: string;
  headers?: Record<string, string>;
  /** Explicit strong ETag value (without quotes); defaults to size+mtime. */
  etag?: string;
  /** Send as a download with this filename. */
  attachmentName?: string;
}

function parseRange(header: string, size: number): { start: number; end: number } | 'invalid' | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // unsupported (multi-range etc.) → ignore, send whole file
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream a file with ETag, conditional GET and single-range support. */
export function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: { path: string; size: number; mtimeMs: number },
  opts: SendFileOptions = {},
): FastifyReply {
  const etag = `"${opts.etag ?? `${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}`}"`;
  reply.header('ETag', etag);
  reply.header('Accept-Ranges', 'bytes');
  if (opts.cacheControl) reply.header('Cache-Control', opts.cacheControl);
  for (const [k, v] of Object.entries(opts.headers ?? {})) reply.header(k, v);
  reply.header('Content-Type', opts.contentType ?? contentTypeFor(file.path));
  if (opts.attachmentName) reply.header('Content-Disposition', contentDisposition(opts.attachmentName));

  const inm = request.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
    return reply.code(304).send();
  }

  const rangeHeader = request.headers.range;
  if (typeof rangeHeader === 'string') {
    const range = parseRange(rangeHeader, file.size);
    if (range === 'invalid') {
      reply.header('Content-Range', `bytes */${file.size}`);
      return reply.code(416).send();
    }
    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      reply.header('Content-Length', String(range.end - range.start + 1));
      return reply.send(createReadStream(file.path, { start: range.start, end: range.end }));
    }
  }
  reply.header('Content-Length', String(file.size));
  return reply.send(createReadStream(file.path));
}

