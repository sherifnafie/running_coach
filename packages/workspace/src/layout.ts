import { promises as fsp } from 'node:fs';
import type { AthletePaths } from '@opencoach/protocol';

/** mkdir -p every directory in AthletePaths. */
export async function ensureAthleteDirs(paths: AthletePaths): Promise<void> {
  const dirs = [paths.root, paths.workspace, paths.raw, paths.blobs, paths.history, paths.snapshots, paths.published, paths.exports, paths.tmp, paths.calls];
  for (const d of dirs) await fsp.mkdir(d, { recursive: true });
}
