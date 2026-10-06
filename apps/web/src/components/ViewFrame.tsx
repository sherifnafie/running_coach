import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PublishedView, ViewEnv } from '@opencoach/protocol';
import { appStore } from '../lib/appState';
import { BridgeHost } from '../lib/bridge';
import { emitWorkspaceChange, onWorkspaceChange } from '../lib/changeBus';
import { clock } from '../lib/clock';
import { effectiveTheme, getQueue, openChat, toast } from '../lib/controller';
import { views } from '../lib/endpoints';
import { navigate } from '../lib/router';
import { readSafeArea } from '../lib/safeArea';
import { useStore } from '../lib/store';
import { createViewBackend } from '../lib/viewBackend';
import { READY_TIMEOUT_MS, initialLoadState, reduceLoad } from '../lib/viewLoad';
import { Icon } from './Icon';

const CARD_HEIGHTS = { s: 120, m: 200, l: 320 } as const;

export interface ViewFrameProps {
  view: PublishedView;
  params: Record<string, string>;
  /** Visible to the athlete right now (kept mounted while hidden so state survives tab switches). */
  active: boolean;
  mode: 'full' | 'card';
}

/**
 * A coach view in a sandboxed iframe (`allow-scripts` only, never allow-same-origin), plus the bridge host.
 * Implements last-known-good: if the current version fails or reports an error before `ready` within 8 s,
 * the previous version is loaded and the coach is told (SPEC §9.6 step 6).
 */
export function ViewFrame({ view, params, active, mode }: ViewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<BridgeHost | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [attempt, setAttempt] = useState(0);
  const [cardHeight, setCardHeight] = useState<number>(CARD_HEIGHTS[view.manifest.card?.height ?? 'm']);
  const hasPrevious = !!view.previousUrl;
  const [load, dispatch] = useReducer((s: typeof initialLoadState, a: Parameters<typeof reduceLoad>[1]) => reduceLoad(s, a, hasPrevious), initialLoadState);

  const viewId = view.manifest.id;
  const baseUrl = mode === 'card' ? view.cardUrl : view.url;
  const showingPrevious = mode === 'full' && load.source === 'previous' && !!view.previousUrl;
  const src = showingPrevious ? view.previousUrl! : baseUrl;
  const shownVersion = showingPrevious ? (view.previousVersion ?? view.version) : view.version;

  const viewport = useCallback(() => {
    const el = wrapRef.current;
    return `${Math.round(el?.clientWidth ?? window.innerWidth)}x${Math.round(el?.clientHeight ?? window.innerHeight)}`;
  }, []);

  const buildEnv = useCallback((): ViewEnv => {
    const s = appStore.getState();
    const profile = s.me?.settings.profile;
    const el = wrapRef.current;
    return {
      theme: effectiveTheme(),
      locale: profile?.locale ?? navigator.language ?? 'en',
      units: profile?.units ?? 'metric',
      tz: profile?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      nowMs: clock.nowMs(),
      safeArea: readSafeArea(),
      viewport: { w: Math.round(el?.clientWidth ?? window.innerWidth), h: Math.round(el?.clientHeight ?? window.innerHeight) },
      online: s.online,
      viewId,
      params: paramsRef.current,
      mode: 'live',
    };
  }, [viewId]);

  // The bridge host lives as long as the iframe's document.
  useEffect(() => {
    if (!src) return;
    const backend = createViewBackend({ queue: getQueue, isOnline: () => appStore.getState().online });
    const host = new BridgeHost({
      viewId,
      version: shownVersion,
      getWindow: () => iframeRef.current?.contentWindow ?? null,
      postToView: (msg) => iframeRef.current?.contentWindow?.postMessage(msg, '*'),
      backend,
      getEnv: buildEnv,
      getViewport: viewport,
      actions: {
        navigate: (id, p) => navigate({ name: 'view', viewId: id, params: p ?? {} }),
        openChat: (o) => openChat(o.prefill),
        toast: (t) => toast(t),
        resize: (h) => {
          if (mode === 'card') setCardHeight(Math.max(60, Math.min(h, 640)));
        },
        ready: () => dispatch({ type: 'ready' }),
        viewError: (info) => dispatch({ type: 'error', message: info.message.slice(0, 200) }),
        wrote: () => emitWorkspaceChange(),
      },
    });
    hostRef.current = host;
    const onMessage = (ev: MessageEvent) => void host.handleMessage({ source: ev.source, data: ev.data });
    window.addEventListener('message', onMessage);
    const offChange = onWorkspaceChange(() => host.notifyChanged());
    return () => {
      window.removeEventListener('message', onMessage);
      offChange();
      host.dispose();
      if (hostRef.current === host) hostRef.current = null;
    };
  }, [src, viewId, shownVersion, buildEnv, viewport, mode, attempt]);

  // Ready timeout → fall back / fail.
  useEffect(() => {
    if (load.phase !== 'loading') return;
    const t = setTimeout(() => dispatch({ type: 'timeout' }), READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [load.phase, load.source, attempt]);

  // Tell the coach when the fallback kicked in or the view failed outright.
  const reportedRef = useRef('');
  useEffect(() => {
    if (!load.reason || mode !== 'full') return;
    const key = `${load.phase}:${load.source}:${load.reason}`;
    if (reportedRef.current === key) return;
    reportedRef.current = key;
    const failedVersion = load.phase === 'failed' && load.source === 'previous' ? (view.previousVersion ?? view.version) : view.version;
    void views.error(viewId, { version: failedVersion, message: `View failed to start: ${load.reason}`.slice(0, 4000), viewport: viewport() }).catch(() => undefined);
  }, [load.phase, load.source, load.reason, mode, viewId, view.version, view.previousVersion, viewport]);

  // Env changes: theme, connectivity, size, params, becoming visible.
  const online = useStore(appStore, (s) => s.online);
  const themePref = useStore(appStore, (s) => s.theme);
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    if (load.phase === 'ready') hostRef.current?.notifyEnvChanged();
  }, [online, themePref, paramsKey, active, load.phase]);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = () => hostRef.current?.notifyEnvChanged();
    mq?.addEventListener?.('change', on);
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = typeof ResizeObserver !== 'undefined' && wrapRef.current ? new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(on, 150);
    }) : undefined;
    if (wrapRef.current) ro?.observe(wrapRef.current);
    return () => {
      mq?.removeEventListener?.('change', on);
      ro?.disconnect();
      if (t) clearTimeout(t);
    };
  }, []);

  const retry = () => {
    reportedRef.current = '';
    dispatch({ type: 'reset' });
    setAttempt((n) => n + 1);
  };

  const title = view.manifest.title;
  const frameKey = useMemo(() => `${src}#${attempt}`, [src, attempt]);

  if (!src) {
    return (
      <button type="button" className="card view-card-link" onClick={() => navigate({ name: 'view', viewId, params })}>
        <Icon name={view.manifest.icon} /> <span>Open {title}</span> <Icon name="chevron" size={16} />
      </button>
    );
  }

  if (load.phase === 'failed') {
    return (
      <div className={`view-failed${mode === 'card' ? ' compact' : ''}`} role="alert">
        <Icon name="alert" size={28} />
        <p>
          <strong>{title}</strong> could not load{!online ? ' because you are offline' : ''}.
        </p>
        <div className="btn-row">
          <button className="btn primary" type="button" onClick={retry}>
            Try again
          </button>
          {mode === 'full' && (
            <button className="btn" type="button" onClick={() => openChat(`${title} isn't loading for me. Can you take a look?`)}>
              Ask your coach
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={`view-wrap ${mode}`} style={mode === 'card' ? { height: cardHeight } : undefined}>
      {showingPrevious && mode === 'full' && (
        <p className="view-notice" role="status">
          Showing the previous version of {title}. Your coach has been told and will fix it.
        </p>
      )}
      {load.phase === 'loading' && <div className="view-loading" aria-hidden="true" />}
      <iframe
        key={frameKey}
        ref={iframeRef}
        title={title}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading={mode === 'card' ? 'lazy' : undefined}
        className={load.phase === 'ready' ? 'ready' : undefined}
      />
    </div>
  );
}
