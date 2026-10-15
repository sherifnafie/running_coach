import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSituation, type SituationInput } from '../src/situation';
import { ensureEpoch } from '../src/context';
import { lastItemKind, lastUserText, makeHarness, send, situationText, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const athlete = { displayName: 'Sam', coachName: 'Kip', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false };

describe('coach context delivered to the model [CTX-1, SUB-3, UI-1]', () => {
  it('delivers product context, rendered memory, discoverable skills and actual tool schemas', async () => {
    h = await makeHarness();
    const a = await h.runtime.createAthlete(athlete);
    h.setHandler(req => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Ready.'));
    await h.runtime.ingest(a.id, { type: 'user.message', payload: { text: 'What can you do here?' } });
    await h.settle(a.id);
    const req = h.requests[0]!;
    const system = req.system.map(b => b.text).join('\n');
    expect(system).toContain('OpenCoach');
    expect(system).toContain('Kip');
    expect(system).toContain('Sam');
    expect(system).not.toMatch(/\{\{\s*[a-z_]+\s*\}\}/);
    expect(system).toContain('/workspace/AGENTS.md');
    expect(system).toContain('/workspace/athlete/profile.md');
    expect(system).toContain('/system/skills/research/SKILL.md');
    expect(system).toContain('/system/skills/ui-kit/SKILL.md');
    expect(req.tools.map(t => t.name)).toEqual(expect.arrayContaining(['read', 'write', 'bash', 'spawn_agent', 'web_fetch', 'preview_ui', 'publish_ui']));
    // a tool whose service isn't wired is not offered at all, and the report says why
    expect(req.tools.map(t => t.name)).not.toContain('web_search');
    expect(req.tools.map(t => t.name)).not.toContain('generate_image');
    expect(situationText(req)).toContain('app views published:');
    expect(situationText(req)).toMatch(/not available on this server: [^\n]*web_search/);
    expect(situationText(req)).toContain('configured model tiers:');
    expect(situationText(req)).not.toMatch(/wall.time|remaining time|turn limits:|\d+s each|reactive head turn/);
    expect(system).toContain('/system/skills/coach-identity/SKILL.md');
    expect(system).toContain('minor, optional personalization');
    expect(system).toContain('/system/skills/image-generation/SKILL.md');
    expect(situationText(req)).toContain('image generation: not configured');
    expect(situationText(req)).toContain('name/avatar changes NOT ENABLED');
    const context = await h.runtime.core.store.getTurnContext(req.metadata!.turnId!);
    expect(JSON.stringify(context)).toContain('OpenCoach');
  });

  it('reports missing services and vision honestly without exposing configured credentials', async () => {
    h = await makeHarness({
      renderer: null, capabilities: { vision: false },
      config: { web: { search: { provider: 'brave', apiKey: 'SERVER_ONLY_TEST_SECRET' }, fetch: { enabled: false } } },
    });
    const a = await h.runtime.createAthlete(athlete);
    h.setHandler(req => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Limitations noted.'));
    await h.runtime.ingest(a.id, { type: 'user.message', payload: { text: 'Can you research and inspect screenshots?' } });
    await h.settle(a.id);
    const req = h.requests[0]!;
    const situation = situationText(req);
    // config alone is not a wired backend
    expect(situation).toMatch(/not available on this server: [^\n]*web_search/);
    expect(situation).toMatch(/not available on this server: [^\n]*web_fetch/);
    expect(situation).toMatch(/not available on this server: [^\n]*preview_ui/);
    expect(req.tools.map(t => t.name).filter(n => ['web_search', 'web_fetch', 'preview_ui', 'publish_ui'].includes(n))).toEqual([]);
    expect(situation).toContain('current model TEXT ONLY');
    expect(situation).toContain('image-capable helper tier(s): NONE');
    expect(JSON.stringify(req)).not.toContain('SERVER_ONLY_TEST_SECRET');
  });

  it('[CTX-1] reports service additions/removals once per athlete without consolidation grant noise', async () => {
    h = await makeHarness();
    const a = await h.runtime.createAthlete(athlete);
    const b = await h.runtime.createAthlete({ ...athlete, displayName: 'Alex' });
    const core = h.runtime.core;
    const input: SituationInput = {
      athleteId: a.id, settings: await core.store.getSettings(a.id), cls: 'reactive', triggers: [],
      model: core.deps.router.route('coach')[0]!, tools: ['read', 'send_message'],
      epoch: { localDate: '2026-10-07', seq: 1 }, pinned: { tokens: 0, cap: 12000, missing: [], truncated: [] },
      replyRequired: true, proactive: false, limits: { maxSteps: 60, maxWallMs: 600000 }, firstContact: false,
    };
    expect(await buildSituation(core, input)).not.toContain('tools changed');
    expect(await buildSituation(core, { ...input, cls: 'consolidation', tools: ['read'] })).not.toContain('tools changed');
    core.deps.webSearch = { kind: 'searxng', async search() { return []; } };
    expect(await buildSituation(core, { ...input, tools: ['read', 'web_search'] })).toContain('tools changed since your last turn: now available web_search');
    expect(await buildSituation(core, input)).not.toContain('tools changed');
    // A new athlete has no previous service set; another athlete's history is not theirs.
    expect(await buildSituation(core, { ...input, athleteId: b.id, settings: await core.store.getSettings(b.id) })).not.toContain('tools changed');
    core.deps.webSearch = undefined;
    expect(await buildSituation(core, input)).toContain('tools changed since your last turn: no longer available web_search');
    expect(await buildSituation(core, input)).not.toContain('tools changed');
  });

  it('[CTX-1] detects newly enabled search on upgrade before a tool ledger existed', async () => {
    h = await makeHarness();
    const a = await h.runtime.createAthlete(athlete);
    h.setHandler(req => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Ready.'));
    await h.runtime.ingest(a.id, { type: 'user.message', payload: { text: 'Hello.' } });
    await h.settle(a.id);
    const store = h.runtime.core.store;
    const get = store.getKv.bind(store);
    const spy = vi.spyOn(store, 'getKv').mockImplementation(key => key === `tools-seen:${a.id}` ? Promise.resolve(undefined) : get(key));
    h.runtime.core.deps.webSearch = { kind: 'searxng', async search() { return []; } };
    try {
      await h.runtime.ingest(a.id, { type: 'user.message', payload: { text: 'Anything changed?' } });
      await h.settle(a.id);
      expect(situationText(h.requests.at(-1)!)).toContain('tools changed since your last turn: now available web_search');
    } finally { spy.mockRestore(); }
  });

  it.each(['old-release', undefined])('[CTX-1, WS-9] replaces a cached constitution on upgrade (previous version %s)', async version => {
    h = await makeHarness();
    const a = await h.runtime.createAthlete(athlete);
    h.setHandler(req => lastItemKind(req) === 'tool_results' ? { text: 'done' } : send('Ready.'));
    await h.runtime.ingest(a.id, { type: 'user.message', payload: { text: 'Remember my request before the upgrade.' } });
    await h.settle(a.id);
    const core = h.runtime.core;
    const old = (await core.store.getOpenEpoch(a.id))!;
    const key = `epoch-system:${old.id}`;
    const snapshot = JSON.parse((await core.store.getKv(key))!);
    snapshot.harnessVersion = version;
    await core.store.setKv(key, JSON.stringify(snapshot));
    const path = join(core.systemDir, 'constitution.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\nUPGRADED_CONSTITUTION_FIXTURE\n`);
    const next = await ensureEpoch(core, a.id, core.deps.router.route('coach')[0]!);
    expect(next.epoch.id).not.toBe(old.id);
    expect((await core.store.getEpoch(old.id))?.closeReason).toBe('forced');
    const system = next.system.map(b => b.text).join('\n');
    expect(system).toContain('UPGRADED_CONSTITUTION_FIXTURE');
    expect(system).toContain('Remember my request before the upgrade.');
    // No repeated reset on the same version.
    expect((await ensureEpoch(core, a.id, core.deps.router.route('coach')[0]!)).epoch.id).toBe(next.epoch.id);
  });

  it('[SUB-3] retains image references in helper audit context without duplicating image bytes', async () => {
    h = await makeHarness();
    const a = await h.runtime.createAthlete(athlete);
    const path = '/workspace/fixture.png';
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgWBUKQhAKABqeA/24RcKwAAAAAElFTkSuQmCC';
    await writeFile(join(h.runtime.core.paths(a.id).workspace, 'fixture.png'), Buffer.from(png, 'base64'));
    let sentImage = '';
    h.setHandler(req => {
      for (const item of req.items) if (item.kind === 'user') for (const part of item.parts) if (part.type === 'image') sentImage = part.data;
      return { text: 'Inspected the supplied fixture.' };
    });
    await h.runtime.core.helpers.spawn({ athleteId: a.id, turnId: 'image-parent', depth: 0 }, { task: 'Inspect the supplied image.', inputs: [path], tools: ['read'] });
    expect(sentImage.length).toBeGreaterThan(20);
    const [turn] = await h.runtime.core.store.listTurns({ athleteId: a.id, agent: 'helper' });
    const context = JSON.stringify(await h.runtime.core.store.getTurnContext(turn!.id));
    expect(context).toContain(path);
    expect(context).toContain('bytes omitted from stored helper context');
    expect(context).not.toContain(sentImage);
  });

  it.each([
    { profile: 'researcher', effort: 'low', model: 'scripted-fast' },
    { profile: 'deep-researcher', effort: 'max', model: 'scripted-coach' },
  ])('lets $profile retrieve a source and persist a scoped report with the correct context', async ({ profile, effort, model }) => {
    h = await makeHarness({ webSearch: {
      kind: 'test', async search() { return [{ title: 'Primary source', url: 'https://example.org/source', snippet: 'Source excerpt for an offline fixture.' }]; },
    } });
    const a = await h.runtime.createAthlete(athlete);
    let helperStep = 0;
    const report = 'research/context-check.md';
    let returned = '';
    h.setHandler(req => {
      if (lastUserText(req).includes('RESEARCH_CONTEXT_TASK')) {
        if (helperStep++ === 0) return { toolCalls: [
          { name: 'read', input: { path: '/system/skills/research/SKILL.md' } },
          { name: 'web_search', input: { query: 'generic running research' } },
        ] };
        if (helperStep === 2) return { toolCalls: [{ name: 'write', input: { path: report, content: '# Offline fixture findings\n\nPrimary source: https://example.org/source\nSource excerpt for an offline fixture.\n' } }] };
        return { text: `Saved ${report}. Fixture evidence only.` };
      }
      if (lastItemKind(req) === 'tool_results') {
        const last = req.items.at(-1)!;
        if (last.kind === 'tool_results' && last.results.some(r => r.name === 'send_message')) return { text: 'done' };
        returned = JSON.stringify(last);
        return send('Report saved.');
      }
      return { toolCalls: [{ name: 'spawn_agent', input: { profile, task: 'RESEARCH_CONTEXT_TASK: save a cited offline source summary.', budget_usd: 0.1 } }] };
    });
    await h.runtime.ingest(a.id, { type: 'user.message', payload: { text: 'PRIVATE_REQUEST_TEXT: please check a general research question.' } });
    await h.settle(a.id);
    const helper = h.requests.find(req => lastUserText(req).includes('RESEARCH_CONTEXT_TASK'))!;
    expect(helper.model).toBe(model);
    expect(helper.effort).toBe(effort);
    const system = helper.system.map(b => b.text).join('\n');
    expect(system).toContain('OpenCoach');
    expect(system).toContain('now: 2026-10-07T08:00:00.000Z');
    expect(system).toContain('Europe/Amsterdam');
    expect(system).not.toMatch(/wall.time|remaining time|\d+s each|reactive head turn/);
    expect(helper.tools.map(t => t.name)).toContain('web_search');
    expect(system).not.toContain('publish_ui');
    expect(JSON.stringify(helper)).not.toContain('PRIVATE_REQUEST_TEXT');
    expect(helper.tools.map(t => t.name)).toContain('write');
    expect(helper.tools.map(t => t.name).filter(name => ['send_message', 'schedule', 'publish_ui'].includes(name))).toEqual([]);
    expect(await readFile(join(h.runtime.core.paths(a.id).workspace, report), 'utf8')).toContain('https://example.org/source');
    expect(returned).toContain(report);
    const tasks = await h.runtime.core.store.listTasks(a.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ state: 'done', outputs: [`/workspace/${report}`] });
    const [turn] = await h.runtime.core.store.listTurns({ athleteId: a.id, agent: 'helper' });
    const trace = JSON.stringify(await h.runtime.core.store.getTurnContext(turn!.id));
    expect(trace).toContain('RESEARCH_CONTEXT_TASK');
    expect(trace).toContain('tool_results');
    expect(trace).toContain('web_search');
    expect(trace).toContain('Saved research/context-check.md');
    expect(trace).not.toContain('PRIVATE_REQUEST_TEXT');
  });
});
