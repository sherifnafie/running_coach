import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxHandle, SandboxProvider } from '@opencoach/protocol';
import { createDockerProvider, DockerClient, DockerDemuxer } from './docker';
import { FakeDocker } from './fake-docker';
import { makeDirs, type TestDirs } from './test-helpers';

describe('Docker Engine API contract [SEC-1] [SEC-2]', () => {
  let daemon: FakeDocker;
  let dirs: TestDirs;
  let provider: SandboxProvider;
  let handle: SandboxHandle;
  beforeEach(async () => {
    daemon = new FakeDocker();
    await daemon.listen();
    dirs = makeDirs();
    mkdirSync(join(dirs.mounts.workspace, '.git'));
    writeFileSync(join(dirs.mounts.workspace, '.git/config'), 'trusted');
    provider = createDockerProvider({ image: 'opencoach:test', socketPath: daemon.socketPath, memoryMb: 256, cpus: 0.5, user: '1000:1000', runtime: 'runsc' });
    handle = await provider.ensure('ath_1', dirs.mounts);
  });
  afterEach(async () => { await provider.dispose(); await daemon.close(); dirs.cleanup(); });

  it('uses no network, read-only trust mounts and git metadata, and resource quotas', () => {
    const body = [...daemon.containers.values()][0]!.body;
    expect(body).toMatchObject({ User: '1000:1000', HostConfig: { NetworkMode: 'none', Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000, Runtime: 'runsc', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 512, ReadonlyRootfs: true, Init: true } });
    expect(body.HostConfig.Binds).toContain(`${dirs.mounts.workspace}/.git:/workspace/.git:ro`);
    for (const mount of ['raw', 'history', 'system'] as const) expect(body.HostConfig.Binds).toContain(`${dirs.mounts[mount]}:/${mount}:ro`);
  });

  it('reuses containers and serializes simultaneous identical ensure calls', async () => {
    const handles = await Promise.all(Array.from({ length: 5 }, () => provider.ensure('ath_1', dirs.mounts)));
    expect(new Set(handles.map((h) => h.id))).toEqual(new Set([handle.id]));
    expect(daemon.requests.filter((r) => r.path.startsWith('/containers/create'))).toHaveLength(1);
    daemon.stopAll();
    expect((await provider.ensure('ath_1', dirs.mounts)).id).toBe(handle.id);
    expect(daemon.containers.get(handle.id)!.running).toBe(true);
  });

  it('recreates stale configuration and removes duplicate labeled containers', async () => {
    daemon.containers.get(handle.id)!.body.Labels['opencoach.config'] = 'stale';
    const fresh = await provider.ensure('ath_1', dirs.mounts);
    expect(fresh.id).not.toBe(handle.id);
    expect(daemon.containers.has(handle.id)).toBe(false);
    expect(daemon.containers.size).toBe(1);
  });

  it('keeps commands and env values literal, with an empty inherited environment', async () => {
    daemon.handler = () => ({ stdout: 'done', exitCode: 0 });
    const command = 'printf "%s" "$CUSTOM"; echo literal';
    const result = await provider.exec(handle, command, { timeoutS: 2, cwd: 'notes', tz: 'Europe/Amsterdam', env: { CUSTOM: '$(do-not-run)\nvalue' } });
    expect(result).toMatchObject({ stdout: 'done', stderr: '', exitCode: 0, timedOut: false });
    const request = daemon.execRequests[0]!;
    expect(request.workingDir).toBe('/workspace/notes');
    expect(request.cmd.slice(0, 2)).toEqual(['env', '-i']);
    expect(request.cmd).toContain('CUSTOM=$(do-not-run)\nvalue');
    expect(request.cmd.slice(-4)).toEqual(['--noprofile', '--norc', '-c', command]);
    expect(request.env).toContain('TZ=Europe/Amsterdam');
    expect(request.env.some((e) => e.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
  });

  it('delivers stdin and demultiplexes arbitrarily fragmented output', async () => {
    daemon.handler = (req) => ({ frames: [{ stream: 'stdout', data: req.stdin }, { stream: 'stderr', data: 'warning é' }, { stream: 'stdout', data: '\ndone' }], pieceSize: 1, exitCode: 7, runningPolls: 2 });
    const result = await provider.exec(handle, 'cat', { timeoutS: 2, stdin: 'hello 👟\n' });
    expect(result).toMatchObject({ stdout: 'hello 👟\n\ndone', stderr: 'warning é', exitCode: 7 });
    expect(daemon.execRequests[0]!.stdin).toBe('hello 👟\n');
  });

  it('supports plain streaming output and rejects unavailable stdin delivery', async () => {
    daemon.upgrade = false;
    daemon.handler = () => ({ stdout: 'plain output', stderr: 'plain error' });
    expect(await provider.exec(handle, 'true', { timeoutS: 2 })).toMatchObject({ stdout: 'plain output', stderr: 'plain error' });
    await expect(provider.exec(handle, 'cat', { timeoutS: 2, stdin: 'input' })).rejects.toThrow(/stdin cannot be delivered/);
  });

  it('accepts an empty stdin stream', async () => {
    daemon.handler = (req) => ({ stdout: req.stdin === '' && req.attachStdin ? 'EOF' : 'bad' });
    expect((await provider.exec(handle, 'cat', { timeoutS: 2, stdin: '' })).stdout).toBe('EOF');
  });

  it('bounds output while preserving its beginning and end', async () => {
    daemon.handler = () => ({ stdout: 'START' + 'x'.repeat(10000) + 'END', stderr: 'err', pieceSize: 31 });
    const result = await provider.exec(handle, 'large', { timeoutS: 2, maxOutputBytes: 40 });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toMatch(/^START.*truncated[\s\S]*END$/s);
    expect(result.stdout.length).toBeLessThan(100);
    expect(result.stderr).toBe('err');
  });

  it('maps a full-budget timeout to 124 and leaves short exit 137 distinguishable', async () => {
    daemon.handler = () => ({ delayMs: 90, exitCode: 137 });
    expect(await provider.exec(handle, 'slow', { timeoutS: 0.05 })).toMatchObject({ exitCode: 124, timedOut: true });
    daemon.handler = () => ({ exitCode: 137 });
    expect(await provider.exec(handle, 'exit 137', { timeoutS: 2 })).toMatchObject({ exitCode: 137, timedOut: false });
  });

  it('aborts promptly and stops the command container, then recovers on next exec', async () => {
    daemon.handler = () => ({ hang: true });
    const ac = new AbortController();
    const result = provider.exec(handle, 'hang', { timeoutS: 20, signal: ac.signal });
    setTimeout(() => ac.abort(), 80);
    expect(await result).toMatchObject({ exitCode: 130, timedOut: false });
    expect(daemon.containers.get(handle.id)!.running).toBe(false);
    expect(daemon.requests.some((r) => r.path.endsWith('/stop?t=0'))).toBe(true);
    daemon.handler = () => ({ stdout: 'recovered' });
    expect((await provider.exec(handle, 'true', { timeoutS: 2 })).stdout).toBe('recovered');
  });

  it('does not start a pre-aborted command', async () => {
    const ac = new AbortController(); ac.abort();
    expect(await provider.exec(handle, 'never', { timeoutS: 2, signal: ac.signal })).toMatchObject({ exitCode: 130, stdout: '' });
    expect(daemon.execRequests).toHaveLength(0);
  });

  it('recovers when a container disappears and keeps the issued handle usable', async () => {
    daemon.failExecCreate = { status: 404, times: 1 };
    daemon.handler = () => ({ stdout: 'recovered' });
    expect((await provider.exec(handle, 'true', { timeoutS: 2 })).stdout).toBe('recovered');
    expect((await provider.exec(handle, 'true', { timeoutS: 2 })).stdout).toBe('recovered');
    expect(daemon.containers.size).toBe(1);
  });

  it('rejects forged, mismatched and released handles', async () => {
    await expect(provider.exec({ ...handle, id: 'forged' }, 'true', { timeoutS: 2 })).rejects.toThrow(/unknown or released/);
    await expect(provider.exec({ ...handle, athleteId: 'ath_other' }, 'true', { timeoutS: 2 })).rejects.toThrow(/unknown or released/);
    await provider.release?.(handle);
    await expect(provider.exec(handle, 'true', { timeoutS: 2 })).rejects.toThrow(/unknown or released/);
    expect(daemon.containers.size).toBe(1);
  });

  it('never deletes an unmanaged container on a name collision', async () => {
    const other = [...daemon.containers.values()][0]!;
    other.body.Labels = {};
    await expect(provider.ensure('ath_1', dirs.mounts)).rejects.toThrow(/refusing to remove an unmanaged/);
    expect(daemon.containers.has(handle.id)).toBe(true);
  });

  it('supports isolated helper keys without sanitized-name collisions [SUB-3]', async () => {
    const first = await provider.ensure('ath_1:tsk_1', dirs.mounts);
    const second = await provider.ensure('ath_1_tsk_1', dirs.mounts);
    expect(first.id).not.toBe(second.id);
    expect(daemon.containers.size).toBe(3);
  });

  it('provides an actionable missing-image error', async () => {
    const missing = createDockerProvider({ image: 'missing:image', socketPath: daemon.socketPath, memoryMb: 256, cpus: 1 });
    try { await expect(missing.ensure('ath_missing', dirs.mounts)).rejects.toThrow(/build or pull it first/); } finally { await missing.dispose(); }
  });

  it('validates athlete ids, mounts, cwd and execution limits', async () => {
    expect(() => createDockerProvider({ image: 'test', socketPath: daemon.socketPath, memoryMb: 0, cpus: 1 })).toThrow(/memoryMb/);
    expect(() => createDockerProvider({ image: 'test', socketPath: daemon.socketPath, memoryMb: 256, cpus: Number.NaN })).toThrow(/cpus/);
    expect(() => createDockerProvider({ image: 'test', socketPath: daemon.socketPath, memoryMb: 256, cpus: 1, pidsLimit: -1 })).toThrow(/pidsLimit/);
    await expect(provider.ensure('../escape', dirs.mounts)).rejects.toThrow(/invalid athlete/);
    await expect(provider.ensure('ath_2', { ...dirs.mounts, raw: 'relative' })).rejects.toThrow(/absolute/);
    await expect(provider.exec(handle, 'true', { timeoutS: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.exec(handle, 'true', { timeoutS: 2, cwd: '/etc' })).rejects.toMatchObject({ code: 'EOUTOFSCOPE' });
  });

  it('cancels active commands on disposal and refuses subsequent use', async () => {
    daemon.handler = () => ({ hang: true });
    const result = provider.exec(handle, 'hang', { timeoutS: 20 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await provider.dispose();
    expect((await result).exitCode).not.toBe(0);
    expect(daemon.containers.get(handle.id)!.running).toBe(false);
    await expect(provider.ensure('ath_1', dirs.mounts)).rejects.toThrow(/disposed/);
  });

  it('pings an Engine socket and reports a missing socket safely', async () => {
    expect(await new DockerClient(daemon.socketPath).ping()).toBe(true);
    expect(await new DockerClient('/nonexistent/docker.sock').ping()).toBe(false);
  });
});

it('demultiplexes split headers and skips stdin frames [SEC-2]', () => {
  const frames: Array<[string, string]> = [];
  const demux = new DockerDemuxer((stream, bytes) => frames.push([stream, bytes.toString()]));
  for (const [type, value] of [[0, 'ignore'], [1, 'out'], [2, 'err']] as const) {
    const header = Buffer.alloc(8); header[0] = type; header.writeUInt32BE(value.length, 4);
    for (const byte of Buffer.concat([header, Buffer.from(value)])) demux.push(Buffer.from([byte]));
  }
  expect(frames).toEqual([['stdout', 'out'], ['stderr', 'err']]);
});
