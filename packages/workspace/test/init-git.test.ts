import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { athletePaths } from '@opencoach/protocol';
import { HARNESS_GIT_EMAIL, initWorkspace, openWorkspaceGit, renderPlaceholders } from '../src';
import { clockAt, makeSeed, tmpDir, write } from './helpers';

const VARS = { athlete_name: 'Sam "Q" Runner', coach_name: 'Coach Kai', voice_id: 'alloy', created_date: '2026-10-07' };

async function freshWorkspace(extra?: Record<string, string | Uint8Array>) {
  const seed = await makeSeed(extra ? { workspaceFiles: extra } : {});
  const dataDir = await tmpDir('data-');
  const paths = athletePaths(dataDir, 'ath_init');
  const clock = clockAt('2026-10-07T08:00:00.000Z');
  const { commit } = await initWorkspace({ paths, seedRoot: seed, pack: 'running', vars: VARS, clock });
  return { seed, dataDir, paths, clock, commit, ws: paths.workspace };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8' });

describe('initWorkspace', () => {
  it('copies the seed (dotfiles, .gitkeep, binaries) and renders placeholders in text files only', async () => {
    const { ws } = await freshWorkspace();
    expect(await fsp.readFile(path.join(ws, 'coach/persona.md'), 'utf8')).toBe('# Persona\nName: Coach Kai\nSpoken voice: alloy\n');
    expect(await fsp.readFile(path.join(ws, 'athlete/profile.md'), 'utf8')).toContain('Created 2026-10-07');
    const agents = await fsp.readFile(path.join(ws, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('workspace as Sam "Q" Runner\'s coach');
    expect(agents).toContain('{{not_a_var}}'); // unknown placeholders untouched
    expect(await fsp.readFile(path.join(ws, '.notes.md'), 'utf8')).toBe('dot md Sam "Q" Runner\n'); // dotfiles are copied (and rendered when text)
    expect(await fsp.readFile(path.join(ws, '.hidden'), 'utf8')).toBe('dotfile {{athlete_name}}\n'); // no text extension → verbatim
    // binary (.png) is copied byte-for-byte, even though it contains "{{"
    expect([...(await fsp.readFile(path.join(ws, 'logo.png')))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x7b, 0x7b]);
    for (const keep of ['athlete-input/.gitkeep', 'skills/.gitkeep', 'data/dump/.gitkeep']) expect((await fsp.stat(path.join(ws, keep))).isFile()).toBe(true);
  });

  it('escapes values for the syntax of the file they land in', async () => {
    const { ws } = await freshWorkspace();
    const app = JSON.parse(await fsp.readFile(path.join(ws, 'ui/app.json'), 'utf8')); // would throw if the quote broke the JSON
    expect(app.owner).toBe('Sam "Q" Runner');
    expect(await fsp.readFile(path.join(ws, 'ui/views/today/index.html'), 'utf8')).toContain('Sam &quot;Q&quot; Runner');
    expect(renderPlaceholders("x = '{{a}}'", { a: "it's" }, '.js')).toBe("x = 'it\\u0027s'");
    expect(renderPlaceholders("INSERT '{{a}}'", { a: "it's" }, '.sql')).toBe("INSERT 'it''s'");
    expect(renderPlaceholders('{{ a }} {{b}}', { a: '$&' }, '.md')).toBe('$& {{b}}');
  });

  it('writes .gitignore and keeps coach.db out of git', async () => {
    const { ws } = await freshWorkspace();
    expect(await fsp.readFile(path.join(ws, '.gitignore'), 'utf8')).toBe('data/coach.db\ndata/coach.db-*\ntmp/\n__pycache__/\n*.pyc\n.DS_Store\n');
    const tracked = git(ws, 'ls-files').split('\n');
    expect(tracked).toContain('data/migrations/0001_init.sql');
    expect(tracked).toContain('.gitignore');
    expect(tracked).not.toContain('data/coach.db');
  });

  it('creates coach.db from migrations, in order, recording _migrations', async () => {
    const { ws } = await freshWorkspace({ 'data/migrations/0002_more.sql': 'CREATE TABLE extra (x INTEGER);', 'data/migrations/0010_late.sql': 'CREATE TABLE late (x INTEGER);' });
    const db = new DatabaseSync(path.join(ws, 'data/coach.db'), { readOnly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(['activities', 'planned_workouts', 'checkins', 'metrics', 'extra', 'late', '_migrations']));
      const applied = (db.prepare('SELECT name FROM _migrations ORDER BY rowid').all() as Array<{ name: string }>).map((r) => r.name);
      expect(applied).toEqual(['0001_init.sql', '0002_more.sql', '0010_late.sql']);
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('rolls back and leaves no db when a migration fails', async () => {
    const seed = await makeSeed({ workspaceFiles: { 'data/migrations/0002_bad.sql': 'CREATE TABLE ok (x); THIS IS NOT SQL;' } });
    const dataDir = await tmpDir('data-');
    const paths = athletePaths(dataDir, 'ath_bad');
    await expect(initWorkspace({ paths, seedRoot: seed, pack: 'running', vars: VARS, clock: clockAt() })).rejects.toThrow(/0002_bad\.sql/);
    await expect(fsp.stat(path.join(paths.workspace, 'data/coach.db'))).rejects.toThrow();
  });

  it('makes the seed commit with harness identity, clock date and Kind trailer', async () => {
    const { ws, commit, clock } = await freshWorkspace();
    expect(git(ws, 'rev-parse', 'HEAD').trim()).toBe(commit);
    expect(git(ws, 'branch', '--show-current').trim()).toBe('main');
    expect(git(ws, 'log', '-1', '--format=%an|%ae|%cn|%ce|%aI|%cI').trim()).toBe(`OpenCoach Harness|${HARNESS_GIT_EMAIL}|OpenCoach Harness|${HARNESS_GIT_EMAIL}|${clock.now().toISOString().replace('.000Z', '+00:00')}|${clock.now().toISOString().replace('.000Z', '+00:00')}`);
    expect(git(ws, 'log', '-1', '--format=%B').trim()).toBe('seed: initial workspace\n\nKind: seed');
    expect(git(ws, 'config', '--local', 'user.name').trim()).toBe('OpenCoach Harness');
    expect(git(ws, 'config', '--local', 'commit.gpgsign').trim()).toBe('false');
    expect(git(ws, 'status', '--porcelain')).toBe('');
  });

  it('refuses to initialise twice', async () => {
    const { seed, paths, clock } = await freshWorkspace();
    await expect(initWorkspace({ paths, seedRoot: seed, pack: 'running', vars: VARS, clock })).rejects.toThrow(/already a git repository/);
  });
});

describe('WorkspaceGit', () => {
  it('commitAll appends trailers, returns CommitInfo, and returns null when clean', async () => {
    const { ws, clock, commit } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    expect(await g.head()).toBe(commit);
    expect(await g.commitAll('nothing changed')).toBeNull();

    clock.advanceBy(60_000);
    await write(path.join(ws, 'journal/2026/10/07.md'), 'ran easy\n');
    const info = await g.commitAll('turn: journal entry', { 'Turn-Id': 'turn_01ABC', Kind: 'turn' });
    expect(info).not.toBeNull();
    expect(info!.message).toBe('turn: journal entry');
    expect(info!.trailers).toEqual({ 'Turn-Id': 'turn_01ABC', Kind: 'turn' });
    expect(info!.files).toEqual(['journal/2026/10/07.md']);
    expect(info!.at).toBe('2026-10-07T08:01:00.000Z');
    expect(await g.head()).toBe(info!.commit);
    expect(git(ws, 'log', '-1', '--format=%B').trim()).toBe('turn: journal entry\n\nTurn-Id: turn_01ABC\nKind: turn');
    expect(git(ws, 'log', '-1', '--format=%ae').trim()).toBe(HARNESS_GIT_EMAIL);
  });

  it('commitAll rejects invalid trailer keys and flattens multi-line values', async () => {
    const { ws, clock } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    await write(path.join(ws, 'a.txt'), 'a');
    await expect(g.commitAll('x', { 'bad key': 'v' })).rejects.toThrow(/trailer/);
    const info = await g.commitAll('multi\n\nbody line', { Note: 'line1\nline2' });
    expect(info!.message).toBe('multi\n\nbody line');
    expect(info!.trailers).toEqual({ Note: 'line1 line2' });
  });

  it('a subject that looks like "key: value" is not parsed as a trailer', async () => {
    const { ws, clock } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    const [seed] = await g.log({ limit: 1 });
    expect(seed!.message).toBe('seed: initial workspace');
    expect(seed!.trailers).toEqual({ Kind: 'seed' });
  });

  it('log: newest first, files, paging with before, paths filter', async () => {
    const { ws, clock } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    const shas: string[] = [];
    for (let i = 1; i <= 5; i++) {
      clock.advanceBy(1000);
      await write(path.join(ws, i % 2 ? 'odd.txt' : 'even.txt'), `v${i}\n`);
      shas.push((await g.commitAll(`commit ${i}`, { N: String(i) }))!.commit);
    }
    const first = await g.log({ limit: 2 });
    expect(first.map((c) => c.message)).toEqual(['commit 5', 'commit 4']);
    expect(first[0]!.files).toEqual(['odd.txt']);
    const next = await g.log({ limit: 2, before: first[1]!.commit });
    expect(next.map((c) => c.message)).toEqual(['commit 3', 'commit 2']);
    const rest = await g.log({ limit: 50, before: next[1]!.commit });
    expect(rest.map((c) => c.message)).toEqual(['commit 1', 'seed: initial workspace']);
    expect(await g.log({ limit: 5, before: rest[1]!.commit })).toEqual([]); // before the root commit
    const odd = await g.log({ limit: 10, paths: ['odd.txt'] });
    expect(odd.map((c) => c.message)).toEqual(['commit 5', 'commit 3', 'commit 1']);
    await expect(g.log({ limit: 1, before: 'nonexistent-ref' })).rejects.toThrow();
    await expect(g.log({ limit: 1, before: '--output=/tmp/x' })).rejects.toThrow(/invalid git revision/);
  });

  it('log survives multi-line messages with odd characters and non-ASCII file names', async () => {
    const { ws, clock } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    await write(path.join(ws, 'notes/läuft schön.md'), 'x');
    await write(path.join(ws, 'weird "quote".txt'), 'y');
    const info = await g.commitAll('Fix: odd\n\nSecond paragraph with : colons\n- bullet', { Kind: 'turn' });
    const [c] = await g.log({ limit: 1 });
    expect(c!.message).toBe('Fix: odd\n\nSecond paragraph with : colons\n- bullet');
    expect(c!.files.sort()).toEqual(['notes/läuft schön.md', 'weird "quote".txt']);
    expect(c!.commit).toBe(info!.commit);
  });

  it('status lists uncommitted changes including untracked files', async () => {
    const { ws, clock } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    expect(await g.status()).toEqual([]);
    await write(path.join(ws, 'plan/current-week.md'), 'changed');
    await write(path.join(ws, 'new/dir/file.md'), 'new');
    await fsp.rm(path.join(ws, 'HEARTBEAT.md'));
    expect(await g.status()).toEqual(['HEARTBEAT.md', 'new/dir/file.md', 'plan/current-week.md']);
  });

  it('show returns content at a commit or undefined', async () => {
    const { ws, clock, commit } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    await write(path.join(ws, 'plan/current-week.md'), 'second');
    const info = (await g.commitAll('update plan'))!;
    expect(await g.show(commit, 'plan/current-week.md')).toBe('No plan yet.\n');
    expect(await g.show(info.commit, 'plan/current-week.md')).toBe('second');
    expect(await g.show(commit, 'nope.md')).toBeUndefined();
    expect(await g.show(commit, 'plan')).toBeUndefined(); // a directory
    expect(await g.show('deadbeef', 'plan/current-week.md')).toBeUndefined();
    await expect(g.show('HEAD', '../etc/passwd')).rejects.toThrow(/invalid workspace path/);
    await expect(g.show('HEAD', '.git/config')).rejects.toThrow(/\.git/);
  });

  describe('restorePaths', () => {
    it('restores modified files, resurrects deleted ones, and deletes files that did not exist then', async () => {
      const { ws, clock, commit } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      await write(path.join(ws, 'plan/current-week.md'), 'edited');
      await fsp.rm(path.join(ws, 'HEARTBEAT.md'));
      await write(path.join(ws, 'later/new.md'), 'added later');
      const info = (await g.commitAll('lots of changes'))!;
      await g.restorePaths(['plan/current-week.md', 'HEARTBEAT.md', 'later/new.md'], commit);
      expect(await fsp.readFile(path.join(ws, 'plan/current-week.md'), 'utf8')).toBe('No plan yet.\n');
      expect(await fsp.readFile(path.join(ws, 'HEARTBEAT.md'), 'utf8')).toBe('# Daily heartbeat\n');
      await expect(fsp.stat(path.join(ws, 'later/new.md'))).rejects.toThrow();
      await expect(fsp.stat(path.join(ws, 'later'))).rejects.toThrow(); // emptied directory pruned
      const restored = (await g.commitAll('undo', { Kind: 'undo' }))!;
      expect(restored.files.sort()).toEqual(['HEARTBEAT.md', 'later/new.md', 'plan/current-week.md']);
      expect(info.commit).not.toBe(restored.commit);
    });

    it('supports directories (restores contents, removes extra files, keeps ignored files)', async () => {
      const { ws, clock, commit } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      await write(path.join(ws, 'ui/views/today/index.html'), 'changed');
      await write(path.join(ws, 'ui/views/today/extra.js'), 'extra');
      await fsp.rm(path.join(ws, 'ui/app.json'));
      await write(path.join(ws, 'data/schema.md'), 'changed schema');
      await g.commitAll('edits');
      await write(path.join(ws, 'ui/views/today/untracked.css'), 'u');
      await g.restorePaths(['ui', 'data'], commit);
      expect(await fsp.readFile(path.join(ws, 'ui/views/today/index.html'), 'utf8')).toContain('<!doctype html>');
      await expect(fsp.stat(path.join(ws, 'ui/views/today/extra.js'))).rejects.toThrow();
      await expect(fsp.stat(path.join(ws, 'ui/views/today/untracked.css'))).rejects.toThrow();
      expect((await fsp.stat(path.join(ws, 'ui/app.json'))).isFile()).toBe(true);
      expect(await fsp.readFile(path.join(ws, 'data/schema.md'), 'utf8')).toBe('# Schema\n');
      // the git-ignored live database is never touched
      expect((await fsp.stat(path.join(ws, 'data/coach.db'))).isFile()).toBe(true);
      expect(await g.status()).not.toContain('data/coach.db');
    });

    it('rejects traversal, .git and unknown commits, and never follows symlinked parents', async () => {
      const { ws, clock, commit } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      await expect(g.restorePaths(['../outside'], commit)).rejects.toThrow(/invalid workspace path/);
      await expect(g.restorePaths(['.git/config'], commit)).rejects.toThrow(/\.git/);
      await expect(g.restorePaths(['.'], commit)).rejects.toThrow(/invalid workspace path/);
      await expect(g.restorePaths(['HEARTBEAT.md'], 'deadbeefdeadbeef')).rejects.toThrow(/unknown git commit/);
      const outside = await tmpDir('outside-');
      await write(path.join(outside, 'victim.txt'), 'precious');
      await fsp.symlink(outside, path.join(ws, 'linked'));
      await expect(g.restorePaths(['linked/victim.txt'], commit)).rejects.toThrow(/symbolic link/);
      expect(await fsp.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('precious');
    });
  });

  describe('revertOutside', () => {
    it('reverts changes to files outside the globs and keeps the ones inside', async () => {
      const { ws, clock } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      await write(path.join(ws, 'plan/drafts/a.md'), 'draft'); // inside (untracked)
      await write(path.join(ws, 'plan/current-week.md'), 'tampered'); // outside (tracked, modified)
      await write(path.join(ws, 'athlete/new.md'), 'sneaky'); // outside (untracked)
      await fsp.rm(path.join(ws, 'HEARTBEAT.md')); // outside (tracked, deleted)
      await write(path.join(ws, 'ui/.hidden-in-scope'), 'dot'); // inside via dot:true
      const reverted = await g.revertOutside(['plan/drafts/**', 'ui/**']);
      expect(reverted).toEqual(['HEARTBEAT.md', 'athlete/new.md', 'plan/current-week.md']);
      expect(await fsp.readFile(path.join(ws, 'plan/current-week.md'), 'utf8')).toBe('No plan yet.\n');
      expect(await fsp.readFile(path.join(ws, 'HEARTBEAT.md'), 'utf8')).toBe('# Daily heartbeat\n');
      await expect(fsp.stat(path.join(ws, 'athlete/new.md'))).rejects.toThrow();
      expect(await fsp.readFile(path.join(ws, 'plan/drafts/a.md'), 'utf8')).toBe('draft');
      expect(await g.status()).toEqual(['plan/drafts/a.md', 'ui/.hidden-in-scope']);
    });

    it('handles staged additions/deletions and an empty glob list (nothing allowed)', async () => {
      const { ws, clock } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      await write(path.join(ws, 'staged.md'), 'staged');
      git(ws, 'add', 'staged.md');
      git(ws, 'rm', '-q', 'HEARTBEAT.md');
      const reverted = await g.revertOutside([]);
      expect(reverted).toEqual(['HEARTBEAT.md', 'staged.md']);
      expect(await g.status()).toEqual([]);
      expect(git(ws, 'status', '--porcelain')).toBe('');
    });

    it('reports nothing when every change is inside the scope, and accepts /workspace-prefixed globs', async () => {
      const { ws, clock } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      await write(path.join(ws, 'journal/x.md'), 'j');
      expect(await g.revertOutside(['/workspace/journal/**'])).toEqual([]);
      expect(await g.status()).toEqual(['journal/x.md']);
    });

    it('never follows a symlink when deleting an untracked outside file', async () => {
      const { ws, clock } = await freshWorkspace();
      const g = openWorkspaceGit(ws, clock);
      const outside = await tmpDir('outside-');
      await write(path.join(outside, 'victim.txt'), 'precious');
      await fsp.symlink(path.join(outside, 'victim.txt'), path.join(ws, 'link-to-victim'));
      expect(await g.revertOutside([])).toEqual(['link-to-victim']);
      expect(await fsp.readFile(path.join(outside, 'victim.txt'), 'utf8')).toBe('precious');
    });
  });

  it('foreignCommitsSince reports only commits not authored by the harness', async () => {
    const { ws, clock, commit } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    await write(path.join(ws, 'a.md'), 'a');
    const mine = (await g.commitAll('mine'))!;
    await write(path.join(ws, 'hand-edit.md'), 'hand');
    git(ws, 'add', '-A');
    execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-q', '-m', 'edited by hand', '--no-verify'], { cwd: ws, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    await write(path.join(ws, 'b.md'), 'b');
    await g.commitAll('mine again');
    const foreign = await g.foreignCommitsSince(commit);
    expect(foreign.map((c) => c.message)).toEqual(['edited by hand']);
    expect(foreign[0]!.files).toEqual(['hand-edit.md']);
    expect(await g.foreignCommitsSince(mine.commit)).toHaveLength(1);
    expect(await g.foreignCommitsSince(await g.head())).toEqual([]);
  });

  it('ignores hooks and user git config planted in the repo', async () => {
    const { ws, clock } = await freshWorkspace();
    const marker = path.join(await tmpDir('marker-'), 'ran');
    await write(path.join(ws, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
    await fsp.chmod(path.join(ws, '.git/hooks/pre-commit'), 0o755);
    const g = openWorkspaceGit(ws, clock);
    await write(path.join(ws, 'a.md'), 'a');
    await g.commitAll('with hook present');
    await expect(fsp.stat(marker)).rejects.toThrow();
  });

  it('serialises concurrent commitAll calls', async () => {
    const { ws, clock } = await freshWorkspace();
    const g = openWorkspaceGit(ws, clock);
    const results = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        await write(path.join(ws, `c${i}.md`), String(i));
        return g.commitAll(`concurrent ${i}`);
      }),
    );
    const committed = results.filter(Boolean);
    expect(committed.length).toBeGreaterThanOrEqual(1);
    expect(await g.status()).toEqual([]);
    expect((await g.log({ limit: 20 })).length).toBeGreaterThanOrEqual(2);
  });
});
