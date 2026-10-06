#!/usr/bin/env node
/**
 * Builds the browser UI kit with esbuild:
 *   src/browser/kit.ts  -> dist/kit.js   (ESM, minified, es2022)
 *   src/browser/kit.css -> dist/kit.css  (minified, @imports inlined)
 *   src/browser/icons.json -> dist/icons.json (name -> inner SVG markup, for the shell's nav icons)
 *
 * Usage: `pnpm --filter @opencoach/ui-kit build`  or  `import { buildKit } from './build.mjs'`.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const KIT_MAX_JS_BYTES = 120 * 1024;

/** Newest mtime (ms) among the kit sources, used to detect a stale dist/. */
export async function newestSourceMtime() {
  let newest = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else newest = Math.max(newest, (await stat(p)).mtimeMs);
    }
  };
  await walk(join(here, 'src', 'browser'));
  newest = Math.max(newest, (await stat(join(here, 'build.mjs'))).mtimeMs);
  return newest;
}

/** Is dist/ missing or older than the sources? */
export async function kitIsStale(outDir = join(here, 'dist')) {
  let built;
  try {
    built = Math.min((await stat(join(outDir, 'kit.js'))).mtimeMs, (await stat(join(outDir, 'kit.css'))).mtimeMs);
    await stat(join(outDir, 'icons.json'));
  } catch {
    return true; // missing
  }
  try {
    return built < (await newestSourceMtime());
  } catch {
    return false; // sources not shipped (packaged install): trust the prebuilt dist
  }
}

/**
 * Build the kit into `outDir` (default packages/ui-kit/dist). Output is written to a temp dir
 * first and swapped in, so concurrent readers never see a half-built kit.
 * @returns {Promise<{ outDir: string, jsBytes: number, cssBytes: number }>}
 */
export async function buildKit(options = {}) {
  const outDir = resolve(options.outDir ?? join(here, 'dist'));
  const tmp = `${outDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmp, { recursive: true });
  try {
    const common = { absWorkingDir: here, logLevel: 'silent', legalComments: 'none', minify: true, bundle: true };
    const js = await build({
      ...common,
      entryPoints: ['src/browser/kit.ts'],
      outfile: join(tmp, 'kit.js'),
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      charset: 'utf8',
      metafile: false,
    });
    void js;
    await build({
      ...common,
      entryPoints: ['src/browser/kit.css'],
      outfile: join(tmp, 'kit.css'),
      target: ['chrome100', 'safari15', 'firefox100'],
      loader: { '.svg': 'dataurl' },
    });
    const icons = await readFile(join(here, 'src', 'browser', 'icons.json'), 'utf8');
    await writeFile(join(tmp, 'icons.json'), JSON.stringify(JSON.parse(icons)));
    const jsBytes = (await stat(join(tmp, 'kit.js'))).size;
    const cssBytes = (await stat(join(tmp, 'kit.css'))).size;
    if (jsBytes > KIT_MAX_JS_BYTES) {
      throw new Error(`kit.js is ${(jsBytes / 1024).toFixed(1)} KB, over the ${KIT_MAX_JS_BYTES / 1024} KB budget`);
    }
    await mkdir(dirname(outDir), { recursive: true });
    await rm(outDir, { recursive: true, force: true });
    await rename(tmp, outDir);
    return { outDir, jsBytes, cssBytes };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildKit()
    .then((r) => console.log(`kit built -> ${r.outDir}  kit.js ${(r.jsBytes / 1024).toFixed(1)} KB, kit.css ${(r.cssBytes / 1024).toFixed(1)} KB`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
