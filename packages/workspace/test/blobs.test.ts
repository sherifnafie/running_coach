import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsBlobStore } from '../src';
import { clockAt, newFakeStore, pathsFor, tmpDir } from './helpers';

async function setup() {
  const dataDir = await tmpDir(); const { fake, store } = newFakeStore(); const clock = clockAt();
  return { dataDir, fake, clock, blobs: createFsBlobStore({ dataDir, store, clock }) };
}

describe('immutable content-addressed blobs [WS-7] [SEC-6]', () => {
  it('stores athlete bytes read-only with content hash and immutable provenance sidecar', async () => {
    const { dataDir, fake, clock, blobs } = await setup();
    const bytes = Buffer.from('upload bytes');
    const saved = await blobs.put('ath_1', bytes, { mime: 'image/png; charset=binary', name: 'watch.png', origin: 'athlete', extra: { device: 'watch', sha256: 'override' } });
    expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(saved.existed).toBe(false);
    expect(saved.path).toBe(join(pathsFor(dataDir, 'ath_1').raw, `${saved.sha256}.png`));
    expect((await fs.stat(saved.path)).mode & 0o777).toBe(0o444);
    const sidecar = join(pathsFor(dataDir, 'ath_1').raw, `${saved.sha256}.json`);
    const provenance = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    expect(provenance).toMatchObject({ sha256: saved.sha256, mime: 'image/png', uploadedAt: clock.now().toISOString(), device: 'watch', name: 'watch.png' });
    await clock.advanceBy(1000);
    expect((await blobs.put('ath_1', bytes, { mime: 'image/jpeg', origin: 'athlete', name: 'second.jpg' })).existed).toBe(true);
    expect(JSON.parse(await fs.readFile(sidecar, 'utf8'))).toEqual(provenance);
    expect((await fake.getBlob('ath_1', saved.sha256))!.name).toBe('watch.png');
    expect(Buffer.from(await blobs.read('ath_1', saved.sha256))).toEqual(bytes);
  });

  it('keeps derived bytes outside raw and isolates athletes sharing a hash', async () => {
    const { dataDir, blobs } = await setup();
    const saved = await blobs.put('ath_1', Buffer.from('chart'), { mime: 'image/png', origin: 'coach' });
    expect(saved.path).toBe(join(pathsFor(dataDir, 'ath_1').blobs, saved.sha256.slice(0, 2), saved.sha256));
    expect(await blobs.path('ath_2', saved.sha256)).toBeUndefined();
    await expect(blobs.read('ath_2', saved.sha256)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await blobs.put('ath_2', Buffer.from('chart'), { mime: 'image/png', origin: 'athlete' });
    await blobs.delete('ath_1', saved.sha256);
    expect(Buffer.from(await blobs.read('ath_2', saved.sha256)).toString()).toBe('chart');
  });

  it('deletes bytes, sidecar and metadata, and rejects invalid paths and hashes', async () => {
    const { blobs, fake } = await setup();
    const saved = await blobs.put('ath_1', Buffer.from('raw'), { mime: 'text/plain', origin: 'sync' });
    await blobs.delete('ath_1', saved.sha256);
    expect(await blobs.path('ath_1', saved.sha256)).toBeUndefined();
    expect(await fake.getBlob('ath_1', saved.sha256)).toBeUndefined();
    await expect(fs.stat(saved.path)).rejects.toThrow();
    await expect(blobs.read('ath_1', '../outside')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(blobs.put('../escape', Buffer.from('x'), { mime: 'text/plain', origin: 'athlete' })).rejects.toThrow(/invalid athlete/);
  });
});
