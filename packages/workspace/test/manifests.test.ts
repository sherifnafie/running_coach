import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { athletePaths } from '@opencoach/protocol';
import { copyPublishedView, ensureAthleteDirs, listSkills, readPinnedList, readUiManifests } from '../src';
import { tmpDir, write } from './helpers';

const view = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, title: id.toUpperCase(), reads: ['db:planned_workouts'], ...extra });

describe('readUiManifests', () => {
  it('reads app.json and valid views, applying schema defaults', async () => {
    const ws = await tmpDir('ui-');
    await write(path.join(ws, 'ui/app.json'), JSON.stringify({ version: 1, nav: ['today', 'plan'], home: 'today', theme: { accent: '#E4572E' } }));
    await write(path.join(ws, 'ui/views/today/view.json'), view('today', { placement: { nav: 0 }, writes: [{ db: 'planned_workouts', ops: ['update'], columns: ['status'] }] }));
    await write(path.join(ws, 'ui/views/plan/view.json'), view('plan'));
    await write(path.join(ws, 'ui/views/plan/index.html'), '<html></html>');
    const m = await readUiManifests(ws);
    expect(m.errors).toEqual([]);
    expect(m.app).toMatchObject({ version: 1, nav: ['today', 'plan'], home: 'today', theme: { accent: '#E4572E' } });
    expect(Object.keys(m.views).sort()).toEqual(['plan', 'today']);
    expect(m.views['plan']).toMatchObject({ id: 'plan', entry: 'index.html', kit: '1', icon: 'circle', refresh: 'on-change', placement: { hidden: true }, actions: [], writes: [] });
    expect(m.views['today']!.writes).toEqual([{ db: 'planned_workouts', ops: ['update'], columns: ['status'] }]);
  });

  it('collects validation errors instead of throwing', async () => {
    const ws = await tmpDir('ui-');
    await write(path.join(ws, 'ui/app.json'), JSON.stringify({ version: 2 }));
    await write(path.join(ws, 'ui/views/good/view.json'), view('good'));
    await write(path.join(ws, 'ui/views/wrong-dir/view.json'), view('other-id'));
    await write(path.join(ws, 'ui/views/broken/view.json'), '{ not json');
    await write(path.join(ws, 'ui/views/nomanifest/index.html'), '<html></html>');
    await write(path.join(ws, 'ui/views/toolong/view.json'), view('toolong', { title: 'x'.repeat(41) }));
    await write(path.join(ws, 'ui/views/badreads/view.json'), view('badreads', { reads: ['table:nope'] }));
    await write(path.join(ws, 'ui/views/Bad_Id/view.json'), JSON.stringify({ id: 'Bad_Id', title: 'x' }));
    const m = await readUiManifests(ws);
    expect(m.app).toBeNull();
    expect(Object.keys(m.views)).toEqual(['good']);
    const byPath = Object.fromEntries(m.errors.map((e) => [e.path, e.message]));
    expect(Object.keys(byPath).sort()).toEqual(['ui/app.json', 'ui/views/Bad_Id/view.json', 'ui/views/badreads/view.json', 'ui/views/broken/view.json', 'ui/views/nomanifest/view.json', 'ui/views/toolong/view.json', 'ui/views/wrong-dir/view.json']);
    expect(byPath['ui/views/wrong-dir/view.json']).toMatch(/"other-id" must equal its directory name "wrong-dir"/);
    expect(byPath['ui/views/broken/view.json']).toMatch(/invalid JSON/);
    expect(byPath['ui/views/nomanifest/view.json']).toBe('missing view.json');
    expect(byPath['ui/views/toolong/view.json']).toMatch(/title/);
    expect(byPath['ui/app.json']).toMatch(/version/);
  });

  it('returns an empty result when there is no ui directory', async () => {
    expect(await readUiManifests(await tmpDir('ui-'))).toEqual({ app: null, views: {}, errors: [] });
  });

  it('does not follow a symlinked view.json', async () => {
    const ws = await tmpDir('ui-');
    const outside = await tmpDir('outside-');
    await write(path.join(outside, 'view.json'), view('sneaky'));
    await fsp.mkdir(path.join(ws, 'ui/views/sneaky'), { recursive: true });
    await fsp.symlink(path.join(outside, 'view.json'), path.join(ws, 'ui/views/sneaky/view.json'));
    const m = await readUiManifests(ws);
    expect(m.views).toEqual({});
    expect(m.errors).toEqual([{ path: 'ui/views/sneaky/view.json', message: 'not a regular file' }]);
  });
});

describe('readPinnedList', () => {
  const read = async (content: string | null) => {
    const ws = await tmpDir('pin-');
    if (content !== null) await write(path.join(ws, 'AGENTS.md'), content);
    return readPinnedList(ws);
  };

  it('parses the front-matter pinned list in order (comments allowed)', async () => {
    expect(await read('---\npinned:            # loaded into every context\n  - coach/persona.md\n  - athlete/profile.md\n  - plan/current-week.md\n---\n\n# Workspace manual\n')).toEqual(['coach/persona.md', 'athlete/profile.md', 'plan/current-week.md']);
  });

  it('normalises prefixes, drops non-strings and duplicates', async () => {
    expect(await read('---\npinned:\n  - /workspace/a.md\n  - ./b.md\n  - /c.md\n  - 42\n  - a.md\n  - "  d.md  "\n---\n')).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  });

  it('is [] for a missing file, no front-matter, bad YAML, or a non-list', async () => {
    expect(await read(null)).toEqual([]);
    expect(await read('# no front matter\npinned:\n  - x.md\n')).toEqual([]);
    expect(await read('---\npinned: [unclosed\n---\n')).toEqual([]);
    expect(await read('---\npinned: just-a-string\n---\n')).toEqual([]);
    expect(await read('---\nother: 1\n---\n')).toEqual([]);
    expect(await read('---\r\npinned:\r\n  - win.md\r\n---\r\nbody')).toEqual(['win.md']);
  });
});

describe('listSkills', () => {
  it('reads front-matter from system and workspace skills with virtual paths', async () => {
    const sys = await tmpDir('sys-');
    const ws = await tmpDir('ws-');
    await write(path.join(sys, 'skills/intake/SKILL.md'), '---\nname: intake\ndescription: Conducting a coaching intake conversationally\n---\n# Intake');
    await write(path.join(sys, 'skills/zones/SKILL.md'), '---\nname: zones-and-paces\ndescription: >\n  Setting and using\n  intensity guidance\n---\nbody');
    await write(path.join(ws, 'skills/hill-repeats/SKILL.md'), '---\nname: hill-repeats\ndescription: My own hill session recipe\n---\nbody');
    await write(path.join(ws, 'skills/no-front-matter/SKILL.md'), '# Just text');
    await write(path.join(ws, 'skills/not-a-skill/readme.md'), 'ignored');
    await write(path.join(ws, 'skills/loose-file.md'), 'ignored');
    expect(await listSkills({ systemDir: sys, workspaceDir: ws })).toEqual([
      { name: 'intake', description: 'Conducting a coaching intake conversationally', path: '/system/skills/intake/SKILL.md', source: 'system' },
      { name: 'zones-and-paces', description: 'Setting and using intensity guidance', path: '/system/skills/zones/SKILL.md', source: 'system' },
      { name: 'hill-repeats', description: 'My own hill session recipe', path: '/workspace/skills/hill-repeats/SKILL.md', source: 'workspace' },
      { name: 'no-front-matter', description: '', path: '/workspace/skills/no-front-matter/SKILL.md', source: 'workspace' },
    ]);
  });

  it('is empty when the directories are missing', async () => {
    expect(await listSkills({ systemDir: await tmpDir('a-'), workspaceDir: await tmpDir('b-') })).toEqual([]);
  });
});

describe('copyPublishedView', () => {
  async function setup() {
    const dataDir = await tmpDir('pub-');
    const paths = athletePaths(dataDir, 'ath_pub');
    await ensureAthleteDirs(paths);
    await write(path.join(paths.workspace, 'ui/views/today/view.json'), view('today'));
    await write(path.join(paths.workspace, 'ui/views/today/index.html'), '<html>v1</html>');
    await write(path.join(paths.workspace, 'ui/views/today/assets/app.js'), 'console.log(1)');
    await write(path.join(paths.workspace, 'ui/views/today/.hidden'), 'dot');
    return paths;
  }

  it('copies the view into published/<id>/<version> and returns the dir', async () => {
    const paths = await setup();
    const dir = await copyPublishedView(paths, 'today', '1');
    expect(dir).toBe(path.join(paths.published, 'today', '1'));
    expect(await fsp.readFile(path.join(dir, 'index.html'), 'utf8')).toBe('<html>v1</html>');
    expect(await fsp.readFile(path.join(dir, 'assets/app.js'), 'utf8')).toBe('console.log(1)');
    expect(await fsp.readFile(path.join(dir, '.hidden'), 'utf8')).toBe('dot');
    expect((await fsp.readdir(path.join(paths.published, 'today'))).sort()).toEqual(['1']);
  });

  it('is immutable: a published version cannot be overwritten, and later edits do not leak in', async () => {
    const paths = await setup();
    await copyPublishedView(paths, 'today', '1');
    await write(path.join(paths.workspace, 'ui/views/today/index.html'), '<html>v2</html>');
    await expect(copyPublishedView(paths, 'today', '1')).rejects.toThrow(/immutable/);
    expect(await fsp.readFile(path.join(paths.published, 'today/1/index.html'), 'utf8')).toBe('<html>v1</html>');
    const v2 = await copyPublishedView(paths, 'today', '2');
    expect(await fsp.readFile(path.join(v2, 'index.html'), 'utf8')).toBe('<html>v2</html>');
  });

  it('never copies symlinks or .git, and validates ids and versions', async () => {
    const paths = await setup();
    const outside = await tmpDir('outside-');
    await write(path.join(outside, 'secret.txt'), 'secret');
    await fsp.symlink(path.join(outside, 'secret.txt'), path.join(paths.workspace, 'ui/views/today/leak.txt'));
    await fsp.symlink(outside, path.join(paths.workspace, 'ui/views/today/leakdir'));
    await write(path.join(paths.workspace, 'ui/views/today/.git/config'), 'x');
    const dir = await copyPublishedView(paths, 'today', '1');
    expect((await fsp.readdir(dir)).sort()).toEqual(['.hidden', 'assets', 'index.html', 'view.json']);
    await expect(copyPublishedView(paths, '../today', '1')).rejects.toThrow(/invalid view id/);
    await expect(copyPublishedView(paths, 'Today', '1')).rejects.toThrow(/invalid view id/);
    await expect(copyPublishedView(paths, 'today', '../1')).rejects.toThrow(/invalid view version/);
    await expect(copyPublishedView(paths, 'today', '')).rejects.toThrow(/invalid view version/);
    await expect(copyPublishedView(paths, 'missing', '1')).rejects.toThrow(/does not exist/);
  });
});
