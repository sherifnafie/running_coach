/**
 * @opencoach/ui-kit — Node-side entry: kit asset location + the Playwright preview renderer
 * (SPEC §9.6). Browser assets (web components, tokens, bridge client) are built to dist/kit.js and
 * dist/kit.css and served at <viewsUrl>/kit/<major>/.
 *
 * Build: `pnpm --filter @opencoach/ui-kit build` (kitDistDir() also builds on demand).
 */
import type { UiRenderer } from '@opencoach/protocol';
import { kitDistDir as kitDistDirImpl, kitDocsDir as kitDocsDirImpl, kitSourceDir as kitSourceDirImpl } from './node/assets';
import { PlaywrightRenderer, type PlaywrightRendererOptions as RendererOptions } from './node/renderer';

/** Absolute path of the built kit directory (contains kit.js, kit.css, icons). Builds if missing. */
export async function kitDistDir(): Promise<string> {
  return kitDistDirImpl();
}

/** Absolute path of the coach-facing kit docs (ui-kit.md, bridge.md, views.md) to be placed in /system/docs. */
export function kitDocsDir(): string {
  return kitDocsDirImpl();
}

export function kitSourceDir(): string {
  return kitSourceDirImpl();
}

export type PlaywrightRendererOptions = RendererOptions;

/** Headless-Chromium preview renderer implementing the publish gates (SPEC §9.6). */
export function createPlaywrightRenderer(opts?: PlaywrightRendererOptions): UiRenderer {
  return new PlaywrightRenderer(opts);
}

// ---- additional exports (reusable by the gateway / tools)
export { chromiumAvailable, chromiumExecutable, VARIANT_DEFS } from './node/renderer';
export { buildViewCsp, type CspOptions } from './node/server';
export { checkApp, checkViewStatic, scanSource, globMatch, type ViewStatic } from './node/static-checks';
export { readDbSchema, createEmptyDb, validateReadOnlySql, type DbSchema } from './node/sql';
