import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo-relative locations, resolved from this file so they work from source (tsx) and in Docker
 * (the image keeps the monorepo layout under /app).
 */
const here = dirname(fileURLToPath(import.meta.url));

/** apps/server/src */
export const SERVER_SRC_DIR = here;
/** apps/server */
export const SERVER_DIR = resolve(here, '..');
/** Repository root. */
export const REPO_ROOT = resolve(here, '..', '..', '..');
/** Default seed directory (<repo>/seed). */
export const DEFAULT_SEED_ROOT = resolve(REPO_ROOT, 'seed');
/** Built PWA (apps/web/dist). */
export const DEFAULT_WEB_DIST = resolve(REPO_ROOT, 'apps', 'web', 'dist');
