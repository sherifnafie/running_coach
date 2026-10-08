import { useI18n } from '../lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { appStore } from '../lib/appState';
import { dismissToast } from '../lib/controller';
import { presenceLabel } from '../lib/format';
import { computeNav, isActive, type NavItem } from '../lib/nav';
import { navigate, useRoute, type Route } from '../lib/router';
import { useStore } from '../lib/store';
import { CallBar, CallScreen } from '../screens/CallScreen';
import { ChatScreen } from '../screens/chat/ChatScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { MissingView, ViewScreen } from '../screens/ViewScreen';
import { Icon } from './Icon';
import { SafetyBanner } from './SafetyBanner';
import { CoachAvatar } from './CoachAvatar';

/**
 * The shell (SPEC §9.1, P9): harness-owned chrome that always works whatever the coach publishes. Chat is first and
 * cannot be removed; Settings is always last; coach views fill the slots between; the safety banner area and the
 * offline indicator are written only by the harness.
 */
export function Shell() {
  const t = useI18n();
  const shellRef = useRef<HTMLDivElement>(null);
  const route = useRoute();
  const app = useStore(appStore, (s) => s.app);
  const appChecked = useStore(appStore, (s) => s.appChecked);
  const nav = useMemo(() => computeNav(app), [app]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [visited, setVisited] = useState<Record<string, Record<string, string>>>({});

  // Safari overlays its keyboard instead of resizing the layout viewport. Keep the composer reachable.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      if (viewport.scale !== 1) return; // Pinch zoom must not reflow the app.
      shellRef.current?.style.setProperty('--shell-height', `${viewport.height}px`);
    };
    resize();
    viewport.addEventListener('resize', resize);
    return () => viewport.removeEventListener('resize', resize);
  }, []);

  // Keep visited views mounted (hidden) so their state survives tab switches.
  useEffect(() => {
    if (route.name === 'view') setVisited((v) => ({ ...v, [route.viewId]: route.params }));
    setMoreOpen(false);
  }, [route]);

  const views = app?.views ?? [];
  const activeView = route.name === 'view' ? views.find((v) => v.manifest.id === route.viewId) : undefined;
  const chatVisible = route.name === 'chat';

  return (
    <div ref={shellRef} className={`shell route-${route.name}`}>
      <a className="skip-link" href="#main">
        {t("Skip to content")}</a>
      <div className="shell-col">
      <Header route={route} />
      <SafetyBanner />
      <ConnectionBar />
      {route.name !== 'call' && <CallBar />}
      <main id="main" className="shell-main" tabIndex={-1}>
        <section className="screen" hidden={!chatVisible} aria-label={t("Chat")}>
          <ChatScreen visible={chatVisible} />
        </section>
        {Object.entries(visited).map(([id, params]) => {
          const v = views.find((x) => x.manifest.id === id);
          if (!v) return null;
          const on = route.name === 'view' && route.viewId === id;
          return (
            <section key={id} className="screen" hidden={!on} aria-label={v.manifest.title}>
              <ViewScreen view={v} params={on ? route.params : params} active={on} />
            </section>
          );
        })}
        {route.name === 'view' && !activeView && (appChecked ? (
          <section className="screen" aria-label={t("View unavailable")}>
            <MissingView viewId={route.viewId} />
          </section>
        ) : (
          // Still loading the app after a refresh: a quiet cover, not an error.
          <section className="screen" aria-busy="true">
            <div className="view-loading" aria-hidden="true"><span className="spinner" /></div>
          </section>
        ))}
        {route.name === 'settings' && (
          <section className="screen scroll" aria-label={t("Settings")}>
            <SettingsScreen />
          </section>
        )}
        {route.name === 'call' && (
          <section className="screen call-screen" aria-label={t("Call")}>
            <CallScreen />
          </section>
        )}
      </main>
      </div>
      <BottomNav route={route} nav={nav} moreOpen={moreOpen} setMoreOpen={setMoreOpen} />
      <Toasts />
    </div>
  );
}

function Header({ route }: { route: Route }) {
  const t = useI18n();
  const me = useStore(appStore, (s) => s.me);
  const presence = useStore(appStore, (s) => s.presence);
  const progress = useStore(appStore, (s) => s.progress);
  const callsAvailable = !!me && (me.features.calls.realtime || me.features.calls.cascaded);
  const coachName = me?.settings.profile.coachName ?? 'Coach';
  const sub = presenceLabel(coachName, progress?.label, presence, me?.settings.profile.locale);

  if (route.name === 'chat') {
    return (
      <header className="app-header">
        <div className="coach-id">
          <CoachAvatar key={me?.athlete.id} name={coachName} sha256={me?.settings.coachIdentity?.avatarSha256} />
          <div>
            <h1>{coachName}</h1>
            <p className={`presence${sub ? ' on' : ''}`} role="status" aria-live="polite">
              {sub || t('Your coach')}
            </p>
          </div>
        </div>
        {callsAvailable && (
          <button type="button" className="icon-btn call-btn-header" aria-label={`Call ${coachName}`} onClick={() => navigate({ name: 'call' })}>
            <Icon name="phone" />
          </button>
        )}
      </header>
    );
  }
  if (route.name === 'call') return null; // the call screen is full-bleed with its own controls
  if (route.name === 'view') {
    // Views show their own title; repeating it here (with a back arrow on a tab) only cost space. The strip keeps
    // the status-bar inset and surfaces what the coach is doing, linking back to the conversation.
    return (
      <div className={`view-status${sub ? ' on' : ''}`}>
        {sub && (
          <button type="button" className="view-status-pill" onClick={() => navigate({ name: 'chat' })} aria-label={`${sub}. ${t('Open chat')}`}>
            <span className="presence-dot" aria-hidden="true" />
            <span role="status" aria-live="polite">{sub}</span>
          </button>
        )}
      </div>
    );
  }
  return (
    <header className="app-header">
      <div className="coach-id">
        <h1>{t('Settings')}</h1>
      </div>
    </header>
  );
}

/** True once `active` has held continuously for `ms` (resets when it turns false). */
function useSustained(active: boolean, ms: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!active) {
      setSustained(false);
      return;
    }
    const timer = setTimeout(() => setSustained(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && sustained;
}

/** A normal startup or a brief reconnect takes well under this; only a real connection problem is worth a banner. */
const CONNECTION_GRACE_MS = 2000;

function ConnectionBar() {
  const t = useI18n();
  const online = useStore(appStore, (s) => s.online);
  const ws = useStore(appStore, (s) => s.ws);
  const queued = useStore(appStore, (s) => s.queued);
  const boot = useStore(appStore, (s) => s.boot);
  const slowSocket = useSustained(boot === 'ready' && online && ws !== 'open', CONNECTION_GRACE_MS);
  if (boot !== 'ready') return null;
  if (!online)
    return (
      <div className="conn-bar offline" role="status">
        <Icon name="wifi-off" size={16} /> {t("You're offline. Showing saved data")}{queued > 0 ? `, ${queued} item${queued === 1 ? '' : 's'} waiting to send` : ''}.
      </div>
    );
  if (ws !== 'open' && slowSocket)
    return (
      <div className="conn-bar" role="status">
        <Icon name="refresh" size={16} /> {ws === 'connecting' ? t('Connecting…') : t('Reconnecting…')}
        {queued > 0 ? ` ${queued} waiting to send.` : ''}
      </div>
    );
  if (queued > 0)
    return (
      <div className="conn-bar" role="status">
        {t("Sending")} {queued} {queued === 1 ? t("queued item") : t("queued items")}…
      </div>
    );
  return null;
}

function BottomNav({ route, nav, moreOpen, setMoreOpen }: { route: Route; nav: ReturnType<typeof computeNav>; moreOpen: boolean; setMoreOpen: (v: boolean) => void }) {
  const t = useI18n();
  const unseen = useStore(appStore, (s) => s.unseen);
  const updated = useStore(appStore, (s) => s.updated);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen, setMoreOpen]);
  const badge = (item: NavItem): string | undefined => {
    if (item.key === 'chat' && unseen > 0 && route.name !== 'chat') return unseen > 9 ? '9+' : String(unseen);
    if (item.route?.name === 'view' && updated[item.route.viewId]) return '•';
    if (item.more && nav.overflow.some((o) => o.route?.name === 'view' && updated[o.route.viewId])) return '•';
    return undefined;
  };
  return (
    <>
      {moreOpen && (
        // Stops above the tab bar, so "More" (or another tab) stays tappable while the menu is open.
        <div className="menu-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="more-menu" role="menu" aria-label={t("More")} onClick={(e) => e.stopPropagation()}>
            {nav.overflow.map((o, i) => {
              const on = isActive(o, route);
              const fresh = o.route?.name === 'view' && !!updated[o.route.viewId];
              return (
                <button
                  key={o.key}
                  type="button"
                  role="menuitem"
                  autoFocus={i === 0}
                  className={`more-item${on ? ' on' : ''}`}
                  aria-current={on ? 'page' : undefined}
                  onClick={() => {
                    setMoreOpen(false);
                    if (o.route) navigate(o.route);
                  }}
                >
                  <span className="more-icon"><Icon name={o.icon} size={20} /></span>
                  <span className="more-label">{t(o.label)}</span>
                  {fresh && <span className="more-dot" aria-label={t('Updated')} />}
                  {on && <Icon name="check" size={18} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <nav className="bottom-nav" aria-label={t("Main")}>
        {nav.slots.flatMap((item) => (item.more ? [...nav.overflow.map((o) => ({ ...o, wide: true })), item] : [item])).map((item) => {
          const wide = 'wide' in item; // shown directly in the desktop sidebar, behind "More" on phones
          const active = wide ? isActive(item, route) : isActive(item, route, nav.overflow);
          const b = badge(item);
          return (
            <button
              key={wide ? `wide-${item.key}` : item.key}
              type="button"
              className={[active ? 'on' : '', wide ? 'nav-wide' : '', item.more ? 'nav-more' : ''].filter(Boolean).join(' ')}
              aria-current={active && !item.more ? 'page' : undefined}
              aria-haspopup={item.more ? 'menu' : undefined}
              aria-expanded={item.more ? moreOpen : undefined}
              onClick={() => {
                if (item.more) setMoreOpen(!moreOpen);
                else if (item.route) navigate(item.route);
              }}
            >
              <span className="nav-icon">
                <Icon name={item.icon} />
                {b && <span className="nav-badge" aria-label={b === '•' ? 'updated' : `${b} new`}>{b}</span>}
              </span>
              <span className="nav-label">{t(item.label)}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

function Toasts() {
  const t = useI18n();
  const toasts = useStore(appStore, (s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((entry) => (
        <div key={entry.id} className={`toast ${entry.kind}`}>
          <span>{entry.text}</span>
          <button type="button" className="icon-btn small" aria-label={t("Dismiss")} onClick={() => dismissToast(entry.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
