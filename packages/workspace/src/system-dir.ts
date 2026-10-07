import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { systemDir } from '@opencoach/protocol';
import { atomicWriteFile, copyTree, errCode, listFilesRecursive, pathExists, randomSuffix } from './fsutil';

const FORMAT = 'opencoach-system-v1';

function assertSegment(kind: string, v: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) || v.includes('..')) throw new Error(`invalid ${kind} "${v}"`);
}

async function readRequired(file: string, what: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') throw new Error(`buildSystemDir: missing ${what} (${file})`);
    throw e;
  }
}

async function hashFile(h: ReturnType<typeof createHash>, label: string, file: string): Promise<void> {
  const data = await fsp.readFile(file);
  h.update(`F\0${label}\0${data.length}\0`);
  h.update(data);
  h.update('\0');
}

async function hashDir(h: ReturnType<typeof createHash>, label: string, dir: string): Promise<void> {
  const files = await listFilesRecursive(dir);
  h.update(`D\0${label}\0${files.length}\0`);
  for (const rel of files) await hashFile(h, `${label}/${rel}`, path.join(dir, rel));
}

/** Normalise an extraDocs key into a safe relative path below docs/. */
function extraDocTarget(name: string): string {
  const norm = path.posix.normalize(name.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm === '.' || norm.startsWith('..') || norm.includes('\0')) throw new Error(`buildSystemDir: invalid extraDocs name "${name}"`);
  return norm;
}

/**
 * Compose the read-only /system mount for this harness version from the seed:
 *   <seedRoot>/core/constitution.md + <seedRoot>/<pack>/constitution/{coaching,safety}.md → constitution.md
 *     ({{pack_coaching}} and {{pack_safety}} are filled in; every other {{placeholder}} is kept for per-epoch rendering)
 *   <seedRoot>/<pack>/system/**   → docs/, skills/, CHANGELOG-for-coach.md, ... (copied as-is)
 *   <seedRoot>/core/addenda/      → addenda/
 *   <seedRoot>/<pack>/workspace/  → seed-workspace/ (reference copy for upgraded workspaces: views, schema, helper profiles)
 *   extraDocs (name → host file or dir, e.g. the UI kit docs) → docs/<name>
 * A `.source-hash` file records the hash of every input; an unchanged hash means nothing is rebuilt.
 * The tree is built in a temp dir and swapped in with rename. Returns the host path of the system dir.
 */
export async function buildSystemDir(opts: { dataDir: string; seedRoot: string; pack: string; harnessVersion: string; extraDocs?: Record<string, string> }): Promise<string> {
  const { dataDir, seedRoot, pack, harnessVersion } = opts;
  const extraDocs = opts.extraDocs ?? {};
  assertSegment('pack', pack);
  assertSegment('harnessVersion', harnessVersion);
  const target = systemDir(dataDir, harnessVersion);

  const coreConstitution = path.join(seedRoot, 'core', 'constitution.md');
  const coachingFile = path.join(seedRoot, pack, 'constitution', 'coaching.md');
  const safetyFile = path.join(seedRoot, pack, 'constitution', 'safety.md');
  const packSystem = path.join(seedRoot, pack, 'system');
  const addendaDir = path.join(seedRoot, 'core', 'addenda');
  const seedWorkspace = path.join(seedRoot, pack, 'workspace');

  // ---- source hash
  const h = createHash('sha256');
  h.update(`${FORMAT}\0${pack}\0${harnessVersion}\0`);
  await readRequired(coreConstitution, 'core constitution');
  await hashFile(h, 'core/constitution.md', coreConstitution);
  await readRequired(coachingFile, `${pack} constitution/coaching.md`);
  await hashFile(h, 'pack/constitution/coaching.md', coachingFile);
  await readRequired(safetyFile, `${pack} constitution/safety.md`);
  await hashFile(h, 'pack/constitution/safety.md', safetyFile);
  await hashDir(h, 'pack/system', packSystem);
  await hashDir(h, 'core/addenda', addendaDir);
  if (await pathExists(seedWorkspace)) await hashDir(h, 'pack/workspace', seedWorkspace);
  const extraNames = Object.keys(extraDocs).sort();
  for (const name of extraNames) {
    const host = extraDocs[name]!;
    const st = await fsp.stat(host).catch(() => null);
    if (!st) throw new Error(`buildSystemDir: extraDocs "${name}" points to a missing path (${host})`);
    if (st.isDirectory()) await hashDir(h, `extra/${name}`, host);
    else await hashFile(h, `extra/${name}`, host);
  }
  const hash = h.digest('hex');

  const current = await fsp.readFile(path.join(target, '.source-hash'), 'utf8').catch(() => '');
  if (current.trim() === hash) return target;

  // ---- build in a temp dir
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(target)}.build-${randomSuffix()}`);
  try {
    await fsp.mkdir(tmp, { recursive: true });

    const template = await fsp.readFile(coreConstitution, 'utf8');
    const coaching = (await fsp.readFile(coachingFile, 'utf8')).trimEnd();
    const safety = (await fsp.readFile(safetyFile, 'utf8')).trimEnd();
    const constitution = template.replace(/\{\{\s*pack_coaching\s*\}\}/g, () => coaching).replace(/\{\{\s*pack_safety\s*\}\}/g, () => safety);
    await atomicWriteFile(path.join(tmp, 'constitution.md'), constitution);

    if (await pathExists(packSystem)) await copyTree(packSystem, tmp);
    if (await pathExists(addendaDir)) await copyTree(addendaDir, path.join(tmp, 'addenda'));
    if (await pathExists(seedWorkspace)) {
      await copyTree(seedWorkspace, path.join(tmp, 'seed-workspace'), { skip: (rel) => rel.split('/').some((seg) => seg === '.git' || seg === '.gitkeep') });
    }
    for (const name of extraNames) {
      const host = extraDocs[name]!;
      const dest = path.join(tmp, 'docs', extraDocTarget(name));
      const st = await fsp.stat(host);
      if (st.isDirectory()) await copyTree(host, dest);
      else {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(host, dest);
      }
    }
    await fsp.writeFile(path.join(tmp, '.source-hash'), hash + '\n');

    // ---- swap in
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = path.join(parent, `.${path.basename(target)}.old-${randomSuffix()}`);
      let movedOld = false;
      try {
        await fsp.rename(target, old);
        movedOld = true;
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
      try {
        await fsp.rename(tmp, target);
        if (movedOld) await fsp.rm(old, { recursive: true, force: true });
        return target;
      } catch (e) {
        if (movedOld) await fsp.rename(old, target).catch(() => fsp.rm(old, { recursive: true, force: true }));
        const code = errCode(e);
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          // someone else built concurrently; if they built the same inputs we are done
          const theirs = await fsp.readFile(path.join(target, '.source-hash'), 'utf8').catch(() => '');
          if (theirs.trim() === hash) return target;
          continue;
        }
        throw e;
      }
    }
    throw new Error(`buildSystemDir: could not replace ${target}`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
