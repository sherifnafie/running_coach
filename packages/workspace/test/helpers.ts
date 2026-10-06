import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll } from 'vitest';
import {
  VirtualClock,
  athletePaths,
  defaultSettings,
  parseSettings,
  type AnyEvent,
  type AthleteRecord,
  type AthleteSettings,
  type BlobRecord,
  type EventQuery,
  type NewEvent,
  type ScheduleRecord,
  type Store,
  type UiVersionRecord,
} from '@opencoach/protocol';

const created: string[] = [];

/** A fresh temp dir, removed after the test file finishes. */
export async function tmpDir(prefix = 'ws-test-'): Promise<string> {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(d);
  return d;
}

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

export function clockAt(iso = '2026-10-07T08:00:00.000Z'): VirtualClock {
  return new VirtualClock(iso);
}

export async function write(file: string, content: string | Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

export const STARTER_SQL = `PRAGMA journal_mode = WAL;

CREATE TABLE activities (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  sport           TEXT NOT NULL DEFAULT 'run',
  title           TEXT,
  distance_m      REAL,
  duration_s      REAL,
  rpe             REAL,
  laps            JSON,
  planned_id      TEXT REFERENCES planned_workouts(id),
  source          TEXT NOT NULL,
  source_refs     JSON NOT NULL DEFAULT '[]',
  confirmed       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX activities_started ON activities(started_at);

CREATE TABLE planned_workouts (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,
  slot          TEXT,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  structure     JSON,
  status        TEXT NOT NULL DEFAULT 'planned',
  coach_notes   TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX planned_date ON planned_workouts(date);

CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  value JSON NOT NULL,
  source TEXT NOT NULL,
  ref_event TEXT
);

CREATE TABLE metrics (
  date TEXT NOT NULL, name TEXT NOT NULL,
  value REAL NOT NULL, unit TEXT, source TEXT NOT NULL,
  PRIMARY KEY (date, name, source)
);

CREATE TABLE notes (n INTEGER PRIMARY KEY, body TEXT);
`;

export interface SeedOptions {
  /** Extra files under seed/running/workspace (relative path → content). */
  workspaceFiles?: Record<string, string | Uint8Array>;
}

/** Create a fake seed tree and return its root. */
export async function makeSeed(opts: SeedOptions = {}): Promise<string> {
  const root = await tmpDir('seed-');
  const w = (rel: string, content: string | Uint8Array) => write(path.join(root, rel), content);
  await w('core/constitution.md', '# Constitution\n\nCoach {{coach_name}} for {{athlete_name}} (harness {{harness_version}}, pack {{pack_version}}).\n\n## Coaching\n{{pack_coaching}}\n\n## Safety\n{{pack_safety}}\n');
  await w('core/addenda/helper.md', 'helper preamble\n');
  await w('core/addenda/voice.md', 'voice preamble\n');
  await w('running/pack.json', JSON.stringify({ id: 'running', version: '0.1.0', name: 'Running' }));
  await w('running/constitution/coaching.md', 'Easy runs are easy.\n');
  await w('running/constitution/safety.md', 'Chest pain: stop.\n');
  await w('running/system/docs/tools.md', '# Tools\n');
  await w('running/system/skills/intake/SKILL.md', '---\nname: intake\ndescription: Conducting a coaching intake conversationally\n---\n# Intake\n');
  await w('running/system/CHANGELOG-for-coach.md', '# Changelog\n');
  const files: Record<string, string | Uint8Array> = {
    'AGENTS.md': '---\npinned:            # loaded into every context\n  - coach/persona.md\n  - athlete/profile.md\n  - plan/current-week.md\n---\n\n# Workspace manual\nThis is my workspace as {{athlete_name}}\'s coach. Unknown: {{not_a_var}}\n',
    'HEARTBEAT.md': '# Daily heartbeat\n',
    'coach/persona.md': '# Persona\nName: {{coach_name}}\nSpoken voice: {{voice_id}}\n',
    'athlete/profile.md': '# {{athlete_name}}: profile\nCreated {{created_date}}\n',
    'athlete-input/.gitkeep': '',
    'plan/current-week.md': 'No plan yet.\n',
    'data/schema.md': '# Schema\n',
    'data/dump/.gitkeep': '',
    'data/migrations/0001_init.sql': STARTER_SQL,
    'ui/app.json': '{"version":1,"nav":["today"],"home":"today","theme":{"accent":"#E4572E"},"owner":"{{athlete_name}}"}',
    'ui/views/today/view.json': JSON.stringify({ id: 'today', title: 'Today', icon: 'sun', placement: { nav: 0 }, entry: 'index.html', kit: '1', reads: ['db:planned_workouts'], writes: [{ db: 'planned_workouts', ops: ['update'], columns: ['status'] }] }),
    'ui/views/today/index.html': '<!doctype html><title>{{athlete_name}}</title>',
    'skills/.gitkeep': '',
    'exports/calendar.ics': 'BEGIN:VCALENDAR\nEND:VCALENDAR\n',
    '.hidden': 'dotfile {{athlete_name}}\n',
    '.notes.md': 'dot md {{athlete_name}}\n',
    'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x7b, 0x7b]),
    ...(opts.workspaceFiles ?? {}),
  };
  for (const [rel, content] of Object.entries(files)) await w(path.join('running/workspace', rel), content);
  return root;
}

// ------------------------------------------------------------------ fake store

/** Minimal in-memory Store implementing only what @opencoach/workspace calls. */
export class FakeStore {
  athletes = new Map<string, AthleteRecord>();
  settings = new Map<string, AthleteSettings>();
  events: AnyEvent[] = [];
  schedules = new Map<string, ScheduleRecord>();
  uiVersions: UiVersionRecord[] = [];
  current = new Map<string, string>(); // `${athleteId}/${viewId}` → version
  blobs = new Map<string, BlobRecord>(); // `${athleteId}/${sha}`
  private seq = 0;

  async createAthlete(input: { id?: string; displayName: string; isAdmin: boolean; settings: AthleteSettings }): Promise<AthleteRecord> {
    const id = input.id ?? `ath_${++this.seq}`;
    if (this.athletes.has(id)) throw new Error(`athlete ${id} exists`);
    const rec: AthleteRecord = { id, displayName: input.displayName, isAdmin: input.isAdmin, status: 'active', createdAt: '2026-10-07T00:00:00.000Z' };
    this.athletes.set(id, rec);
    this.settings.set(id, input.settings);
    return rec;
  }
  async getAthlete(id: string): Promise<AthleteRecord | undefined> {
    return this.athletes.get(id);
  }
  async getSettings(id: string): Promise<AthleteSettings> {
    return this.settings.get(id) ?? defaultSettings();
  }
  async deleteAthlete(id: string): Promise<void> {
    this.athletes.delete(id);
    this.settings.delete(id);
    this.events = this.events.filter((e) => e.athleteId !== id);
    for (const k of [...this.blobs.keys()]) if (k.startsWith(`${id}/`)) this.blobs.delete(k);
    for (const [k, s] of this.schedules) if (s.athleteId === id) this.schedules.delete(k);
    this.uiVersions = this.uiVersions.filter((v) => v.athleteId !== id);
    for (const k of [...this.current.keys()]) if (k.startsWith(`${id}/`)) this.current.delete(k);
  }

  async appendEvent(e: NewEvent): Promise<AnyEvent> {
    const env = { id: e.id ?? `evt_${String(++this.seq).padStart(6, '0')}`, athleteId: e.athleteId, ts: e.ts ?? '2026-10-07T00:00:00.000Z', type: e.type, actor: e.actor, payload: e.payload, ...(e.turnId ? { turnId: e.turnId } : {}), ...(e.causationId ? { causationId: e.causationId } : {}) } as unknown as AnyEvent;
    if (this.events.some((x) => x.id === env.id)) throw new Error(`event ${env.id} exists`);
    this.events.push(env);
    return env;
  }
  async getEvent(id: string): Promise<AnyEvent | undefined> {
    return this.events.find((e) => e.id === id);
  }
  async listEvents(q: EventQuery): Promise<AnyEvent[]> {
    let list = this.events.filter((e) => e.athleteId === q.athleteId);
    if (q.types) list = list.filter((e) => (q.types as readonly string[]).includes(e.type));
    if (q.since) list = list.filter((e) => e.ts >= q.since!);
    if (q.until) list = list.filter((e) => e.ts < q.until!);
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
    if (q.order === 'desc') list.reverse();
    if (q.afterId) {
      const i = list.findIndex((e) => e.id === q.afterId);
      if (i >= 0) list = list.slice(i + 1);
    }
    return list.slice(0, q.limit ?? 100);
  }

  async upsertSchedule(s: ScheduleRecord): Promise<void> {
    this.schedules.set(s.id, s);
  }
  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    return this.schedules.get(id);
  }
  async listSchedules(athleteId: string): Promise<ScheduleRecord[]> {
    return [...this.schedules.values()].filter((s) => s.athleteId === athleteId);
  }

  async addUiVersion(r: UiVersionRecord): Promise<void> {
    this.uiVersions.push(r);
  }
  async listUiVersions(athleteId: string, viewId?: string): Promise<UiVersionRecord[]> {
    return this.uiVersions.filter((v) => v.athleteId === athleteId && (!viewId || v.viewId === viewId));
  }
  async getCurrentUiVersions(athleteId: string): Promise<UiVersionRecord[]> {
    const out: UiVersionRecord[] = [];
    for (const [k, version] of this.current) {
      if (!k.startsWith(`${athleteId}/`)) continue;
      const v = this.uiVersions.find((x) => x.athleteId === athleteId && x.viewId === k.split('/')[1] && x.version === version);
      if (v) out.push(v);
    }
    return out;
  }
  async setCurrentUiVersion(athleteId: string, viewId: string, version: string): Promise<void> {
    this.current.set(`${athleteId}/${viewId}`, version);
  }

  async putBlob(r: BlobRecord): Promise<void> {
    this.blobs.set(`${r.athleteId}/${r.sha256}`, r);
  }
  async getBlob(athleteId: string, sha: string): Promise<BlobRecord | undefined> {
    return this.blobs.get(`${athleteId}/${sha}`);
  }
  async listBlobs(athleteId: string, opts?: { origin?: BlobRecord['origin']; limit?: number }): Promise<BlobRecord[]> {
    return [...this.blobs.values()].filter((b) => b.athleteId === athleteId && (!opts?.origin || b.origin === opts.origin)).slice(0, opts?.limit ?? 100);
  }
  async deleteBlob(athleteId: string, sha: string): Promise<void> {
    this.blobs.delete(`${athleteId}/${sha}`);
  }

  asStore(): Store {
    return this as unknown as Store;
  }
}

export function newFakeStore(): { fake: FakeStore; store: Store } {
  const fake = new FakeStore();
  return { fake, store: fake.asStore() };
}

/** Create an athlete workspace layout and return its paths. */
export function pathsFor(dataDir: string, athleteId = 'ath_test') {
  return athletePaths(dataDir, athleteId);
}

/** Build a coach.db with the starter schema at <workspace>/data/coach.db. */
export async function makeCoachDb(workspaceDir: string, sql = STARTER_SQL): Promise<string> {
  const file = path.join(workspaceDir, 'data', 'coach.db');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  return file;
}

export { parseSettings };
