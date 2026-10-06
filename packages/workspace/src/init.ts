/**
 * Workspace initialisation from the seed (SPEC §6.1, Appendix D): copy, render placeholders,
 * create coach.db from migrations, `git init` and the "seed" commit.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AthletePaths, Clock } from '@opencoach/protocol';
import { atomicWriteFile, errCode, pathExists } from './fsutil';
import { initGitRepo, openWorkspaceGit } from './git';
import { ensureAthleteDirs } from './layout';

/** Extensions whose `{{var}}` placeholders are rendered. */
const TEXT_EXTS = new Set(['.md', '.json', '.html', '.css', '.js', '.mjs', '.sql', '.txt', '.yaml', '.yml', '.ics', '.py', '.csv']);

export const WORKSPACE_GITIGNORE = ['data/coach.db', 'data/coach.db-*', 'tmp/', '__pycache__/', '*.pyc', '.DS_Store', ''].join('\n');

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Escape a value for the syntactic context of the file it is rendered into. */
function escapeFor(ext: string, v: string): string {
  const jsonInner = () => JSON.stringify(v).slice(1, -1);
  switch (ext) {
    case '.json':
      return jsonInner();
    case '.html':
      return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    case '.sql':
      return v.replace(/'/g, "''");
    case '.js':
    case '.mjs':
      return jsonInner().replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/</g, '\\u003c').replace(/\$\{/g, '\\u0024{');
    case '.py':
      return jsonInner().replace(/'/g, '\\x27');
    default:
      return v;
  }
}

/** Render `{{var}}` placeholders; unknown placeholders are left untouched. */
export function renderPlaceholders(text: string, vars: Record<string, string>, ext = '.md'): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(vars, name) ? escapeFor(ext, String(vars[name])) : whole));
}

async function copyRendered(src: string, dst: string, vars: Record<string, string>): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === '.git') continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) await copyRendered(from, to, vars);
    else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        const text = await fsp.readFile(from, 'utf8');
        const rendered = renderPlaceholders(text, vars, ext);
        await fsp.writeFile(to, rendered);
        await fsp.chmod(to, (await fsp.stat(from)).mode & 0o777);
      } else await fsp.copyFile(from, to);
    }
  }
}

/** Give every empty directory a .gitkeep so git keeps it. */
async function addGitkeeps(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.length === 0) {
    await fsp.writeFile(path.join(dir, '.gitkeep'), '');
    return;
  }
  for (const ent of entries) if (ent.isDirectory() && ent.name !== '.git') await addGitkeeps(path.join(dir, ent.name));
}

/**
 * Create data/coach.db by applying data/migrations/*.sql (lexical order) inside one transaction and
 * recording each applied file in `_migrations`. Journal mode is switched to WAL up front (a mode
 * change is illegal inside a transaction, and migrations such as the starter schema start with
 * `PRAGMA journal_mode = WAL`, which is then a no-op). Migration files must not contain their own
 * BEGIN/COMMIT.
 */
export async function createCoachDbFromMigrations(workspaceDir: string, clock: Clock): Promise<string[]> {
  const migDir = path.join(workspaceDir, 'data', 'migrations');
  let files: string[] = [];
  try {
    files = (await fsp.readdir(migDir)).filter((f) => f.toLowerCase().endsWith('.sql'));
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const dbPath = path.join(workspaceDir, 'data', 'coach.db');
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) await fsp.rm(dbPath + suffix, { force: true });

  const db = new DatabaseSync(dbPath);
  let current = '(setup)';
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN');
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
    for (const f of files) {
      current = f;
      db.exec(await fsp.readFile(path.join(migDir, f), 'utf8'));
      insert.run(f, clock.now().toISOString());
    }
    current = '(commit)';
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no transaction */
    }
    db.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) await fsp.rm(dbPath + suffix, { force: true });
    throw new Error(`initWorkspace: migration ${current} failed: ${(e as Error).message}`);
  }
  db.close();
  return files;
}

/**
 * Initialise a new athlete workspace from <seedRoot>/<pack>/workspace:
 * copy files (dotfiles and .gitkeep included), render {{var}} placeholders in text files, write
 * .gitignore, create data/coach.db from data/migrations/*.sql, `git init` + the "seed" commit
 * (author "OpenCoach Harness <harness@opencoach.local>", dates from the clock).
 */
export async function initWorkspace(opts: { paths: AthletePaths; seedRoot: string; pack: string; vars: Record<string, string>; clock: Clock }): Promise<{ commit: string }> {
  const { paths, seedRoot, pack, vars, clock } = opts;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pack)) throw new Error(`invalid pack "${pack}"`);
  const seedWorkspace = path.join(seedRoot, pack, 'workspace');
  if (!(await pathExists(seedWorkspace))) throw new Error(`initWorkspace: seed workspace not found at ${seedWorkspace}`);
  await ensureAthleteDirs(paths);
  const ws = paths.workspace;
  if (await pathExists(path.join(ws, '.git'))) throw new Error(`initWorkspace: ${ws} is already a git repository`);

  await copyRendered(seedWorkspace, ws, vars);
  await addGitkeeps(ws);
  await atomicWriteFile(path.join(ws, '.gitignore'), WORKSPACE_GITIGNORE);
  await createCoachDbFromMigrations(ws, clock);

  await initGitRepo(ws);
  const git = openWorkspaceGit(ws, clock);
  const info = await git.commitAll('seed: initial workspace', { Kind: 'seed' });
  if (!info) throw new Error('initWorkspace: nothing to commit (empty seed workspace?)');
  return { commit: info.commit };
}
