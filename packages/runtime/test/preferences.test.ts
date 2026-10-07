import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExecutor } from '../src/executor';
import { lastItemKind, lastUserText, makeHarness, send, type Harness } from './harness';
let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const athlete = { displayName: 'Sam', tz: 'UTC', locale: 'en', isAdmin: false };

describe('[UI-1] [SEC-2] persistent presentation preferences', () => {
  it('applies a coach request only to presentation, signals the athlete and replays once [RT-6]', async () => {
    h = await makeHarness();
    const { id } = await h.runtime.createAthlete(athlete);
    const other = await h.runtime.createAthlete(athlete);
    const before = await h.runtime.core.settings(id);
    const executor = createExecutor(h.runtime.core, {
      athleteId: id, turnId: 'preferences-test', triggerClass: 'reactive',
      agent: { kind: 'coach', depth: 0 }, tools: ['set_preferences'], fs: h.runtime.core.fsFor(id),
      sandbox: { exec: async () => { throw new Error('No shell needed'); } }, vision: false,
    });
    const call = { id: 'preferences-call', type: 'tool_call' as const, name: 'set_preferences', input: { locale: 'ar', theme: 'dark', accent: '#2563eb' } };
    const result = await executor.execute(call, new AbortController().signal);
    expect(result.isError).toBe(false);
    const after = await h.runtime.core.settings(id);
    expect(after).toEqual({ ...before, profile: { ...before.profile, locale: 'ar' }, appearance: { theme: 'dark', accent: '#2563eb' } });
    expect((await h.runtime.core.settings(other.id)).appearance).toEqual(before.appearance);
    expect(h.stream.filter(m => m.t === 'settings.changed')).toEqual([{ t: 'settings.changed' }]);
    await h.runtime.updateSettings(id, { appearance: { accent: '#047857' } });
    const replay = await executor.execute(call, new AbortController().signal);
    expect(replay).toEqual(result);
    expect((await h.runtime.core.settings(id)).appearance.accent).toBe('#047857');
  });

  it('rejects privileged patches, invalid locales/colors and helper access atomically', async () => {
    h = await makeHarness();
    const { id } = await h.runtime.createAthlete(athlete);
    const before = await h.runtime.core.settings(id);
    const create = (kind: 'coach' | 'helper') => createExecutor(h!.runtime.core, {
      athleteId: id, turnId: 'denial-test', triggerClass: 'reactive', agent: { kind, depth: kind === 'coach' ? 0 : 1 },
      tools: ['set_preferences'], fs: h!.runtime.core.fsFor(id), sandbox: { exec: async () => { throw new Error('No shell'); } }, vision: false,
    });
    const executor = create('coach');
    for (const [i, input] of [{ locale: 'nl', budgets: { dailyUsd: 999 } }, { locale: 'ar', notifications: { quietHours: null } }, { locale: 'not a locale' }, { accent: 'red;display:none' }, {}].entries()) {
      expect((await executor.execute({ type: 'tool_call', id: `bad-${i}`, name: 'set_preferences', input }, new AbortController().signal)).isError).toBe(true);
    }
    expect((await create('helper').execute({ type: 'tool_call', id: 'helper', name: 'set_preferences', input: { locale: 'ar' } }, new AbortController().signal)).isError).toBe(true);
    expect(await h.runtime.core.settings(id)).toEqual(before);
  });
});


it('[MOD-1] [SUB-1] a planner can save its scoped draft and use an explicit effort override', async () => {
  h = await makeHarness();
  const { id } = await h.runtime.createAthlete(athlete);
  h.setHandler((req) => {
    if (lastUserText(req).includes('PLANNER_DRAFT_PROBE')) return lastItemKind(req) === 'tool_results' ? { text: 'Draft saved.' } : { toolCalls: [{ name: 'write', input: { path: 'plan/drafts/check.md', content: 'Checked synthetic draft.' } }] };
    if (lastItemKind(req) !== 'tool_results') return { toolCalls: [{ name: 'spawn_agent', input: { profile: 'planner', task: 'PLANNER_DRAFT_PROBE: save the scoped draft', effort: 'low', write_scope: ['plan/drafts/check.md'] } }] };
    const last = req.items.at(-1)!;
    return last.kind === 'tool_results' && last.results.some(result => result.name === 'send_message') ? { text: 'Done.' } : send('Draft saved.');
  });
  await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'Make a short draft.' } });
  await h.settle(id);
  expect(await readFile(join(h.runtime.core.paths(id).workspace, 'plan/drafts/check.md'), 'utf8')).toBe('Checked synthetic draft.');
  expect(h.requests.find(req => lastUserText(req).includes('PLANNER_DRAFT_PROBE'))!.effort).toBe('low');
});
