import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { athletePaths, VirtualClock } from '../packages/protocol/src';
import { buildSystemDir, initWorkspace, listSkills, readPinnedList, readUiManifests } from '../packages/workspace/src';
import { parseFrontMatter } from '../packages/workspace/src/frontmatter';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const seedRoot = join(root, 'seed');
const packRoot = join(seedRoot, 'running');
const requiredSkills = [
  'calendar-export', 'data-hygiene', 'environment', 'file-import', 'fueling-basics',
  'illness-return', 'injury-and-pain', 'intake', 'plan-design', 'race-prep', 'research',
  'screenshot-extraction', 'strength-mobility', 'training-load', 'ui-kit', 'zones-and-paces',
];
const tables = ['activities', 'activity_gear', 'blocks', 'checkins', 'gear', 'metrics', 'planned_workouts', 'races'];
const stamp = '2026-10-06T07:00:00+02:00';

describe('running seed pack (Appendix D)', () => {
  let temp: string;
  let workspace: string;
  let system: string;

  beforeAll(async () => {
    await fs.mkdir(join(root, 'work'), { recursive: true });
    temp = await fs.mkdtemp(join(root, 'work', 'seed-test-'));
    const paths = athletePaths(temp, 'ath_seed');
    await initWorkspace({
      paths, seedRoot, pack: 'running', clock: new VirtualClock(stamp),
      vars: { athlete_name: 'Sam Runner', coach_name: 'Kai', voice_id: 'alloy', created_date: '2026-10-06' },
    });
    workspace = paths.workspace;
    system = await buildSystemDir({ dataDir: temp, seedRoot, pack: 'running', harnessVersion: 'seed-test' });
  });

  afterAll(async () => { if (temp) await fs.rm(temp, { recursive: true, force: true }); });

  it('[WS-2] initializes a self-describing pack with existing, rendered pinned files', async () => {
    const pack = JSON.parse(await fs.readFile(join(packRoot, 'pack.json'), 'utf8'));
    expect(pack).toMatchObject({ id: 'running', name: 'Running' });
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    const agents = await fs.readFile(join(workspace, 'AGENTS.md'), 'utf8');
    expect(parseFrontMatter(agents).error).toBeUndefined();
    expect(agents).toContain('Sam Runner');
    expect(agents).not.toMatch(/\{\{\w+\}\}/);
    for (const section of ['Map', 'Conventions', 'Open threads']) expect(agents).toContain(`## ${section}`);
    const pinned = await readPinnedList(workspace);
    expect(pinned).toEqual(['coach/persona.md', 'athlete/profile.md', 'plan/current-week.md']);
    for (const file of pinned) {
      const text = await fs.readFile(join(workspace, file), 'utf8');
      expect(text.trim().length, file).toBeGreaterThan(0);
      expect(text, file).not.toMatch(/\{\{\w+\}\}/);
    }
    expect((await Promise.all(pinned.map((file) => fs.readFile(join(workspace, file), 'utf8')))).join('').length).toBeLessThan(12_000);
  });

  it('[WS-1] applies the real migration, documents every column and preserves unknown/provenance defaults', async () => {
    const db = new DatabaseSync(join(workspace, 'data/coach.db'));
    try {
      const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name").all().map((r) => r.name);
      expect(actual).toEqual(tables);
      expect(db.prepare('SELECT name, applied_at FROM _migrations').all()).toMatchObject([{ name: '0001_init.sql', applied_at: '2026-10-06T05:00:00.000Z' }]);
      const doc = await fs.readFile(join(workspace, 'data/schema.md'), 'utf8');
      for (const table of tables) {
        expect(doc, table).toContain(`\`${table}\``);
        for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) expect(doc, `${table}.${String(row.name)}`).toMatch(new RegExp(`\\b${String(row.name)}\\b`));
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0);
      }
      db.prepare('INSERT INTO activities(id, started_at, source, created_at, updated_at) VALUES(?,?,?,?,?)').run('unknown', stamp, 'manual', stamp, stamp);
      expect(db.prepare('SELECT distance_m, duration_s, avg_hr, rpe, source_refs, confirmed FROM activities WHERE id=?').get('unknown')).toMatchObject({ distance_m: null, duration_s: null, avg_hr: null, rpe: null, source_refs: '[]', confirmed: 0 });
      db.prepare('DELETE FROM activities WHERE id=?').run('unknown');
    } finally { db.close(); }
  });

  it('[SUB-3] ships constrained helper profiles without messaging, scheduling or publishing tools', async () => {
    const profiles = (await fs.readdir(join(workspace, 'agents'))).filter((file) => file.endsWith('.md')).sort();
    expect(profiles).toEqual(['analyst.md', 'deep-researcher.md', 'extractor.md', 'planner.md', 'researcher.md', 'reviewer.md', 'ui-builder.md']);
    for (const file of profiles) {
      const { data, body, error } = parseFrontMatter(await fs.readFile(join(workspace, 'agents', file), 'utf8'));
      expect(error, file).toBeUndefined();
      expect(data.name, file).toBe(file.slice(0, -3));
      expect(typeof data.description, file).toBe('string');
      expect(['coach', 'deep', 'fast'], file).toContain(data.tier);
      expect(['low', 'medium', 'high', 'xhigh', 'max'], file).toContain(data.effort);
      expect(Array.isArray(data.tools), file).toBe(true);
      expect(Array.isArray(data.write_scope), file).toBe(true);
      const tools = data.tools as string[];
      expect(tools.filter((tool) => /^(send_message|schedule|set_heartbeat|cancel_schedule|publish_ui|rollback_ui)$/.test(tool)), file).toEqual([]);
      for (const scope of data.write_scope as string[]) expect(scope, file).not.toMatch(/^(?:\/|\.\.)|(?:^|\/)\.\.(?:\/|$)/);
      expect(body.trim().length, file).toBeGreaterThan(100);
      if (data.name === 'extractor') expect(data.write_scope).toEqual([]);
    }
  });

  it('[SAFE-3] assembles running constitution and turn addenda while retaining epoch placeholders', async () => {
    const constitution = await fs.readFile(join(system, 'constitution.md'), 'utf8');
    for (const file of ['coaching', 'safety']) expect(constitution).toContain((await fs.readFile(join(packRoot, 'constitution', `${file}.md`), 'utf8')).trim());
    expect(constitution).not.toMatch(/\{\{\s*pack_(?:coaching|safety)\s*\}\}/);
    for (const name of ['coach_name', 'athlete_name', 'harness_version', 'pack_version']) expect(constitution).toContain(`{{${name}}}`);
    const addenda = (await fs.readdir(join(seedRoot, 'core/addenda'))).filter((file) => file.endsWith('.md'));
    expect(addenda).toContain('consolidation.md');
    expect(addenda).toContain('helper.md');
    for (const file of addenda) expect(await fs.readFile(join(system, 'addenda', file), 'utf8')).toBe(await fs.readFile(join(seedRoot, 'core/addenda', file), 'utf8'));
    expect(await fs.readFile(join(system, 'addenda/consolidation.md'), 'utf8')).toMatch(/cannot message the athlete/);
    expect(await fs.readFile(join(system, 'CHANGELOG-for-coach.md'), 'utf8')).toMatch(/\S/);
  });

  it('indexes every Appendix D skill with valid frontmatter and existing bundled script references', async () => {
    const skills = await listSkills({ workspaceDir: workspace, systemDir: system });
    expect(skills.map((skill) => skill.name).sort()).toEqual(requiredSkills);
    for (const skill of skills) {
      expect(skill.source).toBe('system');
      expect(skill.description.length, skill.name).toBeGreaterThan(20);
      const skillDir = join(system, 'skills', skill.name);
      const text = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
      const { data, body, error } = parseFrontMatter(text);
      expect(error, skill.name).toBeUndefined();
      expect(data.name, skill.name).toBe(skill.name);
      expect(body.trim().length, skill.name).toBeGreaterThan(100);
      for (const match of text.matchAll(/\/system\/skills\/([a-z-]+)\/(scripts\/[a-zA-Z0-9_.-]+)/g)) {
        expect((await fs.stat(join(system, 'skills', match[1]!, match[2]!))).isFile(), `${skill.name}: ${match[0]}`).toBe(true);
      }
      const scripts = await fs.readdir(join(skillDir, 'scripts')).catch(() => [] as string[]);
      for (const script of scripts.filter((file) => file.endsWith('.py'))) expect(text, `${skill.name}: ${script}`).toContain(script);
    }
    expect((await readUiManifests(workspace)).errors).toEqual([]);
  });

  it('[WS-8] hygiene reports duplicate and provenance problems without editing athlete evidence', async () => {
    const dbFile = join(temp, 'hygiene.db');
    await fs.copyFile(join(workspace, 'data/coach.db'), dbFile);
    const db = new DatabaseSync(dbFile);
    try {
      const add = db.prepare('INSERT INTO activities(id,started_at,sport,distance_m,duration_s,source,source_refs,extracted_by,confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      add.run('file', '2026-10-05T08:00:00+02:00', 'run', 10000, 3600, 'file', JSON.stringify(['a'.repeat(64)]), 'test-parser', .98, stamp, stamp);
      add.run('screenshot', '2026-10-05T08:02:00+02:00', 'run', 10050, 3610, 'screenshot', '[]', 'test-model', .60, stamp, stamp);
    } finally { db.close(); }
    const before = await fs.readFile(dbFile);
    const script = join(system, 'skills/data-hygiene/scripts/check_db.py');
    const report = spawnSync('python3', [script, '--db', dbFile, '--as-of', '2026-10-06', '--schema-md', join(workspace, 'data/schema.md'), '--json'], { encoding: 'utf8' });
    expect(report.status, report.stderr).toBe(1);
    const findings = JSON.parse(report.stdout) as Array<{ severity: string; check: string; ids: string[] }>;
    expect(findings).toContainEqual(expect.objectContaining({ check: 'duplicate', ids: ['file', 'screenshot'] }));
    expect(findings).toContainEqual(expect.objectContaining({ severity: 'error', check: 'provenance', ids: ['screenshot'] }));
    expect(findings).toContainEqual(expect.objectContaining({ check: 'unconfirmed', ids: ['screenshot'] }));
    const candidate = spawnSync('python3', [script, '--db', dbFile, '--candidate', JSON.stringify({ started_at: '2026-10-05T06:01:00Z', distance_m: 10000, duration_s: 3600, source_refs: ['a'.repeat(64)] })], { encoding: 'utf8' });
    expect(candidate.status, candidate.stderr).toBe(0);
    const result = JSON.parse(candidate.stdout);
    expect(result.possible_duplicates.map((row: { id: string }) => row.id)).toEqual(['file', 'screenshot']);
    expect(result.activities_sharing_a_source_blob).toEqual(['file']);
    expect(await fs.readFile(dbFile)).toEqual(before);
  });

  it('exports stable, private-safe calendar events across plan moves and daylight saving', async () => {
    const dbFile = join(temp, 'calendar.db');
    const out = join(temp, 'calendar.ics');
    await fs.copyFile(join(workspace, 'data/coach.db'), dbFile);
    const db = new DatabaseSync(dbFile);
    try {
      const add = db.prepare('INSERT INTO planned_workouts(id,date,slot,type,title,description,structure,target_duration_s,status,coach_notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      add.run('tempo', '2026-10-24', 'am', 'tempo', 'Tempo; café, steady', 'Comfortable effort\nStop if sore.', JSON.stringify({ steps: [{ kind: 'repeat', times: 3, steps: [{ kind: 'work', duration: { time_s: 300 }, target: { rpe: [6, 7] } }] }] }), 1800, 'planned', 'PRIVATE medical rationale', stamp);
      add.run('flex', '2026-10-26', 'any', 'easy', 'Easy run', null, null, 1200, 'planned', null, stamp);
      add.run('skip', '2026-10-27', 'am', 'easy', 'Skipped run', null, null, 1200, 'skipped', null, stamp);
      add.run('rest', '2026-10-28', 'any', 'rest', 'Rest', null, null, null, 'planned', null, stamp);
      db.prepare('INSERT INTO races(id,date,name,distance_m,priority,goal,notes) VALUES(?,?,?,?,?,?,?)').run('race', '2026-11-01', 'Local 10K', 10000, 'B', '{"time_s":3000}', 'PRIVATE race notes');
    } finally { db.close(); }
    const run = () => spawnSync('python3', [join(system, 'skills/calendar-export/scripts/make_ics.py'), '--db', dbFile, '--out', out, '--tz', 'Europe/Amsterdam', '--stamp', stamp, '--check'], { encoding: 'utf8' });
    expect(run().status).toBe(0);
    const first = await fs.readFile(out, 'utf8');
    expect(first).toContain('UID:workout-tempo@opencoach');
    expect(first).toContain('UID:race-race@opencoach');
    expect(first).not.toContain('UID:workout-skip');
    expect(first).not.toContain('UID:workout-rest');
    expect(first).not.toContain('PRIVATE');
    expect(first).toContain('DTSTART;TZID=Europe/Amsterdam:20261024T070000');
    expect(first).toContain('DTSTART;VALUE=DATE:20261026');
    expect(first).toContain('DTEND;VALUE=DATE:20261027');
    expect(first).toContain('TZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100');
    const unfolded = first.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('SUMMARY:Tempo\\; café\\, steady');
    expect(unfolded).toContain('3 x:\\n  Work: 5 min at RPE 6-7');
    expect(first.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of first.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(run().status).toBe(0);
    expect(await fs.readFile(out, 'utf8')).toBe(first);
    const moved = new DatabaseSync(dbFile);
    try { moved.prepare('UPDATE planned_workouts SET date=?, updated_at=? WHERE id=?').run('2026-10-25', '2026-10-06T08:00:00+02:00', 'tempo'); } finally { moved.close(); }
    expect(run().status).toBe(0);
    const changed = await fs.readFile(out, 'utf8');
    expect(changed).toContain('UID:workout-tempo@opencoach');
    expect(changed).toContain('DTSTART;TZID=Europe/Amsterdam:20261025T070000');
    expect(changed).not.toContain('DTSTART;TZID=Europe/Amsterdam:20261024T070000');
  });
});
