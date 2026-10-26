import { useI18n } from '../lib/i18n';
import { useEffect, useState } from 'react';
import type { PublishedView } from '@opencoach/protocol';
import { Icon } from '../components/Icon';
import { ViewFrame } from '../components/ViewFrame';
import { appStore } from '../lib/appState';
import { clearUpdated } from '../lib/controller';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';

/** A full-screen coach view, plus the "Updated by your coach" marker (SPEC §9.6 step 5). */
export function ViewScreen({ view, params, active }: { view: PublishedView; params: Record<string, string>; active: boolean }) {
  const t = useI18n();
  const id = view.manifest.id;
  const updated = useStore(appStore, (s) => s.updated[id]);
  const fromCache = useStore(appStore, (s) => s.appFromCache);
  const online = useStore(appStore, (s) => s.online);
  const coachName = useStore(appStore, s => s.me?.settings.profile.coachName ?? 'Coach');
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const engaged = hovered || focused || expanded;
  useEffect(() => { setExpanded(false); if (!updated) { setHovered(false); setFocused(false); } }, [id, updated]);

  // The marker stays until dismissed, or for a while after the athlete has actually looked at the view.
  useEffect(() => {
    if (!active || !updated || engaged) return;
    const t = setTimeout(() => clearUpdated(id), 20_000);
    return () => clearTimeout(t);
  }, [active, updated, id, engaged]);

  return (
    <div className="view-screen">
      {updated && (
        <div className={`view-update-notice${expanded ? ' expanded' : ''}`} role="status" aria-label={t('View updated')}
          onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
          <span className="view-update-icon" aria-hidden="true"><Icon name="check" size={17} /></span>
          {updated.summary ? (
            <details className="view-update-copy" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
              <summary className="view-update-disclosure">
                <span><strong>{t('Updated by')} {coachName}</strong><span className="view-update-summary">{updated.summary}</span></span>
                <Icon name="chevron" size={16} />
              </summary>
              <p tabIndex={0} role="region" aria-label={t('Update details')}>{updated.summary}</p>
            </details>
          ) : <div className="view-update-copy"><strong>{t('Updated by')} {coachName}</strong></div>}
          <button type="button" className="view-update-history" aria-label={t('View history')} onClick={() => {
            clearUpdated(id); navigate({ name: 'settings', section: 'history' });
          }}><Icon name="clock" size={17} /><span>{t('History')}</span></button>
          <button type="button" className="icon-btn small" aria-label={t("Dismiss update")} onClick={() => clearUpdated(id)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {!online && fromCache && <p className="view-notice">{t("Offline: showing what was last saved.")}</p>}
      <ViewFrame key={`${id}@${view.version}`} view={view} params={params} active={active} mode="full" />
    </div>
  );
}

export function MissingView({ viewId }: { viewId: string }) {
  const t = useI18n();
  return (
    <div className="empty-screen">
      <Icon name="alert" size={32} />
      <p>
        <strong>{viewId}</strong> {t("isn't available right now.")}</p>
      <button type="button" className="btn primary" onClick={() => navigate({ name: 'chat' })}>
        {t("Back to chat")}</button>
    </div>
  );
}
