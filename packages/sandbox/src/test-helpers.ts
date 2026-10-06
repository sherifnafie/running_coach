import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxMounts } from '@opencoach/protocol';

export interface TestDirs {
  root: string;
  mounts: SandboxMounts;
  cleanup: () => void;
}

/** Fresh host directories for the four athlete mounts, with a few seed files. */
export function makeDirs(prefix = 'oc-sbx-test-', base: string = tmpdir()): TestDirs {
  const root = mkdtempSync(join(base, prefix));
  const mounts: SandboxMounts = { workspace: join(root, 'workspace'), raw: join(root, 'raw'), history: join(root, 'history'), system: join(root, 'system') };
  for (const d of Object.values(mounts)) mkdirSync(d, { recursive: true });
  writeFileSync(join(mounts.raw, 'upload.txt'), 'raw-bytes\n');
  writeFileSync(join(mounts.history, 'day.md'), '# history\n');
  writeFileSync(join(mounts.system, 'constitution.md'), 'be kind\n');
  writeFileSync(join(mounts.workspace, 'AGENTS.md'), '# agents\n');
  return { root, mounts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
