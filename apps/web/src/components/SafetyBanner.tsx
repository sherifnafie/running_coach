import { t, useI18n } from '../lib/i18n';
import { appStore } from '../lib/appState';
import { dismissSafety } from '../lib/controller';
import { guidanceFor } from '../lib/safety';
import { useStore } from '../lib/store';
import { Icon } from './Icon';

/**
 * Harness-owned safety banner (SPEC §12.2 [SAFE-2]). Rendered by the shell from stream/notice data only: coach
 * views, messages and markdown cannot reach this component or hide it. Dismissal is "for now" (per notice).
 */
export function SafetyBanner() {
  const t = useI18n();
  const safety = useStore(appStore, (s) => s.safety);
  if (!safety) return null;
  const lines = guidanceFor(safety.categories);
  return (
    <section className={`safety-banner${safety.acute ? ' acute' : ''}`} role="alert" aria-label={t("Safety notice")}>
      <Icon name="alert" size={22} />
      <div className="safety-body">
        <p className="safety-title">{safety.acute ? t("This may be urgent") : t("Please look after yourself first")}</p>
        {safety.text && <p>{t(safety.text)}</p>}
        {lines.map((l) => (
          <p key={l}>{t(l)}</p>
        ))}
      </div>
      <button className="btn small" type="button" onClick={dismissSafety}>
        {t("Dismiss for now")}</button>
    </section>
  );
}
