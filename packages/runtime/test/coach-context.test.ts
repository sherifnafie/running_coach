import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(req.tools.map(t => t.name)).toEqual(expect.arrayContaining(['read', 'write', 'bash', 'spawn_agent', 'web_search', 'web_fetch', 'preview_ui', 'publish_ui']));
    expect(situationText(req)).toContain('app views published:');
    expect(situationText(req)).toContain('research: web_search NOT CONFIGURED');
    expect(situationText(req)).toContain('configured model tiers:');
    expect(system).toContain('/system/skills/coach-identity/SKILL.md');
    expect(system).toContain('minor, optional personalization');
    expect(situationText(req)).toContain('optional image generation: NOT CONFIGURED');
    expect(situationText(req)).toContain('coach identity changes NOT ENABLED');
    expect(req.tools.map(t => t.name)).toContain('generate_image');
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
    expect(situation).toContain('web_search NOT CONFIGURED'); // config alone is not a wired backend
    expect(situation).toContain('web_fetch DISABLED');
    expect(situation).toContain('current model TEXT ONLY');
    expect(situation).toContain('image-capable helper tier(s): NONE');
    expect(situation).toContain('renderer NOT CONFIGURED');
    expect(JSON.stringify(req)).not.toContain('SERVER_ONLY_TEST_SECRET');
  });

  it.each([
    { profile: 'researcher', effort: 'low', model: 'scripted-fast' },
    { profile: 'deep-researcher', effort: 'high', model: 'scripted-coach' },
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
    expect(system).toContain('web_search configured');
    expect(system).toContain('publish_ui not granted');
    expect(JSON.stringify(helper)).not.toContain('PRIVATE_REQUEST_TEXT');
    expect(helper.tools.map(t => t.name)).toContain('write');
    expect(helper.tools.map(t => t.name).filter(name => ['send_message', 'schedule', 'publish_ui'].includes(name))).toEqual([]);
    expect(await readFile(join(h.runtime.core.paths(a.id).workspace, report), 'utf8')).toContain('https://example.org/source');
    expect(returned).toContain(report);
    const tasks = await h.runtime.core.store.listTasks(a.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ state: 'done', outputs: [`/workspace/${report}`] });
  });
});
