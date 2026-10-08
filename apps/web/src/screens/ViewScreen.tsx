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
  const engaged = hovered || focused;
  useEffect(() => { if (!updated) { setHovered(false); setFocused(false); } }, [updated]);

  // The marker stays until dismissed, or for a while after the athlete has actually looked at the view.
  useEffect(() => {
    if (!active || !updated || engaged) return;
    const t = setTimeout(() => clearUpdated(id), 20_000);
    return () => clearTimeout(t);
  }, [active, updated, id, engaged]);

  return (
    <div className="view-screen">
      {updated && (
        <div className="view-update-notice" role="status" aria-label={t('View updated')}
          onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
          <span className="view-update-icon" aria-hidden="true"><Icon name="check" size={17} /></span>
          <div className="view-update-copy"><strong>{t('Updated by')} {coachName}</strong>
            {updated.summary && <p>{updated.summary}</p>}
          </div>
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
