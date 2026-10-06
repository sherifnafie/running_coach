/**
 * Path-jailed virtual filesystem (SPEC §6.1): /workspace (rw unless a write scope restricts it),
 * /raw, /history and /system (read-only). Relative paths resolve under /workspace.
 *
 * Containment is enforced lexically (posix normalisation, no `..` hopping between mounts) and
 * physically (the real path of the longest existing prefix must stay inside the mount's real root,
 * so symlinks planted by the sandbox cannot lead out). Known limit: like any path-based check this
 * has an inherent check-then-use window against a concurrently running sandbox; reads re-verify the
 * opened file descriptor on Linux (/proc/self/fd) to narrow it.
 */
import { constants as fsc, promises as fsp, realpathSync } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { glob as tinyGlob } from 'tinyglobby';
import { ToolError, type GrepMatch, type MountRoot, type ResolvedPath, type VirtualFS } from '@opencoach/protocol';
import { errCode, isWithin, randomSuffix, toPosix } from './fsutil';
import type { MountedFsOptions } from './types';

const DEFAULT_MAX_READ = 2 * 1024 * 1024;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_BINARY_PROBE = 8192;
const GREP_MAX_LINE_CHARS = 2000;
const GREP_BUDGET_MS = 15_000;

interface Mount {
  name: MountRoot;
  host: string;
  writable: boolean;
}

function realpathLenientSync(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    const code = errCode(e);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathLenientSync(parent), path.basename(p));
  }
}

function normalizeScopeGlob(g: string): string {
  let out = g.replace(/^\/workspace(\/|$)/, '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (out.endsWith('/')) out += '**';
  // A subtree scope grants files below the directory, not replacing the directory itself.
  if (out.endsWith('/**')) out += '/*';
  return out;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function mapFsError(e: unknown, virtual: string): never {
  if (e instanceof ToolError) throw e;
  switch (errCode(e)) {
    case 'ENOENT':
      throw new ToolError('ENOENT', `No such file or directory: ${virtual}`);
    case 'ENOTDIR':
      throw new ToolError('ENOENT', `Not found: ${virtual} (a parent component is a file, not a directory)`);
    case 'EISDIR':
      throw new ToolError('EISDIR', `${virtual} is a directory. Use glob to list it.`);
    case 'EACCES':
    case 'EPERM':
      throw new ToolError('EACCES', `Permission denied: ${virtual}`);
    case 'ELOOP':
      throw new ToolError('EACCES', `Too many levels of symbolic links: ${virtual}`);
    default:
      throw new ToolError('INTERNAL', `Filesystem error on ${virtual}: ${(e as Error)?.message ?? String(e)}`);
  }
}

class MountedFS implements VirtualFS {
  private readonly mounts: Mount[];
  private readonly maxReadBytes: number;
  private readonly scope: string[] | null;
  private readonly scopeMatcher: ((p: string) => boolean) | null;

  constructor(private readonly opts: MountedFsOptions) {
    this.mounts = [
      { name: '/workspace', host: path.resolve(opts.workspace), writable: true },
      { name: '/raw', host: path.resolve(opts.raw), writable: false },
      { name: '/history', host: path.resolve(opts.history), writable: false },
      { name: '/system', host: path.resolve(opts.system), writable: false },
    ];
    this.maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ;
    this.scope = opts.writeScope ? [...opts.writeScope] : null;
    const patterns = this.scope ? this.scope.map(normalizeScopeGlob).filter((g) => g.length > 0) : [];
    this.scopeMatcher = this.scope ? (patterns.length ? picomatch(patterns, { dot: true }) : () => false) : null;
  }

  get writeScope(): string[] | null {
    return this.scope ? [...this.scope] : null;
  }

  private mountList(): string {
    return this.mounts.map((m) => `${m.name} (${m.writable ? 'read-write' : 'read-only'})`).join(', ');
  }

  resolve(input: string, mode: 'read' | 'write'): ResolvedPath {
    if (typeof input !== 'string' || input.length === 0) throw new ToolError('INVALID_INPUT', 'path must be a non-empty string');
    if (input.includes('\0')) throw new ToolError('INVALID_INPUT', 'path contains a NUL byte');
    const isAbs = input.startsWith('/');
    const abs = isAbs ? input : `/workspace/${input}`;
    const norm = path.posix.normalize(abs);
    const startSeg = abs.split('/').filter(Boolean)[0];
    const segs = norm.split('/').filter(Boolean);
    if (segs.length === 0) throw new ToolError('EACCES', `"/" is not a directory you can access. Mounts: ${this.mountList()}. Relative paths resolve under /workspace.`);
    const mount = this.mounts.find((m) => m.name === `/${segs[0]}`);
    if (!mount) {
      throw new ToolError('EACCES', `Unknown path root "/${segs[0]}" (${input}). Mounts: ${this.mountList()}. Relative paths resolve under /workspace.`);
    }
    if (startSeg !== segs[0]) {
      throw new ToolError('EACCES', `Path "${input}" escapes ${isAbs ? `/${startSeg ?? ''}` : '/workspace'} (it uses ".." to leave the mount). Use a path inside one of: ${this.mountList()}.`);
    }
    const relSegs = segs.slice(1);
    const rel = relSegs.join('/');
    const virtual = norm.replace(/\/+$/, '') || '/';
    const host = relSegs.length ? path.join(mount.host, ...relSegs) : mount.host;

    // physical containment (symlinks)
    let realRoot: string;
    let realTarget: string;
    try {
      realRoot = realpathLenientSync(mount.host);
      realTarget = realpathLenientSync(host);
    } catch (e) {
      return mapFsError(e, virtual);
    }
    if (!isWithin(realRoot, realTarget)) {
      throw new ToolError('EACCES', `${virtual} resolves outside the ${mount.name} mount (symbolic link?). Access denied.`);
    }

    if (mode === 'write') {
      if (!mount.writable) throw new ToolError('EACCES', `${mount.name} is a read-only mount; you cannot write ${virtual}. Write under /workspace instead.`);
      if (!rel) throw new ToolError('EISDIR', `${virtual} is a directory`);
      // writeFile atomically replaces the final entry, so a final symlink is not followed.
      // Parent symlinks still resolve physically and must satisfy the write scope.
      const writeTarget = path.join(realpathLenientSync(path.dirname(host)), path.basename(host));
      const realRel = toPosix(path.relative(realRoot, writeTarget));
      if (!isWithin(realRoot, writeTarget)) throw new ToolError('EACCES', `${virtual} resolves outside the ${mount.name} mount. Access denied.`);
      const targetRel = toPosix(path.relative(realRoot, realTarget));
      if (targetRel.split('/').includes('.git')) throw new ToolError('EACCES', `The .git directory is managed by the harness; you cannot modify ${virtual}.`);
      for (const r of new Set([rel, realRel])) {
        if (r.split('/').includes('.git')) throw new ToolError('EACCES', `The .git directory is managed by the harness; you cannot modify ${virtual}.`);
        if (this.scopeMatcher && !this.scopeMatcher(r)) {
          const allowed = this.scope && this.scope.length ? this.scope.join(', ') : '(none: read-only)';
          throw new ToolError('EOUTOFSCOPE', `Writing /workspace/${r} is outside your write scope. You may only modify files matching: ${allowed}.`);
        }
      }
    }
    return { virtual, host, mount: mount.name };
  }

  private async verifyOpened(fd: number, mountName: MountRoot, virtual: string): Promise<void> {
    if (process.platform !== 'linux') return;
    let target: string;
    try {
      target = await fsp.readlink(`/proc/self/fd/${fd}`);
    } catch {
      return;
    }
    target = target.replace(/ \(deleted\)$/, '');
    const mount = this.mounts.find((m) => m.name === mountName)!;
    if (!isWithin(realpathLenientSync(mount.host), target)) throw new ToolError('EACCES', `${virtual} resolves outside the ${mountName} mount. Access denied.`);
  }

  async readFile(p: string): Promise<Uint8Array> {
    const r = this.resolve(p, 'read');
    let fh;
    try {
      fh = await fsp.open(r.host, fsc.O_RDONLY | fsc.O_NONBLOCK);
    } catch (e) {
      return mapFsError(e, r.virtual);
    }
    try {
      const st = await fh.stat();
      if (st.isDirectory()) throw new ToolError('EISDIR', `${r.virtual} is a directory. Use glob to list it.`);
      if (!st.isFile()) throw new ToolError('EACCES', `${r.virtual} is not a regular file.`);
      if (st.size > this.maxReadBytes) {
        throw new ToolError('ETOOBIG', `${r.virtual} is ${fmtBytes(st.size)}, larger than the ${fmtBytes(this.maxReadBytes)} read limit. Read part of it with offset/limit, search it with grep, or process it with bash.`);
      }
      await this.verifyOpened(fh.fd, r.mount, r.virtual);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buf = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > this.maxReadBytes) throw new ToolError('ETOOBIG', `${r.virtual} grew beyond the ${fmtBytes(this.maxReadBytes)} read limit while reading.`);
        chunks.push(buf.subarray(0, bytesRead));
      }
      const all = Buffer.concat(chunks, total);
      return new Uint8Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength));
    } catch (e) {
      return mapFsError(e, r.virtual);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async readText(p: string): Promise<string> {
    return Buffer.from(await this.readFile(p)).toString('utf8');
  }

  async writeFile(p: string, data: string | Uint8Array): Promise<void> {
    const r = this.resolve(p, 'write');
    const dir = path.dirname(r.host);
    let mode = 0o644;
    try {
      const st = await fsp.lstat(r.host).catch((e) => {
        if (errCode(e) === 'ENOENT') return null;
        throw e;
      });
      if (st?.isDirectory()) throw new ToolError('EISDIR', `${r.virtual} is a directory; write a file path instead.`);
      if (st?.isFile()) mode = st.mode & 0o777;
      await fsp.mkdir(dir, { recursive: true });
      // creating directories may have followed a symlink: re-check containment before writing
      this.resolve(r.virtual, 'write');
      const tmp = path.join(dir, `.${path.basename(r.host)}.${randomSuffix()}.tmp`);
      try {
        await fsp.writeFile(tmp, data, { mode });
        await fsp.chmod(tmp, mode);
        await fsp.rename(tmp, r.host);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    } catch (e) {
      mapFsError(e, r.virtual);
    }
  }

  async stat(p: string): Promise<{ size: number; isDir: boolean; mtimeMs: number } | null> {
    const r = this.resolve(p, 'read');
    try {
      const st = await fsp.stat(r.host);
      return { size: st.size, isDir: st.isDirectory(), mtimeMs: st.mtimeMs };
    } catch (e) {
      const code = errCode(e);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      return mapFsError(e, r.virtual);
    }
  }

  async glob(pattern: string, base?: string): Promise<string[]> {
    if (typeof pattern !== 'string' || pattern.length === 0) throw new ToolError('INVALID_INPUT', 'glob pattern must be a non-empty string');
    if (pattern.includes('\0')) throw new ToolError('INVALID_INPUT', 'pattern contains a NUL byte');
    let basePath = base ?? '/workspace';
    let pat = pattern;
    if (pat.startsWith('/')) {
      // absolute pattern: the leading non-magic segments become the base directory
      const segs = pat.split('/').filter((s) => s.length > 0);
      const firstMagic = segs.findIndex((s) => /[*?[\]{}()!+@]/.test(s));
      const staticSegs = firstMagic === -1 ? segs.slice(0, -1) : segs.slice(0, firstMagic);
      basePath = '/' + staticSegs.join('/');
      pat = segs.slice(staticSegs.length).join('/') || '**';
    }
    pat = pat.replace(/^(\.\/)+/, '');
    if (pat.split('/').includes('..')) throw new ToolError('INVALID_INPUT', 'glob patterns cannot contain ".." segments');
    const b = this.resolve(basePath, 'read');
    const st = await this.stat(b.virtual);
    if (!st) throw new ToolError('ENOENT', `No such directory: ${b.virtual}`);
    if (!st.isDir) throw new ToolError('INVALID_INPUT', `${b.virtual} is a file, not a directory; pass a directory as the base path.`);
    let files: string[];
    try {
      files = await tinyGlob(pat, {
        cwd: b.host,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        expandDirectories: false,
        ignore: ['**/.git', '**/.git/**'],
      });
    } catch (e) {
      return mapFsError(e, b.virtual);
    }
    return files.map((f) => path.posix.join(b.virtual, toPosix(f))).sort();
  }

  async grep(opts: { pattern: string; path?: string; glob?: string; context?: number; max?: number; caseInsensitive?: boolean }): Promise<GrepMatch[]> {
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, opts.caseInsensitive ? 'i' : '');
    } catch (e) {
      throw new ToolError('INVALID_INPUT', `Invalid regular expression: ${(e as Error).message}`);
    }
    const max = Math.max(1, Math.min(5000, Math.floor(opts.max ?? 100)));
    const ctx = Math.max(0, Math.min(10, Math.floor(opts.context ?? 0)));
    const root = this.resolve(opts.path ?? '/workspace', 'read');
    const st = await this.stat(root.virtual);
    if (!st) throw new ToolError('ENOENT', `No such file or directory: ${root.virtual}`);
    const globMatch = opts.glob ? picomatch(opts.glob.replace(/^(\.\/)+/, ''), { dot: true, basename: !opts.glob.includes('/') }) : null;
    const matches: GrepMatch[] = [];
    const deadline = performance.now() + GREP_BUDGET_MS; // a work budget, not wall-clock "now"

    const scanFile = async (host: string, virtual: string): Promise<void> => {
      let buf: Buffer;
      try {
        const fst = await fsp.stat(host);
        if (!fst.isFile() || fst.size > GREP_MAX_FILE_BYTES) return;
        buf = await fsp.readFile(host);
      } catch {
        return;
      }
      if (buf.subarray(0, GREP_BINARY_PROBE).includes(0)) return;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!re.test(line.length > GREP_MAX_LINE_CHARS ? line.slice(0, GREP_MAX_LINE_CHARS) : line)) continue;
        const m: GrepMatch = { path: virtual, line: i + 1, text: line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line };
        if (ctx > 0) m.context = { before: lines.slice(Math.max(0, i - ctx), i), after: lines.slice(i + 1, i + 1 + ctx) };
        matches.push(m);
        if (matches.length >= max) return;
        if (performance.now() > deadline) throw new ToolError('TIMEOUT', 'grep took too long; narrow it with path or glob.');
      }
      if (performance.now() > deadline) throw new ToolError('TIMEOUT', 'grep took too long; narrow it with path or glob.');
    };

    const walk = async (hostDir: string, virtualDir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(hostDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (matches.length >= max) return;
        if (ent.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        const host = path.join(hostDir, ent.name);
        const virtual = path.posix.join(virtualDir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === '.git' || ent.name === 'node_modules') continue;
          await walk(host, virtual, childRel);
        } else if (ent.isFile()) {
          if (globMatch && !globMatch(childRel)) continue;
          await scanFile(host, virtual);
        }
      }
    };

    if (st.isDir) await walk(root.host, root.virtual, '');
    else if (!globMatch || globMatch(path.posix.basename(root.virtual))) await scanFile(root.host, root.virtual);
    return matches;
  }

  toVirtual(hostPath: string): string | null {
    if (typeof hostPath !== 'string' || hostPath.includes('\0')) return null;
    const abs = path.resolve(hostPath);
    for (const m of this.mounts) {
      const roots = new Set([m.host]);
      try {
        roots.add(realpathSync(m.host));
      } catch {
        /* mount dir does not exist yet */
      }
      for (const root of roots) {
        if (isWithin(root, abs)) {
          const rel = toPosix(path.relative(root, abs));
          return rel ? `${m.name}/${rel}` : m.name;
        }
      }
    }
    return null;
  }

  withWriteScope(scope: string[] | null): VirtualFS {
    return new MountedFS({ ...this.opts, writeScope: scope });
  }
}

export function createMountedFS(opts: MountedFsOptions): VirtualFS {
  return new MountedFS(opts);
}
