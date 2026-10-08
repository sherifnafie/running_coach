/**
 * Static checks for a view directory and ui/app.json (SPEC §9.6 step 1). No browser involved.
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, posix, resolve, sep } from 'node:path';
import { AppManifest, UI_KIT_MAJOR, ViewId, ViewManifest } from '@opencoach/protocol';
import type { DbSchema } from './sql';

export interface ViewStatic {
  viewId: string;
  dir: string;
  manifest?: ViewManifest;
  errors: string[];
  /** The view cannot be rendered at all (missing dir, invalid manifest, missing entry). */
  fatal: boolean;
  bundleKb: number;
}

const TEXT_EXT = /\.(html?|m?js|css)$/i;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function lineOf(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

const EXTERNAL = /^\s*(?:https?:)?\/\//i;
const EXTERNAL_WS = /^\s*(?:wss?|ftp):\/\//i;

/** Scan source text for absolute external URLs and other CSP-hostile patterns. Exported for tests. */
export function scanSource(file: string, src: string): string[] {
  const out: string[] = [];
  const add = (index: number, msg: string) => out.push(`${file}:${lineOf(src, index)}: ${msg}`);
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? '';

  const scanCss = (css: string, base: number) => {
    const urlRe = /url\(\s*(['"]?)\s*([^)'"\s]+)\1\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(css))) if (EXTERNAL.test(m[2] as string)) add(base + m.index, `external URL in CSS url(): ${m[2]} (views cannot load external resources)`);
    const impRe = /@import\s+(?:url\(\s*)?['"]?\s*((?:https?:)?\/\/[^'")\s;]+)/gi;
    while ((m = impRe.exec(css))) add(base + m.index, `external @import: ${m[1]}`);
  };

  const scanJs = (js: string, base: number) => {
    const rules: Array<[RegExp, string]> = [
      [/\bimport\s*(?:[\w*${},\s]+\s+from\s*)?['"]((?:https?:)?\/\/[^'"]+)['"]/g, 'external import'],
      [/\bimport\(\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external dynamic import'],
      [/\bfetch\(\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external fetch() (connect-src is none; use coach.db / coach.files)'],
      [/\.open\(\s*['"][A-Za-z]+['"]\s*,\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external XMLHttpRequest'],
      [/\bnew\s+(?:WebSocket|EventSource)\(\s*['"`]((?:https?|wss?):\/\/[^'"`]+)['"`]/g, 'external WebSocket/EventSource'],
      [/\bnew\s+(?:Shared)?Worker\(\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external Worker'],
      [/\bsendBeacon\(\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external sendBeacon'],
      [/\bimportScripts\(\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external importScripts'],
      [/\.(?:src|href)\s*=\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g, 'external URL assigned to src/href'],
    ];
    for (const [re, what] of rules) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(js))) add(base + m.index, `${what}: ${m[1]}`);
    }
  };

  if (ext === 'css') {
    scanCss(src, 0);
  } else if (ext === 'js' || ext === 'mjs') {
    scanJs(src, 0);
  } else if (ext === 'html' || ext === 'htm') {
    const attrRe = /\s(src|href|action|formaction|poster|data|srcset|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(src))) {
      const name = (m[1] as string).toLowerCase();
      const val = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      const candidates = name === 'srcset' ? val.split(',').map((x) => x.trim().split(/\s+/)[0] ?? '') : [val];
      for (const c of candidates) {
        if (EXTERNAL.test(c) || EXTERNAL_WS.test(c)) add(m.index, `external URL in ${name}="${c}" (views cannot load external resources)`);
        else if (/^\s*javascript:/i.test(c)) add(m.index, `javascript: URL in ${name} is blocked by the CSP`);
      }
    }
    // inline handlers are blocked by the CSP
    const onRe = /\s(on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*')/gi;
    while ((m = onRe.exec(src))) add(m.index, `inline event handler ${m[1]}= is blocked by the CSP; use addEventListener in an external script`);
    // inline <script> / <style>
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    while ((m = scriptRe.exec(src))) {
      const attrs = m[1] as string;
      const body = m[2] as string;
      const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
      if (!/\ssrc\s*=/i.test(attrs) && body.trim() && !type.includes('json')) {
        add(m.index, 'inline <script> is blocked by the CSP; put the code in an external file: <script type="module" src="view.js"></script>');
      }
      if (body.trim() && !type.includes('json')) scanJs(body, m.index + (m[0] as string).indexOf(body));
    }
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
    while ((m = styleRe.exec(src))) scanCss(m[1] as string, m.index);
    // style="..." attributes
    const styleAttr = /\sstyle\s*=\s*"([^"]*)"/gi;
    while ((m = styleAttr.exec(src))) scanCss(m[1] as string, m.index);
  }
  return out;
}

/** Relative (view-local) references in an HTML file: src/href that should resolve to files in the view dir. */
export function localRefs(src: string): Array<{ attr: string; value: string; index: number }> {
  const out: Array<{ attr: string; value: string; index: number }> = [];
  const re = /<(script|link|img|source|video|audio|iframe)\b[^>]*?\s(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ attr: m[2] as string, value: (m[3] ?? m[4] ?? '').trim(), index: m.index });
  return out;
}

async function walk(dir: string, rel = ''): Promise<Array<{ rel: string; abs: string; size: number }>> {
  const out: Array<{ rel: string; abs: string; size: number }> = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...(await walk(abs, r)));
    else if (e.isFile()) out.push({ rel: r, abs, size: (await lstat(abs)).size });
  }
  return out;
}

function safeRel(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !p.includes('\0');
}

export async function checkViewStatic(workspaceDir: string, viewId: string, schema: DbSchema | null): Promise<ViewStatic> {
  const res: ViewStatic = { viewId, dir: join(workspaceDir, 'ui', 'views', viewId), errors: [], fatal: false, bundleKb: 0 };
  const fail = (msg: string) => {
    res.errors.push(msg);
    res.fatal = true;
  };
  if (!ViewId.safeParse(viewId).success) {
    fail(`"${viewId}" is not a valid view id (use lowercase letters, digits and dashes, max 32 chars)`);
    return res;
  }
  try {
    if (!(await stat(res.dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    fail(`directory ui/views/${viewId}/ does not exist`);
    return res;
  }

  // ---- manifest
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(join(res.dir, 'view.json'), 'utf8'));
  } catch (e) {
    fail(`view.json ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'is missing' : `is not valid JSON: ${(e as Error).message}`}`);
  }
  if (rawManifest !== undefined) {
    const parsed = ViewManifest.safeParse(rawManifest);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) fail(`view.json: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    } else {
      res.manifest = parsed.data;
      if (parsed.data.id !== viewId) res.errors.push(`view.json id "${parsed.data.id}" does not match its directory name "${viewId}"`);
      if (parsed.data.kit !== UI_KIT_MAJOR) res.errors.push(`unsupported UI kit major "${parsed.data.kit}" (this harness serves kit ${UI_KIT_MAJOR})`);
    }
  }

  // ---- files
  let files: Array<{ rel: string; abs: string; size: number }> = [];
  try {
    files = await walk(res.dir);
  } catch (e) {
    fail(`cannot read view directory: ${(e as Error).message}`);
  }
  // The workspace's shared ui/lib/ ships inside every bundle as lib/ (unless the view has its own lib/), so it is
  // checked like the view's own files.
  if (!files.some((f) => f.rel.startsWith('lib/'))) {
    const shared = await walk(join(workspaceDir, 'ui', 'lib')).catch(() => []);
    files.push(...shared.map((f) => ({ ...f, rel: `lib/${f.rel}` })));
  }
  res.bundleKb = Math.round((files.reduce((a, f) => a + f.size, 0) / 1024) * 10) / 10;
  const fileSet = new Set(files.map((f) => f.rel));

  if (res.manifest) {
    const entry = res.manifest.entry;
    if (!safeRel(entry)) fail(`entry "${entry}" must be a relative path inside the view directory`);
    else if (!fileSet.has(entry)) fail(`entry file "${entry}" does not exist`);
    const card = res.manifest.card?.entry;
    if (card) {
      if (!safeRel(card)) res.errors.push(`card.entry "${card}" must be a relative path inside the view directory`);
      else if (!fileSet.has(card)) res.errors.push(`card.entry file "${card}" does not exist`);
    }
  }

  for (const f of files) {
    if (!TEXT_EXT.test(f.rel) || f.size > MAX_SCAN_BYTES) continue;
    let text: string;
    try {
      text = await readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    res.errors.push(...scanSource(f.rel, text));
    if (/\.html?$/i.test(f.rel)) {
      const dir = posix.dirname(f.rel);
      for (const ref of localRefs(text)) {
        const v = ref.value;
        if (!v || v.startsWith('#') || /^(data|blob|mailto|tel|javascript):/i.test(v) || EXTERNAL.test(v)) continue;
        const kit = /^\/kit\/([^/]+)\//.exec(v);
        if (kit) {
          if (kit[1] !== UI_KIT_MAJOR) res.errors.push(`${f.rel}:${lineOf(text, ref.index)}: unsupported kit version in ${ref.attr}="${v}" (supported: /kit/${UI_KIT_MAJOR}/)`);
          continue;
        }
        if (v.startsWith('/')) {
          res.errors.push(`${f.rel}:${lineOf(text, ref.index)}: root-relative ${ref.attr}="${v}" will not resolve inside a view; use a path relative to the view directory (or /kit/${UI_KIT_MAJOR}/ for the kit)`);
          continue;
        }
        const target = posix.normalize(posix.join(dir, v.split(/[?#]/)[0] as string));
        if (target.startsWith('..') || !fileSet.has(target)) res.errors.push(`${f.rel}:${lineOf(text, ref.index)}: referenced file "${v}" not found in the view directory`);
      }
    }
  }

  // ---- declared reads/writes vs. the DB schema
  if (res.manifest && schema) {
    for (const r of res.manifest.reads) {
      if (!r.startsWith('db:')) continue;
      const table = r.slice(3);
      if (!schema.tables[table]) res.errors.push(`reads "${r}": table "${table}" does not exist in coach.db (tables: ${Object.keys(schema.tables).join(', ') || 'none'})`);
    }
    for (const w of res.manifest.writes) {
      if (!('db' in w)) continue;
      const cols = schema.tables[w.db];
      if (!cols) {
        res.errors.push(`writes db "${w.db}": table does not exist in coach.db`);
        continue;
      }
      for (const c of w.columns ?? []) if (!cols.includes(c)) res.errors.push(`writes db "${w.db}": column "${c}" does not exist (columns: ${cols.join(', ')})`);
    }
  }
  return res;
}

export interface AppCheck {
  app?: AppManifest;
  errors: string[];
  /** Ids of directories under ui/views that contain a view.json. */
  existingViews: string[];
}

export async function listViewIds(workspaceDir: string): Promise<string[]> {
  const root = join(workspaceDir, 'ui', 'views');
  try {
    const out: string[] = [];
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        await stat(join(root, e.name, 'view.json'));
        out.push(e.name);
      } catch {
        /* not a view */
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

export async function checkApp(workspaceDir: string): Promise<AppCheck> {
  const errors: string[] = [];
  const existingViews = await listViewIds(workspaceDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(workspaceDir, 'ui', 'app.json'), 'utf8'));
  } catch (e) {
    errors.push(`ui/app.json ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'is missing' : `is not valid JSON: ${(e as Error).message}`}`);
    return { errors, existingViews };
  }
  const parsed = AppManifest.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`ui/app.json: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return { errors, existingViews };
  }
  const app = parsed.data;
  for (const id of app.nav) if (!existingViews.includes(id)) errors.push(`ui/app.json nav references unknown view "${id}" (no ui/views/${id}/view.json)`);
  if (app.home && !existingViews.includes(app.home)) errors.push(`ui/app.json home references unknown view "${app.home}"`);
  if (new Set(app.nav).size !== app.nav.length) errors.push('ui/app.json nav lists a view more than once');
  return { app, errors, existingViews };
}

/** Does a workspace-relative `file:` read glob match `path`? Supports *, ** and ?. */
export function globMatch(glob: string, path: string): boolean {
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0001')
        .replace(/\*\*/g, '\u0002')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0001/g, '(?:.*/)?')
        .replace(/\u0002/g, '.*') +
      '$',
  );
  return re.test(path);
}

export function resolveInside(root: string, rel: string): string | null {
  if (!safeRel(rel)) return null;
  const abs = resolve(root, rel);
  const base = resolve(root);
  return abs === base || abs.startsWith(base + sep) ? abs : null;
}

export { basename };
