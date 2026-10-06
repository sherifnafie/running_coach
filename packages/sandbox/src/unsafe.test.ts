import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, SandboxHandle, SandboxProvider } from '@opencoach/protocol';
import { createLocalSandboxProvider, createSandboxProvider, rewriteVirtualPaths } from './index';
import { makeDirs, type TestDirs } from './test-helpers';

const mounts = { workspace: '/data/a/workspace', raw: '/data/a/raw', history: '/data/a/history', system: '/data/system/0.1.0' };

describe('rewriteVirtualPaths', () => {
  it('rewrites virtual mount prefixes at the start of shell words', () => {
    expect(rewriteVirtualPaths('cat /raw/a.txt', mounts)).toBe('cat /data/a/raw/a.txt');
    expect(rewriteVirtualPaths('ls /workspace && cd /history/2026', mounts)).toBe('ls /data/a/workspace && cd /data/a/history/2026');
    expect(rewriteVirtualPaths('python3 /system/skills/x/run.py --out=/workspace/out.json', mounts)).toBe('python3 /data/system/0.1.0/skills/x/run.py --out=/data/a/workspace/out.json');
    expect(rewriteVirtualPaths(`cp "/raw/a b" '/workspace/x'`, mounts)).toBe(`cp "/data/a/raw/a b" '/data/a/workspace/x'`);
    expect(rewriteVirtualPaths('PATH=/usr/bin:/system/bin cmd', mounts)).toBe('PATH=/usr/bin:/data/system/0.1.0/bin cmd');
    expect(rewriteVirtualPaths('/workspace/run.sh; (/raw/x) | /history/y', mounts)).toBe('/data/a/workspace/run.sh; (/data/a/raw/x) | /data/a/history/y');
    expect(rewriteVirtualPaths('cat /raw /raw', mounts)).toBe('cat /data/a/raw /data/a/raw');
    expect(rewriteVirtualPaths('echo $(ls /workspace)', mounts)).toBe('echo $(ls /data/a/workspace)');
  });

  it('leaves look-alikes and mid-word occurrences alone', () => {
    for (const same of ['ls /workspaces/x', 'cat /rawdata', 'echo /tmp/workspace/x', 'cat foo/raw/x', 'echo workspace', 'cat /usr/share/workspace/a', 'echo ~/raw/x']) {
      expect(rewriteVirtualPaths(same, mounts), same).toBe(same);
    }
  });
});

describe('createLocalSandboxProvider without namespaces', () => {
  let dirs: TestDirs;
  const warn = vi.fn();
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => logger };

  beforeEach(() => {
    dirs = makeDirs();
    warn.mockClear();
  });
  afterEach(() => dirs.cleanup());

  it('throws a clear error when namespaces are unavailable and the unsafe fallback is not allowed', async () => {
    await expect(createLocalSandboxProvider({ allowUnsafe: false, unsharePath: '/nonexistent/unshare', logger })).rejects.toThrow(/unprivileged Linux namespaces.*probe failed.*unshare.*not found/s);
    await expect(createLocalSandboxProvider({ allowUnsafe: false, unsharePath: '/nonexistent/unshare', logger })).rejects.toThrow(/allowUnsafe/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('createSandboxProvider surfaces the same error for the local provider', async () => {
    // (uses the real host probe, so only assert the contract when this host cannot do namespaces)
    const { detectSandboxSupport } = await import('./index');
    if ((await detectSandboxSupport()).namespaces) return;
    await expect(createSandboxProvider({ provider: 'local', allowUnsafe: false } as never)).rejects.toThrow(/namespaces/);
  });

  describe('with allowUnsafe', () => {
    let provider: SandboxProvider;
    let handle: SandboxHandle;
    const run = (cmd: string, opts: Record<string, unknown> = {}) => provider.exec(handle, cmd, { timeoutS: 10, ...opts });

    beforeEach(async () => {
      provider = await createLocalSandboxProvider({ allowUnsafe: true, unsharePath: '/nonexistent/unshare', logger, env: { PROVIDER_VAR: 'pv' } });
      handle = await provider.ensure('ath_1', dirs.mounts);
    });
    afterEach(() => provider.dispose());

    it('is flagged non-isolated and warns loudly', () => {
      expect(provider.kind).toBe('local-unsafe');
      expect(provider.isolated).toBe(false);
      expect(handle.kind).toBe('local-unsafe');
      expect(warn).toHaveBeenCalledTimes(1);
      const [msg] = warn.mock.calls[0]!;
      expect(msg).toMatch(/NO isolation/);
      expect(msg).toMatch(/SANDBOX ISOLATION UNAVAILABLE/);
    });

    it('runs in the host workspace, rewrites virtual paths and exports mount variables', async () => {
      const r = await run('pwd; cat /raw/upload.txt; echo "$WORKSPACE|$RAW|$HISTORY|$SYSTEM"; echo hi > /workspace/out.txt; cat /system/constitution.md');
      expect(r.exitCode).toBe(0);
      const [pwd, rawLine, vars, sysLine] = r.stdout.trim().split('\n');
      expect(pwd).toBe(dirs.mounts.workspace);
      expect(rawLine).toBe('raw-bytes');
      expect(vars).toBe(`${dirs.mounts.workspace}|${dirs.mounts.raw}|${dirs.mounts.history}|${dirs.mounts.system}`);
      expect(sysLine).toBe('be kind');
      expect(readFileSync(join(dirs.mounts.workspace, 'out.txt'), 'utf8')).toBe('hi\n');
    });

    it('maps the virtual cwd and validates it', async () => {
      expect((await run('pwd', { cwd: '/raw' })).stdout.trim()).toBe(dirs.mounts.raw);
      expect((await run('mkdir -p sub && cd sub && pwd')).stdout.trim()).toBe(join(dirs.mounts.workspace, 'sub'));
      expect((await run('pwd', { cwd: '/workspace/sub' })).stdout.trim()).toBe(join(dirs.mounts.workspace, 'sub'));
      expect((await run('echo $HOME', { cwd: '/tmp' })).stdout.trim()).toMatch(/opencoach-unsafe-/);
      await expect(run('pwd', { cwd: '/etc' })).rejects.toMatchObject({ code: 'EOUTOFSCOPE' });
      await expect(run('pwd', { cwd: '/workspace/../../..' })).rejects.toMatchObject({ code: 'EOUTOFSCOPE' });
    });

    it('does not pass process.env secrets to commands', async () => {
      process.env.OPENCOACH_TEST_SECRET = 'unsafe-leak-check';
      try {
        const r = await run('env', { env: { EXTRA: 'e' }, tz: 'Europe/Amsterdam' });
        expect(r.stdout).not.toContain('unsafe-leak-check');
        expect(r.stdout).not.toContain('OPENCOACH_TEST_SECRET');
        expect(r.stdout).toContain('PROVIDER_VAR=pv');
        expect(r.stdout).toContain('EXTRA=e');
        expect(r.stdout).toContain('TZ=Europe/Amsterdam');
        expect(r.stdout).toContain('PYTHONDONTWRITEBYTECODE=1');
      } finally {
        delete process.env.OPENCOACH_TEST_SECRET;
      }
    });

    it('supports stdin, timeouts, truncation, aborts and concurrency', async () => {
      expect((await run('cat', { stdin: 'piped\n' })).stdout).toBe('piped\n');
      const t = await run('sleep 30', { timeoutS: 0.5 });
      expect(t).toMatchObject({ timedOut: true, exitCode: 124 });
      const big = await run('seq 1 100000', { maxOutputBytes: 2000 });
      expect(big.truncated).toBe(true);
      expect(big.stdout).toMatch(/truncated \d+ bytes/);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      expect((await run('sleep 30', { signal: ac.signal, timeoutS: 60 })).exitCode).toBe(130);
      const [a, b] = await Promise.all([run('sleep 0.5; echo a'), run('sleep 0.5; echo b')]);
      expect([a.stdout, b.stdout]).toEqual(['a\n', 'b\n']);
    });

    it('refuses unknown handles and rebuilds nothing after dispose', async () => {
      await expect(provider.exec({ athleteId: 'ath_1', id: 'nope', kind: 'local-unsafe' }, 'true', { timeoutS: 5 })).rejects.toThrow(/unknown or released/);
      await provider.release?.(handle);
      await expect(run('true')).rejects.toThrow(/unknown or released/);
      handle = await provider.ensure('ath_1', dirs.mounts);
      await provider.dispose();
      await expect(run('true')).rejects.toThrow(/disposed/);
      expect(existsSync(dirs.mounts.workspace)).toBe(true);
    });

    it('validates mounts', async () => {
      await expect(provider.ensure('ath_2', { ...dirs.mounts, raw: '/definitely/missing' })).rejects.toThrow(/does not exist/);
      await expect(provider.ensure('ath_2', { ...dirs.mounts, raw: 'relative' })).rejects.toThrow(/absolute/);
    });
  });
});
