import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';
import {
  AppManifest,
  ToolError,
  UI_KIT_MAJOR,
  VIEW_QUERY_LIMITS,
  randomToken,
  type AnyEvent,
  type AppInfo,
  type PreviewReport,
  type PublishResult,
  type PublishedView,
  type UiVersionRecord,
  type ViewManifest,
} from '@opencoach/protocol';
import { applyViewWrite, copyPublishedView, openWorkspaceGit, readUiManifests, runViewQuery } from '@opencoach/workspace';
import type { Core } from './core';

const APP_KEY = (a: string) => `app-manifest:${a}`;
const TOKEN_KEY = (a: string) => `view-token:${a}`;
const TOKEN_REV = (t: string) => `view-token-rev:${t}`;
const BUILTIN_ACTIONS = ['ask_coach'];

/** Opaque capability token used in view URLs on the isolated views origin. */
export async function viewTokenFor(core: Core, athleteId: string): Promise<string> {
  const existing = await core.store.getKv(TOKEN_KEY(athleteId));
  if (existing) return existing;
  const t = randomToken(18);
  await core.store.setKv(TOKEN_KEY(athleteId), t);
  await core.store.setKv(TOKEN_REV(t), athleteId);
  return t;
}

export async function athleteForViewToken(store: Core['store'], token: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return undefined;
  return store.getKv(TOKEN_REV(token));
}

async function dirHash(dir: string): Promise<string | null> {
  try {
    await stat(dir);
  } catch {
    return null;
  }
  const h = createHash('sha256');
  const walk = async (d: string) => {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        h.update(relative(dir, p));
        h.update('\0');
        h.update(await readFile(p));
        h.update('\0');
      }
    }
  };
  await walk(dir);
  return h.digest('hex');
}

export class UiService {
  constructor(private core: Core) {}

  currentViews(athleteId: string): Promise<UiVersionRecord[]> {
    return this.core.store.getCurrentUiVersions(athleteId);
  }

  async appManifest(athleteId: string): Promise<AppManifest> {
    const raw = await this.core.store.getKv(APP_KEY(athleteId));
    if (raw) {
      try {
        return AppManifest.parse(JSON.parse(raw));
      } catch {
        /* fall through */
      }
    }
    return AppManifest.parse({});
  }

  async appInfo(athleteId: string): Promise<AppInfo> {
    const viewsUrl = this.core.config.viewsUrl.replace(/\/+$/, '');
    const token = await viewTokenFor(this.core, athleteId);
    const app = await this.appManifest(athleteId);
    const current = await this.currentViews(athleteId);
    const views: PublishedView[] = [];
    for (const c of current) {
      const all = await this.core.store.listUiVersions(athleteId, c.viewId);
      const sorted = all.sort((a, b) => Number(a.version) - Number(b.version));
      const prev = sorted.filter((v) => Number(v.version) < Number(c.version)).pop();
      const base = (v: UiVersionRecord) => `${viewsUrl}/v/${token}/${v.viewId}@${v.version}/`;
      views.push({
        manifest: c.manifest,
        version: c.version,
        url: base(c) + c.manifest.entry,
        cardUrl: c.manifest.card ? base(c) + c.manifest.card.entry : undefined,
        previousVersion: prev?.version,
        previousUrl: prev ? base(prev) + prev.manifest.entry : undefined,
      });
    }
    return { app, views, kitUrl: `${viewsUrl}/kit/${UI_KIT_MAJOR}/kit.js` };
  }

  /** Views whose workspace files differ from their current published version (plus unpublished ones). */
  async changedViews(athleteId: string, workspaceDir?: string): Promise<string[]> {
    const ws = workspaceDir ?? this.core.paths(athleteId).workspace;
    const { views } = await readUiManifests(ws);
    const current = new Map((await this.currentViews(athleteId)).map((v) => [v.viewId, v]));
    const changed: string[] = [];
    for (const id of Object.keys(views)) {
      const cur = current.get(id);
      if (!cur) {
        changed.push(id);
        continue;
      }
      const [a, b] = await Promise.all([dirHash(join(ws, 'ui', 'views', id)), dirHash(cur.dir)]);
      if (a !== b) changed.push(id);
    }
    return changed.sort();
  }

  private async appJsonChanged(athleteId: string, ws: string): Promise<AppManifest | null> {
    let raw: string;
    try {
      raw = await readFile(join(ws, 'ui', 'app.json'), 'utf8');
    } catch {
      return null;
    }
    let parsed: AppManifest;
    try {
      parsed = AppManifest.parse(JSON.parse(raw));
    } catch (e) {
      throw new ToolError('INVALID_INPUT', `ui/app.json is invalid: ${(e as Error).message}`);
    }
    const current = await this.appManifest(athleteId);
    return JSON.stringify(current) === JSON.stringify(parsed) ? null : parsed;
  }

  async preview(athleteId: string, views?: string[], workspaceDir?: string): Promise<PreviewReport> {
    const core = this.core;
    const ws = workspaceDir ?? core.paths(athleteId).workspace;
    const list = views && views.length ? views : await this.changedViews(athleteId, ws);
    const manifests = await readUiManifests(ws);
    const globalErrors = manifests.errors.map((e) => `${e.path}: ${e.message}`);
    try {
      await this.appJsonChanged(athleteId, ws);
    } catch (e) {
      globalErrors.push((e as Error).message);
    }
    if (list.length === 0) return { ok: globalErrors.length === 0, views: [], globalErrors };
    const unknown = list.filter((v) => !manifests.views[v]);
    const known = list.filter((v) => manifests.views[v]);
    for (const u of unknown) globalErrors.push(`View "${u}" not found (ui/views/${u}/view.json missing or invalid).`);
    if (!core.deps.renderer) {
      // No renderer configured: static validation only.
      return {
        ok: globalErrors.length === 0,
        globalErrors: [...globalErrors, 'Visual preview is unavailable on this server (no renderer); only manifests were validated.'].filter(Boolean),
        views: known.map((viewId) => ({
          viewId,
          ok: true,
          staticErrors: [],
          runtimeErrors: [],
          cspViolations: [],
          a11y: { critical: 0, serious: 0, details: [] },
          perf: { firstRenderMs: 0, bundleKb: 0 },
          screenshots: [],
        })),
      };
    }
    const outDir = join(core.paths(athleteId).tmp, 'previews', String(core.clock.now().getTime()));
    await mkdir(outDir, { recursive: true });
    const report = await core.deps.renderer.preview({ athleteId, workspaceDir: ws, views: known, outDir, kitDir: core.deps.kitDir });
    return { ...report, ok: report.ok && globalErrors.length === 0, globalErrors: [...globalErrors, ...report.globalErrors] };
  }

  async publish(athleteId: string, views: string[] | undefined, summary: string, turnId?: string): Promise<PublishResult> {
    const core = this.core;
    const paths = core.paths(athleteId);
    const list = views && views.length ? views : await this.changedViews(athleteId);
    let appChange: AppManifest | null = null;
    try {
      appChange = await this.appJsonChanged(athleteId, paths.workspace);
    } catch (e) {
      const report: PreviewReport = { ok: false, views: [], globalErrors: [(e as Error).message] };
      return { ok: false, report, message: 'Publish refused: ui/app.json is invalid.' };
    }
    if (list.length === 0 && !appChange) {
      return { ok: true, published: [], report: { ok: true, views: [], globalErrors: ['Nothing to publish: no changes since the last publish.'] } };
    }
    const report = await this.preview(athleteId, list);
    if (appChange) {
      const known = new Set([...(await this.currentViews(athleteId)).map((v) => v.viewId), ...list]);
      for (const id of [...appChange.nav, ...(appChange.home ? [appChange.home] : [])]) {
        if (!known.has(id)) report.globalErrors.push(`ui/app.json references view "${id}" which is not published or being published.`);
      }
      if (report.globalErrors.some((g) => g.startsWith('ui/app.json'))) report.ok = false;
    }
    if (!report.ok) {
      const failing = report.views.filter((v) => !v.ok).map((v) => v.viewId);
      return { ok: false, report, message: `Publish refused: gates failed${failing.length ? ` for ${failing.join(', ')}` : ''}. Nothing was published.` };
    }

    const git = openWorkspaceGit(paths.workspace, core.clock);
    const { views: manifests } = await readUiManifests(paths.workspace);
    const published: Array<{ viewId: string; version: string }> = [];
    const now = core.clock.now().toISOString();
    const head = await git.head().catch(() => '');
    for (const viewId of list) {
      const manifest = manifests[viewId];
      if (!manifest) continue;
      const versions = await core.store.listUiVersions(athleteId, viewId);
      const version = String(versions.reduce((m, v) => Math.max(m, Number(v.version) || 0), 0) + 1);
      const dir = await copyPublishedView(paths, viewId, version);
      await core.store.addUiVersion({ athleteId, viewId, version, commit: head, summary, publishedAt: now, publishedBy: 'coach', manifest, dir });
      await core.store.setCurrentUiVersion(athleteId, viewId, version);
      published.push({ viewId, version });
    }
    if (appChange) await core.store.setKv(APP_KEY(athleteId), JSON.stringify(appChange));
    await git.commitAll(`publish: ${summary}`, { Kind: 'publish', ...(turnId ? { 'Turn-Id': turnId } : {}) }).catch(() => null);
    for (const p of published) {
      await core.store.appendEvent({ athleteId, type: 'coach.ui_published', actor: 'coach', turnId, payload: { viewId: p.viewId, version: p.version, commit: head, summary } });
      core.bus.publish(athleteId, { t: 'ui.published', viewId: p.viewId, version: p.version, summary });
    }
    if (appChange && published.length === 0) core.bus.publish(athleteId, { t: 'ui.published', viewId: '_app', version: '0', summary });
    return { ok: true, published, report };
  }

  /** Publish the seed views as version 1 without the preview gates (trusted, day zero). */
  async publishSeed(athleteId: string): Promise<void> {
    const core = this.core;
    const paths = core.paths(athleteId);
    const { app, views } = await readUiManifests(paths.workspace);
    const now = core.clock.now().toISOString();
    const head = await openWorkspaceGit(paths.workspace, core.clock).head().catch(() => '');
    for (const [viewId, manifest] of Object.entries(views)) {
      const dir = await copyPublishedView(paths, viewId, '1');
      await core.store.addUiVersion({ athleteId, viewId, version: '1', commit: head, summary: 'Starter view', publishedAt: now, publishedBy: 'seed', manifest, dir });
      await core.store.setCurrentUiVersion(athleteId, viewId, '1');
    }
    if (app) await core.store.setKv(APP_KEY(athleteId), JSON.stringify(app));
  }

  async rollback(athleteId: string, viewId: string, toVersion?: string, turnId?: string): Promise<{ viewId: string; version: string }> {
    const target = await this.targetVersion(athleteId, viewId, toVersion);
    await this.core.store.setCurrentUiVersion(athleteId, viewId, target.version);
    await this.core.store.appendEvent({ athleteId, type: 'coach.ui_published', actor: 'coach', turnId, payload: { viewId, version: target.version, commit: target.commit, summary: `Rolled back to v${target.version}` } });
    this.core.bus.publish(athleteId, { t: 'ui.published', viewId, version: target.version, summary: `Rolled back to v${target.version}` });
    return { viewId, version: target.version };
  }

  private async targetVersion(athleteId: string, viewId: string, toVersion?: string): Promise<UiVersionRecord> {
    const versions = (await this.core.store.listUiVersions(athleteId, viewId)).sort((a, b) => Number(a.version) - Number(b.version));
    if (versions.length === 0) throw new ToolError('NOT_FOUND', `View "${viewId}" has never been published.`);
    const current = (await this.currentViews(athleteId)).find((v) => v.viewId === viewId);
    if (toVersion) {
      const t = versions.find((v) => v.version === toVersion);
      if (!t) throw new ToolError('NOT_FOUND', `View "${viewId}" has no version ${toVersion}. Versions: ${versions.map((v) => v.version).join(', ')}.`);
      return t;
    }
    const prev = versions.filter((v) => !current || Number(v.version) < Number(current.version)).pop();
    if (!prev) throw new ToolError('NOT_FOUND', `View "${viewId}" has no earlier version to go back to.`);
    return prev;
  }

  // ------------------------------------------------------------------ athlete-facing ViewsAPI parts

  private async manifestFor(athleteId: string, viewId: string): Promise<ViewManifest> {
    const cur = (await this.currentViews(athleteId)).find((v) => v.viewId === viewId);
    if (!cur) throw new ToolError('NOT_FOUND', `View "${viewId}" is not published.`);
    return cur.manifest;
  }

  async query(athleteId: string, viewId: string, sql: string, params?: unknown[]) {
    const m = await this.manifestFor(athleteId, viewId);
    const tables = m.reads.filter((r) => r.startsWith('db:')).map((r) => r.slice(3));
    if (tables.length === 0) throw new ToolError('NOT_ALLOWED', `View "${viewId}" declares no db: reads.`);
    return runViewQuery({
      workspaceDir: this.core.paths(athleteId).workspace,
      sql,
      params,
      allowedTables: tables,
      maxRows: VIEW_QUERY_LIMITS.maxRows,
      timeoutMs: VIEW_QUERY_LIMITS.timeoutMs,
    });
  }

  async readFile(athleteId: string, viewId: string, path: string): Promise<string> {
    const m = await this.manifestFor(athleteId, viewId);
    const rel = path.replace(/^\/workspace\//, '').replace(/^\/+/, '');
    const globs = m.reads.filter((r) => r.startsWith('file:')).map((r) => r.slice(5));
    if (!globs.length || !picomatch(globs, { dot: true })(rel)) throw new ToolError('NOT_ALLOWED', `View "${viewId}" may not read ${rel}.`);
    const text = await this.core.fsFor(athleteId).readText(`/workspace/${rel}`);
    return text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
  }

  async write(athleteId: string, viewId: string, input: { target: string; op: 'insert' | 'update' | 'delete'; row: Record<string, unknown>; key?: Record<string, unknown> }): Promise<AnyEvent> {
    const manifest = await this.manifestFor(athleteId, viewId);
    await applyViewWrite({ workspaceDir: this.core.paths(athleteId).workspace, manifest, write: input });
    const e = await this.core.store.appendEvent({
      athleteId,
      type: 'user.ui_write',
      actor: 'athlete',
      payload: { viewId, target: input.target, op: input.op, row: input.row, key: input.key },
    });
    this.core.minds.get(athleteId).addPassive(e);
    this.core.bus.publish(athleteId, { t: 'event', event: e });
    return e;
  }

  async validateAction(athleteId: string, viewId: string, name: string): Promise<void> {
    const m = await this.manifestFor(athleteId, viewId);
    if (!m.actions.includes(name) && !BUILTIN_ACTIONS.includes(name)) {
      throw new ToolError('NOT_ALLOWED', `View "${viewId}" did not declare action "${name}".`);
    }
  }

  versions(athleteId: string, viewId: string): Promise<UiVersionRecord[]> {
    return this.core.store.listUiVersions(athleteId, viewId).then((v) => v.sort((a, b) => Number(b.version) - Number(a.version)));
  }

  /** Athlete-initiated revert (SPEC [WS-5]): serve the older version AND restore it into the workspace. */
  async revert(athleteId: string, viewId: string, toVersion?: string): Promise<UiVersionRecord> {
    const core = this.core;
    const current = (await this.currentViews(athleteId)).find((v) => v.viewId === viewId);
    const target = await this.targetVersion(athleteId, viewId, toVersion);
    await core.store.setCurrentUiVersion(athleteId, viewId, target.version);
    const paths = core.paths(athleteId);
    const dest = join(paths.workspace, 'ui', 'views', viewId);
    await core.minds.get(athleteId).runExclusive(async () => {
      await rm(dest, { recursive: true, force: true });
      await cp(target.dir, dest, { recursive: true });
      await openWorkspaceGit(paths.workspace, core.clock).commitAll(`revert: ${viewId} to v${target.version} (by athlete)`, { Kind: 'revert' });
    });
    const e = await core.store.appendEvent({
      athleteId,
      type: 'user.view_reverted',
      actor: 'athlete',
      payload: { viewId, fromVersion: current?.version ?? '?', toVersion: target.version },
    });
    core.bus.publish(athleteId, { t: 'ui.published', viewId, version: target.version, summary: `Reverted to v${target.version}` });
    core.minds.get(athleteId).enqueue(e, 'followup');
    return target;
  }
}
