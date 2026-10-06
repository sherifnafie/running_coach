import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualClock, PREVIEW_VARIANTS } from '@opencoach/protocol';
import { chromiumAvailable, createPlaywrightRenderer, kitDistDir } from '../src/index';
import { makeWorkspace, NOW } from './helpers/workspace';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe.skipIf(!chromiumAvailable())('[UI-1] [UI-3] Chromium seed view publish gates', () => {
  it.each(['empty', 'sample'] as const)('renders all four views against %s data and empty fixture', async (data) => {
    const dir = await mkdtemp(join(tmpdir(), 'kit-render-'));
    dirs.push(dir);
    makeWorkspace(dir, { data });
    const renderer = createPlaywrightRenderer({ clock: new VirtualClock(NOW), env: { locale: 'en-GB', tz: 'Europe/Amsterdam' } });
    try {
      const report = await renderer.preview({ athleteId: 'test-athlete', workspaceDir: dir, views: ['today', 'calendar', 'plan', 'progress'],
        kitDir: await kitDistDir(), outDir: join(dir, 'screenshots') });
      expect(report.globalErrors).toEqual([]);
      for (const view of report.views) {
        expect(view.staticErrors, view.viewId).toEqual([]);
        expect(view.runtimeErrors, view.viewId).toEqual([]);
        expect(view.cspViolations, view.viewId).toEqual([]);
        expect(view.a11y.critical, view.viewId).toBe(0);
        expect(view.perf.firstRenderMs, view.viewId).toBeLessThanOrEqual(1500);
        expect(view.screenshots.map(s => s.variant), view.viewId).toEqual([...PREVIEW_VARIANTS]);
        expect(view.ok, JSON.stringify(view)).toBe(true);
      }
      if (data === 'sample') {
        const today = report.views.find(v => v.viewId === 'today');
        const shot = today?.screenshots.find(s => s.variant === 'phone-light');
        expect(shot).toBeDefined();
        const png = await readFile(shot!.path);
        expect(png.readUInt32BE(20), 'full-page screenshot includes content below the viewport').toBeGreaterThan(844);
      }
      expect(report.ok).toBe(true);
    } finally { await renderer.dispose(); }
  }, 180_000);

  it('refuses publication when view JS throws and when Chromium is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kit-bad-render-'));
    dirs.push(dir);
    makeWorkspace(dir, { data: 'empty' });
    await writeFile(join(dir, 'ui/views/today/view.js'), "import { coach } from '/kit/1/kit.js'; await coach.ready; fetch('/blocked').catch(() => {}); throw new Error('broken view');");
    const renderer = createPlaywrightRenderer({ clock: new VirtualClock(NOW) });
    const unavailable = createPlaywrightRenderer({ executablePath: '/not/a/browser' });
    const input = { athleteId: 'test-athlete', workspaceDir: dir, views: ['today'], kitDir: await kitDistDir(), outDir: join(dir, 'screenshots') };
    try {
      const broken = await renderer.preview(input);
      expect(broken.ok).toBe(false);
      expect(broken.views[0]?.runtimeErrors.join('\n')).toContain('broken view');
      expect(broken.views[0]?.cspViolations.join('\n')).toContain('connect-src');
      const missing = await unavailable.preview(input);
      expect(missing.ok).toBe(false);
      expect(missing.views[0]?.runtimeErrors.join('\n')).toContain('Chromium is unavailable');
    } finally { await renderer.dispose(); await unavailable.dispose(); }
  }, 60_000);
});
