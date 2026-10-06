import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystemDir } from '../src';
import { makeSeed, tmpDir, write } from './helpers';

describe('buildSystemDir [WS-9] [SAFE-3]', () => {
  it('assembles pack sections and ships addenda, skills, changelog and extra docs', async () => {
    const seedRoot = await makeSeed();
    const dataDir = await tmpDir();
    const extra = await tmpDir();
    await write(join(extra, 'kit.md'), 'kit reference');
    const target = await buildSystemDir({ seedRoot, dataDir, pack: 'running', harnessVersion: '0.1.0', extraDocs: { 'kit': extra } });
    const constitution = await fs.readFile(join(target, 'constitution.md'), 'utf8');
    expect(constitution).toContain('Easy runs are easy.');
    expect(constitution).toContain('Chest pain: stop.');
    expect(constitution).toContain('{{coach_name}}');
    expect(constitution).not.toContain('{{pack_coaching}}');
    expect(await fs.readFile(join(target, 'addenda/helper.md'), 'utf8')).toBe('helper preamble\n');
    expect(await fs.readFile(join(target, 'skills/intake/SKILL.md'), 'utf8')).toContain('name: intake');
    expect(await fs.readFile(join(target, 'CHANGELOG-for-coach.md'), 'utf8')).toBe('# Changelog\n');
    expect(await fs.readFile(join(target, 'docs/kit/kit.md'), 'utf8')).toBe('kit reference');
  });

  it('skips unchanged inputs and rebuilds when an input or extra document changes', async () => {
    const seedRoot = await makeSeed();
    const dataDir = await tmpDir();
    const doc = join(await tmpDir(), 'kit.md'); await write(doc, 'one');
    const opts = { seedRoot, dataDir, pack: 'running', harnessVersion: '0.1.0', extraDocs: { 'kit.md': doc } };
    const target = await buildSystemDir(opts);
    const before = await fs.stat(join(target, 'constitution.md'));
    const hash = await fs.readFile(join(target, '.source-hash'), 'utf8');
    await buildSystemDir(opts);
    expect((await fs.stat(join(target, 'constitution.md'))).ino).toBe(before.ino);
    await write(doc, 'two');
    await buildSystemDir(opts);
    expect(await fs.readFile(join(target, 'docs/kit.md'), 'utf8')).toBe('two');
    expect(await fs.readFile(join(target, '.source-hash'), 'utf8')).not.toBe(hash);
    await write(join(seedRoot, 'running/constitution/safety.md'), 'New safety instruction\n');
    await buildSystemDir(opts);
    expect(await fs.readFile(join(target, 'constitution.md'), 'utf8')).toContain('New safety instruction');
    expect((await fs.readdir(join(dataDir, 'system'))).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('rejects path traversal and missing inputs without replacing a working tree', async () => {
    const seedRoot = await makeSeed(); const dataDir = await tmpDir();
    const opts = { seedRoot, dataDir, pack: 'running', harnessVersion: '0.1.0' };
    const target = await buildSystemDir(opts);
    const original = await fs.readFile(join(target, '.source-hash'), 'utf8');
    await expect(buildSystemDir({ ...opts, pack: '../evil' })).rejects.toThrow(/invalid pack/);
    await expect(buildSystemDir({ ...opts, extraDocs: { '../../escaped': join(seedRoot, 'core/constitution.md') } })).rejects.toThrow(/invalid extraDocs/);
    await fs.rm(join(seedRoot, 'running/constitution/safety.md'));
    await expect(buildSystemDir(opts)).rejects.toThrow(/missing running constitution\/safety/);
    expect(await fs.readFile(join(target, '.source-hash'), 'utf8')).toBe(original);
  });
});
