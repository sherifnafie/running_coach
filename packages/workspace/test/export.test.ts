import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Store } from '@opencoach/protocol';
import { openSqliteStore } from '../../store/src';
import { createFsBlobStore, deleteAthleteData, exportAthlete, importAthlete, initWorkspace, openWorkspaceGit } from '../src';
import { clockAt, makeSeed, pathsFor, tmpDir, write } from './helpers';

const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function setup() {
  const dataDir = await tmpDir(); const clock = clockAt();
  const store = await openSqliteStore({ path: join(dataDir, 'system.db'), clock }); stores.push(store);
  const settings = defaultSettings(); settings.profile.name = 'Alex'; settings.calendarToken = 'calendar-secret';
  await store.createAthlete({ id: 'ath_original', displayName: 'Alex', isAdmin: true, settings });
  const paths = pathsFor(dataDir, 'ath_original');
  await initWorkspace({ paths, seedRoot: await makeSeed(), pack: 'running', clock, vars: { athlete_name: 'Alex', coach_name: 'Coach', voice_id: 'alloy', created_date: '2026-10-07' } });
  const db = new DatabaseSync(join(paths.workspace, 'data/coach.db'));
  db.prepare('INSERT INTO notes (n,body) VALUES (?,?)').run(1, 'athlete-specific data'); db.close();
  const event = await store.appendEvent({ athleteId: 'ath_original', actor: 'athlete', type: 'user.message', payload: { text: 'Hello coach' } });
  const blobs = createFsBlobStore({ dataDir, store, clock });
  const raw = await blobs.put('ath_original', Buffer.from('raw bytes'), { mime: 'text/plain', name: 'upload.txt', origin: 'athlete' });
  const derived = await blobs.put('ath_original', Buffer.from('derived chart'), { mime: 'image/png', origin: 'coach' });
  await write(join(paths.history, '2026/10/07.md'), 'athlete history');
  await write(join(paths.published, 'today/1/index.html'), '<h1>Published</h1>');
  await store.addUiVersion({ athleteId: 'ath_original', viewId: 'today', version: '1', manifest: { id: 'today', title: 'Today', icon: 'sun', placement: { nav: 0 }, entry: 'index.html', kit: '1', reads: ['db:notes'], writes: [], actions: [], refresh: 'on-change' }, commit: await openWorkspaceGit(paths.workspace, clock).head(), summary: 'Seed view', publishedBy: 'seed', dir: join(paths.published, 'today/1'), publishedAt: clock.now().toISOString() });
  await store.setCurrentUiVersion('ath_original', 'today', '1');
  return { dataDir, clock, store, paths, event, raw, derived };
}

describe('full export and import [SEC-5]', () => {
  it('reproduces committed workspace, live DB, raw provenance, derived blobs, events and published views', async () => {
    const original = await setup();
    const bundle = await exportAthlete({ ...original, athleteId: 'ath_original' });
    const dataDir = await tmpDir();
    const store = await openSqliteStore({ path: join(dataDir, 'system.db'), clock: original.clock }); stores.push(store);
    const { athleteId } = await importAthlete({ dataDir, bundlePath: bundle, store, clock: original.clock });
    expect(athleteId).toBe('ath_original');
    expect((await store.getAthlete(athleteId))!.isAdmin).toBe(false);
    const settings = await store.getSettings(athleteId);
    expect(settings.profile.name).toBe('Alex');
    expect(settings.calendarToken).toBeNull();
    const paths = pathsFor(dataDir, athleteId);
    expect(await fs.readFile(join(paths.workspace, 'athlete/profile.md'), 'utf8')).toContain('Alex');
    expect(await openWorkspaceGit(paths.workspace, original.clock).head()).toBe(await openWorkspaceGit(original.paths.workspace, original.clock).head());
    const db = new DatabaseSync(join(paths.workspace, 'data/coach.db'));
    expect(db.prepare('SELECT body FROM notes WHERE n=1').get()!.body).toBe('athlete-specific data'); db.close();
    const blobs = createFsBlobStore({ dataDir, store, clock: original.clock });
    expect(Buffer.from(await blobs.read(athleteId, original.raw.sha256)).toString()).toBe('raw bytes');
    expect(Buffer.from(await blobs.read(athleteId, original.derived.sha256)).toString()).toBe('derived chart');
    expect(await store.getEvent(original.event.id)).toMatchObject({ athleteId, payload: { text: 'Hello coach' } });
    expect(await fs.readFile(join(paths.history, '2026/10/07.md'), 'utf8')).toBe('athlete history');
    const current = await store.getCurrentUiVersions(athleteId);
    expect(current).toHaveLength(1);
    expect(current[0]!.dir).toBe(join(paths.published, 'today/1'));
    expect(await fs.readFile(join(current[0]!.dir, 'index.html'), 'utf8')).toContain('Published');
  });

  it('reissues colliding event ids and rewrites references during an import to the same store', async () => {
    const original = await setup();
    await original.store.appendEvent({ athleteId: 'ath_original', actor: 'coach', type: 'coach.message', causationId: original.event.id, payload: { messageId: 'msg1', text: 'Hi Alex', replyTo: original.event.id, notify: 'none', delivery: 'sent', proactive: false } });
    const bundle = await exportAthlete({ ...original, athleteId: 'ath_original' });
    const result = await importAthlete({ ...original, bundlePath: bundle, newAthleteId: 'ath_copy' });
    const imported = await original.store.listEvents({ athleteId: result.athleteId });
    expect(imported).toHaveLength(2);
    expect(imported[0]!.id).not.toBe(original.event.id);
    expect(imported[1]!.causationId).toBe(imported[0]!.id);
    expect((imported[1]!.payload as { replyTo: string }).replyTo).toBe(imported[0]!.id);
    expect((await original.store.getEvent(original.event.id))!.athleteId).toBe('ath_original');
  });

  it('remaps forward event references before restoring the log [SEC-5]', async () => {
    const original = await setup();
    await original.store.appendEvent({ id: 'evt_Aforward', athleteId: 'ath_original', type: 'user.message', actor: 'athlete', payload: { text: 'forward reference', replyTo: 'evt_Bforward' } });
    await original.store.appendEvent({ id: 'evt_Bforward', athleteId: 'ath_original', type: 'user.message', actor: 'athlete', payload: { text: 'future message' } });
    const bundle = await exportAthlete({ ...original, athleteId: 'ath_original' });
    const { athleteId } = await importAthlete({ ...original, bundlePath: bundle, newAthleteId: 'ath_forward' });
    const imported = await original.store.listEvents({ athleteId });
    const first = imported.find((event) => (event.payload as { text?: string }).text === 'forward reference')!;
    const future = imported.find((event) => (event.payload as { text?: string }).text === 'future message')!;
    expect((first.payload as { replyTo: string }).replyTo).toBe(future.id);
    expect(future.id).not.toBe('evt_Bforward');
  });

  it('preserves erased event envelopes without resurrecting private text [SEC-5] [SEC-6]', async () => {
    const original = await setup();
    await original.store.tombstoneEvent(original.event.id);
    const bundle = await exportAthlete({ ...original, athleteId: 'ath_original' });
    const { athleteId } = await importAthlete({ ...original, bundlePath: bundle, newAthleteId: 'ath_erased' });
    const [event] = await original.store.listEvents({ athleteId });
    expect(event!.payload).toEqual({ tombstoned: true });
    expect(await original.store.searchEvents({ athleteId, query: 'Hello' })).toEqual([]);
  });

  it('rolls back athlete records and files when an archive is malformed', async () => {
    const original = await setup();
    const bundle = await exportAthlete({ ...original, athleteId: 'ath_original' });
    const staging = await tmpDir();
    await tar.extract({ file: bundle, cwd: staging });
    await write(join(staging, 'events.jsonl'), 'invalid JSON\n');
    const malformed = join(await tmpDir(), 'broken.tar.gz');
    await tar.create({ gzip: true, file: malformed, cwd: staging }, await fs.readdir(staging));
    await expect(importAthlete({ ...original, bundlePath: malformed, newAthleteId: 'ath_broken' })).rejects.toThrow();
    expect(await original.store.getAthlete('ath_broken')).toBeUndefined();
    await expect(fs.stat(pathsFor(original.dataDir, 'ath_broken').root)).rejects.toThrow();
    expect(await original.store.getAthlete('ath_original')).toBeDefined();
  });

  it('rejects an existing destination and omits sessions, secrets, temporary files and symlink targets', async () => {
    const original = await setup();
    await write(join(original.paths.tmp, 'private.txt'), 'private');
    await write(join(original.paths.root, 'calls/private.txt'), 'private');
    const outside = join(await tmpDir(), 'secret.txt'); await write(outside, 'secret');
    await fs.symlink(outside, join(original.paths.raw, 'escape.txt'));
    const bundle = await exportAthlete({ ...original, athleteId: 'ath_original' });
    const entries: string[] = []; await tar.list({ file: bundle, onReadEntry: (entry) => { entries.push(entry.path); } });
    expect(entries.some((path) => /(^|\/)(private|secret|escape)/.test(path))).toBe(false);
    await expect(importAthlete({ ...original, bundlePath: bundle, newAthleteId: 'ath_original' })).rejects.toThrow(/already exists/);
    expect(await fs.readFile(join(original.paths.workspace, 'AGENTS.md'), 'utf8')).toContain('workspace');
  });
});

describe('hard deletion [SEC-6]', () => {
  it('removes all athlete files and refuses substituted paths and symlink roots', async () => {
    const original = await setup();
    await expect(deleteAthleteData({ ...original.paths, raw: '/tmp' })).rejects.toThrow(/refusing to delete/);
    const outside = await tmpDir();
    const symlinkPaths = pathsFor(original.dataDir, 'ath_link');
    await fs.symlink(outside, symlinkPaths.root);
    await expect(deleteAthleteData(symlinkPaths)).rejects.toThrow(/not a plain directory/);
    await deleteAthleteData(original.paths);
    await expect(fs.stat(original.paths.root)).rejects.toThrow();
    await deleteAthleteData(original.paths);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
  });
});
