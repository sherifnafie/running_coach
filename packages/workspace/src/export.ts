/**
 * Export / import / delete of an athlete's data (SPEC §13 [SEC-5], [SEC-6]).
 *
 * Export archive (tar.gz in athletePaths.exports):
 *   manifest.json     { format: 1, athleteId, exportedAt, harnessVersion }
 *   athlete.json      AthleteRecord
 *   settings.json     AthleteSettings
 *   events.jsonl      one event envelope per line (oldest first)
 *   schedules.json    ScheduleRecord[]
 *   ui_versions.json  { versions: UiVersionRecord[], current: [{ viewId, version }] }
 *   blobs.json        BlobRecord[] (metadata of every stored blob)
 *   workspace.bundle  `git bundle create --all` of the workspace repo (COMMITTED state only)
 *   coach.db          online-backup copy of data/coach.db (the live file is git-ignored)
 *   raw/ blobs/ published/ history/
 * Not exported: snapshots, tmp, calls, previous exports, secrets, sessions.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import * as tar from 'tar';
import {
  HARNESS_VERSION,
  athletePaths,
  newId,
  parseSettings,
  type AnyEvent,
  type AthletePaths,
  type AthleteRecord,
  type BlobRecord,
  type Clock,
  type ScheduleRecord,
  type Store,
  type UiVersionRecord,
} from '@opencoach/protocol';
import { coachDbPath, compactIso } from './db';
import { assertSafeId, copyTree, errCode, pathExists, randomSuffix } from './fsutil';
import { configureRepo, initGitRepo, runGit } from './git';
import { ensureAthleteDirs } from './layout';

const FORMAT = 1;
const EVENT_PAGE = 1000;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const VIEW_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RELPATH_RE = /^(raw\/[a-f0-9]{64}\.[a-z0-9]{1,8}|blobs\/[a-f0-9]{2}\/[a-f0-9]{64})$/;

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

/** Write a .tar.gz with workspace (git bundle + files), raw/, blobs/, events.jsonl, settings.json, manifest.json. */
export async function exportAthlete(opts: { dataDir: string; athleteId: string; store: Store; clock: Clock }): Promise<string> {
  const { dataDir, athleteId, store, clock } = opts;
  assertSafeId('athlete id', athleteId);
  const paths = athletePaths(dataDir, athleteId);
  const athlete = await store.getAthlete(athleteId);
  if (!athlete) throw new Error(`exportAthlete: athlete ${athleteId} not found`);
  await ensureAthleteDirs(paths);

  const now = clock.now();
  const staging = path.join(paths.tmp, `export-${randomSuffix()}`);
  await fsp.mkdir(staging, { recursive: true });
  const finalPath = path.join(paths.exports, `opencoach-export-${athleteId}-${compactIso(now)}.tar.gz`);
  const tmpTar = path.join(paths.exports, `.export-${randomSuffix()}.tmp`);
  try {
    await writeJson(path.join(staging, 'manifest.json'), { format: FORMAT, athleteId, exportedAt: now.toISOString(), harnessVersion: HARNESS_VERSION });
    await writeJson(path.join(staging, 'athlete.json'), athlete);
    await writeJson(path.join(staging, 'settings.json'), await store.getSettings(athleteId));
    await writeJson(path.join(staging, 'schedules.json'), await store.listSchedules(athleteId));
    await writeJson(path.join(staging, 'ui_versions.json'), {
      versions: await store.listUiVersions(athleteId),
      current: (await store.getCurrentUiVersions(athleteId)).map((v) => ({ viewId: v.viewId, version: v.version })),
    });
    await writeJson(path.join(staging, 'blobs.json'), await store.listBlobs(athleteId, { limit: 1_000_000 }));

    // events (paginated)
    const fh = await fsp.open(path.join(staging, 'events.jsonl'), 'w');
    try {
      let afterId: string | undefined;
      for (;;) {
        const batch = await store.listEvents({ athleteId, order: 'asc', limit: EVENT_PAGE, ...(afterId ? { afterId } : {}) });
        if (batch.length === 0) break;
        await fh.write(batch.map((e) => JSON.stringify(e)).join('\n') + '\n');
        const last = batch[batch.length - 1]!.id;
        if (batch.length < EVENT_PAGE || last === afterId) break;
        afterId = last;
      }
    } finally {
      await fh.close();
    }

    // workspace: git bundle of the committed state + a consistent copy of coach.db
    if (await pathExists(path.join(paths.workspace, '.git'))) {
      const r = await runGit(paths.workspace, ['bundle', 'create', path.join(staging, 'workspace.bundle'), '--all'], { allow: [0, 128] });
      if (r.code !== 0 && !/empty bundle/i.test(r.stderr)) throw new Error(`git bundle failed: ${r.stderr.trim()}`);
    }
    const dbPath = coachDbPath(paths.workspace);
    if (await pathExists(dbPath)) {
      const src = new DatabaseSync(dbPath, { readOnly: true });
      try {
        await backup(src, path.join(staging, 'coach.db'));
      } finally {
        src.close();
      }
    }

    // bulky directories: hard links into the staging tree (no extra disk), symlinks skipped
    for (const dir of ['raw', 'blobs', 'published', 'history'] as const) {
      if (await pathExists(paths[dir])) await copyTree(paths[dir], path.join(staging, dir), { link: true });
    }

    const entries = (await fsp.readdir(staging)).sort();
    await tar.create({ gzip: true, file: tmpTar, cwd: staging, portable: true }, entries);
    await fsp.rename(tmpTar, finalPath);
    return finalPath;
  } catch (e) {
    await fsp.rm(tmpTar, { force: true }).catch(() => {});
    throw e;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rewrite every string equal to a remapped event id (deep). */
function remapIds(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => remapIds(x, map));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = remapIds(x, map);
    return out;
  }
  return v;
}

async function moveDir(src: string, dst: string): Promise<void> {
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (errCode(e) !== 'EXDEV') throw e;
    await copyTree(src, dst);
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/**
 * Import a bundle created by exportAthlete into a (new) athlete id.
 *
 * The athlete id is `newAthleteId` when given (must be free), otherwise the original id, or a fresh
 * one when that is taken. Imported athletes are never admins, and the calendar token is dropped
 * (re-issue it): an archive must not be able to grant privileges or clone a secret URL. Event ids
 * are preserved when free; otherwise they are re-issued and references inside the log are rewritten.
 * On any failure everything created so far is rolled back.
 */
export async function importAthlete(opts: { dataDir: string; bundlePath: string; store: Store; clock: Clock; newAthleteId?: string }): Promise<{ athleteId: string }> {
  const { dataDir, bundlePath, store, clock } = opts;
  const stagingRoot = path.join(dataDir, 'import-tmp');
  await fsp.mkdir(stagingRoot, { recursive: true });
  const staging = path.join(stagingRoot, randomSuffix());
  await fsp.mkdir(staging, { recursive: true });

  let id: string | undefined;
  let paths: AthletePaths | undefined;
  let created = false;
  try {
    await tar.extract({
      file: bundlePath,
      cwd: staging,
      strict: true,
      filter: (_p, entry) => {
        const type = (entry as { type?: string }).type;
        return type === undefined || type === 'File' || type === 'Directory' || type === 'OldFile' || type === 'ContiguousFile';
      },
    });

    const manifest = await readJson<{ format?: number; athleteId?: string }>(path.join(staging, 'manifest.json')).catch(() => {
      throw new Error('importAthlete: not an OpenCoach export (manifest.json missing or unreadable)');
    });
    if (manifest.format !== FORMAT) throw new Error(`importAthlete: unsupported export format ${String(manifest.format)} (this build reads format ${FORMAT})`);
    const athlete = await readJson<AthleteRecord>(path.join(staging, 'athlete.json'));
    const settingsRaw = await readJson<Record<string, unknown>>(path.join(staging, 'settings.json'));

    // ---- choose the id
    if (opts.newAthleteId !== undefined) {
      assertSafeId('athlete id', opts.newAthleteId);
      id = opts.newAthleteId;
      if ((await store.getAthlete(id)) || (await pathExists(athletePaths(dataDir, id).root))) throw new Error(`importAthlete: athlete ${id} already exists`);
    } else {
      const original = typeof manifest.athleteId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(manifest.athleteId) ? manifest.athleteId : undefined;
      id = original;
      if (!id || (await store.getAthlete(id)) || (await pathExists(athletePaths(dataDir, id).root))) id = newId('ath', clock);
    }
    paths = athletePaths(dataDir, id);
    await ensureAthleteDirs(paths);

    // ---- athlete + settings
    const settings = parseSettings({ ...settingsRaw, calendarToken: null });
    await store.createAthlete({ id, displayName: athlete.displayName || settings.profile.name, isAdmin: false, settings });
    created = true;

    // ---- directories
    for (const dir of ['raw', 'blobs', 'published', 'history'] as const) {
      const src = path.join(staging, dir);
      if (await pathExists(src)) await moveDir(src, paths[dir]);
    }

    // ---- workspace
    const bundle = path.join(staging, 'workspace.bundle');
    await fsp.rm(paths.workspace, { recursive: true, force: true });
    if (await pathExists(bundle)) {
      await runGit(paths.root, ['clone', '-q', '--no-hardlinks', bundle, paths.workspace]);
      await runGit(paths.workspace, ['remote', 'remove', 'origin'], { allow: [0, 2, 128] });
      await configureRepo(paths.workspace);
    } else {
      await fsp.mkdir(paths.workspace, { recursive: true });
      await initGitRepo(paths.workspace);
    }
    const db = path.join(staging, 'coach.db');
    if (await pathExists(db)) {
      await fsp.mkdir(path.join(paths.workspace, 'data'), { recursive: true });
      await fsp.copyFile(db, coachDbPath(paths.workspace));
    }

    // ---- events
    const idMap = new Map<string, string>();
    const eventsFile = path.join(staging, 'events.jsonl');
    if (await pathExists(eventsFile)) {
      const text = await fsp.readFile(eventsFile, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as AnyEvent;
        let eventId: string | undefined = e.id;
        if (!eventId || (await store.getEvent(eventId))) {
          const fresh = newId('evt', clock);
          if (eventId) idMap.set(eventId, fresh);
          eventId = fresh;
        }
        const payload = idMap.size ? remapIds(e.payload, idMap) : e.payload;
        const causationId = e.causationId ? (idMap.get(e.causationId) ?? e.causationId) : undefined;
        await store.appendEvent({
          id: eventId,
          athleteId: id,
          type: e.type,
          actor: e.actor,
          ts: e.ts,
          payload: payload as never,
          ...(e.turnId ? { turnId: e.turnId } : {}),
          ...(causationId ? { causationId } : {}),
        });
      }
    }

    // ---- schedules
    const schedulesFile = path.join(staging, 'schedules.json');
    if (await pathExists(schedulesFile)) {
      for (const s of await readJson<ScheduleRecord[]>(schedulesFile)) {
        const scheduleId = (await store.getSchedule(s.id)) ? newId('sch', clock) : s.id;
        await store.upsertSchedule({ ...s, id: scheduleId, athleteId: id });
      }
    }

    // ---- published view versions
    const versionsFile = path.join(staging, 'ui_versions.json');
    if (await pathExists(versionsFile)) {
      const { versions, current } = await readJson<{ versions: UiVersionRecord[]; current: Array<{ viewId: string; version: string }> }>(versionsFile);
      for (const v of versions) {
        if (!VIEW_ID_RE.test(v.viewId) || !VERSION_RE.test(v.version)) continue;
        await store.addUiVersion({ ...v, athleteId: id, dir: path.join(paths.published, v.viewId, v.version) });
      }
      for (const c of current ?? []) {
        if (VIEW_ID_RE.test(c.viewId) && VERSION_RE.test(c.version)) await store.setCurrentUiVersion(id, c.viewId, c.version);
      }
    }

    // ---- blob metadata (blobs.json is authoritative; raw sidecars fill any gap)
    const blobsFile = path.join(staging, 'blobs.json');
    const known = new Set<string>();
    const rawNames = await fsp.readdir(paths.raw).catch(() => [] as string[]);
    const rawFileFor = (sha: string): string | undefined => rawNames.find((n) => n.startsWith(`${sha}.`) && n !== `${sha}.json`);
    if (await pathExists(blobsFile)) {
      for (const r of await readJson<BlobRecord[]>(blobsFile)) {
        if (!/^[a-f0-9]{64}$/.test(r.sha256)) continue;
        const isRaw = r.origin === 'athlete' || r.origin === 'sync';
        const relPath = RELPATH_RE.test(r.relPath ?? '') ? r.relPath : isRaw ? `raw/${rawFileFor(r.sha256) ?? `${r.sha256}.bin`}` : `blobs/${r.sha256.slice(0, 2)}/${r.sha256}`;
        await store.putBlob({ ...r, athleteId: id, relPath });
        known.add(r.sha256);
      }
    }
    for (const name of rawNames) {
      const m = /^([a-f0-9]{64})\.json$/.exec(name);
      if (!m || known.has(m[1]!)) continue;
      const side = await readJson<{ mime?: string; bytes?: number; name?: string; origin?: string; uploadedAt?: string }>(path.join(paths.raw, name)).catch(() => undefined);
      const file = rawFileFor(m[1]!);
      if (!side || !file || (await store.getBlob(id, m[1]!))) continue;
      await store.putBlob({
        sha256: m[1]!,
        mime: side.mime ?? 'application/octet-stream',
        bytes: side.bytes ?? 0,
        ...(side.name ? { name: side.name } : {}),
        athleteId: id,
        origin: side.origin === 'sync' ? 'sync' : 'athlete',
        createdAt: side.uploadedAt ?? clock.now().toISOString(),
        relPath: `raw/${file}`,
      });
    }
    return { athleteId: id };
  } catch (e) {
    if (created && id) await store.deleteAthlete(id).catch(() => {});
    if (paths && id) await fsp.rm(paths.root, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Remove all on-disk data for an athlete. Refuses (throws) unless `paths.root` is exactly
 * `<dataDir>/athletes/<id>` (id is a safe segment, the parent directory is named "athletes", the
 * root is not a symlink) and every other path is where athletePaths() puts it.
 */
export async function deleteAthleteData(paths: AthletePaths): Promise<void> {
  const root = path.resolve(paths.root);
  const id = path.basename(root);
  const parent = path.dirname(root);
  if (!path.isAbsolute(paths.root) || path.basename(parent) !== 'athletes' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`deleteAthleteData: refusing to delete "${paths.root}" (not <dataDir>/athletes/<id>)`);
  }
  const expected = athletePaths(path.dirname(parent), id);
  for (const key of Object.keys(expected) as Array<keyof AthletePaths>) {
    if (path.resolve(paths[key]) !== path.resolve(expected[key])) throw new Error(`deleteAthleteData: refusing to delete: paths.${key} (${paths[key]}) is not inside the athlete root`);
  }
  const st = await fsp.lstat(root).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`deleteAthleteData: ${root} is not a plain directory`);
  const realParent = await fsp.realpath(parent);
  if (path.dirname(await fsp.realpath(root)) !== realParent) throw new Error(`deleteAthleteData: ${root} resolves outside ${parent}`);
  await fsp.rm(root, { recursive: true, force: true });
}
