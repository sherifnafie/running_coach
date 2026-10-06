import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { describeError } from '../lib/api';
import { appStore } from '../lib/appState';
import { finishOnboarding, updateSettings } from '../lib/controller';
import { addPasskey, isPasskeyCancelled, passkeysSupported } from '../lib/passkey';
import { canPromptInstall, enablePush, isIos, isStandalone, onInstallStateChange, promptInstall, pushSupport } from '../lib/push';
import { useStore } from '../lib/store';
import { Icon } from '../components/Icon';

type StepId = 'install' | 'notifications' | 'passkey';

/** Optional post-sign-in steps (SPEC §14): install to home screen, notifications, passkey. Every step can be skipped. */
export function OnboardingSteps() {
  const me = useStore(appStore, (s) => s.me);
  const steps = useMemo<StepId[]>(() => {
    const list: StepId[] = [];
    if (!isStandalone()) list.push('install');
    if (me?.features.push !== false && pushSupport() !== 'unsupported') list.push('notifications');
    if (me?.features.passkeys !== false && passkeysSupported()) list.push('passkey');
    return list;
  }, [me?.features.push, me?.features.passkeys]);
  const [i, setI] = useState(0);
  const step = steps[i];

  useEffect(() => {
    if (!step) finishOnboarding();
  }, [step]);
  if (!step) return null;

  const next = () => setI((n) => n + 1);
  return (
    <main className="auth">
      <header className="auth-brand">
        <img src="/icon.svg" alt="" width="64" height="64" />
        <h1>You're in{me ? `, ${me.athlete.displayName.split(' ')[0]}` : ''}</h1>
        <p>
          A few optional steps ({i + 1} of {steps.length})
        </p>
      </header>
      <div className="card auth-form">
        {step === 'install' && <InstallStep onNext={next} />}
        {step === 'notifications' && <NotificationsStep onNext={next} vapidKey={me?.vapidPublicKey} />}
        {step === 'passkey' && <PasskeyStep onNext={next} />}
      </div>
      <button className="btn link" type="button" onClick={finishOnboarding}>
        Skip the rest
      </button>
    </main>
  );
}

function InstallStep({ onNext }: { onNext: () => void }) {
  const canPrompt = useSyncExternalStore(onInstallStateChange, canPromptInstall, () => false);
  const ios = isIos();
  return (
    <>
      <h2>Add OpenCoach to your home screen</h2>
      {ios ? (
        <ol className="steps">
          <li>
            Tap the <strong>Share</strong> button in Safari.
          </li>
          <li>
            Choose <strong>Add to Home Screen</strong>.
          </li>
          <li>Open OpenCoach from your home screen. This is required for notifications on iPhone and iPad.</li>
        </ol>
      ) : canPrompt ? (
        <p>Install the app for a full-screen experience and reliable notifications.</p>
      ) : (
        <p>Open your browser menu and choose “Install app” or “Add to Home screen” for a full-screen experience and reliable notifications.</p>
      )}
      <div className="btn-row">
        {canPrompt && (
          <button
            className="btn primary"
            type="button"
            onClick={async () => {
              if (await promptInstall()) onNext();
            }}
          >
            Install
          </button>
        )}
        <button className={canPrompt ? 'btn' : 'btn primary'} type="button" onClick={onNext}>
          {canPrompt ? 'Not now' : 'Continue'}
        </button>
      </div>
    </>
  );
}

function NotificationsStep({ onNext, vapidKey }: { onNext: () => void; vapidKey?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  const support = pushSupport();
  return (
    <>
      <h2>Get your coach's messages</h2>
      <p>Your coach writes when it matters: today's session, a check-in, a reply. You choose quiet hours and how often in Settings, and your coach can't override them.</p>
      {support === 'needs-install' && <p className="note">On iPhone and iPad, notifications work after you add OpenCoach to your Home Screen (previous step).</p>}
      {msg && (
        <p role="alert" className="form-error">
          {msg}
        </p>
      )}
      <div className="btn-row">
        <button
          className="btn primary"
          type="button"
          disabled={busy || support !== 'supported'}
          onClick={async () => {
            setBusy(true);
            setMsg(undefined);
            const res = await enablePush(vapidKey);
            setBusy(false);
            if (res.ok) {
              void updateSettings({ notifications: { push: true } });
              onNext();
            } else setMsg(res.reason);
          }}
        >
          {busy ? 'Enabling…' : 'Enable notifications'}
        </button>
        <button className="btn" type="button" onClick={onNext}>
          Not now
        </button>
      </div>
    </>
  );
}

function PasskeyStep({ onNext }: { onNext: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  return (
    <>
      <h2>Add a passkey</h2>
      <p>
        <Icon name="check" size={16} /> Sign in with your fingerprint, face or screen lock on this device, with no code to copy.
      </p>
      {msg && (
        <p role="alert" className="form-error">
          {msg}
        </p>
      )}
      <div className="btn-row">
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(undefined);
            try {
              await addPasskey();
              onNext();
            } catch (e) {
              if (!isPasskeyCancelled(e)) setMsg(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Waiting…' : 'Add passkey'}
        </button>
        <button className="btn" type="button" onClick={onNext}>
          Skip
        </button>
      </div>
    </>
  );
}
