import { useId, useRef } from 'react';
import { useI18n } from '../lib/i18n';

/** Optional supporting help. Callers keep status, warnings and consequences visible. */
export function InfoButton({ label, text }: { label: string; text: string }) {
  const t = useI18n();
  const id = useId();
  const details = useRef<HTMLDetailsElement>(null);
  const about = `${t('About')} ${label}`;
  if (!('showPopover' in HTMLElement.prototype)) {
    return <details ref={details} className="info-fallback" onKeyDown={e => {
      if (e.key === 'Escape' && details.current?.open) {
        details.current.open = false;
        details.current.querySelector('summary')?.focus();
        e.stopPropagation();
      }
    }}>
      <summary className="rc-info-button" aria-label={about}><span aria-hidden="true">i</span></summary>
      <p className="info-inline">{text}</p>
    </details>;
  }
  return <>
    <button type="button" className="rc-info-button" aria-label={about} aria-haspopup="dialog" popoverTarget={id}><span aria-hidden="true">i</span></button>
    <div id={id} popover="auto" role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`} className="rc-info-popover">
      <div className="rc-info-head"><strong id={`${id}-title`}>{about}</strong><button type="button" popoverTarget={id} popoverTargetAction="hide">{t('Close')}</button></div>
      <p id={`${id}-text`}>{text}</p>
    </div>
  </>;
}
