import { execFileSync } from 'node:child_process';
import { promises as fsp, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToolError, type VirtualFS } from '@opencoach/protocol';
import { createMountedFS } from '../src';
import { tmpDir, write } from './helpers';

interface Env {
  root: string;
  workspace: string;
  raw: string;
  history: string;
  system: string;
  outside: string;
  fs: VirtualFS;
}

async function setup(opts: { writeScope?: string[] | null; maxReadBytes?: number } = {}): Promise<Env> {
  const root = await tmpDir('mfs-');
  const e = { root, workspace: path.join(root, 'ws'), raw: path.join(root, 'raw'), history: path.join(root, 'history'), system: path.join(root, 'system'), outside: path.join(root, 'outside') };
  await write(path.join(e.workspace, 'AGENTS.md'), '# Manual\nneedle in AGENTS\n');
  await write(path.join(e.workspace, 'plan/current.md'), 'line1\nline2 needle\nline3\nline4\nline5 NEEDLE\n');
  await write(path.join(e.workspace, 'plan/drafts/a.md'), 'draft needle\n');
  await write(path.join(e.workspace, 'athlete/profile.md'), 'profile\n');
  await write(path.join(e.workspace, '.hidden/x.txt'), 'hidden needle\n');
  await write(path.join(e.workspace, '.git/config'), 'needle in git\n');
  await write(path.join(e.workspace, 'node_modules/pkg/index.js'), 'needle in node_modules\n');
  await write(path.join(e.raw, `${'a'.repeat(64)}.png`), 'png-bytes');
  await write(path.join(e.raw, `${'a'.repeat(64)}.json`), '{"mime":"image/png","note":"needle"}');
  await write(path.join(e.history, '2026/10/07.md'), '# 2026-10-07\n06:58 · Athlete: needle\n');
  await write(path.join(e.system, 'constitution.md'), 'constitution needle\n');
  await write(path.join(e.outside, 'secret.txt'), 'top secret needle\n');
  const fs = createMountedFS({ workspace: e.workspace, raw: e.raw, history: e.history, system: e.system, ...opts });
  return { ...e, fs };
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof ToolError) return e.code;
    throw e;
  }
  return 'ok';
}

let env: Env;
beforeEach(async () => {
  env = await setup();
});

describe('resolve [SEC-1] [SEC-2] [SUB-3]', () => {
  it('protects git metadata through in-mount aliases [SEC-2]', async () => {
    await fsp.symlink(path.join(env.workspace, '.git'), path.join(env.workspace, 'git-alias'));
    await expect(env.fs.writeFile('git-alias/config', 'tampered')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(env.fs.writeFile('.git', 'gitdir: elsewhere')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fsp.readFile(path.join(env.workspace, '.git/config'), 'utf8')).toBe('needle in git\n');
  });

  it('maps virtual paths to host paths; relative paths go to /workspace', () => {
    const { fs, workspace, raw, history, system } = env;
    expect(fs.resolve('AGENTS.md', 'read')).toEqual({ virtual: '/workspace/AGENTS.md', host: path.join(workspace, 'AGENTS.md'), mount: '/workspace' });
    expect(fs.resolve('/workspace/plan/current.md', 'read').host).toBe(path.join(workspace, 'plan/current.md'));
    expect(fs.resolve('./plan//drafts/./a.md', 'read').virtual).toBe('/workspace/plan/drafts/a.md');
    expect(fs.resolve('/raw/x.png', 'read')).toMatchObject({ mount: '/raw', host: path.join(raw, 'x.png') });
    expect(fs.resolve('/history/2026/10/07.md', 'read')).toMatchObject({ mount: '/history', host: path.join(history, '2026/10/07.md') });
    expect(fs.resolve('/system/constitution.md', 'read')).toMatchObject({ mount: '/system', host: path.join(system, 'constitution.md') });
    expect(fs.resolve('/workspace', 'read').host).toBe(workspace);
    expect(fs.resolve('/workspace/', 'read').virtual).toBe('/workspace');
    expect(fs.resolve('plan/', 'read').virtual).toBe('/workspace/plan');
  });

  it('rejects empty paths, NUL bytes and unknown roots with a helpful message', () => {
    const { fs } = env;
    expect(() => fs.resolve('', 'read')).toThrow(ToolError);
    expect(() => fs.resolve('a\0b', 'read')).toThrow(/NUL/);
    for (const p of ['/etc/passwd', '/', '/tmp/x', '/workspaceevil/x', '/workspace2', '/Workspace/x', '/proc/self/environ']) {
      let err: ToolError | undefined;
      try {
        fs.resolve(p, 'read');
      } catch (e) {
        err = e as ToolError;
      }
      expect(err, p).toBeInstanceOf(ToolError);
      expect(err!.code, p).toBe('EACCES');
      expect(err!.message, p).toMatch(/\/workspace \(read-write\).*\/raw \(read-only\).*\/history \(read-only\).*\/system \(read-only\)/);
    }
  });

  it('rejects ".." escapes, including hops between mounts', () => {
    const { fs } = env;
    for (const p of ['../outside/secret.txt', '../../etc/passwd', 'plan/../../outside/secret.txt', '/workspace/../outside/secret.txt', '/workspace/../etc/passwd', '/workspace/plan/../../..', '..', '/workspace/..', '../raw/x', '/raw/../workspace/AGENTS.md', '/workspace/../raw/x.png', '/history/../system/constitution.md']) {
      expect(() => fs.resolve(p, 'read'), p).toThrowError(ToolError);
      expect(() => fs.resolve(p, 'write'), p).toThrowError(ToolError);
    }
    // ".." that stays inside the mount is fine
    expect(fs.resolve('plan/drafts/../current.md', 'read').virtual).toBe('/workspace/plan/current.md');
    expect(fs.resolve('/raw/a/../b.png', 'read').virtual).toBe('/raw/b.png');
  });

  it('is read-only for /raw, /history and /system', () => {
    const { fs } = env;
    for (const p of ['/raw/new.png', `/raw/${'a'.repeat(64)}.png`, '/history/2026/10/08.md', '/system/constitution.md', '/system/docs/x.md']) {
      let err: ToolError | undefined;
      try {
        fs.resolve(p, 'write');
      } catch (e) {
        err = e as ToolError;
      }
      expect(err?.code, p).toBe('EACCES');
      expect(err?.message, p).toMatch(/read-only/);
    }
    expect(() => fs.resolve('/raw/x', 'read')).not.toThrow();
  });

  it('refuses writes to the mount root and to .git', () => {
    const { fs } = env;
    expect(() => fs.resolve('/workspace', 'write')).toThrowError(expect.objectContaining({ code: 'EISDIR' }));
    expect(() => fs.resolve('.git/hooks/pre-commit', 'write')).toThrowError(expect.objectContaining({ code: 'EACCES' }));
    expect(() => fs.resolve('plan/.git/x', 'write')).toThrowError(expect.objectContaining({ code: 'EACCES' }));
    expect(() => fs.resolve('.git/config', 'read')).not.toThrow(); // reading is harmless
  });
});

describe('symlinks', () => {
  it('cannot read or write through a symlink that leaves the mount', async () => {
    const { fs, workspace, outside } = env;
    await fsp.symlink(outside, path.join(workspace, 'dir-link'));
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'file-link'));
    expect(await code(fs.readFile('dir-link/secret.txt'))).toBe('EACCES');
    expect(await code(fs.readFile('file-link'))).toBe('EACCES');
    expect(await code(fs.readText('/workspace/dir-link/secret.txt'))).toBe('EACCES');
    expect(await code(fs.stat('dir-link/secret.txt'))).toBe('EACCES');
    expect(await code(fs.writeFile('dir-link/new.txt', 'pwned'))).toBe('EACCES');
    expect(await code(fs.writeFile('dir-link/sub/new.txt', 'pwned'))).toBe('EACCES');
    expect(await code(fs.writeFile('file-link', 'pwned'))).toBe('EACCES');
    await expect(fsp.stat(path.join(outside, 'new.txt'))).rejects.toThrow();
    await expect(fsp.stat(path.join(outside, 'sub'))).rejects.toThrow();
    expect(await fsp.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret needle\n');
  });

  it('cannot escape through a chain of links or a link to the parent', async () => {
    const { fs, workspace, root } = env;
    await fsp.symlink(path.join(workspace, 'hop2'), path.join(workspace, 'hop1'));
    await fsp.symlink(root, path.join(workspace, 'hop2'));
    expect(await code(fs.readFile('hop1/outside/secret.txt'))).toBe('EACCES');
    await fsp.symlink('..', path.join(workspace, 'up'));
    expect(await code(fs.readFile('up/outside/secret.txt'))).toBe('EACCES');
    await fsp.symlink('/etc/passwd', path.join(workspace, 'passwd'));
    expect(await code(fs.readFile('passwd'))).toBe('EACCES');
  });

  it('dangling links pointing outside cannot be used to create files outside', async () => {
    const { fs, workspace, outside } = env;
    const target = path.join(outside, 'will-not-exist.txt');
    await fsp.symlink(target, path.join(workspace, 'dangling'));
    expect(await code(fs.readFile('dangling'))).toBe('ENOENT');
    await fs.writeFile('dangling', 'written'); // replaces the link itself (atomic rename), does not follow it
    await expect(fsp.stat(target)).rejects.toThrow();
    expect(await fs.readText('dangling')).toBe('written');
    const lst = await fsp.lstat(path.join(workspace, 'dangling'));
    expect(lst.isSymbolicLink()).toBe(false);
    await fsp.symlink(path.join(outside, 'newdir/deep'), path.join(workspace, 'dangling-dir'));
    expect(await code(fs.writeFile('dangling-dir/x.txt', 'x'))).not.toBe('ok');
    await expect(fsp.stat(path.join(outside, 'newdir'))).rejects.toThrow();
  });

  it('allows links that stay inside their mount', async () => {
    const { fs, workspace } = env;
    await fsp.symlink(path.join(workspace, 'plan'), path.join(workspace, 'plan-link'));
    expect(await fs.readText('plan-link/current.md')).toContain('line1');
    await fs.writeFile('plan-link/new.md', 'via link');
    expect(await fsp.readFile(path.join(workspace, 'plan/new.md'), 'utf8')).toBe('via link');
  });

  it('a link in one mount pointing into another mount is refused', async () => {
    const { fs, raw, workspace } = env;
    await fsp.symlink(path.join(workspace, 'AGENTS.md'), path.join(raw, 'sneaky.txt'));
    expect(await code(fs.readFile('/raw/sneaky.txt'))).toBe('EACCES');
    await fsp.symlink(raw, path.join(workspace, 'rawlink'));
    expect(await code(fs.readFile('rawlink/aaaa.png'))).toBe('EACCES');
    expect(await code(fs.writeFile('rawlink/x.png', 'x'))).toBe('EACCES');
  });

  it('readFile refuses a FIFO instead of hanging', async () => {
    const { fs, workspace } = env;
    execFileSync('mkfifo', [path.join(workspace, 'pipe')]);
    expect(await code(fs.readFile('pipe'))).toBe('EACCES');
  });
});

describe('readFile / readText / stat', () => {
  it('reads bytes and text', async () => {
    const { fs, workspace } = env;
    const bytes = await fs.readFile('AGENTS.md');
    expect(bytes.constructor).toBe(Uint8Array);
    expect(Buffer.from(bytes).toString('utf8')).toBe('# Manual\nneedle in AGENTS\n');
    expect(await fs.readText('/raw/' + 'a'.repeat(64) + '.png')).toBe('png-bytes');
    await fsp.writeFile(path.join(workspace, 'bin.dat'), new Uint8Array([0, 255, 128, 1]));
    expect([...(await fs.readFile('bin.dat'))]).toEqual([0, 255, 128, 1]);
    await expect(fs.readText('')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 10_000);

  it('maps filesystem errors to tool error codes', async () => {
    const { fs } = env;
    expect(await code(fs.readFile('nope.md'))).toBe('ENOENT');
    expect(await code(fs.readFile('plan'))).toBe('EISDIR');
    expect(await code(fs.readFile('AGENTS.md/child'))).toBe('ENOENT');
    expect(await code(fs.readFile('/etc/passwd'))).toBe('EACCES');
    expect(await code(fs.readFile('/raw/missing.png'))).toBe('ENOENT');
  });

  it('enforces the read size cap (default 2 MiB, configurable)', async () => {
    const { fs, workspace } = env;
    await fsp.writeFile(path.join(workspace, 'exact.bin'), Buffer.alloc(2 * 1024 * 1024));
    await fsp.writeFile(path.join(workspace, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await fs.readFile('exact.bin')).byteLength).toBe(2 * 1024 * 1024);
    let err: ToolError | undefined;
    try {
      await fs.readFile('big.bin');
    } catch (e) {
      err = e as ToolError;
    }
    expect(err?.code).toBe('ETOOBIG');
    expect(err?.message).toMatch(/2\.0 MiB.*offset\/limit|read limit/);
    const small = await setup({ maxReadBytes: 10 });
    expect(await code(small.fs.readFile('AGENTS.md'))).toBe('ETOOBIG');
    await write(path.join(small.workspace, 'tiny.txt'), '1234567890');
    expect(await small.fs.readText('tiny.txt')).toBe('1234567890');
  });

  it('stat reports files, directories and missing paths', async () => {
    const { fs } = env;
    expect(await fs.stat('AGENTS.md')).toMatchObject({ size: 26, isDir: false });
    expect((await fs.stat('AGENTS.md'))!.mtimeMs).toBeGreaterThan(0);
    expect(await fs.stat('plan')).toMatchObject({ isDir: true });
    expect(await fs.stat('/workspace')).toMatchObject({ isDir: true });
    expect(await fs.stat('nope')).toBeNull();
    expect(await fs.stat('AGENTS.md/child')).toBeNull();
    expect(await code(fs.stat('../x'))).toBe('EACCES');
  });
});

describe('writeFile', () => {
  it('creates parent directories and writes strings and bytes atomically', async () => {
    const { fs, workspace } = env;
    await fs.writeFile('journal/2026/10/07.md', 'hello é');
    expect(await fsp.readFile(path.join(workspace, 'journal/2026/10/07.md'), 'utf8')).toBe('hello é');
    await fs.writeFile('/workspace/blob.bin', new Uint8Array([1, 2, 3]));
    expect([...(await fsp.readFile(path.join(workspace, 'blob.bin')))]).toEqual([1, 2, 3]);
    await fs.writeFile('journal/2026/10/07.md', 'replaced');
    expect(await fs.readText('journal/2026/10/07.md')).toBe('replaced');
    const leftovers = (await fsp.readdir(path.join(workspace, 'journal/2026/10'))).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    await fs.writeFile('empty.txt', '');
    expect((await fs.stat('empty.txt'))!.size).toBe(0);
  });

  it('preserves the mode of an existing file', async () => {
    const { fs, workspace } = env;
    await fsp.writeFile(path.join(workspace, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await fsp.chmod(path.join(workspace, 'run.sh'), 0o755);
    await fs.writeFile('run.sh', '#!/bin/sh\necho hi\n');
    expect((await fsp.stat(path.join(workspace, 'run.sh'))).mode & 0o777).toBe(0o755);
  });

  it('rejects read-only mounts, directories, .git and parents that are files', async () => {
    const { fs, raw, history, system } = env;
    expect(await code(fs.writeFile('/raw/new.png', 'x'))).toBe('EACCES');
    expect(await code(fs.writeFile(`/raw/${'a'.repeat(64)}.png`, 'tampered'))).toBe('EACCES');
    expect(await code(fs.writeFile('/history/2026/10/07.md', 'tampered'))).toBe('EACCES');
    expect(await code(fs.writeFile('/system/constitution.md', 'tampered'))).toBe('EACCES');
    await expect(fsp.stat(path.join(raw, 'new.png'))).rejects.toThrow();
    expect(await fsp.readFile(path.join(history, '2026/10/07.md'), 'utf8')).toContain('needle');
    expect(await fsp.readFile(path.join(system, 'constitution.md'), 'utf8')).toBe('constitution needle\n');
    expect(await code(fs.writeFile('plan', 'x'))).toBe('EISDIR');
    expect(await code(fs.writeFile('.git/hooks/pre-commit', '#!/bin/sh\nrm -rf /'))).toBe('EACCES');
    expect(await code(fs.writeFile('AGENTS.md/child.md', 'x'))).toBe('ENOENT');
    expect(await code(fs.writeFile('../escape.txt', 'x'))).toBe('EACCES');
    expect(await code(fs.writeFile('/workspace/../escape.txt', 'x'))).toBe('EACCES');
    await expect(fsp.stat(path.join(env.root, 'escape.txt'))).rejects.toThrow();
  });
});

describe('write scope', () => {
  it('restricts writes to the globs (relative to /workspace), not reads', async () => {
    const scoped = (await setup()).fs.withWriteScope(['plan/drafts/**', '/workspace/journal/*.md', 'notes/', '.dot/**']);
    expect(scoped.writeScope).toEqual(['plan/drafts/**', '/workspace/journal/*.md', 'notes/', '.dot/**']);
    await scoped.writeFile('plan/drafts/new/deep.md', 'ok');
    await scoped.writeFile('journal/today.md', 'ok');
    await scoped.writeFile('notes/a/b.md', 'ok');
    await scoped.writeFile('.dot/hidden.md', 'ok');
    for (const p of ['AGENTS.md', 'plan/current.md', 'athlete/profile.md', 'journal/sub/deep.md', 'journal/today.txt', 'notes', 'plan/drafts', '/workspace/ui/app.json']) {
      expect(await code(scoped.writeFile(p, 'nope')), p).toBe('EOUTOFSCOPE');
      expect(await code(() => scoped.resolve(p, 'write')), p).toBe('EOUTOFSCOPE');
    }
    expect(await scoped.readText('AGENTS.md')).toContain('Manual'); // reads are unaffected
    expect(await code(scoped.readFile('/raw/' + 'a'.repeat(64) + '.png'))).toBe('ok');
    expect(await code(scoped.writeFile('/raw/x', 'x'))).toBe('EACCES'); // read-only mounts stay read-only
  });

  it('the message tells the model what it may modify', async () => {
    const scoped = (await setup()).fs.withWriteScope(['plan/drafts/**']);
    await expect(scoped.writeFile('AGENTS.md', 'x')).rejects.toThrow(/outside your write scope.*plan\/drafts\/\*\*/);
  });

  it('[] means read-only and null means unrestricted; the original instance is unchanged', async () => {
    const e = await setup();
    const ro = e.fs.withWriteScope([]);
    expect(await code(ro.writeFile('x.md', 'x'))).toBe('EOUTOFSCOPE');
    expect(ro.writeScope).toEqual([]);
    expect(e.fs.writeScope).toBeNull();
    expect(await code(e.fs.writeFile('x.md', 'x'))).toBe('ok');
    const open = ro.withWriteScope(null);
    expect(open.writeScope).toBeNull();
    expect(await code(open.writeFile('y.md', 'y'))).toBe('ok');
    const initiallyScoped = await setup({ writeScope: ['a/**'] });
    expect(initiallyScoped.fs.writeScope).toEqual(['a/**']);
    expect(await code(initiallyScoped.fs.writeFile('b.md', 'x'))).toBe('EOUTOFSCOPE');
  });

  it('cannot be bypassed through symlinks inside the scope', async () => {
    const e = await setup();
    await fsp.mkdir(path.join(e.workspace, 'plan/drafts'), { recursive: true });
    await fsp.symlink(path.join(e.workspace, 'athlete'), path.join(e.workspace, 'plan/drafts/athlete-link'));
    await fsp.symlink(path.join(e.workspace, 'athlete/profile.md'), path.join(e.workspace, 'plan/drafts/profile-link.md'));
    const scoped = e.fs.withWriteScope(['plan/drafts/**']);
    expect(await code(scoped.writeFile('plan/drafts/athlete-link/profile.md', 'pwned'))).toBe('EOUTOFSCOPE');
    expect(await code(scoped.writeFile('plan/drafts/athlete-link/new.md', 'pwned'))).toBe('EOUTOFSCOPE');
    expect(await fsp.readFile(path.join(e.workspace, 'athlete/profile.md'), 'utf8')).toBe('profile\n');
    // a link at an in-scope path is replaced (not followed) by an atomic write
    await scoped.writeFile('plan/drafts/profile-link.md', 'replaced link');
    expect(await fsp.readFile(path.join(e.workspace, 'athlete/profile.md'), 'utf8')).toBe('profile\n');
  });
});

describe('glob', () => {
  it('lists virtual paths, sorted, files only, dotfiles included, .git excluded', async () => {
    const { fs } = env;
    expect(await fs.glob('**/*.md')).toEqual(['/workspace/.hidden/x.txt'].slice(0, 0).concat(['/workspace/AGENTS.md', '/workspace/athlete/profile.md', '/workspace/plan/current.md', '/workspace/plan/drafts/a.md']));
    const all = await fs.glob('**/*');
    expect(all).toContain('/workspace/.hidden/x.txt');
    expect(all.some((p) => p.includes('/.git/') || p.endsWith('/.git'))).toBe(false);
    expect(all).toEqual([...all].sort());
    expect(all.every((p) => p.startsWith('/workspace/'))).toBe(true);
    expect(await fs.glob('*')).toEqual(['/workspace/AGENTS.md']);
    expect(await fs.glob('plan/*.md')).toEqual(['/workspace/plan/current.md']);
    expect(await fs.glob('./plan/**/*.md')).toEqual(['/workspace/plan/current.md', '/workspace/plan/drafts/a.md']);
    expect(await fs.glob('{AGENTS,plan/current}.md')).toEqual(['/workspace/AGENTS.md', '/workspace/plan/current.md']);
    expect(await fs.glob('nothing/**')).toEqual([]);
  });

  it('supports a base directory and absolute patterns on any mount', async () => {
    const { fs } = env;
    expect(await fs.glob('*.md', 'plan')).toEqual(['/workspace/plan/current.md']);
    expect(await fs.glob('**/*.md', '/workspace/plan')).toEqual(['/workspace/plan/current.md', '/workspace/plan/drafts/a.md']);
    expect(await fs.glob('/workspace/plan/*.md')).toEqual(['/workspace/plan/current.md']);
    expect(await fs.glob('/raw/*.json')).toEqual([`/raw/${'a'.repeat(64)}.json`]);
    expect(await fs.glob('**/*.md', '/history')).toEqual(['/history/2026/10/07.md']);
    expect(await fs.glob('*.md', '/system')).toEqual(['/system/constitution.md']);
    expect(await fs.glob('/system/constitution.md')).toEqual(['/system/constitution.md']);
  });

  it('cannot escape: no .. segments, no unknown roots, symlinked dirs are not traversed', async () => {
    const { fs, workspace, outside } = env;
    expect(await code(fs.glob('../outside/*'))).toBe('INVALID_INPUT');
    expect(await code(fs.glob('plan/../../outside/*'))).toBe('INVALID_INPUT');
    expect(await code(fs.glob('*', '..'))).toBe('EACCES');
    expect(await code(fs.glob('*', '/'))).toBe('EACCES');
    expect(await code(fs.glob('/etc/*'))).toBe('EACCES');
    expect(await code(fs.glob('/*/passwd'))).toBe('EACCES');
    await fsp.symlink(outside, path.join(workspace, 'dir-link'));
    expect((await fs.glob('**/*')).filter((p) => p.includes('secret'))).toEqual([]);
    expect(await code(fs.glob('*', 'dir-link'))).toBe('EACCES');
  });

  it('errors for missing bases and file bases', async () => {
    const { fs } = env;
    expect(await code(fs.glob('*', 'missing'))).toBe('ENOENT');
    expect(await code(fs.glob('*', 'AGENTS.md'))).toBe('INVALID_INPUT');
    expect(await code(fs.glob(''))).toBe('INVALID_INPUT');
  });
});

describe('grep', () => {
  it('finds matches with 1-based line numbers across the workspace, skipping .git and node_modules', async () => {
    const { fs } = env;
    const m = await fs.grep({ pattern: 'needle' });
    const paths = m.map((x) => x.path);
    expect(paths).toEqual(['/workspace/.hidden/x.txt', '/workspace/AGENTS.md', '/workspace/athlete/profile.md'].filter((p) => p !== '/workspace/athlete/profile.md').concat(['/workspace/plan/current.md', '/workspace/plan/drafts/a.md']));
    expect(m.find((x) => x.path === '/workspace/plan/current.md')).toEqual({ path: '/workspace/plan/current.md', line: 2, text: 'line2 needle' });
    expect(paths.some((p) => p.includes('.git/') || p.includes('node_modules'))).toBe(false);
  });

  it('supports case-insensitive search, context lines and a max', async () => {
    const { fs } = env;
    const sensitive = await fs.grep({ pattern: 'needle', path: 'plan/current.md' });
    expect(sensitive.map((x) => x.line)).toEqual([2]);
    const insensitive = await fs.grep({ pattern: 'needle', path: 'plan/current.md', caseInsensitive: true, context: 1 });
    expect(insensitive).toEqual([
      { path: '/workspace/plan/current.md', line: 2, text: 'line2 needle', context: { before: ['line1'], after: ['line3'] } },
      { path: '/workspace/plan/current.md', line: 5, text: 'line5 NEEDLE', context: { before: ['line4'], after: [''] } },
    ]);
    expect((await fs.grep({ pattern: 'needle', caseInsensitive: true, max: 2 })).length).toBe(2);
    const first = await fs.grep({ pattern: 'line', path: 'plan', context: 0 });
    expect(first[0]!.context).toBeUndefined();
  });

  it('uses JS regular expressions and reports invalid ones', async () => {
    const { fs } = env;
    expect((await fs.grep({ pattern: '^line\\d needle$', path: 'plan' })).map((x) => x.line)).toEqual([2]);
    expect((await fs.grep({ pattern: 'line[1-2]', path: 'plan/current.md' })).map((x) => x.line)).toEqual([1, 2]);
    expect(await code(fs.grep({ pattern: '(unclosed' }))).toBe('INVALID_INPUT');
    expect(await code(fs.grep({ pattern: 'x', path: 'missing' }))).toBe('ENOENT');
  });

  it('filters by glob (basename globs match at any depth) and path', async () => {
    const { fs } = env;
    expect((await fs.grep({ pattern: 'needle', glob: '*.md' })).map((x) => x.path)).toEqual(['/workspace/AGENTS.md', '/workspace/plan/current.md', '/workspace/plan/drafts/a.md']);
    expect((await fs.grep({ pattern: 'needle', glob: 'plan/**' })).map((x) => x.path)).toEqual(['/workspace/plan/current.md', '/workspace/plan/drafts/a.md']);
    expect((await fs.grep({ pattern: 'needle', path: 'plan', glob: 'drafts/*.md' })).map((x) => x.path)).toEqual(['/workspace/plan/drafts/a.md']);
    expect((await fs.grep({ pattern: 'needle', path: '/history' })).map((x) => x.path)).toEqual(['/history/2026/10/07.md']);
    expect((await fs.grep({ pattern: 'needle', path: '/system' })).map((x) => x.path)).toEqual(['/system/constitution.md']);
    expect((await fs.grep({ pattern: 'needle', path: '/raw', glob: '*.json' })).map((x) => x.path)).toEqual([`/raw/${'a'.repeat(64)}.json`]);
  });

  it('skips binary files, files over 2 MiB and symlinks', async () => {
    const { fs, workspace, outside } = env;
    await fsp.writeFile(path.join(workspace, 'binary.dat'), Buffer.concat([Buffer.from('needle'), Buffer.from([0]), Buffer.from('needle')]));
    await fsp.writeFile(path.join(workspace, 'huge.txt'), 'needle\n' + 'x'.repeat(2 * 1024 * 1024 + 1));
    await fsp.symlink(outside, path.join(workspace, 'dir-link'));
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'file-link.txt'));
    const paths = (await fs.grep({ pattern: 'needle', max: 500 })).map((x) => x.path);
    expect(paths).not.toContain('/workspace/binary.dat');
    expect(paths).not.toContain('/workspace/huge.txt');
    expect(paths.some((p) => p.includes('dir-link') || p.includes('file-link'))).toBe(false);
    expect(await fs.grep({ pattern: 'secret', max: 500 })).toEqual([]);
    expect(await code(fs.grep({ pattern: 'secret', path: 'dir-link' }))).toBe('EACCES');
    expect(await code(fs.grep({ pattern: 'secret', path: 'file-link.txt' }))).toBe('EACCES');
  });

  it('defaults to 100 matches', async () => {
    const { fs, workspace } = env;
    await fsp.writeFile(path.join(workspace, 'many.txt'), Array.from({ length: 300 }, (_, i) => `row ${i}`).join('\n'));
    expect((await fs.grep({ pattern: '^row', path: 'many.txt' })).length).toBe(100);
    expect((await fs.grep({ pattern: '^row', path: 'many.txt', max: 250 })).length).toBe(250);
  });

  it('handles CRLF files', async () => {
    const { fs, workspace } = env;
    await fsp.writeFile(path.join(workspace, 'crlf.txt'), 'a\r\nneedle\r\nb\r\n');
    expect(await fs.grep({ pattern: '^needle$', path: 'crlf.txt' })).toEqual([{ path: '/workspace/crlf.txt', line: 2, text: 'needle' }]);
  });
});

describe('toVirtual', () => {
  it('maps host paths back into the virtual namespace', () => {
    const { fs, workspace, raw, history, system, outside, root } = env;
    expect(fs.toVirtual(path.join(workspace, 'plan/current.md'))).toBe('/workspace/plan/current.md');
    expect(fs.toVirtual(workspace)).toBe('/workspace');
    expect(fs.toVirtual(path.join(raw, 'x.png'))).toBe('/raw/x.png');
    expect(fs.toVirtual(path.join(history, '2026'))).toBe('/history/2026');
    expect(fs.toVirtual(path.join(system, 'docs/a.md'))).toBe('/system/docs/a.md');
    expect(fs.toVirtual(path.join(outside, 'secret.txt'))).toBeNull();
    expect(fs.toVirtual(root)).toBeNull();
    expect(fs.toVirtual(workspace + '-evil/x')).toBeNull();
    expect(fs.toVirtual(path.join(workspace, '../outside'))).toBeNull();
    expect(fs.toVirtual('relative/path')).toBeNull();
  });

  it('also recognises real paths when a mount was configured through a symlink', async () => {
    const e = await setup();
    const link = path.join(e.root, 'ws-link');
    await fsp.symlink(e.workspace, link);
    const fs = createMountedFS({ workspace: link, raw: e.raw, history: e.history, system: e.system });
    expect(fs.toVirtual(path.join(link, 'AGENTS.md'))).toBe('/workspace/AGENTS.md');
    expect(fs.toVirtual(path.join(realpathSync(e.workspace), 'AGENTS.md'))).toBe('/workspace/AGENTS.md');
    expect(await fs.readText('AGENTS.md')).toContain('Manual');
    await fs.writeFile('via-link.md', 'x');
    expect(await fsp.readFile(path.join(e.workspace, 'via-link.md'), 'utf8')).toBe('x');
  });
});
