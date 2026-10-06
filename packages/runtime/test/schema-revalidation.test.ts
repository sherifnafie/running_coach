import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiRenderer } from '@opencoach/protocol';
import { readUiManifests } from '@opencoach/workspace';
import { lastItemKind, makeHarness, passRenderer, send, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('schema migration view revalidation [UI-3]', () => {
  it('replays a partially mutating timed-out command without executing it again [RT-6]', async () => {
    h = await makeHarness();
    const id = (await h.runtime.createAthlete({ displayName: 'Sam', coachName: 'Kip', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false })).id;
    let repeated = false;
    const call = { id: 'partial_timeout', name: 'bash', input: { command: "printf partial >> partial-mutations.txt; sleep 30", timeout_s: 1 } };
    h.setHandler((request) => {
      const last = request.items.at(-1);
      if (last?.kind === 'tool_results') {
        if (last.results.some((tool) => tool.name === 'send_message')) return { text: 'done' };
        expect(last.results[0]!.isError).toBe(true);
        if (!repeated) { repeated = true; return { toolCalls: [call] }; }
        return send('The command timed out.');
      }
      return { toolCalls: [call] };
    });
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'test partial timeout' } }); await h.settle(id);
    expect(await readFile(join(h.runtime.core.paths(id).workspace, 'partial-mutations.txt'), 'utf8')).toBe('partial');
  });

  for (const broken of [false, true]) {
    it(`${broken ? 'reports broken published views' : 'validates compatible migrations'} in the same bash result`, async () => {
      const previews: Array<{ workspaceDir: string; views: string[] }> = [];
      const renderer: UiRenderer = {
        async preview(input) {
          previews.push({ workspaceDir: input.workspaceDir, views: input.views });
          const report = await passRenderer.preview(input);
          const manifests = await readUiManifests(input.workspaceDir);
          const db = new DatabaseSync(join(input.workspaceDir, 'data/coach.db'), { readOnly: true });
          try {
            const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
            for (const view of report.views) {
              const missing = manifests.views[view.viewId]!.reads.filter((read) => read.startsWith('db:') && !tables.has(read.slice(3)));
              if (missing.length) { view.ok = false; view.runtimeErrors.push(`Missing table: ${missing.join(', ')}`); }
            }
            report.ok = report.views.every((view) => view.ok);
            return report;
          } finally { db.close(); }
        },
        async dispose() {},
      };
      h = await makeHarness({ renderer });
      const id = (await h.runtime.createAthlete({ displayName: 'Sam', coachName: 'Kip', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false })).id;
      let result = ''; let reportedFailure = false; let replayed = false;
      const sql = broken ? 'DROP TABLE planned_workouts' : 'ALTER TABLE planned_workouts ADD COLUMN audit_flag TEXT';
      const migrationCall = { id: 'migration_call', name: 'bash', input: { command: `printf 'mutation\\n' >> schema-mutations.txt; python3 -c 'import sqlite3; db=sqlite3.connect("data/coach.db"); db.execute("${sql}"); db.commit()'` } };
      h.setHandler((req) => {
        const last = req.items.at(-1);
        if (last?.kind === 'tool_results') {
          if (last.results.some((tool) => tool.name === 'send_message')) return { text: 'done' };
          const bash = last.results.find((tool) => tool.name === 'bash')!;
          const content = JSON.stringify(bash.content);
          if (replayed) expect(content).toBe(result);
          result = content; reportedFailure = bash.isError;
          if (!replayed) { replayed = true; return { toolCalls: [migrationCall] }; }
          return send('Migration reviewed.');
        }
        if (lastItemKind(req) !== 'tool_results') {
          return { toolCalls: [migrationCall] };
        }
        return { text: 'done' };
      });
      await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'Apply the schema migration' } }); await h.settle(id);
      expect(await readFile(join(h.runtime.core.paths(id).workspace, 'schema-mutations.txt'), 'utf8')).toBe('mutation\n');
      expect(previews).toHaveLength(2);
      expect(previews[0]!.workspaceDir).toBe(h.runtime.core.paths(id).workspace);
      expect(previews[1]!.workspaceDir).toContain('/schema-views/');
      expect(previews[0]!.views.sort()).toEqual(previews[1]!.views.sort());
      expect(result).toContain('View revalidation [UI-3]');
      expect(reportedFailure).toBe(broken);
      if (broken) expect(result).toContain('planned_workouts');
      else expect(result).toContain('passed');
      const versions = await h.runtime.core.store.getCurrentUiVersions(id);
      expect(versions.every((view) => view.version === '1')).toBe(true);
    });
  }
});
