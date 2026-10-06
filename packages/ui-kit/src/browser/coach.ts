/**
 * `window.coach`: the view-side API (Appendix C §C.4). A thin, typed layer over the bridge
 * transport (bridge.ts) plus env/theme handling, error capture, render reporting and auto-resize.
 */
import type { ViewEnv } from '@opencoach/protocol';
import { Bridge, type ParentLike } from './bridge';
import { dates, weekStartsOnFor, type DateHelpers } from './dates';
import { createFormat, type Formatters } from './format';
import { randomBytes, ulid } from './ids';
import { applyAccent } from './theme';
import { isRecord, parseJson, targetMatches, type Row } from './util';

export const KIT_MAJOR = '1';

export type Unsubscribe = () => void;

export interface CoachEnv extends Omit<ViewEnv, 'nowMs'> {
  /** Optional brand accent from app.json (hex). Not part of the frozen ViewEnv contract. */
  accent?: string;
  /** Epoch ms as sent by the host when env was received. Use now() for the current time. */
  nowMs: number;
  /** Current time from the harness clock (injectable; never use new Date() for "now"). */
  now(): Date;
  /** First day of the week for the athlete's locale: 0 = Sunday, 1 = Monday. */
  weekStartsOn: 0 | 1;
}

export interface Coach {
  /** Resolves with the environment once the host has answered `ready`. */
  ready: Promise<CoachEnv>;
  env: CoachEnv;
  db: {
    query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
    /** First row or undefined. */
    one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
    write(target: string, op: 'insert' | 'update' | 'delete', row: Record<string, unknown>, key?: Record<string, unknown>): Promise<void>;
  };
  files: { read(path: string): Promise<string> };
  act(name: string, payload?: unknown, opts?: { wake?: boolean }): Promise<void>;
  navigate(viewId: string, params?: Record<string, string>): void;
  openChat(opts?: { prefill?: string; ref?: { viewId?: string; view_id?: string; params?: Record<string, unknown> } }): void;
  subscribe(targets: string[], cb: (changed: string[]) => void): Unsubscribe;
  toast(text: string): void;
  report(level: 'error' | 'warn' | 'info', message: string, detail?: unknown): void;
  format: Formatters;
  dates: DateHelpers;
  /** A new time-ordered row id (ULID) for direct inserts, e.g. coach.db.write('checkins', 'insert', { id: coach.id(), ... }). */
  id(): string;
  /** Safe JSON.parse for JSON columns that come back as strings. */
  json<T = unknown>(v: unknown, fallback?: T): T | undefined;
  /** Listen for environment changes (theme, viewport...). Returns an unsubscribe function. */
  onEnv(cb: (env: CoachEnv) => void): Unsubscribe;
  /** Count a promise as render work so the "rendered" report waits for it (kit components use this). */
  track<T>(p: Promise<T>): Promise<T>;
  /** Kit version this build implements. */
  readonly kit: string;
}

export interface CreateCoachOptions {
  win: Window & typeof globalThis;
  parent?: ParentLike | null;
  /** Skip error capture / render report / auto-resize (unit tests). */
  bare?: boolean;
  timeoutMs?: number;
}

const ERROR_RATE_LIMIT = 100;

function sanitize(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) return { name: detail.name, message: detail.message, stack: detail.stack };
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    return String(detail);
  }
}

export function createCoach(opts: CreateCoachOptions): Coach {
  const { win } = opts;
  const doc = win.document;
  const perf = () => win.performance.now();
  const bridge = new Bridge({ win, parent: opts.parent, timeoutMs: opts.timeoutMs });

  let baseNow = (win.performance.timeOrigin || 0) + perf();
  let basePerf = perf();
  const prefersDark = (() => {
    try {
      return win.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  })();
  const locale = win.navigator?.language || 'en-US';
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();

  const env: CoachEnv = {
    theme: prefersDark ? 'dark' : 'light',
    locale,
    units: 'metric',
    tz,
    nowMs: baseNow,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    viewport: { w: win.innerWidth || 0, h: win.innerHeight || 0 },
    online: true,
    viewId: '',
    params: {},
    mode: 'live',
    weekStartsOn: weekStartsOnFor(locale),
    now: () => new Date(baseNow + (perf() - basePerf)),
  };

  const envListeners = new Set<(e: CoachEnv) => void>();

  const applyEnv = (e: Partial<ViewEnv> & { accent?: string }): void => {
    if (e.theme === 'light' || e.theme === 'dark') env.theme = e.theme;
    if (typeof e.locale === 'string' && e.locale) {
      env.locale = e.locale;
      env.weekStartsOn = weekStartsOnFor(e.locale);
    }
    if (e.units === 'metric' || e.units === 'imperial') env.units = e.units;
    if (typeof e.tz === 'string' && e.tz) env.tz = e.tz;
    if (typeof e.nowMs === 'number' && Number.isFinite(e.nowMs)) {
      env.nowMs = e.nowMs;
      baseNow = e.nowMs;
      basePerf = perf();
    }
    if (isRecord(e.safeArea)) env.safeArea = { top: 0, right: 0, bottom: 0, left: 0, ...(e.safeArea as object) };
    if (isRecord(e.viewport)) env.viewport = { ...env.viewport, ...(e.viewport as object) };
    if (typeof e.online === 'boolean') env.online = e.online;
    if (typeof e.viewId === 'string') env.viewId = e.viewId;
    if (isRecord(e.params)) env.params = e.params as Record<string, string>;
    if (e.mode === 'live' || e.mode === 'preview') env.mode = e.mode;
    if ('accent' in e) env.accent = typeof e.accent === 'string' ? e.accent : undefined;

    const root = doc.documentElement;
    root.setAttribute('data-theme', env.theme);
    root.style.colorScheme = env.theme;
    root.setAttribute('lang', env.locale);
    const sa = env.safeArea;
    root.style.setProperty('--rc-safe-top', `${sa.top}px`);
    root.style.setProperty('--rc-safe-right', `${sa.right}px`);
    root.style.setProperty('--rc-safe-bottom', `${sa.bottom}px`);
    root.style.setProperty('--rc-safe-left', `${sa.left}px`);
    applyAccent(root, env.accent, env.theme);
    for (const l of envListeners) {
      try {
        l(env);
      } catch {
        /* ignore */
      }
    }
  };

  // ------------------------------------------------------------------ reporting

  let reportCount = 0;
  const report: Coach['report'] = (level, message, detail) => {
    if (level === 'error') {
      reportCount += 1;
      if (reportCount > ERROR_RATE_LIMIT) return;
    }
    bridge.send('report', { level, message: String(message).slice(0, 4000), ...(detail === undefined ? {} : { detail: sanitize(detail) }) });
  };

  // ------------------------------------------------------------------ ready

  const ready: Promise<CoachEnv> = (async () => {
    if (bridge.standalone) {
      applyEnv({});
      return env;
    }
    const res = await bridge.request<unknown>('ready', { kit: KIT_MAJOR }, 8_000);
    const e = isRecord(res) && isRecord(res.env) ? res.env : res;
    applyEnv(isRecord(e) ? (e as Partial<ViewEnv>) : {});
    return env;
  })();
  ready.catch((e: Error) => report('error', `coach.ready failed: ${e.message}`));

  // ------------------------------------------------------------------ subscriptions

  interface Sub {
    targets: string[];
    cb: (changed: string[]) => void;
    hostId?: string;
    dead?: boolean;
  }
  const subs = new Set<Sub>();

  bridge.onNotification((method, params) => {
    if (method === 'env.changed') {
      if (isRecord(params)) applyEnv(params as Partial<ViewEnv>);
      return;
    }
    if (method !== 'changed') return;
    const p = isRecord(params) ? params : {};
    const changed = Array.isArray(p.targets) ? (p.targets.filter((t) => typeof t === 'string') as string[]) : [];
    const subId = typeof p.subscriptionId === 'string' ? p.subscriptionId : undefined;
    for (const s of [...subs]) {
      if (s.dead) continue;
      if (subId && s.hostId) {
        if (s.hostId !== subId) continue;
      } else if (changed.length > 0 && !changed.some((t) => s.targets.some((pat) => targetMatches(pat, t)))) continue;
      try {
        s.cb(changed);
      } catch (e) {
        report('error', `subscribe callback threw: ${(e as Error).message}`, e);
      }
    }
  });

  // ------------------------------------------------------------------ render tracking

  let tracked = 0;
  const track = <T>(p: Promise<T>): Promise<T> => {
    tracked += 1;
    const done = () => {
      tracked -= 1;
    };
    p.then(done, done);
    return p;
  };

  const rowsOf = <T>(res: unknown): T[] => {
    if (Array.isArray(res)) return res as T[];
    if (isRecord(res) && Array.isArray(res.rows)) return res.rows as T[];
    return [];
  };

  // ------------------------------------------------------------------ the API

  const format = createFormat(() => ({ locale: env.locale, units: env.units, tz: env.tz, nowMs: () => env.now().getTime() }));

  const coach: Coach = {
    ready,
    env,
    kit: KIT_MAJOR,
    db: {
      query: async <T = Row>(sql: string, params?: unknown[]) => rowsOf<T>(await track(bridge.request('db.query', { sql, ...(params ? { params } : {}) }, 10_000))),
      one: async <T = Row>(sql: string, params?: unknown[]) => (await coach.db.query<T>(sql, params))[0],
      write: async (target, op, row, key) => {
        await track(bridge.request('db.write', { target, op, row, ...(key ? { key } : {}) }, 10_000));
      },
    },
    files: {
      read: async (path) => {
        const res = await track(bridge.request<unknown>('files.read', { path }, 10_000));
        if (typeof res === 'string') return res;
        if (isRecord(res) && typeof res.content === 'string') return res.content;
        if (isRecord(res) && typeof res.text === 'string') return res.text;
        return '';
      },
    },
    act: async (name, payload, o) => {
      await track(bridge.request('act', { name, ...(payload === undefined ? {} : { payload }), ...(o?.wake === undefined ? {} : { wake: o.wake }) }, 10_000));
    },
    navigate: (viewId, params) => bridge.send('navigate', { viewId, ...(params ? { params } : {}) }),
    openChat: (o) => {
      const ref = o?.ref ? { viewId: o.ref.viewId ?? o.ref.view_id ?? '', ...(o.ref.params ? { params: o.ref.params } : {}) } : undefined;
      bridge.send('openChat', { ...(o?.prefill ? { prefill: o.prefill } : {}), ...(ref ? { ref } : {}) });
    },
    subscribe: (targets, cb) => {
      const sub: Sub = { targets: [...targets], cb };
      subs.add(sub);
      bridge
        .request<unknown>('subscribe', { targets: sub.targets }, 5_000)
        .then((res) => {
          if (isRecord(res) && typeof res.subscriptionId === 'string') sub.hostId = res.subscriptionId;
          else if (typeof res === 'string') sub.hostId = res;
          if (sub.dead && sub.hostId) bridge.send('unsubscribe', { subscriptionId: sub.hostId });
        })
        .catch(() => {});
      return () => {
        if (sub.dead) return;
        sub.dead = true;
        subs.delete(sub);
        if (sub.hostId) bridge.send('unsubscribe', { subscriptionId: sub.hostId });
      };
    },
    toast: (text) => bridge.send('toast', { text: String(text).slice(0, 200) }),
    report,
    format,
    dates,
    id: () => ulid(env.now().getTime(), randomBytes),
    json: (v, fallback) => parseJson(v, fallback),
    onEnv: (cb) => {
      envListeners.add(cb);
      return () => envListeners.delete(cb);
    },
    track,
  };

  if (!opts.bare) {
    installErrorCapture(win, report);
    startRenderReport(win, coach, bridge, () => tracked, perf);
    startAutoResize(win, bridge);
  }
  return coach;
}

// ----------------------------------------------------------------------------- helpers

function installErrorCapture(win: Window & typeof globalThis, report: Coach['report']): void {
  win.addEventListener(
    'error',
    (e: Event) => {
      const ee = e as ErrorEvent;
      if (e.target === win || e.target == null) {
        report('error', ee.message || 'Script error', { source: ee.filename, line: ee.lineno, col: ee.colno, stack: (ee.error as Error | undefined)?.stack });
        return;
      }
      const t = e.target as Element;
      const tag = t.tagName?.toLowerCase();
      if (tag === 'img' || tag === 'script' || tag === 'link' || tag === 'source' || tag === 'video' || tag === 'audio') {
        report('error', `Failed to load <${tag}>: ${t.getAttribute('src') ?? t.getAttribute('href') ?? ''}`);
      }
    },
    true,
  );
  win.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason as unknown;
    const msg = r instanceof Error ? r.message : typeof r === 'string' ? r : JSON.stringify(sanitize(r)) ?? 'unknown';
    report('error', `Unhandled promise rejection: ${msg}`, r);
  });
  win.addEventListener('securitypolicyviolation', (e: SecurityPolicyViolationEvent) => {
    report('error', `CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`, {
      directive: e.violatedDirective,
      blockedURI: e.blockedURI,
      sourceFile: e.sourceFile,
      line: e.lineNumber,
    });
  });
}

const nextFrame = (win: Window): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      win.requestAnimationFrame(fin);
    } catch {
      /* ignore */
    }
    setTimeout(fin, 80);
  });

/** After ready + first render settle, tell the host (the preview uses this for first-render timing). */
function startRenderReport(win: Window & typeof globalThis, coach: Coach, bridge: Bridge, tracked: () => number, perf: () => number): void {
  void (async () => {
    if (win.document.readyState !== 'complete') await new Promise<void>((r) => win.addEventListener('load', () => r(), { once: true }));
    try {
      await coach.ready;
    } catch {
      return;
    }
    let quiet = 0;
    const started = perf();
    while (quiet < 2 && perf() - started < 5000) {
      await nextFrame(win);
      quiet = bridge.inflight === 0 && tracked() === 0 ? quiet + 1 : 0;
    }
    coach.report('info', 'rendered', { ms: Math.round(perf()) });
  })();
}

function startAutoResize(win: Window & typeof globalThis, bridge: Bridge): void {
  if (typeof win.ResizeObserver !== 'function') return;
  let last = -1;
  let queued = false;
  const post = () => {
    queued = false;
    const meta = win.document.querySelector('meta[name="rc-resize"]');
    if (meta?.getAttribute('content') === 'off') return;
    const height = Math.min(10_000, Math.max(0, Math.ceil(win.document.documentElement.getBoundingClientRect().height)));
    if (height === last) return;
    last = height;
    bridge.send('resize', { height });
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(post);
  };
  const ro = new win.ResizeObserver(schedule);
  ro.observe(win.document.documentElement);
  win.addEventListener('load', schedule);
}
