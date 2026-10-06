/**
 * Playwright preview renderer: the publish gate for coach-authored views (SPEC §9.6, ADR 0003).
 *
 * For every view: static checks, then four renders (phone-light, phone-dark, tablet-light,
 * empty-state) in headless Chromium against the athlete's data / an empty-schema fixture, with 4x
 * CPU throttling, all non-local network blocked; plus an axe-core pass in a CSP-bypassing context.
 * The view's JavaScript only ever executes inside Chromium renderer processes.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import {
  PREVIEW_VARIANTS,
  PUBLISH_GATES,
  SystemClock,
  type Clock,
  type Logger,
  type PreviewReport,
  type PreviewVariant,
  type UiRenderInput,
  type UiRenderer,
  type ViewPreview,
  silentLogger,
} from '@opencoach/protocol';
import { kitDistDir } from './assets';
import { createEmptyDb, readDbSchema, SqlExecutor } from './sql';
import { PreviewServer, type ViewContext } from './server';
import { checkApp, checkViewStatic, type ViewStatic } from './static-checks';

export interface PlaywrightRendererOptions {
  /** Chromium executable (defaults to Playwright's resolution via PLAYWRIGHT_BROWSERS_PATH). */
  executablePath?: string;
  /**
   * Use Chromium's own process sandbox (ADR 0003). Defaults to true, except when running as root
   * (Chromium refuses to sandbox as root); set OPENCOACH_CHROMIUM_NO_SANDBOX=1 to force it off.
   */
  chromiumSandbox?: boolean;
  /** Source of "now" for the view environment (default: the system clock). */
  clock?: Clock;
  logger?: Logger;
  /** CPU slowdown applied while measuring first render (default 4, per SPEC §9.6). */
  cpuThrottle?: number;
  /** Hard cap for one preview() call. Default 3 minutes. */
  previewTimeoutMs?: number;
  /** View environment used for the render. */
  env?: { locale?: string; units?: 'metric' | 'imperial'; tz?: string };
}

interface VariantDef {
  w: number;
  h: number;
  theme: 'light' | 'dark';
  empty: boolean;
}

export const VARIANT_DEFS: Record<PreviewVariant, VariantDef> = {
  'phone-light': { w: 390, h: 844, theme: 'light', empty: false },
  'phone-dark': { w: 390, h: 844, theme: 'dark', empty: false },
  'tablet-light': { w: 768, h: 1024, theme: 'light', empty: false },
  'empty-state': { w: 390, h: 844, theme: 'light', empty: true },
};

const RENDER_TIMEOUT_MS = 10_000;
const VARIANT_HARD_TIMEOUT_MS = 40_000;
const MAX_SHOT_HEIGHT = 4000;
const MAX_LIST = 25;

/** Resolve configured, Playwright-managed, or system Chromium without downloading a browser. */
export function chromiumExecutable(executablePath?: string): string | undefined {
  const configured = executablePath ?? process.env.OPENCOACH_CHROMIUM_PATH;
  if (configured) return existsSync(configured) ? configured : undefined;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* Playwright browser may not be installed. */
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
}

/** Is a Chromium available for the renderer? (Tests use this to skip cleanly.) */
export function chromiumAvailable(executablePath?: string): boolean {
  return !!chromiumExecutable(executablePath);
}

let axeSource: string | undefined;
function getAxeSource(): string {
  if (!axeSource) {
    const require = createRequire(import.meta.url);
    axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  }
  return axeSource;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (t) clearTimeout(t);
  });
}

class Issues {
  private m = new Map<string, Set<string>>();
  add(msg: string, variant: string): void {
    const text = msg.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;
    let s = this.m.get(text);
    if (!s) this.m.set(text, (s = new Set()));
    s.add(variant);
  }
  merge(other: Issues): void {
    for (const [k, v] of other.m) for (const variant of v) this.add(k, variant);
  }
  list(allVariants: number): string[] {
    const out: string[] = [];
    for (const [msg, vs] of this.m) out.push(vs.size >= allVariants ? msg : `${msg} [${[...vs].join(', ')}]`);
    return out.slice(0, MAX_LIST);
  }
  get size(): number {
    return this.m.size;
  }
}

interface VariantResult {
  variant: PreviewVariant;
  runtime: Issues;
  csp: Issues;
  firstRenderMs: number;
  screenshot?: string;
}

interface A11yViolation {
  id: string;
  impact: string;
  help: string;
  count: number;
  target: string;
}

export class PlaywrightRenderer implements UiRenderer {
  private browser?: Promise<Browser>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly log: Logger;
  private readonly clock: Clock;

  constructor(private readonly opts: PlaywrightRendererOptions = {}) {
    this.log = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? new SystemClock();
  }

  preview(input: UiRenderInput): Promise<PreviewReport> {
    // One preview at a time: CPU throttling and timing measurements must not compete.
    const run = this.queue.then(
      () => this.run(input),
      () => this.run(input),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    if (b) {
      try {
        await (await b).close();
      } catch {
        /* already gone */
      }
    }
  }

  // ------------------------------------------------------------------ browser

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      const sandbox = this.opts.chromiumSandbox ?? (!asRoot && process.env.OPENCOACH_CHROMIUM_NO_SANDBOX !== '1');
      const exe = chromiumExecutable(this.opts.executablePath);
      if (!exe) return Promise.reject(new Error('Chromium is unavailable for UI preview (set OPENCOACH_CHROMIUM_PATH or install Chromium)'));
      const p = chromium
        .launch({
          headless: true,
          executablePath: exe,
          chromiumSandbox: sandbox,
          args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--no-first-run', '--mute-audio', '--hide-scrollbars'],
          timeout: 30_000,
        })
        .then((b) => {
          b.on('disconnected', () => {
            if (this.browser === p) this.browser = undefined;
          });
          return b;
        })
        .catch((e: Error) => {
          this.browser = undefined;
          throw new Error(`could not launch Chromium for the UI preview: ${e.message.split('\n')[0]} (set executablePath / PLAYWRIGHT_BROWSERS_PATH${sandbox ? ', or chromiumSandbox: false when the OS sandbox is unavailable' : ''})`);
        });
      this.browser = p;
    }
    return this.browser;
  }

  // ------------------------------------------------------------------ preview

  private async run(input: UiRenderInput): Promise<PreviewReport> {
    const started = performance.now();
    const globalErrors: string[] = [];
    const views: ViewPreview[] = [];
    await mkdir(input.outDir, { recursive: true });

    const dbPath = join(input.workspaceDir, 'data', 'coach.db');
    const schema = readDbSchema(dbPath);
    const app = await checkApp(input.workspaceDir);
    globalErrors.push(...app.errors);

    const statics: ViewStatic[] = [];
    for (const id of input.views) statics.push(await checkViewStatic(input.workspaceDir, id, schema));

    const renderable = statics.filter((s) => !s.fatal && s.manifest);
    const tmp = await mkdtemp(join(tmpdir(), 'opencoach-preview-'));
    const exec = new SqlExecutor();
    let server: PreviewServer | undefined;
    try {
      if (renderable.length > 0) {
        const kitDir = input.kitDir || (await kitDistDir());
        for (const f of ['kit.js', 'kit.css']) if (!existsSync(join(kitDir, f))) globalErrors.push(`UI kit file ${f} not found in ${kitDir}`);
        const emptyDb = join(tmp, 'empty.db');
        createEmptyDb(emptyDb, schema);
        const ctxs = new Map<string, ViewContext>();
        for (const s of renderable) ctxs.set(s.viewId, { id: s.viewId, manifest: s.manifest as NonNullable<ViewStatic['manifest']>, dir: s.dir });
        server = new PreviewServer({ workspaceDir: input.workspaceDir, kitDir, realDb: existsSync(dbPath) ? dbPath : emptyDb, emptyDb, views: ctxs, existingViews: app.existingViews, exec });
        await server.start();
      }

      for (const st of statics) {
        const timeLeft = this.opts.previewTimeoutMs ?? 180_000;
        if (performance.now() - started > timeLeft) {
          views.push(this.finish(st, new Issues(), new Issues(), 0, [], { critical: 0, serious: 0, details: [] }, ['preview timed out before this view was rendered']));
          continue;
        }
        if (st.fatal || !st.manifest || !server) {
          views.push(this.finish(st, new Issues(), new Issues(), 0, [], { critical: 0, serious: 0, details: [] }));
          continue;
        }
        try {
          views.push(await this.renderView(st, server, input, app.app?.theme?.accent));
        } catch (e) {
          const rt = new Issues();
          rt.add(`preview failed: ${(e as Error).message}`, 'all');
          views.push(this.finish(st, rt, new Issues(), 0, [], { critical: 0, serious: 0, details: [] }));
        }
      }
    } finally {
      await server?.close().catch(() => {});
      await exec.close().catch(() => {});
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: views.every((v) => v.ok) && globalErrors.length === 0, views, globalErrors };
  }

  private finish(st: ViewStatic, runtime: Issues, csp: Issues, firstRenderMs: number, screenshots: ViewPreview['screenshots'], a11y: ViewPreview['a11y'], extraRuntime: string[] = []): ViewPreview {
    const staticErrors = [...st.errors];
    if (st.bundleKb > PUBLISH_GATES.maxBundleKb) staticErrors.push(`bundle is ${st.bundleKb} KB, over the ${PUBLISH_GATES.maxBundleKb} KB limit (excluding the kit): shrink or remove large assets`);
    const runtimeErrors = [...runtime.list(PREVIEW_VARIANTS.length), ...extraRuntime];
    if (firstRenderMs > PUBLISH_GATES.maxFirstRenderMs) runtimeErrors.push(`first render took ${Math.round(firstRenderMs)} ms with 4x CPU throttling (limit ${PUBLISH_GATES.maxFirstRenderMs} ms): simplify the initial render or reduce query sizes`);
    const cspViolations = csp.list(PREVIEW_VARIANTS.length);
    const ok = staticErrors.length === 0 && runtimeErrors.length === 0 && cspViolations.length === 0 && a11y.critical <= PUBLISH_GATES.maxCriticalA11y && firstRenderMs <= PUBLISH_GATES.maxFirstRenderMs && st.bundleKb <= PUBLISH_GATES.maxBundleKb;
    return {
      viewId: st.viewId,
      ok,
      staticErrors: staticErrors.slice(0, MAX_LIST * 2),
      runtimeErrors,
      cspViolations,
      a11y,
      perf: { firstRenderMs: Math.round(firstRenderMs), bundleKb: st.bundleKb },
      screenshots,
    };
  }

  private async renderView(st: ViewStatic, server: PreviewServer, input: UiRenderInput, accent: string | undefined): Promise<ViewPreview> {
    const browser = await this.getBrowser();
    const view = { id: st.viewId, manifest: st.manifest as NonNullable<ViewStatic['manifest']>, dir: st.dir };
    const runtime = new Issues();
    const csp = new Issues();
    const screenshots: ViewPreview['screenshots'] = [];
    let firstRender = 0;

    // Timed passes run one after another so CPU throttling measurements are not disturbed.
    for (const variant of PREVIEW_VARIANTS) {
      let r = await this.safeVariant(browser, server, view, variant, input.outDir, accent, false);
      if (r.firstRenderMs > PUBLISH_GATES.maxFirstRenderMs && r.runtime.size === 0) {
        // One retry to filter out scheduling jitter; keep the faster run.
        const again = await this.safeVariant(browser, server, view, variant, input.outDir, accent, false);
        if (again.firstRenderMs < r.firstRenderMs) r = again;
      }
      runtime.merge(r.runtime);
      csp.merge(r.csp);
      firstRender = Math.max(firstRender, r.firstRenderMs);
      if (r.screenshot) screenshots.push({ variant, path: r.screenshot });
    }

    // Accessibility pass: separate contexts with CSP bypassed so axe can be injected.
    const a11yAll: A11yViolation[] = [];
    const a11yVariants = new Map<string, Set<string>>();
    await Promise.all(
      PREVIEW_VARIANTS.map(async (variant) => {
        try {
          const found = await withTimeout(this.a11yPass(browser, server, view, variant, accent), VARIANT_HARD_TIMEOUT_MS, `axe pass (${variant})`);
          for (const v of found) {
            const key = `${v.impact}|${v.id}`;
            if (!a11yVariants.has(key)) {
              a11yVariants.set(key, new Set());
              a11yAll.push(v);
            }
            a11yVariants.get(key)?.add(variant);
          }
        } catch (e) {
          runtime.add(`accessibility check failed: ${(e as Error).message}`, variant);
        }
      }),
    );
    const critical = a11yAll.filter((v) => v.impact === 'critical').length;
    const serious = a11yAll.filter((v) => v.impact === 'serious').length;
    const details = a11yAll
      .filter((v) => v.impact === 'critical' || v.impact === 'serious')
      .sort((a, b) => (a.impact === b.impact ? 0 : a.impact === 'critical' ? -1 : 1))
      .slice(0, 12)
      .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.count} element${v.count === 1 ? '' : 's'}, e.g. ${v.target}) [${[...(a11yVariants.get(`${v.impact}|${v.id}`) ?? [])].join(', ')}]`);
    return this.finish(st, runtime, csp, firstRender, screenshots, { critical, serious, details });
  }

  private hostUrl(server: PreviewServer, view: ViewContext, variant: PreviewVariant, accent: string | undefined): string {
    const def = VARIANT_DEFS[variant];
    const cfg = {
      view: view.id,
      variant,
      entry: view.manifest.entry,
      theme: def.theme,
      w: def.w,
      h: def.h,
      empty: def.empty,
      nowMs: this.clock.now().getTime(),
      units: this.opts.env?.units ?? 'metric',
      locale: this.opts.env?.locale ?? 'en-US',
      tz: this.opts.env?.tz ?? 'UTC',
      accent,
      token: server.token,
    };
    return `${server.origin}/__host.html?cfg=${encodeURIComponent(JSON.stringify(cfg))}`;
  }

  private async newContext(browser: Browser, variant: PreviewVariant, server: PreviewServer, bypassCSP: boolean, blocked: Issues): Promise<BrowserContext> {
    const def = VARIANT_DEFS[variant];
    const ctx = await browser.newContext({
      viewport: { width: def.w, height: def.h },
      deviceScaleFactor: 1,
      colorScheme: def.theme,
      reducedMotion: 'reduce',
      acceptDownloads: false,
      locale: this.opts.env?.locale ?? 'en-US',
      timezoneId: this.opts.env?.tz ?? 'UTC',
      bypassCSP,
    });
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`${server.origin}/`) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return route.continue();
      blocked.add(`blocked network request to ${url.slice(0, 200)} (views cannot reach the network; use coach.db / coach.files)`, variant);
      return route.abort('blockedbyclient');
    });
    return ctx;
  }

  private async safeVariant(browser: Browser, server: PreviewServer, view: ViewContext, variant: PreviewVariant, outDir: string, accent: string | undefined, a11y: boolean): Promise<VariantResult> {
    try {
      return await withTimeout(this.runVariant(browser, server, view, variant, outDir, accent, a11y), VARIANT_HARD_TIMEOUT_MS, `rendering ${variant}`);
    } catch (e) {
      const runtime = new Issues();
      runtime.add(`preview of ${variant} failed: ${(e as Error).message}`, variant);
      return { variant, runtime, csp: new Issues(), firstRenderMs: RENDER_TIMEOUT_MS };
    }
  }

  private attachListeners(page: Page, server: PreviewServer, variant: PreviewVariant, runtime: Issues, csp: Issues): void {
    page.on('pageerror', (err) => runtime.add(`uncaught error: ${err.message}`, variant));
    page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const text = msg.text();
      if (/Refused to|Content Security Policy|violates the following/i.test(text)) {
        csp.add(text, variant);
        return;
      }
      if (type !== 'error') return;
      if (/^Failed to load resource/i.test(text)) return; // reported with its URL by the response/requestfailed hooks
      runtime.add(`console.error: ${text}`, variant);
    });
    page.on('requestfailed', (req) => {
      const err = req.failure()?.errorText ?? '';
      if (/BLOCKED_BY_CSP|BLOCKED_BY_CLIENT|ABORTED/i.test(err)) return; // CSP violations / blocked network are reported separately
      if (req.url().endsWith('/favicon.ico')) return;
      runtime.add(`request failed: ${req.url().slice(0, 200)} (${err})`, variant);
    });
    page.on('response', (res) => {
      const url = res.url();
      if (res.status() >= 400 && url.startsWith(server.origin) && !url.endsWith('/favicon.ico') && !url.includes('/__api/')) {
        runtime.add(`HTTP ${res.status()} for ${url.slice(server.origin.length).slice(0, 200)}`, variant);
      }
    });
    page.on('dialog', (d) => {
      runtime.add(`view opened a ${d.type()} dialog: "${d.message().slice(0, 100)}"`, variant);
      void d.dismiss().catch(() => {});
    });
    page.on('popup', (p) => {
      runtime.add('view tried to open a popup window', variant);
      void p.close().catch(() => {});
    });
  }

  private async waitRendered(page: Page, variant: PreviewVariant, runtime: Issues): Promise<{ renderedAt: number; height: number }> {
    try {
      await page.waitForFunction('window.__preview && window.__preview.done === true', undefined, { timeout: RENDER_TIMEOUT_MS, polling: 50 });
    } catch {
      runtime.add(`the view did not finish its first render within ${RENDER_TIMEOUT_MS / 1000} s (no "rendered" report from the kit and the page never settled)`, variant);
      return { renderedAt: RENDER_TIMEOUT_MS, height: 0 };
    }
    const info = (await page.evaluate('({ renderedAt: window.__preview.renderedAt, height: window.__preview.height })')) as { renderedAt: number; height: number };
    return info;
  }

  private async runVariant(browser: Browser, server: PreviewServer, view: ViewContext, variant: PreviewVariant, outDir: string, accent: string | undefined, a11y: boolean): Promise<VariantResult> {
    const def = VARIANT_DEFS[variant];
    const runtime = new Issues();
    const csp = new Issues();
    const ctx = await this.newContext(browser, variant, server, a11y, runtime);
    try {
      const page = await ctx.newPage();
      this.attachListeners(page, server, variant, runtime, csp);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: Math.max(1, this.opts.cpuThrottle ?? 4) });
      await page.goto(this.hostUrl(server, view, variant, accent), { waitUntil: 'commit', timeout: RENDER_TIMEOUT_MS });
      const { renderedAt, height } = await this.waitRendered(page, variant, runtime);
      await page.waitForTimeout(150); // let late errors / CSP events arrive
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

      // Screenshot the whole page: grow the iframe to the content height reported by the kit.
      const full = Math.min(MAX_SHOT_HEIGHT, Math.max(def.h, Math.ceil(height)));
      await page.evaluate(`window.__setFrameHeight(${full})`);
      // Opaque-origin iframes can be out-of-process. Give their compositor a real viewport
      // covering the whole frame; fullPage's temporary viewport alone may leave a white tail.
      await page.setViewportSize({ width: def.w, height: full });
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))');
      const shot = join(outDir, `${view.id}-${variant}.png`);
      await page.screenshot({ path: shot, fullPage: true, type: 'png', timeout: 15_000 });

      // Server-side findings for this variant (bridge misuse, undeclared reads/writes, kit-reported errors).
      const col = server.collector(view.id, variant);
      for (const m of col.runtime) runtime.add(m, variant);
      for (const m of col.csp) csp.add(m, variant);
      this.log.debug('preview variant', { view: view.id, variant, firstRenderMs: Math.round(renderedAt), contentHeight: height });
      return { variant, runtime, csp, firstRenderMs: renderedAt, screenshot: shot };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  private async a11yPass(browser: Browser, server: PreviewServer, view: ViewContext, variant: PreviewVariant, accent: string | undefined): Promise<A11yViolation[]> {
    const blocked = new Issues();
    const ctx = await this.newContext(browser, variant, server, true, blocked);
    try {
      const page = await ctx.newPage();
      const ignore = new Issues();
      this.attachListeners(page, server, variant, ignore, ignore);
      await page.goto(this.hostUrl(server, view, variant, accent), { waitUntil: 'commit', timeout: RENDER_TIMEOUT_MS });
      await this.waitRendered(page, variant, ignore);
      await page.waitForTimeout(150);
      const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
      if (!frame) throw new Error('view frame not found');
      await frame.evaluate(getAxeSource());
      const found = (await frame.evaluate(`(async () => {
        const r = await window.axe.run(document, { resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact || 'minor', help: v.help, count: v.nodes.length, target: (v.nodes[0] && v.nodes[0].target ? v.nodes[0].target.join(' ') : '') }));
      })()`)) as A11yViolation[];
      return found;
    } finally {
      await ctx.close().catch(() => {});
    }
  }
}

/** Headless-Chromium preview renderer implementing the publish gates (SPEC §9.6). */
export function createPlaywrightRenderer(opts?: PlaywrightRendererOptions): UiRenderer {
  return new PlaywrightRenderer(opts);
}

void readFile;
