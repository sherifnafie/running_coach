import { useI18n } from '../lib/i18n';
import { useEffect } from 'react';
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

  // The marker stays until dismissed, or for a while after the athlete has actually looked at the view.
  useEffect(() => {
    if (!active || !updated) return;
    const t = setTimeout(() => clearUpdated(id), 20_000);
    return () => clearTimeout(t);
  }, [active, updated, id]);

  return (
    <div className="view-screen">
      {updated && (
        <div className="updated-marker" role="status">
          <Icon name="refresh" size={16} />
          <span>
            {t("Updated by your coach")}{updated.summary ? `: ${updated.summary}` : ''}
          </span>
          <button type="button" className="icon-btn small" aria-label={t("Dismiss")} onClick={() => clearUpdated(id)}>
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
