import { describe, expect, it } from 'vitest';
import { ToolError } from '@opencoach/protocol';
import { DEFAULT_MAX_OUTPUT_BYTES, OutputCollector, buildEnv, containsPath, formatFaketime, runProcess, validateCwd } from './common';

describe('validateCwd', () => {
  it('defaults to /workspace and normalises paths under the mounts', () => {
    expect(validateCwd(undefined)).toBe('/workspace');
    expect(validateCwd('')).toBe('/workspace');
    expect(validateCwd('/workspace')).toBe('/workspace');
    expect(validateCwd('/workspace/')).toBe('/workspace');
    expect(validateCwd('/workspace//a/./b/../c/')).toBe('/workspace/a/c');
    expect(validateCwd('notes/week')).toBe('/workspace/notes/week');
    for (const root of ['/raw', '/history', '/system', '/tmp']) {
      expect(validateCwd(root)).toBe(root);
      expect(validateCwd(`${root}/x`)).toBe(`${root}/x`);
    }
  });

  it('rejects everything outside the mounts with EOUTOFSCOPE', () => {
    for (const bad of ['/', '/etc', '/usr/bin', '/proc/self', '/dev', '/home', '/workspace/..', '/workspace/../etc', '/workspaces', '/rawdata', '/tmpx', '../etc', 'a/../../b', '/tmp/../etc']) {
      expect(() => validateCwd(bad), bad).toThrow(ToolError);
      try {
        validateCwd(bad);
      } catch (e) {
        expect((e as ToolError).code).toBe('EOUTOFSCOPE');
      }
    }
    expect(() => validateCwd('/workspace/\0')).toThrow(/NUL/);
  });
});

describe('formatFaketime', () => {
  it('formats the instant as libfaketime wall time in the given zone', () => {
    expect(formatFaketime('2026-10-07T06:58:12Z')).toBe('@2026-10-07 06:58:12');
    expect(formatFaketime('2026-10-07T08:58:12+02:00')).toBe('@2026-10-07 06:58:12');
    expect(formatFaketime('2026-10-07T06:58:12Z', 'Europe/Amsterdam')).toBe('@2026-10-07 08:58:12');
    expect(formatFaketime('2026-01-15T23:30:00Z', 'America/New_York')).toBe('@2026-01-15 18:30:00');
    expect(formatFaketime('2026-01-01T00:00:00Z')).toBe('@2026-01-01 00:00:00'); // midnight renders as 00, not 24
    expect(formatFaketime('2026-10-07T06:58:12Z', 'Not/AZone')).toBe('@2026-10-07 06:58:12'); // invalid zone falls back to UTC
  });

  it('rejects unparseable timestamps', () => {
    expect(() => formatFaketime('yesterday')).toThrow(ToolError);
  });
});

describe('buildEnv', () => {
  it('builds the environment from scratch and never reads process.env', () => {
    process.env.OPENCOACH_TEST_SECRET = 'leak-me';
    try {
      const env = buildEnv({ path: '/bin' });
      expect(env).toEqual({ PATH: '/bin', HOME: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC', PYTHONDONTWRITEBYTECODE: '1', OPENCOACH_SANDBOX: '1' });
      expect(JSON.stringify(env)).not.toContain('leak-me');
    } finally {
      delete process.env.OPENCOACH_TEST_SECRET;
    }
  });

  it('layers base < provider env < per-exec env, and validates entries', () => {
    const env = buildEnv({ path: '/bin', tz: 'Europe/Amsterdam', base: { HOME: '/h', X: 'base' }, providerEnv: { X: 'provider', Y: 'provider' }, env: { Y: 'exec', Z: 'exec' } });
    expect(env).toMatchObject({ TZ: 'Europe/Amsterdam', HOME: '/h', X: 'provider', Y: 'exec', Z: 'exec' });
    expect(() => buildEnv({ path: '/bin', env: { '1BAD': 'x' } })).toThrow(/invalid environment variable name/);
    expect(() => buildEnv({ path: '/bin', env: { 'A=B': 'x' } })).toThrow(ToolError);
    expect(() => buildEnv({ path: '/bin', providerEnv: { OK: 'a\0b' } })).toThrow(/invalid value/);
    expect(buildEnv({ path: '/bin', tz: 'Bogus/Zone' }).TZ).toBe('UTC');
  });

  it('adds libfaketime variables only when both a time and a library are available', () => {
    const lib = '/usr/lib/faketime/libfaketime.so.1';
    expect(buildEnv({ path: '/bin', fakeTime: '2031-02-03T04:05:06Z' })).not.toHaveProperty('LD_PRELOAD');
    expect(buildEnv({ path: '/bin', faketimeLibrary: lib })).not.toHaveProperty('FAKETIME');
    const env = buildEnv({ path: '/bin', fakeTime: '2031-02-03T04:05:06Z', faketimeLibrary: lib });
    expect(env).toMatchObject({ LD_PRELOAD: lib, FAKETIME: '@2031-02-03 04:05:06', FAKETIME_DONT_FAKE_MONOTONIC: '1' });
    expect(buildEnv({ path: '/bin', tz: 'Europe/Amsterdam', fakeTime: '2031-02-03T04:05:06Z', faketimeLibrary: lib }).FAKETIME).toBe('@2031-02-03 05:05:06');
  });
});

describe('containsPath', () => {
  it('matches the dir itself and its descendants only', () => {
    expect(containsPath('/opt', '/opt')).toBe(true);
    expect(containsPath('/opt', '/opt/node22/bin')).toBe(true);
    expect(containsPath('/opt/', '/opt/x')).toBe(true);
    expect(containsPath('/opt', '/optical')).toBe(false);
    expect(containsPath('/opt/a', '/opt')).toBe(false);
  });
});

describe('OutputCollector', () => {
  const collect = (cap: number, chunks: Array<string | Buffer>) => {
    const c = new OutputCollector(cap);
    for (const ch of chunks) c.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
    return c.finish();
  };

  it('returns everything when it fits (including exactly at the cap)', () => {
    expect(collect(10, ['hello'])).toEqual({ text: 'hello', truncated: false });
    expect(collect(10, ['01234', '56789'])).toEqual({ text: '0123456789', truncated: false });
    expect(collect(10, [])).toEqual({ text: '', truncated: false });
  });

  it('keeps head and tail with a marker counting the dropped bytes', () => {
    const r = collect(10, ['0123456789ABCDEF']);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('01234\n[… truncated 6 bytes …]\nBCDEF');
  });

  it('gives the same result however the stream is chunked', () => {
    const data = Array.from({ length: 5000 }, (_, i) => `${i}\n`).join('');
    const whole = collect(1000, [data]);
    expect(whole.truncated).toBe(true);
    for (const size of [1, 3, 7, 64, 999, 1000, 1001, 4096]) {
      const chunks: string[] = [];
      for (let i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size));
      expect(collect(1000, chunks), `chunk size ${size}`).toEqual(whole);
    }
    const m = /\[… truncated (\d+) bytes …\]/.exec(whole.text)!;
    const kept = Buffer.byteLength(whole.text) - Buffer.byteLength(`\n${m[0]}\n`);
    expect(kept + Number(m[1])).toBe(Buffer.byteLength(data));
    expect(kept).toBeLessThanOrEqual(1000);
  });

  it('never splits a multi-byte character at the cut', () => {
    const r = collect(20, ['😀'.repeat(50)]);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain('�');
    const [head, tail] = r.text.split(/\n\[… truncated \d+ bytes …\]\n/);
    expect(head).toMatch(/^(😀)+$/);
    expect(tail).toMatch(/^(😀)+$/);
  });

  it('uses bounded memory for huge streams', () => {
    const c = new OutputCollector(1024);
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let i = 0; i < 2000; i++) c.push(chunk); // 128 MB through a 1 KiB window
    const r = c.finish();
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThan(1024 + 80);
    expect(/truncated (\d+) bytes/.exec(r.text)![1]).toBe(String(2000 * 64 * 1024 - 1024));
  });

  it('defaults to 1 MiB', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(1_048_576);
  });
});

describe('runProcess', () => {
  const base = { env: { PATH: '/usr/bin:/bin' }, timeoutS: 10, maxOutputBytes: 10_000 };

  it('captures output, exit code and stdin', async () => {
    const r = await runProcess({ ...base, file: '/bin/sh', args: ['-c', 'cat; echo err >&2; exit 3'], stdin: 'in\n' });
    expect(r).toMatchObject({ stdout: 'in\n', stderr: 'err\n', exitCode: 3, timedOut: false, truncated: false });
  });

  it('kills the process group on timeout', async () => {
    const t0 = performance.now();
    const r = await runProcess({ ...base, timeoutS: 0.5, file: '/bin/sh', args: ['-c', 'sleep 30 & sleep 30'] });
    expect(r).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('reports signal deaths as 128+n', async () => {
    const r = await runProcess({ ...base, file: '/bin/sh', args: ['-c', 'kill -TERM $$'] });
    expect(r.exitCode).toBe(143);
  });

  it('rejects when the program cannot be spawned', async () => {
    await expect(runProcess({ ...base, file: '/nonexistent/program', args: [] })).rejects.toThrow(/ENOENT/);
  });

  it('does not hang on a daemonised child holding the pipes', async () => {
    const t0 = performance.now();
    const r = await runProcess({ ...base, file: '/bin/sh', args: ['-c', '(sleep 20 >/dev/null 2>&1 &) ; (sleep 20 &) ; echo done'] });
    expect(r.stdout).toBe('done\n');
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});
