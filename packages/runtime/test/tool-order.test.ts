import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lastItemKind, makeHarness, send, type Harness } from './harness';
let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const athlete = { displayName: 'Sam', tz: 'UTC', locale: 'en', isAdmin: false };

it('[RT-10] two edits to one file in the same step both land, in written order', async () => {
  h = await makeHarness();
  const { id } = await h.runtime.createAthlete(athlete);
  const file = join(h.runtime.core.paths(id).workspace, 'notes.md');
  await writeFile(file, 'alpha\nbeta\n');
  h.setHandler((req) => {
    if (lastItemKind(req) !== 'tool_results') {
      return {
        toolCalls: [
          { name: 'edit', input: { path: 'notes.md', old: 'alpha', new: 'ALPHA' } },
          { name: 'edit', input: { path: 'notes.md', old: 'beta', new: 'BETA' } },
          { name: 'edit', input: { path: 'notes.md', old: 'ALPHA\nBETA', new: 'ALPHA\nBETA\ngamma' } },
        ],
      };
    }
    const last = req.items.at(-1)!;
    return last.kind === 'tool_results' && last.results.some((r) => r.name === 'send_message') ? { text: 'Done.' } : send('Updated.');
  });
  await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'Update my notes.' } });
  await h.settle(id);
  expect(await readFile(file, 'utf8')).toBe('ALPHA\nBETA\ngamma\n');
});
