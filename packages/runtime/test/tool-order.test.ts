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

it('[RT-4] [RT-10] a reply written next to a slow tool is delivered without waiting for it', async () => {
  h = await makeHarness({ config: { limits: { debounceIdleMs: 0, reactiveMaxWallMs: 4_000 } } });
  const { id } = await h.runtime.createAthlete(athlete);
  h.setHandler((req) => (lastItemKind(req) === 'tool_results' ? { text: 'Done.' } : {
    toolCalls: [
      { name: 'bash', input: { command: 'sleep 30' } },
      { name: 'send_message', input: { text: 'On it, give me a moment.' } },
    ],
  }));
  await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'Can you crunch my numbers?' } });
  await h.settle(id);
  const events = await h.runtime.core.store.listEvents({ athleteId: id, types: ['coach.message', 'harness.notice'] });
  expect(events.filter((e) => e.type === 'coach.message').map((e) => (e.payload as { text: string }).text)).toEqual(['On it, give me a moment.']);
  expect(events.some((e) => e.type === 'harness.notice' && (e.payload as { kind: string }).kind === 'reply_fallback')).toBe(false);
}, 60_000);

it('[RT-10] a queued write does not run after the turn hit its time limit', async () => {
  h = await makeHarness({ config: { limits: { debounceIdleMs: 0, reactiveMaxWallMs: 4_000 } } });
  const { id } = await h.runtime.createAthlete(athlete);
  let calls = 0;
  h.setHandler(() => (++calls === 1 ? {
    toolCalls: [
      { name: 'bash', input: { command: 'sleep 30' } },
      { name: 'write', input: { path: 'late.md', content: 'written after the turn ended' } },
    ],
  } : send('Sorry, that took too long.')));
  await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'Crunch it.' } });
  await h.settle(id);
  await expect(readFile(join(h.runtime.core.paths(id).workspace, 'late.md'), 'utf8')).rejects.toThrow();
}, 60_000);
