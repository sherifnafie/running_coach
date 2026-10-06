import { copyFile, lstat, readFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { lastItemKind, lastUserText, makeHarness, send, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
async function athlete() {
  h = await makeHarness();
  return (await h.runtime.createAthlete({ displayName: 'Sam', coachName: 'Kip', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false })).id;
}
function coachDone(req: Parameters<Parameters<Harness['setHandler']>[0]>[0]) {
  const last = req.items.at(-1);
  return last?.kind === 'tool_results' && last.results.some((result) => result.name === 'send_message');
}

describe('helper worktree isolation [SUB-3] [SEC-2]', () => {
  it('discards an in-scope file symlink instead of following it during merge', async () => {
    const id = await athlete();
    h!.setHandler((req) => {
      if (lastUserText(req).includes('SYMLINK_TASK')) {
        return lastItemKind(req) === 'tool_results' ? { text: 'done' } : { toolCalls: [{ name: 'bash', input: { command: 'mkdir -p plan/drafts; ln -s ../../athlete/profile.md plan/drafts/stolen.md' } }] };
      }
      if (coachDone(req)) return { text: 'done' };
      if (lastItemKind(req) === 'tool_results') return send('Helper checked.');
      return { toolCalls: [{ name: 'spawn_agent', input: { task: 'SYMLINK_TASK', tools: ['bash'], write_scope: ['plan/drafts/**'] } }] };
    });
    await h!.runtime.ingest(id, { type: 'user.message', payload: { text: 'check symlink' } }); await h!.settle(id);
    await expect(lstat(join(h!.runtime.core.paths(id).workspace, 'plan/drafts/stolen.md'))).rejects.toThrow();
    expect(await readFile(join(h!.runtime.core.paths(id).workspace, 'athlete/profile.md'), 'utf8')).toContain('Sam');
  });

  it('merges a coherent helper DB by replacing a destination symlink without overwriting its target', async () => {
    const id = await athlete(); const ws = h!.runtime.core.paths(id).workspace;
    const main = join(ws, 'data/coach.db'); const privateDb = join(ws, 'athlete/private.db');
    const db = new DatabaseSync(main); db.exec("CREATE TABLE security_marker (value TEXT); INSERT INTO security_marker VALUES ('original')"); db.close();
    await copyFile(main, privateDb); await unlink(main); await symlink('../athlete/private.db', main);
    h!.setHandler((req) => {
      if (lastUserText(req).includes('DB_TASK')) {
        return lastItemKind(req) === 'tool_results' ? { text: 'updated helper DB' } : { toolCalls: [{ name: 'bash', input: { command: `python3 -c 'import sqlite3; db=sqlite3.connect("data/coach.db"); db.execute("UPDATE security_marker SET value=?", ("helper",)); db.commit()'` } }] };
      }
      if (coachDone(req)) return { text: 'done' };
      if (lastItemKind(req) === 'tool_results') return send('Database updated.');
      return { toolCalls: [{ name: 'spawn_agent', input: { task: 'DB_TASK', tools: ['bash'], write_scope: ['data/coach.db'] } }] };
    });
    await h!.runtime.ingest(id, { type: 'user.message', payload: { text: 'update database' } }); await h!.settle(id);
    expect((await lstat(main)).isSymbolicLink()).toBe(false);
    const merged = new DatabaseSync(main); expect(merged.prepare('SELECT value FROM security_marker').get()!.value).toBe('helper'); merged.close();
    const untouched = new DatabaseSync(privateDb); expect(untouched.prepare('SELECT value FROM security_marker').get()!.value).toBe('original'); untouched.close();
  });

  it('nested helpers read their parent worktree and cannot widen ancestor grants', async () => {
    const id = await athlete(); let outerStage = 0; let nestedRead = '';
    h!.setHandler((req) => {
      const text = lastUserText(req);
      if (text.includes('INNER_TASK')) {
        if (lastItemKind(req) === 'tool_results') {
          const last = req.items.at(-1)!;
          if (last.kind === 'tool_results') nestedRead = JSON.stringify(last.results);
          return { text: 'nested done' };
        }
        return { toolCalls: [{ name: 'read', input: { path: 'plan/drafts/parent.md' } }, { name: 'write', input: { path: 'athlete/profile.md', content: 'HIJACKED' } }] };
      }
      if (text.includes('OUTER_TASK')) {
        if (outerStage++ === 0) return { toolCalls: [{ name: 'write', input: { path: 'plan/drafts/parent.md', content: 'visible only in parent worktree' } }] };
        if (outerStage === 2) return { toolCalls: [{ name: 'spawn_agent', input: { task: 'INNER_TASK', tools: ['read', 'write'], write_scope: ['athlete/**', 'plan/drafts/**'] } }] };
        return { text: 'outer done' };
      }
      if (coachDone(req)) return { text: 'done' };
      if (lastItemKind(req) === 'tool_results') return send('Nested helper done.');
      return { toolCalls: [{ name: 'spawn_agent', input: { task: 'OUTER_TASK', tools: ['read', 'write', 'spawn_agent'], write_scope: ['plan/drafts/**'] } }] };
    });
    await h!.runtime.ingest(id, { type: 'user.message', payload: { text: 'run nested helpers' } }); await h!.settle(id);
    expect(nestedRead).toContain('visible only in parent worktree');
    expect(nestedRead).toContain('EOUTOFSCOPE');
    expect(await readFile(join(h!.runtime.core.paths(id).workspace, 'athlete/profile.md'), 'utf8')).not.toBe('HIJACKED');
  });
});
