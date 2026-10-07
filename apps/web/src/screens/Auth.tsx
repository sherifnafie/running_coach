import { useState, type FormEvent } from 'react';
import { SetupRequest, isValidTimeZone } from '@opencoach/protocol';
import { describeError } from '../lib/api';
import { appStore } from '../lib/appState';
import { onAuthenticated, boot } from '../lib/controller';
import { auth } from '../lib/endpoints';
import { deviceLabel, isPasskeyCancelled, loginWithPasskey, passkeysSupported } from '../lib/passkey';
import { useStore } from '../lib/store';

function detectTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <header className="auth-brand">
      <img src="/icon.svg" alt="" width="64" height="64" />
      <h1>OpenCoach</h1>
      <p>{subtitle}</p>
    </header>
  );
}

/** `?invite=CODE` in the address bar: an invite link from Settings → Admin. */
function inviteFromUrl(): string | undefined {
  try {
    return new URLSearchParams(location.search).get('invite')?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates an account with a code: the first-run setup code (administrator), or an invite code from an
 * administrator (`invite`). The server accepts both on the same route.
 */
export function SetupScreen({ invite, initialCode = '', onBack }: { invite?: boolean; initialCode?: string; onBack?: () => void } = {}) {
  const locale = navigator.language || 'en';
  const [code, setCode] = useState(initialCode);
  const [displayName, setDisplayName] = useState('');
  const [coachName, setCoachName] = useState('Coach');
  const [tz, setTz] = useState(detectTz());
  const [loc, setLoc] = useState(locale);
  const [units, setUnits] = useState<'metric' | 'imperial'>('metric');
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
      setError(parsed.error.issues[0]?.message ?? 'Please check the form.');
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

  return (
    <main className="auth">
      <Brand subtitle={invite ? 'Join with your invite' : 'Set up your coach'} />
      <form className="card auth-form" onSubmit={submit} aria-describedby={error ? 'auth-error' : undefined}>
        <label className="field">
          <span>{invite ? 'Invite code' : 'Setup code'}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCapitalize="characters" inputMode="text" required name="setup-code" />
          <small>{invite ? 'From the person who invited you. It works once, for 24 hours.' : "From the server's first-run output or your administrator."}</small>
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={80} required name="name" />
        </label>
        <label className="field">
          <span>Name your coach</span>
          <input value={coachName} onChange={(e) => setCoachName(e.target.value)} maxLength={40} required name="coach-name" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Time zone</span>
            <input value={tz} onChange={(e) => setTz(e.target.value)} list="tz-list" aria-invalid={!tzOk} name="tz" />
            {!tzOk && <small className="err">Unknown time zone</small>}
          </label>
          <label className="field">
            <span>Language</span>
            <input value={loc} onChange={(e) => setLoc(e.target.value)} name="locale" />
          </label>
        </div>
        <fieldset className="field">
          <legend>Units</legend>
          <div className="segmented" role="radiogroup">
            {(['metric', 'imperial'] as const).map((u) => (
              <label key={u} className={units === u ? 'on' : ''}>
                <input type="radio" name="units" checked={units === u} onChange={() => setUnits(u)} />
                {u === 'metric' ? 'Metric (km)' : 'Imperial (mi)'}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="consents">
          <legend>Before we start</legend>
          <label className="check">
            <input type="checkbox" checked={healthData} onChange={(e) => setHealthData(e.target.checked)} name="consent-health" />
            <span>I agree that my health and training data is processed to coach me. It is treated as sensitive data and I can export or delete it at any time.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={aiDisclosure} onChange={(e) => setAiDisclosure(e.target.checked)} name="consent-ai" />
            <span>I understand my coach is an AI, not a human and not a medical professional.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} name="consent-age" />
            <span>I am 18 or older.</span>
          </label>
        </fieldset>

        {error && (
          <p id="auth-error" role="alert" className="form-error">
            {error}
          </p>
        )}
        <button className="btn primary block" type="submit" disabled={!ready || busy}>
          {busy ? 'Setting up…' : 'Create my coach'}
        </button>
        {onBack && (
          <button className="btn link block" type="button" onClick={onBack} disabled={busy}>
            I already have an account
          </button>
        )}
      </form>
      <datalist id="tz-list">
        {(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </main>
  );
}

export function SignInScreen() {
  const [inviteCode] = useState(inviteFromUrl);
  const [joining, setJoining] = useState(!!inviteCode);
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
    <main className="auth">
      <Brand subtitle="Welcome back" />
      <div className="card auth-form">
        {passkeys && (
          <>
            <button className="btn primary block" type="button" onClick={passkey} disabled={busy}>
              Sign in with a passkey
            </button>
            <p className="divider">or</p>
          </>
        )}
        <form onSubmit={pair}>
          <label className="field">
            <span>Pairing code from another device</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-2345" autoCapitalize="characters" autoComplete="one-time-code" name="pairing-code" />
            <small>On a signed-in device, open Settings → Devices → Pair a new device. Lost every device? Ask your administrator for a recovery code.</small>
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="btn block" type="submit" disabled={busy || code.trim().length < 4}>
            {busy ? 'Signing in…' : 'Pair this device'}
          </button>
        </form>
        <p className="divider">new here?</p>
        <button className="btn block" type="button" onClick={() => setJoining(true)} disabled={busy}>
          I have an invite code
        </button>
      </div>
    </main>
  );
}

export function UnreachableScreen() {
  const err = useStore(appStore, (s) => s.bootError);
  return (
    <main className="auth">
      <Brand subtitle="Can't reach your coach" />
      <div className="card auth-form">
        <p>{err ?? 'The server did not answer. Check your connection.'}</p>
        <button className="btn primary block" type="button" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    </main>
  );
}
