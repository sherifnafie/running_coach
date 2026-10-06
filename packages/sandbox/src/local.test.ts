import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError, type ExecOptions, type ExecResult, type SandboxHandle, type SandboxProvider } from '@opencoach/protocol';
import { createLocalSandboxProvider, detectSandboxSupport } from './index';
import { findFaketimeLibrary, resolveHostDirs } from './local';
import { makeDirs, type TestDirs } from './test-helpers';

const support = await detectSandboxSupport();
const nsDescribe = describe.skipIf(!support.namespaces);

describe('detectSandboxSupport', () => {
  it('reports what this host can do, with details', () => {
    expect(typeof support.namespaces).toBe('boolean');
    expect(typeof support.docker).toBe('boolean');
    expect(support.details.some((d) => d.startsWith('unshare:') || d.includes('namespaces'))).toBe(true);
    expect(support.details.some((d) => d.startsWith('docker:'))).toBe(true);
    expect(support.details.some((d) => d.startsWith('libfaketime:'))).toBe(true);
  });

  it('reports a missing Docker socket without throwing', async () => {
    const s = await detectSandboxSupport({ dockerSocket: '/nonexistent/docker.sock' });
    expect(s.docker).toBe(false);
    expect(s.details.some((d) => d.includes('/nonexistent/docker.sock'))).toBe(true);
  });
});

nsDescribe('local isolated provider (real namespaces)', () => {
  let dirs: TestDirs;
  let provider: SandboxProvider;
  let handle: SandboxHandle;

  const run = (command: string, opts: Partial<ExecOptions> = {}): Promise<ExecResult> => provider.exec(handle, command, { timeoutS: 20, ...opts });

  beforeAll(async () => {
    dirs = makeDirs();
    provider = await createLocalSandboxProvider({ allowUnsafe: false, env: { PROVIDER_VAR: 'from-provider' } });
    handle = await provider.ensure('ath_1', dirs.mounts);
  });
  afterAll(async () => {
    await provider.dispose();
    dirs.cleanup();
  });

  it('is an isolated local provider', () => {
    expect(provider.kind).toBe('local-isolated');
    expect(provider.isolated).toBe(true);
    expect(handle).toMatchObject({ athleteId: 'ath_1', kind: 'local-isolated' });
    expect(typeof handle.id).toBe('string');
  });

  it('runs commands in /workspace by default, as the namespace user', async () => {
    const r = await run('pwd; id -u; cat AGENTS.md');
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, truncated: false, stderr: '' });
    expect(r.stdout).toBe('/workspace\n0\n# agents\n');
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('writes in /workspace are visible on the host', async () => {
    const r = await run('mkdir -p notes && echo "from the sandbox" > notes/a.txt && printf "%s" "$(pwd)"');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dirs.mounts.workspace, 'notes', 'a.txt'), 'utf8')).toBe('from the sandbox\n');
    // and host-side changes are visible inside
    writeFileSync(join(dirs.mounts.workspace, 'host.txt'), 'from the host\n');
    expect((await run('cat /workspace/host.txt')).stdout).toBe('from the host\n');
  });

  it('/raw, /history and /system are readable but read-only and cannot be remounted', async () => {
    expect((await run('cat /raw/upload.txt /history/day.md /system/constitution.md')).stdout).toBe('raw-bytes\n# history\nbe kind\n');
    for (const d of ['/raw', '/history', '/system']) {
      const w = await run(`echo nope > ${d}/new.txt`);
      expect(w.exitCode).not.toBe(0);
      expect(w.stderr).toMatch(/Read-only file system/);
      const rm = await run(`rm -f ${d}/*`);
      expect(rm.exitCode).not.toBe(0);
      const remount = await run(`mount -o remount,rw ${d}`);
      expect(remount.exitCode).not.toBe(0);
      expect(existsSync(join(dirs.mounts[d.slice(1) as 'raw'], 'new.txt'))).toBe(false);
    }
    expect(readFileSync(join(dirs.mounts.raw, 'upload.txt'), 'utf8')).toBe('raw-bytes\n');
    // rebinding the workspace read-write elsewhere or unsharing again is impossible without capabilities
    expect((await run('mount --bind /workspace /raw')).exitCode).not.toBe(0);
    expect((await run('unshare --user --map-root-user --mount sh -c "mount -o remount,rw /raw && touch /raw/x"')).exitCode).not.toBe(0);
    expect(existsSync(join(dirs.mounts.raw, 'x'))).toBe(false);
  });

  it('drops every capability and sets no_new_privs', async () => {
    const r = await run('grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):" /proc/self/status');
    expect(r.stdout).toContain('CapEff:\t0000000000000000');
    expect(r.stdout).toContain('CapBnd:\t0000000000000000');
    expect(r.stdout).toContain('CapPrm:\t0000000000000000');
    if (/NoNewPrivs/.test(r.stdout)) expect(r.stdout).toContain('NoNewPrivs:\t1');
    const chroot = await run(`python3 -c "import os; os.chroot('/tmp')"`);
    expect(chroot.exitCode).not.toBe(0);
    expect(chroot.stderr).toMatch(/Operation not permitted|PermissionError/);
  });

  it('has no network', async () => {
    const r = await run(`python3 -c "
import socket
s = socket.socket()
s.settimeout(3)
try:
    s.connect(('1.1.1.1', 53))
    print('CONNECTED')
except OSError as e:
    print('blocked', e.errno)
"`);
    expect(r.stdout).toMatch(/^blocked \d+/);
    expect(r.stdout).not.toContain('CONNECTED');
    const ifaces = await run(`tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '`);
    expect(ifaces.stdout.trim()).toBe('lo');
    const udp = await run(`python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(('8.8.8.8', 53)); print('ROUTE')
except OSError as e:
    print('noroute', e.errno)
"`);
    expect(udp.stdout).toMatch(/^noroute/);
  });

  it('cannot see the host filesystem, its secrets or other processes', async () => {
    const secretPath = join(dirs.root, 'host-secret.txt');
    writeFileSync(secretPath, 'TOP-SECRET-HOST-FILE');
    // an absolute symlink inside the workspace resolves inside the sandbox root, not on the host
    symlinkSync(secretPath, join(dirs.mounts.workspace, 'escape-link'));
    symlinkSync('../../../..', join(dirs.mounts.workspace, 'dotdot-link'));
    expect((await run(`cat ${secretPath}`)).exitCode).not.toBe(0);
    const viaLink = await run('cat /workspace/escape-link');
    expect(viaLink.exitCode).not.toBe(0);
    expect(viaLink.stdout).not.toContain('TOP-SECRET');
    const dotdot = await run('ls /workspace/dotdot-link/');
    expect(dotdot.stdout).not.toContain('home');
    expect((await run('cat /workspace/../../../../' + secretPath.slice(1))).stdout).not.toContain('TOP-SECRET');

    const top = (await run('ls -A /')).stdout.trim().split('\n');
    for (const forbidden of ['home', 'root', 'var', 'run', 'mnt', 'srv', 'sys', 'boot', '.oldroot', 'data']) expect(top).not.toContain(forbidden);
    expect(top).toEqual(expect.arrayContaining(['workspace', 'raw', 'history', 'system', 'tmp', 'usr', 'proc', 'dev']));
    expect((await run('ls /.oldroot')).exitCode).not.toBe(0);

    // pid namespace: the server (and every other host process) is invisible and unsignalable
    const pids = (await run(`ls /proc | grep -E '^[0-9]+$' | wc -l`)).stdout.trim();
    expect(Number(pids)).toBeLessThan(8);
    const kill = await run(`kill -0 ${process.pid}`);
    expect(kill.exitCode).not.toBe(0);
    expect(kill.stderr).toMatch(/No such process/);
    expect((await run('echo $$')).stdout.trim()).toBe('1');
    // mounts of the host (including host paths of the athlete dirs) are not in the sandbox's view of /dev
    const dev = (await run('ls /dev')).stdout.trim().split('\n');
    expect(dev).not.toEqual(expect.arrayContaining(['vda']));
    expect(dev).toEqual(expect.arrayContaining(['null', 'zero', 'urandom']));
    expect((await run('echo discard > /dev/null && head -c4 /dev/zero | wc -c')).stdout.trim()).toBe('4');
  });

  it('only the declared mounts and /tmp are writable; host OS dirs are read-only', async () => {
    for (const p of ['/', '/usr', '/etc', '/opt', '/bin', '/sbin', '/lib', '/dev', '/proc/sys']) {
      const r = await run(`touch ${p}/oc-probe`);
      expect(r.exitCode, `touch ${p}`).not.toBe(0);
    }
    expect((await run('echo ok > /tmp/t.txt && cat /tmp/t.txt')).stdout).toBe('ok\n');
    expect((await run('cat /etc/os-release | head -1')).exitCode).toBe(0);
  });

  it('/tmp is private to each command and never touches the host', async () => {
    await run('echo first > /tmp/state.txt');
    const second = await run('ls /tmp');
    expect(second.stdout).toBe('');
    expect(existsSync('/tmp/state.txt')).toBe(false);
  });

  it('masks well-known host secrets under /etc', async () => {
    const r = await run('cat /etc/shadow 2>&1 | wc -c; ls /etc/ssl/private 2>/dev/null | wc -l');
    const [shadowBytes, privateEntries] = r.stdout.trim().split('\n').map(Number);
    expect(shadowBytes === 0 || shadowBytes! < 80).toBe(true); // empty (masked) or "Permission denied"
    expect(privateEntries).toBe(0);
  });

  it('kills the whole process tree on timeout', async () => {
    const t0 = performance.now();
    const r = await run('sleep 31.001 & sleep 31.002 & sleep 31.003', { timeoutS: 1 });
    const elapsed = performance.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(6000);
    expect(r.durationMs).toBeGreaterThanOrEqual(900);
    await new Promise((res) => setTimeout(res, 300));
    const left = spawnSync('pgrep', ['-f', 'sleep 31.00']);
    if (!left.error) expect(left.status, `leftover: ${left.stdout}`).toBe(1); // 1 = nothing matched
    // the provider is still healthy afterwards
    expect((await run('echo alive')).stdout).toBe('alive\n');
  });

  it('background processes do not outlive their command', async () => {
    const r = await run('(sleep 32.001 &) ; echo started');
    expect(r.stdout).toBe('started\n');
    expect(r.timedOut).toBe(false);
    await new Promise((res) => setTimeout(res, 300));
    const left = spawnSync('pgrep', ['-f', 'sleep 32.001']);
    if (!left.error) expect(left.status).toBe(1);
  });

  it('reports exit codes and stderr', async () => {
    const r = await run('echo out; echo err >&2; exit 7');
    expect(r).toMatchObject({ stdout: 'out\n', stderr: 'err\n', exitCode: 7, timedOut: false, truncated: false });
    expect((await run('nonexistent-command-xyz')).exitCode).toBe(127);
    expect((await run('true')).exitCode).toBe(0);
  });

  it('truncates long output keeping head and tail, per stream', async () => {
    const r = await run('seq 1 200000', { maxOutputBytes: 10_000 });
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith('1\n2\n3\n')).toBe(true);
    expect(r.stdout.endsWith('199999\n200000\n')).toBe(true);
    const m = /\[… truncated (\d+) bytes …\]/.exec(r.stdout);
    expect(m).not.toBeNull();
    const total = Buffer.byteLength(Array.from({ length: 200000 }, (_, i) => `${i + 1}\n`).join(''));
    const marker = m![0];
    const kept = Buffer.byteLength(r.stdout) - Buffer.byteLength(`\n${marker}\n`);
    expect(kept + Number(m![1])).toBe(total);
    expect(kept).toBeLessThanOrEqual(10_000);
    expect(kept).toBeGreaterThan(9_900);

    const e = await run('seq 1 50000 >&2; echo done', { maxOutputBytes: 5_000 });
    expect(e.stdout).toBe('done\n');
    expect(e.truncated).toBe(true);
    expect(e.stderr).toMatch(/truncated \d+ bytes/);

    const small = await run('seq 1 100', { maxOutputBytes: 10_000 });
    expect(small.truncated).toBe(false);
  });

  it('truncates by default at 1 MiB per stream', async () => {
    const r = await run(`head -c 3000000 /dev/zero | tr '\\0' 'x'`);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(1_048_576 + 100);
    expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(1_048_576 - 100);
  });

  it('validates the virtual cwd', async () => {
    mkdirSync(join(dirs.mounts.workspace, 'sub', 'dir'), { recursive: true });
    for (const bad of ['/etc', '/', '/usr/bin', '/proc', '/workspace/../etc', '/workspace/../../', '/rawr', '/workspaceX', '../..', 'sub/../../etc']) {
      await expect(run('pwd', { cwd: bad }), bad).rejects.toMatchObject({ name: 'ToolError', code: 'EOUTOFSCOPE' });
    }
    await expect(run('pwd', { cwd: '/workspace/\0x' })).rejects.toBeInstanceOf(ToolError);
    expect((await run('pwd', { cwd: '/workspace/sub/dir' })).stdout).toBe('/workspace/sub/dir\n');
    expect((await run('pwd', { cwd: 'sub' })).stdout).toBe('/workspace/sub\n');
    expect((await run('pwd', { cwd: '/workspace/sub/../sub/./dir/' })).stdout).toBe('/workspace/sub/dir\n');
    expect((await run('pwd', { cwd: '/tmp' })).stdout).toBe('/tmp\n');
    expect((await run('pwd; ls', { cwd: '/raw' })).stdout).toBe('/raw\nupload.txt\n');
    const missing = await run('pwd', { cwd: '/workspace/does/not/exist' });
    expect(missing.exitCode).toBe(125);
    expect(missing.stderr).toMatch(/opencoach-sandbox: cannot cd/);
  });

  it('builds the environment from scratch: no process.env secrets leak', async () => {
    process.env.OPENCOACH_TEST_SECRET = 'super-secret-value-123';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-leak-check';
    try {
      const r = await run('env; echo ---; cat /proc/self/environ | tr "\\0" "\\n"; echo ---; cat /proc/1/environ | tr "\\0" "\\n"');
      expect(r.stdout).not.toContain('super-secret-value-123');
      expect(r.stdout).not.toContain('sk-ant-test-leak-check');
      expect(r.stdout).not.toContain('OPENCOACH_TEST_SECRET');
      const names = new Set(
        r.stdout
          .split('---')[0]!
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('=')[0]!),
      );
      expect([...names].sort()).toEqual(['HOME', 'LANG', 'OPENCOACH_SANDBOX', 'PATH', 'PROVIDER_VAR', 'PWD', 'PYTHONDONTWRITEBYTECODE', 'SHLVL', 'TZ', '_'].sort());
      expect(r.stdout).toContain('PROVIDER_VAR=from-provider');
      expect(r.stdout).toContain('TZ=UTC');
      expect(r.stdout).toContain('HOME=/tmp');
      expect(r.stdout).toContain('PYTHONDONTWRITEBYTECODE=1');
    } finally {
      delete process.env.OPENCOACH_TEST_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('passes per-exec env exactly, including awkward values, and honours tz', async () => {
    const weird = `a b'c"d$e\nf\\g ä😀`;
    const r = await run(`printf "%s" "$WEIRD"; echo; echo "$PROVIDER_VAR"; date -d '2026-01-15 12:00 UTC' +%Z; date -d '2026-07-15 12:00 UTC' +%Z`, {
      env: { WEIRD: weird, PROVIDER_VAR: 'override' },
      tz: 'Europe/Amsterdam',
    });
    expect(r.stdout).toBe(`${weird}\noverride\nCET\nCEST\n`);
    await expect(run('true', { env: { 'BAD NAME': 'x' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run('true', { env: { OK: 'a\0b' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('passes the command through safely (quotes, newlines, unicode, heredocs)', async () => {
    const cmd = `echo 'single' "double \\"q\\"" $((6*7)) ünï😀
cat <<'EOF'
line one with $HOME and \`backticks\`
EOF
printf '%s\\n' "a'b"`;
    const r = await run(cmd);
    expect(r.stdout).toBe(`single double "q" 42 ünï😀\nline one with $HOME and \`backticks\`\na'b\n`);
    const inj = await run(`echo '; touch /workspace/pwned; echo '`);
    expect(inj.stdout).toBe('; touch /workspace/pwned; echo \n');
    expect(existsSync(join(dirs.mounts.workspace, 'pwned'))).toBe(false);
  });

  it('handles commands too large for a single argument', async () => {
    const big = `: '${'x'.repeat(300_000)}'\necho big-ok; echo "$0"`;
    const r = await run(big);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('big-ok');
  });

  it('delivers stdin (and EOF when there is none)', async () => {
    expect((await run('cat', { stdin: 'hello from stdin\nsecond line\n' })).stdout).toBe('hello from stdin\nsecond line\n');
    expect((await run('read -r line; echo "got:$line"', { stdin: 'one line\nrest\n' })).stdout).toBe('got:one line\n');
    const none = await run('cat; echo eof');
    expect(none.stdout).toBe('eof\n');
    const big = 'y'.repeat(2_000_000);
    expect((await run('wc -c', { stdin: big })).stdout.trim()).toBe('2000000');
    // a command that never reads stdin does not hang or fail
    expect((await run('echo fine', { stdin: big })).stdout).toBe('fine\n');
  });

  it('runs two commands at once without interference', async () => {
    const t0 = performance.now();
    const [a, b] = await Promise.all([
      run('echo A > /tmp/who && sleep 1 && cat /tmp/who && cat /proc/self/status | grep ^Pid:', { }),
      run('echo B > /tmp/who && sleep 1 && cat /tmp/who && cat /proc/self/status | grep ^Pid:', { }),
    ]);
    const elapsed = performance.now() - t0;
    expect(a.stdout.split('\n')[0]).toBe('A');
    expect(b.stdout.split('\n')[0]).toBe('B');
    expect(a.exitCode + b.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(1900);

    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => run(`echo ${i} > /tmp/n; sleep 0.3; cat /tmp/n; echo ${i} >> /workspace/conc.log`)));
    expect(many.map((r) => r.stdout.trim())).toEqual(Array.from({ length: 8 }, (_, i) => String(i)));
    expect(readFileSync(join(dirs.mounts.workspace, 'conc.log'), 'utf8').trim().split('\n').sort()).toEqual(Array.from({ length: 8 }, (_, i) => String(i)));
  });

  it('protects git metadata against writes, deletion, rename and aliases [SEC-2]', async () => {
    const gitDir = join(dirs.mounts.workspace, '.git');
    mkdirSync(join(gitDir, 'hooks'), { recursive: true });
    writeFileSync(join(gitDir, 'config'), 'trusted config\n');
    symlinkSync('.git', join(dirs.mounts.workspace, 'git-alias'));
    for (const command of [
      'echo injected > .git/config',
      'echo injected > .git/hooks/pre-commit',
      'echo injected > git-alias/config',
      'rm -rf .git',
      'mv .git .git-stolen',
      'mount -o remount,rw /workspace/.git',
    ]) {
      expect((await run(command)).exitCode, command).not.toBe(0);
    }
    expect(readFileSync(join(gitDir, 'config'), 'utf8')).toBe('trusted config\n');
    expect((await run('echo writable > notes/still-writable')).exitCode).toBe(0);
  });

  it('protects .git files used by helper worktrees [SUB-3] [SEC-2]', async () => {
    const other = makeDirs('oc-sbx-worktree-');
    try {
      writeFileSync(join(other.mounts.workspace, '.git'), 'gitdir: /trusted/worktree\n');
      const h = await provider.ensure('ath_worktree', other.mounts);
      const result = await provider.exec(h, 'echo injected > .git; rm .git; mv .git stolen', { timeoutS: 10 });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(other.mounts.workspace, '.git'), 'utf8')).toBe('gitdir: /trusted/worktree\n');
    } finally {
      other.cleanup();
    }
  });

  it('supports abort signals', async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    const p = run('sleep 33', { signal: ac.signal, timeoutS: 60 });
    setTimeout(() => ac.abort(), 400);
    const r = await p;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.exitCode).toBe(130);
    expect(r.timedOut).toBe(false);
    const pre = new AbortController();
    pre.abort();
    const immediate = await run('echo should-not-run', { signal: pre.signal });
    expect(immediate).toMatchObject({ stdout: '', exitCode: 130 });
  });

  it('runs python and (when exposed) node', async () => {
    expect((await run('python3 -c "print(6*7)"')).stdout).toBe('42\n');
    expect((await run('python3 -c "import sqlite3, json, ssl; print(sqlite3.sqlite_version[0])"')).exitCode).toBe(0);
    const nodeDir = dirname(process.execPath);
    const exposed = resolveHostDirs(undefined).some((d) => nodeDir === d || nodeDir.startsWith(`${d}/`));
    if (exposed) {
      const r = await run('node -e "console.log(2+3)"');
      expect(r.stdout).toBe('5\n');
    }
  });

  it('ignores fakeTime when libfaketime is unavailable, and applies it when present', async () => {
    const lib = findFaketimeLibrary(resolveHostDirs(undefined));
    const r = await run('echo "[$FAKETIME]" "[$LD_PRELOAD]"; date -u +%Y', { fakeTime: '2031-02-03T04:05:06Z' });
    if (!lib) {
      expect(r.stdout).toMatch(/^\[\] \[\]\n/);
      expect(Number(r.stdout.split('\n')[1])).not.toBe(2031);
    } else {
      expect(r.stdout).toContain('[@2031-02-03 04:05:06]');
      expect(r.stdout.split('\n')[1]).toBe('2031');
    }
  });

  it('refuses unknown or released handles and mounts that do not exist', async () => {
    await expect(provider.exec({ athleteId: 'ath_1', id: 'local:nope', kind: 'local-isolated' }, 'true', { timeoutS: 5 })).rejects.toThrow(/unknown or released/);
    await expect(provider.ensure('ath_x', { ...dirs.mounts, raw: join(dirs.root, 'missing') })).rejects.toThrow(/does not exist/);
    await expect(provider.ensure('ath_x', { ...dirs.mounts, workspace: 'relative/path' })).rejects.toThrow(/absolute/);
    await expect(provider.ensure('ath_x', { ...dirs.mounts, system: join(dirs.mounts.workspace, 'AGENTS.md') })).rejects.toThrow(/not a directory/);
    const h2 = await provider.ensure('ath_2', makeDirsInto(dirs, 'two'));
    expect((await provider.exec(h2, 'echo two', { timeoutS: 5 })).stdout).toBe('two\n');
    await provider.release?.(h2);
    await expect(provider.exec(h2, 'echo two', { timeoutS: 5 })).rejects.toThrow(/unknown or released/);
  });

  it('re-ensure updates the mounts of an existing handle', async () => {
    const other = makeDirs('oc-sbx-other-');
    try {
      writeFileSync(join(other.mounts.workspace, 'AGENTS.md'), '# other\n');
      const h = await provider.ensure('ath_swap', dirs.mounts);
      expect((await provider.exec(h, 'cat AGENTS.md', { timeoutS: 5 })).stdout).toBe('# agents\n');
      const h2 = await provider.ensure('ath_swap', other.mounts);
      expect(h2.id).toBe(h.id);
      expect((await provider.exec(h2, 'cat AGENTS.md', { timeoutS: 5 })).stdout).toBe('# other\n');
    } finally {
      other.cleanup();
    }
  });

  it('isolates athletes from each other', async () => {
    const other = makeDirs('oc-sbx-iso-');
    try {
      const h = await provider.ensure('ath_iso', other.mounts);
      const r = await provider.exec(h, 'ls /workspace /raw; cat /workspace/host.txt 2>&1', { timeoutS: 5 });
      expect(r.stdout).not.toContain('host.txt\n# agents');
      expect(r.stdout).not.toContain('notes');
      expect(r.stdout).toContain('AGENTS.md');
    } finally {
      other.cleanup();
    }
  });

  it('refuses to run after dispose', async () => {
    const p2 = await createLocalSandboxProvider({ allowUnsafe: false });
    const h = await p2.ensure('ath_d', dirs.mounts);
    const running = p2.exec(h, 'sleep 34', { timeoutS: 60 });
    await new Promise((r) => setTimeout(r, 300));
    await p2.dispose();
    const r = await running; // the live command was killed by dispose
    expect(r.exitCode).not.toBe(0);
    await expect(p2.exec(h, 'true', { timeoutS: 5 })).rejects.toThrow(/disposed/);
    await expect(p2.ensure('ath_d', dirs.mounts)).rejects.toThrow(/disposed/);
    await p2.dispose(); // idempotent
  });
});

nsDescribe('local isolated provider configuration', () => {
  it('rejects mounts located inside an exposed host dir', async () => {
    // Use /var/tmp: /tmp and /workspace are reserved virtual mounts.
    const dirs = makeDirs('oc-sbx-exposed-', '/var/tmp');
    const base = dirs.root;
    try {
      const p = await createLocalSandboxProvider({ allowUnsafe: false, hostDirs: ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/etc', base] });
      await expect(p.ensure('ath_1', dirs.mounts)).rejects.toThrow(/lies inside the exposed host dir/);
      await p.dispose();
    } finally {
      dirs.cleanup();
    }
  });

  it('validates host dirs and provider env at creation', async () => {
    await expect(createLocalSandboxProvider({ allowUnsafe: false, hostDirs: ['/'] })).rejects.toThrow(/whole host/);
    await expect(createLocalSandboxProvider({ allowUnsafe: false, hostDirs: ['relative'] })).rejects.toThrow(/invalid sandbox host dir/);
    await expect(createLocalSandboxProvider({ allowUnsafe: false, hostDirs: ['/workspace'] })).rejects.toThrow(/collides/);
    await expect(createLocalSandboxProvider({ allowUnsafe: false, hostDirs: ['/tmp/anything'] })).rejects.toThrow(/collides/);
    await expect(createLocalSandboxProvider({ allowUnsafe: false, env: { 'BAD NAME': 'x' } })).rejects.toThrow(/invalid environment variable name/);
  });

  it('honours a custom list of host dirs (missing ones are skipped)', async () => {
    const dirs = makeDirs();
    try {
      const p = await createLocalSandboxProvider({ allowUnsafe: false, hostDirs: ['/usr', '/bin', '/lib', '/lib64', '/sbin', '/definitely-not-a-dir'] });
      const h = await p.ensure('ath_1', dirs.mounts);
      const r = await p.exec(h, 'ls / ; ls /etc 2>&1 | head -1', { timeoutS: 10 });
      expect(r.stdout.split('\n')).not.toContain('etc'); // /etc was not exposed
      expect(r.stdout).toMatch(/No such file or directory/);
      await p.dispose();
    } finally {
      dirs.cleanup();
    }
  });

  it('enforces the /tmp size limit', async () => {
    const dirs = makeDirs();
    try {
      const p = await createLocalSandboxProvider({ allowUnsafe: false, tmpSize: '2m' });
      const h = await p.ensure('ath_1', dirs.mounts);
      const r = await p.exec(h, 'head -c 5000000 /dev/zero > /tmp/big; echo "exit=$?"; ls -l /tmp/big | cut -d" " -f5', { timeoutS: 10 });
      expect(r.stdout).toContain('exit=1');
      expect(Number(r.stdout.trim().split('\n').pop())).toBeLessThanOrEqual(2 * 1024 * 1024);
      await p.dispose();
    } finally {
      dirs.cleanup();
    }
  });
});

function makeDirsInto(base: TestDirs, name: string) {
  const root = join(base.root, name);
  const mounts = { workspace: join(root, 'workspace'), raw: join(root, 'raw'), history: join(root, 'history'), system: join(root, 'system') };
  for (const d of Object.values(mounts)) mkdirSync(d, { recursive: true });
  return mounts;
}
