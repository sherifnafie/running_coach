/**
 * Workspace git repository (SPEC §6.3, [WS-3..6], [RT-8]). Everything shells out to `git` with
 * execFile-style argument arrays (never a shell string).
 *
 * Hardening: the workspace is a repo the coach (through its sandbox) can write into, so every
 * invocation ignores user/system git config, disables hooks and fsmonitor, and prompts never.
 * Harness commits always carry the harness identity and clock-derived dates, so they are
 * deterministic and distinguishable from foreign (hand-made) commits.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { Clock } from '@opencoach/protocol';
import { errCode, sleep, withLock } from './fsutil';
import type { CommitInfo, WorkspaceGit } from './types';

export const HARNESS_GIT_NAME = 'OpenCoach Harness';
export const HARNESS_GIT_EMAIL = 'harness@opencoach.local';

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitRunOptions {
  input?: string;
  env?: Record<string, string>;
  /** Exit codes that are not errors (default [0]). */
  allow?: number[];
  /** Treat pathspecs literally (no glob/magic). */
  literal?: boolean;
}

const BASE_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.quotepath=false',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'safe.directory=*',
  'advice.detachedHead=false',
  'gc.auto=0',
];

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  for (const k of ['PATH', 'TMPDIR', 'SYSTEMROOT', 'HOME']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Run git in `cwd`. Rejects on non-zero exit unless the code is in `allow`. */
export function runGit(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
  const full: string[] = [];
  for (const c of BASE_CONFIG) full.push('-c', c);
  if (opts.literal) full.push('--literal-pathspecs');
  full.push(...args);
  const allow = opts.allow ?? [0];
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', full, { cwd, env: { ...baseEnv(), ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const res: GitResult = { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') };
      if (!allow.includes(res.code)) {
        const sub = args.find((a) => !a.startsWith('-')) ?? args[0] ?? '';
        reject(new Error(`git ${sub} failed (exit ${res.code}): ${res.stderr.trim().slice(0, 500)}`));
      } else resolve(res);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/** Author/committer identity and clock-derived dates for harness commits. */
export function identityEnv(clock: Clock): Record<string, string> {
  const date = `${Math.floor(clock.now().getTime() / 1000)} +0000`;
  return {
    GIT_AUTHOR_NAME: HARNESS_GIT_NAME,
    GIT_AUTHOR_EMAIL: HARNESS_GIT_EMAIL,
    GIT_COMMITTER_NAME: HARNESS_GIT_NAME,
    GIT_COMMITTER_EMAIL: HARNESS_GIT_EMAIL,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

/** `git init` + local identity config for a fresh workspace repo. */
export async function initGitRepo(dir: string): Promise<void> {
  await runGit(dir, ['init', '-q', '-b', 'main']);
  await configureRepo(dir);
}

export async function configureRepo(dir: string): Promise<void> {
  await runGit(dir, ['config', 'user.name', HARNESS_GIT_NAME]);
  await runGit(dir, ['config', 'user.email', HARNESS_GIT_EMAIL]);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
}

// ---------------------------------------------------------------- messages & trailers

const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/;
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;

export function formatCommitMessage(message: string, trailers?: Record<string, string>): string {
  let msg = message.replace(/\r\n/g, '\n').trimEnd();
  if (msg.length === 0) msg = '(no message)';
  const lines: string[] = [];
  for (const [k, v] of Object.entries(trailers ?? {})) {
    if (!TRAILER_KEY.test(k)) throw new Error(`invalid commit trailer key "${k}"`);
    lines.push(`${k}: ${String(v).replace(/\s*[\r\n]+\s*/g, ' ').trim()}`);
  }
  return lines.length ? `${msg}\n\n${lines.join('\n')}\n` : `${msg}\n`;
}

/** Split a commit message into the message proper and its trailing "Key: value" block. */
export function parseCommitMessage(body: string): { message: string; trailers: Record<string, string> } {
  const text = body.replace(/\r\n/g, '\n').trim();
  const paras = text.split(/\n[ \t]*\n/);
  if (paras.length >= 2) {
    const last = paras[paras.length - 1]!;
    const lines = last.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0 && lines.every((l) => TRAILER_LINE.test(l))) {
      const trailers: Record<string, string> = {};
      for (const l of lines) {
        const m = TRAILER_LINE.exec(l)!;
        trailers[m[1]!] = m[2]!.trim();
      }
      return { message: paras.slice(0, -1).join('\n\n').trim(), trailers };
    }
  }
  return { message: text, trailers: {} };
}

// ---------------------------------------------------------------- log parsing

export interface ParsedCommit extends CommitInfo {
  authorEmail: string;
}

const LOG_FORMAT = '--format=%x1e%H%x1f%cI%x1f%ae%x1f%B%x1f';
const SHA_START = /^[0-9a-f]{40,64}\x1f/;

function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const n = inner[++i]!;
    if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && inner[i + 1] !== undefined && inner[i + 1]! >= '0' && inner[i + 1]! <= '7') oct += inner[++i]!;
      bytes.push(parseInt(oct, 8));
    } else {
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' };
      bytes.push(...Buffer.from(map[n] ?? n, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function parseGitLog(stdout: string): ParsedCommit[] {
  const chunks = stdout.split('\x1e');
  const records: string[] = [];
  for (const c of chunks) {
    if (c.length === 0) continue;
    if (SHA_START.test(c) || records.length === 0) records.push(c);
    else records[records.length - 1] += '\x1e' + c; // a stray separator inside a commit message
  }
  const out: ParsedCommit[] = [];
  for (const rec of records) {
    const parts = rec.split('\x1f');
    if (parts.length < 5) continue;
    const commit = parts[0]!;
    const iso = parts[1]!;
    const authorEmail = parts[2]!;
    const tail = parts[parts.length - 1]!;
    const body = parts.slice(3, -1).join('\x1f');
    const files = tail
      .split('\n')
      .filter((l) => l.length > 0)
      .map(unquoteGitPath);
    const { message, trailers } = parseCommitMessage(body);
    const t = new Date(iso);
    out.push({ commit, at: Number.isNaN(t.getTime()) ? iso : t.toISOString(), message, files, trailers, authorEmail });
  }
  return out;
}

// ---------------------------------------------------------------- argument validation

const REV = /^[A-Za-z0-9_][A-Za-z0-9._\/~^@{}:+-]*$/;
export function assertRev(rev: string): void {
  if (typeof rev !== 'string' || !REV.test(rev) || rev.includes('..')) throw new Error(`invalid git revision "${String(rev).slice(0, 80)}"`);
}

/** Normalise a workspace-relative path; rejects traversal and anything inside .git. */
export function normalizeRelPath(p: string): string {
  if (typeof p !== 'string' || p.includes('\0')) throw new Error('invalid workspace path');
  let n = path.posix.normalize(p.replace(/\\/g, '/'));
  n = n.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (n === '' || n === '.' || n.startsWith('/') || n === '..' || n.startsWith('../')) throw new Error(`invalid workspace path "${p}"`);
  if (n.split('/').includes('.git')) throw new Error(`refusing to touch .git (path "${p}")`);
  return n;
}

/** Strip /workspace, ./ and leading slashes from a glob so it is relative to the workspace root. */
function normalizeGlob(g: string): string {
  return g.replace(/^\/workspace(\/|$)/, '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

async function assertNoSymlinkAncestors(root: string, rel: string): Promise<void> {
  const segs = rel.split('/');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]!);
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch (e) {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to modify "${rel}": "${segs.slice(0, i + 1).join('/')}" is a symbolic link`);
  }
}

// ---------------------------------------------------------------- the repo handle

interface StatusEntry {
  xy: string;
  path: string;
  orig?: string;
}

function parsePorcelainZ(buf: Buffer): StatusEntry[] {
  const fields = buf.toString('utf8').split('\0');
  const out: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    const p = f.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const orig = fields[++i];
      out.push({ xy, path: p, orig: orig && orig.length > 0 ? orig : undefined });
    } else out.push({ xy, path: p });
  }
  return out;
}

export function openWorkspaceGit(dir: string, clock: Clock): WorkspaceGit {
  const root = path.resolve(dir);
  const git = (args: string[], opts?: GitRunOptions) => runGit(root, args, opts);
  const locked = <T>(fn: () => Promise<T>) => withLock(`git:${root}`, fn);

  async function listLog(args: string[]): Promise<ParsedCommit[]> {
    const res = await git(['log', '--no-color', '--no-decorate', '--no-renames', '--name-only', LOG_FORMAT, ...args]);
    return parseGitLog(res.stdout.toString('utf8'));
  }

  async function gitRetryingLock(args: string[], opts?: GitRunOptions): Promise<GitResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await git(args, opts);
      } catch (e) {
        if (attempt < 6 && /index\.lock|Unable to create .*\.lock/.test(String((e as Error).message))) {
          await sleep(40 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  }

  async function assertCommit(rev: string): Promise<string> {
    assertRev(rev);
    const r = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allow: [0, 1] });
    if (r.code !== 0) throw new Error(`unknown git commit "${rev}"`);
    return r.stdout.toString('utf8').trim();
  }

  async function existsAt(commit: string, rel: string): Promise<boolean> {
    const r = await git(['cat-file', '-e', `${commit}:${rel}`], { allow: [0, 1, 128] });
    return r.code === 0;
  }

  async function lsFilesNow(rel: string): Promise<string[]> {
    const r = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', rel], { literal: true });
    return r.stdout.toString('utf8').split('\0').filter((s) => s.length > 0);
  }

  async function lsTree(commit: string, rel: string): Promise<string[]> {
    const r = await git(['ls-tree', '-r', '-z', '--name-only', commit, '--', rel], { literal: true });
    return r.stdout.toString('utf8').split('\0').filter((s) => s.length > 0);
  }

  async function removeFile(rel: string, stopAt?: string): Promise<void> {
    await assertNoSymlinkAncestors(root, rel);
    await fsp.rm(path.join(root, rel), { recursive: true, force: true });
    // prune directories that became empty (up to and including stopAt)
    let cur = path.posix.dirname(rel);
    while (cur !== '.' && cur !== '') {
      try {
        await fsp.rmdir(path.join(root, cur));
      } catch {
        break;
      }
      if (stopAt !== undefined && cur === stopAt) break;
      cur = path.posix.dirname(cur);
    }
  }

  const handle: WorkspaceGit = {
    dir: root,

    async commitAll(message, trailers) {
      return locked(async () => {
        await gitRetryingLock(['add', '-A']);
        const diff = await git(['diff', '--cached', '--quiet'], { allow: [0, 1] });
        if (diff.code === 0) return null;
        await gitRetryingLock(['commit', '-q', '--no-verify', '--cleanup=verbatim', '-F', '-'], {
          input: formatCommitMessage(message, trailers),
          env: identityEnv(clock),
        });
        const sha = (await git(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
        const [info] = await listLog(['--max-count=1', sha]);
        if (!info) throw new Error('commit created but could not be read back');
        const { authorEmail: _a, ...pub } = info;
        void _a;
        return pub;
      });
    },

    async head() {
      return (await git(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
    },

    async log(opts) {
      const limit = Math.max(1, Math.min(10_000, Math.floor(opts.limit)));
      const args = [`--max-count=${limit}`];
      if (opts.before) {
        await assertCommit(opts.before);
        const parents = (await git(['rev-list', '--parents', '-n', '1', opts.before])).stdout.toString('utf8').trim().split(/\s+/).slice(1);
        if (parents.length === 0) return [];
        args.push(...parents);
      } else args.push('HEAD');
      if (opts.paths && opts.paths.length > 0) args.push('--', ...opts.paths);
      const commits = await listLog(args);
      return commits.map(({ authorEmail: _a, ...pub }) => (void _a, pub));
    },

    async status() {
      const res = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const set = new Set<string>();
      for (const e of parsePorcelainZ(res.stdout)) {
        set.add(e.path);
        if (e.orig) set.add(e.orig);
      }
      return [...set].sort();
    },

    async restorePaths(paths, commit) {
      await locked(async () => {
        const sha = await assertCommit(commit);
        for (const raw of paths) {
          const rel = normalizeRelPath(raw);
          await assertNoSymlinkAncestors(root, rel);
          const atCommit = new Set(await lsTree(sha, rel));
          for (const f of await lsFilesNow(rel)) if (!atCommit.has(f)) await removeFile(f, rel);
          if (await existsAt(sha, rel)) await gitRetryingLock(['checkout', sha, '--', rel], { literal: true });
        }
      });
    },

    async revertOutside(globs) {
      return locked(async () => {
        const patterns = globs.map(normalizeGlob).filter((g) => g.length > 0);
        const matcher = patterns.length > 0 ? picomatch(patterns, { dot: true }) : () => false;
        const res = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        const reverted = new Set<string>();
        const seen = new Set<string>();
        for (const e of parsePorcelainZ(res.stdout)) {
          const targets = e.orig ? [{ p: e.path, untracked: false }, { p: e.orig, untracked: false }] : [{ p: e.path, untracked: e.xy === '??' }];
          for (const t of targets) {
            const rel = t.p.replace(/\/+$/, '');
            if (seen.has(rel)) continue;
            seen.add(rel);
            if (rel.split('/').includes('.git')) continue;
            if (matcher(rel)) continue;
            if (t.untracked) {
              await removeFile(rel);
            } else if (await existsAt('HEAD', rel)) {
              await gitRetryingLock(['checkout', 'HEAD', '--', rel], { literal: true });
            } else {
              await git(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', rel], { literal: true });
              await removeFile(rel);
            }
            reverted.add(rel);
          }
        }
        return [...reverted].sort();
      });
    },

    async foreignCommitsSince(sinceCommit) {
      const sha = await assertCommit(sinceCommit);
      const commits = await listLog([`${sha}..HEAD`]);
      return commits.filter((c) => c.authorEmail !== HARNESS_GIT_EMAIL).map(({ authorEmail: _a, ...pub }) => (void _a, pub));
    },

    async show(commit, p) {
      assertRev(commit);
      const rel = normalizeRelPath(p);
      const r = await git(['cat-file', 'blob', `${commit}:${rel}`], { allow: [0, 1, 128] });
      if (r.code !== 0) return undefined;
      return r.stdout.toString('utf8');
    },
  };
  return handle;
}
