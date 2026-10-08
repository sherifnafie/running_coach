import { useEffect, useState } from 'react';
import { describeError } from '../../lib/api';
import { appStore } from '../../lib/appState';
import { toast } from '../../lib/controller';
import { useI18n } from '../../lib/i18n';
import { disablePush, enablePush, pushDeviceState, testPush, type PushDeviceState } from '../../lib/push';
import { useStore } from '../../lib/store';
import { Row, Toggle, useCommit } from './Controls';

const hints: Record<PushDeviceState | 'checking' | 'error', string> = {
  supported: 'Enable notifications on this device.',
  unsupported: 'This browser does not support push notifications.',
  'needs-install': 'On iPhone and iPad, add OpenCoach to your Home Screen first.',
  blocked: 'Blocked. Allow notifications for OpenCoach in your phone or browser settings, then reopen the app.',
  permission: 'Notifications have not been allowed on this device.',
  unsubscribed: 'This device is not connected to notifications.',
  unregistered: 'This device needs to reconnect to notifications.',
  ready: 'Connected. Send a test to check delivery on your phone.',
  checking: 'Checking this device…',
  error: 'Could not check this device. Check your connection and try again.',
};

/** Account preference and actual device enrollment are deliberately shown separately [UI-1]. */
export function PushControl() {
  const t = useI18n();
  const me = useStore(appStore, s => s.me!);
  const save = useCommit();
  const [state, setState] = useState<PushDeviceState | 'checking' | 'error'>('checking');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const enabled = me.settings.notifications.push;
  const available = me.features.push;
  const refresh = () => pushDeviceState(me.vapidPublicKey).then(setState).catch(() => setState('error'));
  useEffect(() => {
    let active = true;
    const check = () => void pushDeviceState(me.vapidPublicKey).then(s => { if (active) setState(s); }).catch(() => { if (active) setState('error'); });
    check();
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible); };
  }, [me.vapidPublicKey, enabled]);

  async function connect() {
    setBusy(true); setResult('');
    try {
      const res = await enablePush(me.vapidPublicKey);
      if (!res.ok) { toast(res.reason, 'error'); return; }
      await save({ notifications: { push: true } });
    } catch (e) {
      toast(describeError(e), 'error');
    } finally { await refresh(); setBusy(false); }
  }

  return <>
    <Toggle label={t('Push notifications')} hint={t('Allow push notifications for your account. Each device also needs to be connected below.')}
      checked={enabled} disabled={busy || !available}
      onChange={async on => { setBusy(true); try { if (!on) await disablePush(); await save({ notifications: { push: on } }); } finally { await refresh(); setBusy(false); } }} />
    <Row label={t('This device')} hint={t(!available ? 'Push is not configured on this server.' : hints[state])}>
      <div className="btn-row">
        {state === 'ready' && enabled && available && <button type="button" className="btn small" disabled={busy}
          onClick={async () => {
            setBusy(true); setResult('');
            try { await testPush(); setResult('Test accepted by the push service. If it does not appear, check your phone notification settings and Do Not Disturb.'); }
            catch (e) { toast(describeError(e), 'error'); }
            finally { await refresh(); setBusy(false); }
          }}>{t(busy ? 'Sending…' : 'Send test notification')}</button>}
        {available && !['unsupported', 'needs-install', 'checking'].includes(state) &&
          <button type="button" className="btn small" disabled={busy} onClick={() => void connect()}>
            {t(state === 'ready' ? 'Reconnect' : 'Enable on this device')}
          </button>}
      </div>
    </Row>
    {result && <p className="note" role="status">{t(result)}</p>}
  </>;
}
