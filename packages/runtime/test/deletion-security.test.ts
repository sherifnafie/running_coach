import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as workspace from '@opencoach/workspace';
import { makeHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); h = undefined; });
async function setup() {
  h = await makeHarness();
  const id = (await h.runtime.createAthlete({ displayName: 'Sam', coachName: 'Kip', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false })).id;
  await h.runtime.core.sandboxFor(id);
  return id;
}

describe('retryable hard deletion [SEC-6]', () => {
  it('keeps the account and files when stopping the sandbox fails, then retries the retained handle', async () => {
    const id = await setup();
    const release = vi.spyOn(h!.runtime.core.deps.sandbox, 'release').mockRejectedValueOnce(new Error('daemon refused removal'));
    await expect(h!.runtime.deleteAthlete(id)).rejects.toThrow('daemon refused removal');
    expect(await h!.runtime.core.store.getAthlete(id)).toBeDefined();
    const paths = h!.runtime.core.paths(id);
    expect(await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')).toContain('Sam');
    await h!.runtime.deleteAthlete(id);
    expect(release).toHaveBeenCalledTimes(2);
    expect(await h!.runtime.core.store.getAthlete(id)).toBeUndefined();
    await expect(stat(paths.root)).rejects.toThrow();
  });

  it('keeps account ownership when filesystem removal fails, then completes a safe retry', async () => {
    const id = await setup();
    const remove = vi.spyOn(workspace, 'deleteAthleteData').mockRejectedValueOnce(new Error('disk removal failed'));
    await expect(h!.runtime.deleteAthlete(id)).rejects.toThrow('disk removal failed');
    expect(await h!.runtime.core.store.getAthlete(id)).toBeDefined();
    expect((await stat(h!.runtime.core.paths(id).root)).isDirectory()).toBe(true);
    await h!.runtime.deleteAthlete(id);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await h!.runtime.core.store.getAthlete(id)).toBeUndefined();
    await expect(stat(h!.runtime.core.paths(id).root)).rejects.toThrow();
  });
});
