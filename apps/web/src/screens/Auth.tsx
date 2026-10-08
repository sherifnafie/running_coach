import { useState, type FormEvent, type ReactNode } from 'react';
import { SetupRequest, isValidTimeZone } from '@opencoach/protocol';
import { Icon } from '../components/Icon';
import { describeError } from '../lib/api';
import { appStore } from '../lib/appState';
import { onAuthenticated, boot } from '../lib/controller';
import { auth } from '../lib/endpoints';
import { useI18n } from '../lib/i18n';
import { languageName, languageOptions } from '../lib/languages';
import { deviceLabel, isPasskeyCancelled, loginWithPasskey, passkeysSupported } from '../lib/passkey';
import { useStore } from '../lib/store';

/**
 * First-visit screens: the landing page (sign in, or join with an invite), the account form used for invites and the
 * first-run setup, and the "can't reach" screen. Text follows the browser's language until an account exists.
 */

function detectTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `?invite=CODE` in the address bar: an invite link from Settings → Admin. */
function inviteFromUrl(): string | undefined {
  try {
    return new URLSearchParams(location.search).get('invite')?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function Brand() {
  return (
    <div className="landing-brand">
      <img src="/icon.svg" alt="" width="40" height="40" />
      <span>OpenCoach</span>
    </div>
  );
}

/** The short "what is this" next to (desktop) or above (phone) the card. `compact` drops the lead and features. */
function Intro({ compact }: { compact?: boolean }) {
  const t = useI18n();
  const features: Array<[string, string]> = [
    ['plan', t('Plans built from your own training, for any sport')],
    ['chat', t('A coach that checks in, adapts and remembers')],
    ['shield', t('Your data stays on this server, and you can export or delete it')],
  ];
  return (
    <header className={`landing-intro${compact ? ' compact' : ''}`}>
      <Brand />
      <h1>{t('Your AI coach, in your pocket')}</h1>
      <p className="landing-lead">{t('Tell it what you train and what you want. It plans with you, keeps an eye on how it goes and adjusts, in your language.')}</p>
      <ul className="landing-features">
        {features.map(([icon, text]) => (
          <li key={icon}>
            <span className="landing-feature-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
            {text}
          </li>
        ))}
      </ul>
    </header>
  );
}

function Landing({ children, compactIntro }: { children: ReactNode; compactIntro?: boolean }) {
  return (
    <main className="landing">
      <div className="landing-inner">
        <Intro compact={compactIntro} />
        <section className="landing-card">{children}</section>
      </div>
    </main>
  );
}

function ErrorLine({ error }: { error?: string }) {
  return error ? <p id="auth-error" role="alert" className="form-error">{error}</p> : null;
}

/**
 * Creates an account with a code: the first-run setup code (administrator), or an invite code from an
 * administrator (`invite`). The server accepts both on the same route.
 */
export function SetupScreen({ invite, initialCode = '', onBack }: { invite?: boolean; initialCode?: string; onBack?: () => void } = {}) {
  const t = useI18n();
  const browserLocale = navigator.language || 'en';
  const [code, setCode] = useState(initialCode);
  const [editCode, setEditCode] = useState(!initialCode);
  const [displayName, setDisplayName] = useState('');
  const [coachName, setCoachName] = useState('Coach');
  const [tz, setTz] = useState(detectTz());
  const [loc, setLoc] = useState(browserLocale);
  const [units, setUnits] = useState<'metric' | 'imperial'>('metric');
  const [editPrefs, setEditPrefs] = useState(false);
  const [healthData, setHealthData] = useState(false);
  const [aiDisclosure, setAiDisclosure] = useState(false);
  const [age, setAge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const tzOk = isValidTimeZone(tz);
  const ready = code.trim().length >= 4 && displayName.trim() && coachName.trim() && tzOk && loc.trim().length >= 2 && healthData && aiDisclosure && age;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setError(undefined);
    const body = {
      code: code.trim(),
      displayName: displayName.trim(),
      coachName: coachName.trim(),
      tz,
      locale: loc.trim(),
      units,
      consents: { healthData: true, aiDisclosure: true, ageConfirmed18: true },
      deviceName: deviceLabel(),
    };
    const parsed = SetupRequest.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('Please check the form.'));
      return;
    }
    setBusy(true);
    try {
      const res = await auth.setup(parsed.data);
      if (invite && location.search) history.replaceState(null, '', location.pathname + location.hash);
      await onAuthenticated(res, { fresh: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const unitLabel = units === 'metric' ? t('Metric (km)') : t('Imperial (mi)');

  return (
    <Landing compactIntro>
      <div className="landing-card-head">
        <h2>{invite ? t('Join with your invite') : t('Set up your coach')}</h2>
        <p>{invite ? t('A few details and your coach is ready.') : t('You are creating the first account, which administers this server.')}</p>
      </div>
      <form onSubmit={submit} aria-describedby={error ? 'auth-error' : undefined}>
        {editCode ? (
          <label className="field">
            <span>{invite ? t('Invite code') : t('Setup code')}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCapitalize="characters" inputMode="text" required name="setup-code" placeholder="ABCD-2345" />
            <small>{invite ? t('From the person who invited you. It works once, for 24 hours.') : t("From the server's first-run output.")}</small>
          </label>
        ) : (
          <div className="code-chip">
            <Icon name="check" size={18} />
            <span>{t('Invite code')} <strong>{code}</strong></span>
            <button type="button" className="text-btn" onClick={() => setEditCode(true)}>{t('Change')}</button>
            <input type="hidden" name="setup-code" value={code} />
          </div>
        )}
        <label className="field">
          <span>{t('Your name')}</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="given-name" maxLength={80} required name="name" />
        </label>
        <label className="field">
          <span>{t('Name your coach')}</span>
          <input value={coachName} onChange={(e) => setCoachName(e.target.value)} maxLength={40} required name="coach-name" />
          <small>{t('You can change it later.')}</small>
        </label>

        {editPrefs ? (
          <div className="prefs-edit">
            <label className="field">
              <span>{t('Time zone')}</span>
              <input value={tz} onChange={(e) => setTz(e.target.value)} list="tz-list" aria-invalid={!tzOk} name="tz" />
              {!tzOk && <small className="err">{t('Unknown time zone')}</small>}
            </label>
            <label className="field">
              <span>{t('Language')}</span>
              <select value={loc} onChange={(e) => setLoc(e.target.value)} name="locale">
                {languageOptions(loc).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <fieldset className="field">
              <legend>{t('Units')}</legend>
              <div className="segmented" role="radiogroup">
                {(['metric', 'imperial'] as const).map((u) => (
                  <label key={u} className={units === u ? 'on' : ''}>
                    <input type="radio" name="units" checked={units === u} onChange={() => setUnits(u)} />
                    {u === 'metric' ? t('Metric (km)') : t('Imperial (mi)')}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        ) : (
          <div className="prefs-summary">
            <Icon name="map" size={18} />
            <span>{[tz.replace(/_/g, ' '), languageName(loc), unitLabel].join(' · ')}</span>
            <button type="button" className="text-btn" onClick={() => setEditPrefs(true)}>{t('Change')}</button>
          </div>
        )}

        <fieldset className="consents">
          <legend>{t('Before we start')}</legend>
          <label className="check">
            <input type="checkbox" checked={healthData} onChange={(e) => setHealthData(e.target.checked)} name="consent-health" />
            <span>{t('I agree that my health and training data is processed to coach me. It is treated as sensitive data and I can export or delete it at any time.')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={aiDisclosure} onChange={(e) => setAiDisclosure(e.target.checked)} name="consent-ai" />
            <span>{t('I understand my coach is an AI, not a human and not a medical professional.')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} name="consent-age" />
            <span>{t('I am 18 or older.')}</span>
          </label>
        </fieldset>

        <ErrorLine error={error} />
        <button className="btn primary block lg" type="submit" disabled={!ready || busy}>
          {busy ? t('Setting up…') : t('Create my coach')}
        </button>
        {onBack && (
          <button className="text-btn block" type="button" onClick={onBack} disabled={busy}>
            {t('I already have an account')}
          </button>
        )}
      </form>
      <datalist id="tz-list">
        {(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </Landing>
  );
}

export function SignInScreen() {
  const t = useI18n();
  const [inviteCode] = useState(inviteFromUrl);
  const [joining, setJoining] = useState(!!inviteCode);
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const passkeys = passkeysSupported();

  async function pair(e: FormEvent) {
    e.preventDefault();
    if (code.trim().length < 4 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await auth.pair({ code: code.trim(), deviceName: deviceLabel() });
      await onAuthenticated(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function passkey() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await loginWithPasskey();
      await onAuthenticated(res);
    } catch (err) {
      if (!isPasskeyCancelled(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (joining) return <SetupScreen invite initialCode={inviteCode} onBack={() => setJoining(false)} />;

  return (
    <Landing>
      <div className="landing-card-head">
        <h2>{t('Welcome')}</h2>
        <p>{t('Sign in, or join with the invite you were sent.')}</p>
      </div>
      <div className="landing-actions">
        {passkeys && (
          <button className="btn primary block lg" type="button" onClick={passkey} disabled={busy}>
            <Icon name="key" size={18} /> {t('Sign in with a passkey')}
          </button>
        )}
        <button className={`btn block lg${passkeys ? '' : ' primary'}`} type="button" onClick={() => setJoining(true)} disabled={busy}>
          {t('I have an invite code')}
        </button>
      </div>
      {pairing ? (
        <form onSubmit={pair} className="pair-form">
          <label className="field">
            <span>{t('Code from another device')}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-2345" autoCapitalize="characters" autoComplete="one-time-code" name="pairing-code" autoFocus />
            <small>{t('On a signed-in device, open Settings → Devices → Pair a new device. Lost every device? Ask your administrator for a recovery code.')}</small>
          </label>
          <ErrorLine error={error} />
          <button className="btn block" type="submit" disabled={busy || code.trim().length < 4}>
            {busy ? t('Signing in…') : t('Pair this device')}
          </button>
        </form>
      ) : (
        <>
          <ErrorLine error={error} />
          <button className="text-btn block" type="button" onClick={() => setPairing(true)}>
            {t('Use a code from another device')}
          </button>
        </>
      )}
    </Landing>
  );
}

export function UnreachableScreen() {
  const t = useI18n();
  const err = useStore(appStore, (s) => s.bootError);
  return (
    <Landing compactIntro>
      <div className="landing-card-head">
        <h2>{t("Can't reach your coach")}</h2>
        <p>{err ?? t('The server did not answer. Check your connection.')}</p>
      </div>
      <button className="btn primary block lg" type="button" onClick={() => void boot()}>
        {t('Try again')}
      </button>
    </Landing>
  );
}
