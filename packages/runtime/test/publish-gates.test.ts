import { join } from 'node:path';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { makeHarness } from './harness';

it('[SEC-3] SPEC §9.6 refuses publication without a browser renderer and preserves the served seed version', async () => {
  const h = await makeHarness();
  try {
    const athlete = await h.runtime.createAthlete({ displayName: 'Sam', tz: 'UTC', locale: 'en', isAdmin: false });
    h.runtime.core.deps.renderer = undefined;
    await appendFile(join(h.runtime.core.paths(athlete.id).workspace, 'ui/views/today/index.html'), '\n<!-- changed -->\n');
    const result = await h.runtime.core.ui.publish(athlete.id, ['today'], 'update');
    expect(result.ok).toBe(false);
    expect(result.report?.globalErrors.join(' ')).toContain('unavailable');
    expect((await h.runtime.views.appInfo(athlete.id)).views.find((v) => v.manifest.id === 'today')?.version).toBe('1');
  } finally { await h.close(); }
});

it('[UI-1] compares inherited libraries and skips unchanged selections without emitting alerts or versions', async () => {
  const h = await makeHarness();
  try {
    const athlete = await h.runtime.createAthlete({ displayName: 'Sam', tz: 'UTC', locale: 'en', isAdmin: false });
    const ui = h.runtime.core.ui;
    const ws = h.runtime.core.paths(athlete.id).workspace;
    expect(await ui.changedViews(athlete.id)).toEqual([]);
    const noChange = await ui.publish(athlete.id, ['today', 'calendar', 'plan', 'progress'], 'No actual changes');
    expect(noChange.ok).toBe(true);
    if (!noChange.ok) throw new Error(noChange.message);
    expect(noChange.published).toEqual([]);
    expect(await h.events(athlete.id, ['coach.ui_published'])).toEqual([]);
    await appendFile(join(ws, 'ui/views/calendar/index.html'), '\n<!-- week default -->\n');
    expect(await ui.changedViews(athlete.id)).toEqual(['calendar']);
    const change = await ui.publish(athlete.id, ['today', 'calendar', 'plan', 'progress'], 'Calendar change');
    if (!change.ok) throw new Error(change.message);
    expect(change.published).toEqual([{ viewId: 'calendar', version: '2' }]);
    expect(await h.events(athlete.id, ['coach.ui_published'])).toHaveLength(1);
    expect(await ui.changedViews(athlete.id)).toEqual([]);
    const unknown = await ui.publish(athlete.id, ['does-not-exist'], 'Invalid selection');
    expect(unknown.ok).toBe(false);
  } finally { await h.close(); }
});

it('[UI-1, SEC-3] detects shared library changes/deletions and respects a screen-local library override', async () => {
  const h = await makeHarness();
  try {
    const athlete = await h.runtime.createAthlete({ displayName: 'Sam', tz: 'UTC', locale: 'en', isAdmin: false });
    const ui = h.runtime.core.ui; const ws = h.runtime.core.paths(athlete.id).workspace;
    await mkdir(join(ws, 'ui/views/today/lib'), { recursive: true });
    await writeFile(join(ws, 'ui/views/today/lib/local.js'), '// local override');
    await ui.publish(athlete.id, ['today'], 'Own library');
    await writeFile(join(ws, 'ui/lib/new.js'), '// shared change');
    expect(await ui.changedViews(athlete.id)).toEqual(['calendar', 'plan', 'progress']);
    await ui.publish(athlete.id, undefined, 'Shared change');
    expect(await ui.changedViews(athlete.id)).toEqual([]);
    await rm(join(ws, 'ui/lib/new.js'));
    expect(await ui.changedViews(athlete.id)).toEqual(['calendar', 'plan', 'progress']);
    await ui.publish(athlete.id, undefined, 'Removed shared file');
    expect(await ui.changedViews(athlete.id)).toEqual([]);
  } finally { await h.close(); }
});
