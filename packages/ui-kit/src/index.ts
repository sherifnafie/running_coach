/**
 * @opencoach/ui-kit — Node-side entry: kit asset location + the Playwright preview renderer
 * (SPEC §9.6). Browser assets (web components, tokens, bridge client) are built to dist/kit.js and
 * dist/kit.css and served at <viewsUrl>/kit/<major>/.
 *
 * STUB: signatures are final; implementation provided by the UI kit work package.
 */
import type { UiRenderer } from '@opencoach/protocol';

const ni = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

/** Absolute path of the built kit directory (contains kit.js, kit.css, icons). Builds if missing. */
export async function kitDistDir(): Promise<string> {
  return ni('kitDistDir');
}

/** Absolute path of the coach-facing kit docs (ui-kit.md, bridge.md) to be placed in /system/docs. */
export function kitDocsDir(): string {
  return ni('kitDocsDir');
}

export interface PlaywrightRendererOptions {
  /** Chromium executable (defaults to Playwright's resolution via PLAYWRIGHT_BROWSERS_PATH). */
  executablePath?: string;
}

/** Headless-Chromium preview renderer implementing the publish gates (SPEC §9.6). */
export function createPlaywrightRenderer(opts?: PlaywrightRendererOptions): UiRenderer {
  void opts;
  return ni('createPlaywrightRenderer');
}
