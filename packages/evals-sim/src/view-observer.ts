/** Eval-only phone client. Uses immutable published bundles, the production PWA bridge host,
 * runtime manifest-scoped reads, and the same stream-change predicate as the PWA [EV-1, UI-1].
 * It keeps the iframe open across actions. Publication previews alone cannot prove live updates.
 * This is a component client, not an authentication/offline/full-PWA acceptance test.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Clock, StreamMessage } from '@opencoach/protocol';
import type { CoachRuntime } from '@opencoach/runtime';
import { chromiumExecutable } from '@opencoach/ui-kit';
import { PreviewServer } from '../../ui-kit/src/node/server';
import { SqlExecutor } from '../../ui-kit/src/node/sql';
import { BridgeHost } from '../../../apps/web/src/lib/bridge';
import { isWorkspaceChange } from '../../../apps/web/src/lib/changeBus';
import type { Assertion, ViewObservation } from './scenarios';

const HOST_SCRIPT = `(() => {
  const cfg = JSON.parse(new URLSearchParams(location.search).get('cfg'));
  const iframe = document.createElement('iframe');
  iframe.title = 'view'; iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.width = '390px'; iframe.style.height = '844px';
  window.addEventListener('message', ev => {
    if (ev.source === iframe.contentWindow) void window.evalBridgeCall(ev.data);
  });
  iframe.src = cfg.src; document.body.appendChild(iframe);
})();`;

interface OpenView {
  page: Page; server: PreviewServer; exec: SqlExecutor; host: BridgeHost;
  version: string; mount: number; ready: boolean; rendered: boolean;
  queries: ViewObservation['queries']; errors: string[];
}
export class BrowserViewObserver {
  private browser?: Browser;
  private opened = new Map<string, OpenView>();
  private nextMount = 0;
  constructor(private readonly opts: {
    runtime: CoachRuntime; athleteId: string; clock: Clock; outDir: string;
    kitDir: string; executablePath?: string;
  }) {}

  onStream(message: StreamMessage): void {
    if (isWorkspaceChange(message)) for (const view of this.opened.values()) view.host.notifyChanged();
  }

  private async open(viewId: string): Promise<OpenView | undefined> {
    const { runtime, athleteId } = this.opts;
    const record = (await runtime.core.store.getCurrentUiVersions(athleteId)).find(v => v.viewId === viewId);
    if (!record) return undefined;
    const old = this.opened.get(viewId);
    if (old?.version === record.version) return old;
    if (old) { old.host.dispose(); await old.page.close(); await old.server.close(); await old.exec.close(); this.opened.delete(viewId); }
    if (!this.browser) {
      const executablePath = chromiumExecutable(this.opts.executablePath);
      if (!executablePath) throw new Error('Chromium unavailable for published-view observations');
      this.browser = await chromium.launch({ executablePath, headless: true,
        chromiumSandbox: process.getuid?.() !== 0 && process.env.OPENCOACH_CHROMIUM_NO_SANDBOX !== '1',
        args: ['--disable-dev-shm-usage', '--disable-background-networking'] });
    }
    const workspaceDir = runtime.core.paths(athleteId).workspace;
    const profile = (await runtime.core.store.getSettings(athleteId)).profile;
    const exec = new SqlExecutor();
    const server = new PreviewServer({ workspaceDir, kitDir: this.opts.kitDir,
      realDb: join(workspaceDir, 'data/coach.db'), emptyDb: join(workspaceDir, 'data/coach.db'),
      views: new Map([[viewId, { id: viewId, manifest: record.manifest, dir: record.dir }]]), existingViews: [viewId], exec });
    await server.start();
    const page = await this.browser.newPage({ viewport: { width: 390, height: 844 } });
    const state: OpenView = { page, server, exec, host: null!, version: record.version,
      mount: ++this.nextMount, ready: false, rendered: false, queries: [], errors: [] };
    this.opened.set(viewId, state);
    const frameWindow = {}; // Browser-side listener verifies the real event.source before forwarding.
    state.host = new BridgeHost({ viewId, version: record.version, getWindow: () => frameWindow,
      postToView: message => { void page.evaluate(m => document.querySelector('iframe')?.contentWindow?.postMessage(m, '*'), message).catch(e => state.errors.push(String(e))); },
      getViewport: () => '390x844',
      getEnv: () => ({ theme: 'light', locale: profile.locale, units: profile.units, tz: profile.tz, nowMs: this.opts.clock.now().getTime(),
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, viewport: { w: 390, h: 844 }, online: true, viewId, params: {}, mode: 'live' }),
      backend: {
        query: async (id, sql, params) => {
          const rows = await runtime.views.query(athleteId, id, sql, params);
          state.queries.push({ sql, rows }); return rows;
        },
        file: (id, path) => runtime.views.readFile(athleteId, id, path),
        write: async () => { throw new Error('Eval observer is read-only'); },
        act: async () => { throw new Error('Eval observer does not trigger coaching actions'); },
        error: async (_id, body) => { state.errors.push(body.message); },
      },
      actions: { navigate() {}, openChat() {}, toast() {}, resize() {}, ready: () => { state.ready = true; },
        viewError: body => state.errors.push(body.message) },
    });
    page.on('pageerror', error => state.errors.push(error.message));
    await page.exposeFunction('evalBridgeCall', async (data: unknown) => {
      if (data && typeof data === 'object' && (data as { method?: string }).method === 'report' &&
        (data as { params?: { message?: string } }).params?.message === 'rendered') state.rendered = true;
      await state.host.handleMessage({ source: frameWindow, data });
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== server.origin) return route.abort();
      if (url.pathname === '/__host.js') return route.fulfill({ contentType: 'text/javascript', body: HOST_SCRIPT });
      return route.continue();
    });
    await page.goto(`${server.origin}/__host.html?cfg=${encodeURIComponent(JSON.stringify({ src: `/v/${viewId}/${record.manifest.entry}` }))}`);
    return state;
  }

  async observe(action: number, assertions: Assertion[]): Promise<ViewObservation[]> {
    const observations: ViewObservation[] = [];
    for (const viewId of [...new Set(assertions.filter(a => a.kind === 'view' && a.action === action).map(a => a.viewId).filter((v): v is string => !!v))]) {
      try {
        const state = await this.open(viewId);
        if (!state) { observations.push({ action, viewId, version: '', mount: 0, renderedText: '', errors: ['Requested view is unpublished.'], queries: [], subscriptions: 0 }); continue; }
        state.host.notifyEnvChanged();
        const checks = assertions.filter(a => a.kind === 'view' && a.action === action && a.viewId === viewId);
        let renderedText = '';
        const deadline = performance.now() + 5000;
        do {
          const frame = state.page.frames().find(f => f.url().includes(`/v/${viewId}/`));
          if (frame) renderedText = await frame.locator('body').ariaSnapshot({ timeout: 1000 }).catch(() => '');
          // An older/duplicate result may leave the displayed value unchanged. Still wait for
          // the subscription's new query, rather than capturing before the 300ms debounce.
          if (state.ready && state.rendered && state.queries.length && checks.every(a => !a.expected || new RegExp(a.expected, 'iu').test(renderedText))) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (performance.now() < deadline);
        await mkdir(this.opts.outDir, { recursive: true });
        const screenshot = join(this.opts.outDir, `${viewId}-action-${action}.png`);
        await state.page.screenshot({ path: screenshot, fullPage: true });
        observations.push({ action, viewId, version: state.version, mount: state.mount, renderedText, screenshot,
          errors: [...state.errors, ...(!state.ready ? ['View ready handshake did not complete.'] : []), ...(!state.rendered ? ['View did not report completed render.'] : [])],
          queries: [...state.queries], subscriptions: state.host.subscriptionCount });
        state.queries.length = 0;
      } catch (error) {
        observations.push({ action, viewId, version: '', mount: 0, renderedText: '', errors: [String(error)], queries: [], subscriptions: 0 });
      }
    }
    return observations;
  }

  async dispose(): Promise<void> {
    for (const state of this.opened.values()) { state.host.dispose(); await state.page.close().catch(() => {}); await state.server.close(); await state.exec.close(); }
    this.opened.clear(); await this.browser?.close();
  }
}
