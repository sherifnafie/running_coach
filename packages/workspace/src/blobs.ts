/**
 * Content-addressed blob store on disk (SPEC [WS-7]).
 *
 *   athlete / sync origins →  <raw>/<sha256>.<ext>  + <raw>/<sha256>.json sidecar   (visible at /raw, read-only)
 *   other origins          →  <blobs>/<sha[0:2]>/<sha256>                            (not visible to the coach)
 *
 * Bytes are immutable (written once, atomically, mode 0444). Metadata is also recorded in the Store;
 * `BlobRecord.relPath` is relative to the athlete root (`raw/<sha>.<ext>` or `blobs/<sha[0:2]>/<sha>`).
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ToolError, athletePaths, type AthletePaths, type BlobOrigin, type BlobRecord, type BlobStore, type Clock, type Store, type StoredBlob } from '@opencoach/protocol';
import { assertSafeId, atomicWriteFile, errCode, isWithin, pathExists, sha256Hex } from './fsutil';
import { baseMime, extForMime } from './mime';

const SHA = /^[a-f0-9]{64}$/;

export function isRawOrigin(origin: BlobOrigin): boolean {
  return origin === 'athlete' || origin === 'sync';
}

interface Sidecar {
  sha256: string;
  mime: string;
  bytes: number;
  name?: string;
  origin: BlobOrigin;
  uploadedAt: string;
  [k: string]: unknown;
}

export function createFsBlobStore(opts: { dataDir: string; store: Store; clock: Clock }): BlobStore {
  const { dataDir, store, clock } = opts;

  const pathsFor = (athleteId: string): AthletePaths => {
    assertSafeId('athlete id', athleteId);
    return athletePaths(dataDir, athleteId);
  };
  const checkSha = (sha: string): void => {
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new ToolError('INVALID_INPUT', 'sha256 must be 64 lowercase hex characters');
  };

  async function readSidecar(p: AthletePaths, sha: string): Promise<Sidecar | undefined> {
    try {
      return JSON.parse(await fsp.readFile(path.join(p.raw, `${sha}.json`), 'utf8')) as Sidecar;
    } catch {
      return undefined;
    }
  }

  /** Existing raw file for a sha (extension taken from the sidecar, else found by scanning). */
  async function findRaw(p: AthletePaths, sha: string): Promise<string | undefined> {
    const side = await readSidecar(p, sha);
    if (side) {
      const f = path.join(p.raw, `${sha}.${extForMime(side.mime)}`);
      if (await pathExists(f)) return f;
    }
    try {
      for (const name of await fsp.readdir(p.raw)) if (name.startsWith(`${sha}.`) && name !== `${sha}.json`) return path.join(p.raw, name);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
    return undefined;
  }

  async function locate(athleteId: string, sha: string): Promise<{ file: string; raw: boolean } | undefined> {
    const p = pathsFor(athleteId);
    const rec = await store.getBlob(athleteId, sha).catch(() => undefined);
    if (rec?.relPath) {
      const candidate = path.resolve(p.root, rec.relPath);
      if (isWithin(p.root, candidate) && (await pathExists(candidate))) return { file: candidate, raw: isRawOrigin(rec.origin) };
    }
    const raw = await findRaw(p, sha);
    if (raw) return { file: raw, raw: true };
    const other = path.join(p.blobs, sha.slice(0, 2), sha);
    if (await pathExists(other)) return { file: other, raw: false };
    return undefined;
  }

  return {
    async put(athleteId, data, meta) {
      const p = pathsFor(athleteId);
      const sha = sha256Hex(data);
      const mime = baseMime(meta.mime) || 'application/octet-stream';
      const raw = isRawOrigin(meta.origin);
      const createdAt = clock.now().toISOString();
      let file: string;
      let relPath: string;
      let existed = false;

      if (raw) {
        const existing = await findRaw(p, sha);
        if (existing) {
          existed = true;
          file = existing;
        } else {
          const ext = extForMime(mime);
          file = path.join(p.raw, `${sha}.${ext}`);
        }
        relPath = `raw/${path.basename(file)}`;
        if (!existed) await atomicWriteFile(file, data, { mode: 0o444 });
        const sidecarPath = path.join(p.raw, `${sha}.json`);
        if (!(await pathExists(sidecarPath))) {
          const sidecar: Sidecar = { sha256: sha, mime, bytes: data.byteLength, ...(meta.name !== undefined ? { name: meta.name } : {}), origin: meta.origin, uploadedAt: createdAt };
          for (const [k, v] of Object.entries(meta.extra ?? {})) if (!(k in sidecar)) sidecar[k] = v;
          await atomicWriteFile(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', { mode: 0o444 });
        }
      } else {
        file = path.join(p.blobs, sha.slice(0, 2), sha);
        relPath = `blobs/${sha.slice(0, 2)}/${sha}`;
        existed = await pathExists(file);
        if (!existed) await atomicWriteFile(file, data, { mode: 0o444 });
      }

      if (!(await store.getBlob(athleteId, sha).catch(() => undefined))) {
        const record: BlobRecord = {
          sha256: sha,
          mime,
          bytes: data.byteLength,
          ...(meta.name !== undefined ? { name: meta.name } : {}),
          athleteId,
          origin: meta.origin,
          createdAt,
          relPath,
          ...(meta.extra ? { meta: meta.extra } : {}),
        };
        await store.putBlob(record);
      }
      const stored: StoredBlob = { sha256: sha, mime, bytes: data.byteLength, ...(meta.name !== undefined ? { name: meta.name } : {}), path: file, existed };
      return stored;
    },

    async path(athleteId, sha256) {
      checkSha(sha256);
      return (await locate(athleteId, sha256))?.file;
    },

    async read(athleteId, sha256) {
      checkSha(sha256);
      const loc = await locate(athleteId, sha256);
      if (!loc) throw new ToolError('NOT_FOUND', `blob ${sha256} not found`);
      const buf = await fsp.readFile(loc.file);
      return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    },

    async delete(athleteId, sha256) {
      checkSha(sha256);
      const p = pathsFor(athleteId);
      const loc = await locate(athleteId, sha256);
      if (loc) {
        await fsp.rm(loc.file, { force: true });
        if (loc.raw) await fsp.rm(path.join(p.raw, `${sha256}.json`), { force: true });
        else await fsp.rmdir(path.dirname(loc.file)).catch(() => {});
      }
      await store.deleteBlob(athleteId, sha256);
    },
  };
}
