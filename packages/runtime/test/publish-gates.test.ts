import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
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
