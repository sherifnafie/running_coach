import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKit, kitIsStale } from '../../build.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let building: Promise<string> | undefined;

/** Absolute path of the built kit directory (kit.js, kit.css, icons.json). Builds if missing or stale. */
export async function kitDistDir(): Promise<string> {
  const dir = join(pkgRoot, 'dist');
  if (!(await kitIsStale(dir))) return dir;
  building ??= buildKit({ outDir: dir })
    .then((r) => r.outDir)
    .finally(() => {
      building = undefined;
    });
  return building;
}

/** Absolute path of the coach-facing kit docs (ui-kit.md, bridge.md, views.md). */
export function kitDocsDir(): string {
  return join(pkgRoot, 'docs');
}

/** The kit's readable browser source, shown to the coach so it can copy and change any component. */
export function kitSourceDir(): string {
  return join(pkgRoot, 'src', 'browser');
}
