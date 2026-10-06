/**
 * Coach-authored UI manifests, pinned-memory list, skill index and immutable published views.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { AppManifest, ViewId, ViewManifest, type AthletePaths } from '@opencoach/protocol';
import { copyTree, errCode, pathExists, randomSuffix } from './fsutil';
import { parseFrontMatter } from './frontmatter';
import type { SkillInfo, UiManifests } from './types';

const MAX_MANIFEST_BYTES = 1024 * 1024;

function issues(e: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return e.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`).join('; ');
}

async function readJsonFile(abs: string): Promise<{ value?: unknown; missing?: boolean; error?: string }> {
  try {
    const st = await fsp.lstat(abs);
    if (!st.isFile()) return { error: 'not a regular file' };
    if (st.size > MAX_MANIFEST_BYTES) return { error: `file is larger than ${MAX_MANIFEST_BYTES} bytes` };
    return { value: JSON.parse(await fsp.readFile(abs, 'utf8')) };
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { missing: true };
    return { error: `invalid JSON: ${(e as Error).message}` };
  }
}

/** Read ui/app.json and ui/views/<id>/view.json with validation errors collected, not thrown. */
export async function readUiManifests(workspaceDir: string): Promise<UiManifests> {
  const result: UiManifests = { app: null, views: {}, errors: [] };

  const app = await readJsonFile(path.join(workspaceDir, 'ui', 'app.json'));
  if (app.error) result.errors.push({ path: 'ui/app.json', message: app.error });
  else if (!app.missing) {
    const parsed = AppManifest.safeParse(app.value);
    if (parsed.success) result.app = parsed.data;
    else result.errors.push({ path: 'ui/app.json', message: issues(parsed.error) });
  }

  const viewsDir = path.join(workspaceDir, 'ui', 'views');
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fsp.readdir(viewsDir, { withFileTypes: true });
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const rel = `ui/views/${ent.name}/view.json`;
    const r = await readJsonFile(path.join(viewsDir, ent.name, 'view.json'));
    if (r.missing) {
      result.errors.push({ path: rel, message: 'missing view.json' });
      continue;
    }
    if (r.error) {
      result.errors.push({ path: rel, message: r.error });
      continue;
    }
    const parsed = ViewManifest.safeParse(r.value);
    if (!parsed.success) {
      result.errors.push({ path: rel, message: issues(parsed.error) });
      continue;
    }
    if (parsed.data.id !== ent.name) {
      result.errors.push({ path: rel, message: `view id "${parsed.data.id}" must equal its directory name "${ent.name}"` });
      continue;
    }
    result.views[parsed.data.id] = parsed.data;
  }
  return result;
}

/** Parse AGENTS.md front-matter `pinned:` list (workspace-relative paths). Missing → []. */
export async function readPinnedList(workspaceDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(workspaceDir, 'AGENTS.md'), 'utf8');
  } catch {
    return [];
  }
  const pinned = parseFrontMatter(text).data['pinned'];
  if (!Array.isArray(pinned)) return [];
  const out: string[] = [];
  for (const item of pinned) {
    if (typeof item !== 'string') continue;
    const p = item.trim().replace(/^\/workspace\//, '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

async function scanSkills(dir: string, virtualPrefix: string, source: SkillInfo['source']): Promise<SkillInfo[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: SkillInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'SKILL.md');
    let text: string;
    try {
      const st = await fsp.lstat(file);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { data } = parseFrontMatter(text);
    const name = typeof data['name'] === 'string' && data['name'].trim() ? data['name'].trim() : ent.name;
    const description = typeof data['description'] === 'string' ? data['description'].trim().replace(/\s*\n\s*/g, ' ') : '';
    out.push({ name, description, path: `${virtualPrefix}/${ent.name}/SKILL.md`, source });
  }
  return out;
}

/** Scan <dir>/<skill>/SKILL.md front-matter in /system/skills and /workspace/skills. */
export async function listSkills(opts: { systemDir: string; workspaceDir: string }): Promise<SkillInfo[]> {
  const system = await scanSkills(path.join(opts.systemDir, 'skills'), '/system/skills', 'system');
  const workspace = await scanSkills(path.join(opts.workspaceDir, 'skills'), '/workspace/skills', 'workspace');
  return [...system, ...workspace];
}

/**
 * Copy ui/views/<viewId> into published/<viewId>/<version>/ (immutable: refuses to overwrite).
 * Symbolic links and .git are never copied. Returns the host dir.
 */
export async function copyPublishedView(paths: AthletePaths, viewId: string, version: string): Promise<string> {
  if (!ViewId.safeParse(viewId).success) throw new Error(`invalid view id "${viewId}"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(version) || version.includes('..')) throw new Error(`invalid view version "${version}"`);
  const src = path.join(paths.workspace, 'ui', 'views', viewId);
  const st = await fsp.lstat(src).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`view "${viewId}" does not exist in the workspace (ui/views/${viewId})`);
  const dest = path.join(paths.published, viewId, version);
  if (await pathExists(dest)) throw new Error(`published version ${viewId}@${version} already exists; published versions are immutable`);
  const tmp = path.join(paths.published, viewId, `.${version}.tmp-${randomSuffix()}`);
  try {
    await copyTree(src, tmp, { skip: (rel, isDir) => isDir && rel.split('/').includes('.git') });
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return dest;
}
