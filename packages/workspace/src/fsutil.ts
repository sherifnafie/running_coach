/**
 * Small filesystem helpers shared by the workspace modules (atomic writes, tree copies,
 * ids that are safe to use as path segments). Nothing here knows about coaching.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/** Write a file atomically (temp file in the same directory, then rename). Creates parent dirs. */
export async function atomicWriteFile(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomSuffix()}.tmp`);
  try {
    await fsp.writeFile(tmp, data, { mode: opts.mode ?? 0o644 });
    if (opts.mode !== undefined) await fsp.chmod(tmp, opts.mode);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export interface CopyTreeOptions {
  /** Return true to skip an entry. `rel` is posix-relative to the copy root. */
  skip?: (rel: string, isDir: boolean) => boolean;
  /** Hard-link files instead of copying (falls back to copying across devices). */
  link?: boolean;
}

/**
 * Recursively copy regular files and directories. Symbolic links and special files are never
 * copied or followed (the coach's sandbox can create links; the harness must not follow them).
 */
export async function copyTree(src: string, dst: string, opts: CopyTreeOptions = {}, rel = ''): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (opts.skip?.(childRel, true)) continue;
      await copyTree(from, to, opts, childRel);
    } else if (ent.isFile()) {
      if (opts.skip?.(childRel, false)) continue;
      if (opts.link) {
        try {
          await fsp.link(from, to);
          continue;
        } catch {
          /* fall through to copy */
        }
      }
      await fsp.copyFile(from, to);
    }
  }
}

/** Sorted posix-relative paths of regular files below `root` (symlinks skipped). Missing root → []. */
export async function listFilesRecursive(root: string, skip?: (rel: string, isDir: boolean) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (errCode(e) === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (skip?.(childRel, true)) continue;
        await walk(path.join(dir, ent.name), childRel);
      } else if (ent.isFile()) {
        if (skip?.(childRel, false)) continue;
        out.push(childRel);
      }
    }
  }
  await walk(root, '');
  return out.sort();
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Ids (athlete ids, view ids, ...) become path segments: allow only a conservative alphabet. */
export function assertSafeId(kind: string, id: string): void {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`invalid ${kind} "${String(id).slice(0, 80)}": expected [A-Za-z0-9_-]{1,128}`);
}

/** Lexical containment test for absolute, normalised paths (equal counts as inside). */
export function isWithin(root: string, p: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(p);
  if (c === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(withSep);
}

/** Real path of the longest existing prefix, with the non-existing remainder appended. */
export async function realpathLenient(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch (e) {
    const code = errCode(e);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(await realpathLenient(parent), path.basename(p));
  }
}

/** Run async tasks one at a time per key (in-process mutex). */
const locks = new Map<string, Promise<unknown>>();
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(key, chained);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
