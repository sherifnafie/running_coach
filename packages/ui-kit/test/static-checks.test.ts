import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkApp, checkViewStatic, globMatch, scanSource } from '../src/node/static-checks';
import { readDbSchema } from '../src/node/sql';
import { makeWorkspace } from './helpers/workspace';
import { buildViewCsp, chromiumAvailable, chromiumExecutable, kitDocsDir } from '../src/index';
import { readFile } from 'node:fs/promises';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kit-static-')); makeWorkspace(dir, { data: 'empty' }); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('[UI-3] view static validation and assets', () => {
  it('validates every seed manifest against the real starter schema', async () => {
    const app = await checkApp(dir);
    expect(app.errors).toEqual([]);
    expect(app.app?.nav).toEqual(['today', 'calendar', 'plan', 'progress']);
    const schema = readDbSchema(join(dir, 'data', 'coach.db'));
    for (const id of app.existingViews) {
      const view = await checkViewStatic(dir, id, schema);
      expect(view.errors, id).toEqual([]);
      expect(view.fatal).toBe(false);
      expect(view.bundleKb).toBeLessThan(500);
    }
    for (const doc of ['ui-kit.md', 'bridge.md', 'views.md']) expect((await readFile(join(kitDocsDir(), doc), 'utf8')).length).toBeGreaterThan(500);
  });

  it('reports missing references and schema drift before rendering', async () => {
    const manifest = { id: 'today', title: 'Today', entry: 'missing.html', reads: ['db:missing_table'], writes: [{ db: 'activities', ops: ['update'], columns: ['missing_col'] }] };
    await writeFile(join(dir, 'ui/views/today/view.json'), JSON.stringify(manifest));
    const result = await checkViewStatic(dir, 'today', readDbSchema(join(dir, 'data/coach.db')));
    expect(result.fatal).toBe(true);
    expect(result.errors.join('\n')).toContain('missing.html');
    expect(result.errors.join('\n')).toContain('missing_table');
    expect(result.errors.join('\n')).toContain('missing_col');
  });

  it('blocks external/inline code, preserves declared glob scope, and emits the production CSP', () => {
    expect(scanSource('index.html', '<script>alert(1)</script><img onerror="x()" src="https://bad.test/x">')).toHaveLength(3);
    expect(scanSource('view.js', "import 'https://bad.test/x.js'; fetch('https://bad.test/api')")).toHaveLength(2);
    expect(scanSource('view.css', '@import "https://bad.test/x.css";')).toHaveLength(1);
    expect(globMatch('plan/*.md', 'plan/current.md')).toBe(true);
    expect(globMatch('plan/*.md', 'plan/private/current.md')).toBe(false);
    expect(globMatch('plan/**/*.md', 'plan/current.md')).toBe(true);
    expect(buildViewCsp({ kitOrigin: 'https://views.test', appOrigin: 'https://app.test' })).toContain("connect-src 'none'; frame-ancestors https://app.test");
    expect(chromiumAvailable('/not/a/browser')).toBe(false);
    expect(chromiumExecutable('/not/a/browser')).toBeUndefined();
  });
});
