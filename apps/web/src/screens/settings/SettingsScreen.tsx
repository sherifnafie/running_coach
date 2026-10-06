import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isValidTimeZone } from '@opencoach/protocol';
import { Section, useTick } from '../../components/Atoms';
import { describeError } from '../../lib/api';
import { appStore, type ThemePref } from '../../lib/appState';
import { setTheme, signOut, toast, updateSettings } from '../../lib/controller';
import { clock } from '../../lib/clock';
import { auth, settingsApi } from '../../lib/endpoints';
import { formatDuration, localDayKey, toDateInputValue } from '../../lib/format';
import { addPasskey, isPasskeyCancelled, passkeysSupported } from '../../lib/passkey';
import { disablePush, enablePush, isStandalone, pushSupport } from '../../lib/push';
import { useRoute } from '../../lib/router';
import { useStore } from '../../lib/store';
import { AdminSection } from './AdminSection';
import { ChangesSection, DataSection, DeleteSection, ViewHistorySection } from './DataSections';
import { HealthConnectSection } from './HealthConnectSection';
import { NumberRow, Row, SaveContext, SelectRow, TextRow, TimeRow, Toggle, useCommit, type SaveStatus } from './Controls';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const GAPS = [0, 30, 60, 120, 180, 240, 360, 720];

export function SettingsScreen() {
  const route = useRoute();
  const me = useStore(appStore, (s) => s.me);
  const [status, setStatus] = useState<SaveStatus>('idle');

  const commit = useCallback(async (patch: unknown) => {
    setStatus('saving');
    const ok = !!(await updateSettings(patch));
    setStatus(ok ? 'saved' : 'error');
    return ok;
  }, []);
  const ctx = useMemo(() => ({ commit }), [commit]);

  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (route.name === 'settings' && route.section) document.getElementById(`settings-${route.name}-${route.section}`)?.scrollIntoView();
  }, [route]);

  if (!me) return null;
  return (
    <SaveContext.Provider value={ctx}>
      <div className="settings">
        <p className={`save-status ${status}`} role="status" aria-live="polite">
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Could not save' : ''}
        </p>
        <ProfileSection />
        <AppearanceSection />
        <NotificationsSection />
        <VoiceSection />
        <PrivacySection />
        <BudgetSection />
        <DevicesSection />
        <CalendarSection />
        <HealthConnectSection />
        <ChangesSection />
        <ViewHistorySection />
        <DataSection />
        <DeleteSection />
        {me.athlete.isAdmin && <AdminSection />}
        <AboutSection />
        <div className="settings-signout">
          <button type="button" className="btn block" onClick={() => void signOut()}>
            Sign out of this device
          </button>
        </div>
      </div>
    </SaveContext.Provider>
  );
}

function useSettings() {
  return useStore(appStore, (s) => s.me!.settings);
}

// ---- profile -----------------------------------------------------------------------------------------------------

function ProfileSection() {
  const s = useSettings();
  const save = useCommit();
  return (
    <Section title="Profile">
      <TextRow label="Your name" value={s.profile.name} maxLength={80} autoComplete="name" onCommit={(v) => save({ profile: { name: v } })} />
      <TextRow label="Coach name" value={s.profile.coachName} maxLength={40} onCommit={(v) => save({ profile: { coachName: v } })} />
      <SelectRow
        label="Units"
        value={s.profile.units}
        options={[
          { value: 'metric', label: 'Metric (km)' },
          { value: 'imperial', label: 'Imperial (mi)' },
        ]}
        onChange={(v) => save({ profile: { units: v } })}
      />
      <TextRow
        label="Time zone"
        hint="Quiet hours and your coach's schedule follow this."
        value={s.profile.tz}
        list="tz-list-settings"
        validate={(v) => (isValidTimeZone(v) ? undefined : 'Unknown time zone')}
        onCommit={(v) => save({ profile: { tz: v } })}
      />
      <datalist id="tz-list-settings">
        {(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </Section>
  );
}

// ---- appearance (local only) ------------------------------------------------------------------------------------------

function AppearanceSection() {
  const theme = useStore(appStore, (s) => s.theme);
  return (
    <Section title="Appearance">
      <SelectRow<ThemePref>
        label="Theme"
        hint="Stored on this device only."
        value={theme}
        options={[
          { value: 'system', label: 'Match my device' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        onChange={setTheme}
      />
    </Section>
  );
}

// ---- notifications -------------------------------------------------------------------------------------------------------

function NotificationsSection() {
  const s = useSettings();
  const me = useStore(appStore, (st) => st.me!);
  const save = useCommit();
  const n = s.notifications;
  const qh = n.quietHours;
  const tz = s.profile.tz;
  const support = pushSupport();
  const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const [pushBusy, setPushBusy] = useState(false);
  const pausedUntil = n.pauseUntil && Date.parse(n.pauseUntil) > clock.nowMs() ? n.pauseUntil : null;

  return (
    <Section title="Notifications" hint="Your limits. Your coach cannot change them: messages are held during quiet hours and capped by these budgets.">
      <Toggle
        label="Quiet hours"
        hint="Messages written during this window wait until it ends."
        checked={!!qh}
        onChange={(on) => save({ notifications: { quietHours: on ? { start: '22:00', end: '07:00' } : null } })}
      />
      {qh && (
        <>
          <TimeRow label="From" value={qh.start} onCommit={(v) => save({ notifications: { quietHours: { start: v, end: qh.end } } })} />
          <TimeRow label="Until" value={qh.end} onCommit={(v) => save({ notifications: { quietHours: { start: qh.start, end: v } } })} />
        </>
      )}
      <NumberRow label="Proactive messages per day" hint="Messages your coach starts, not replies. 0 means only replies." value={n.proactivePerDay} min={0} max={10} integer onCommit={(v) => save({ notifications: { proactivePerDay: v } })} />
      <NumberRow label="Proactive messages per week" value={n.proactivePerWeek} min={0} max={50} integer onCommit={(v) => save({ notifications: { proactivePerWeek: v } })} />
      <SelectRow
        label="Minimum gap between them"
        value={n.minGapMinutes}
        options={GAPS.concat(GAPS.includes(n.minGapMinutes) ? [] : [n.minGapMinutes])
          .sort((a, b) => a - b)
          .map((m) => ({ value: m, label: m === 0 ? 'No minimum' : m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}` }))}
        onChange={(v) => save({ notifications: { minGapMinutes: v } })}
      />
      <Row label="Pause until" hint="Vacation mode: your coach stays quiet until this date." htmlFor="pause-until">
        <div className="input-unit">
          <input
            id="pause-until"
            type="date"
            min={localDayKey(clock.nowIso(), tz)}
            value={pausedUntil ? toDateInputValue(pausedUntil, tz) : ''}
            onChange={(e) => {
              const d = e.target.value;
              if (!d) return;
              // end of that local day
              save({ notifications: { pauseUntil: new Date(`${d}T23:59:00`).toISOString() } });
            }}
          />
          {pausedUntil && (
            <button type="button" className="btn small" onClick={() => save({ notifications: { pauseUntil: null } })}>
              Resume now
            </button>
          )}
        </div>
      </Row>
      <Toggle
        label="Push notifications"
        hint={
          support === 'unsupported'
            ? 'This browser does not support push notifications.'
            : support === 'needs-install' && !isStandalone()
              ? 'On iPhone and iPad, add OpenCoach to your Home Screen first.'
              : blocked
                ? 'Blocked in your browser settings.'
                : 'On this device.'
        }
        checked={n.push}
        disabled={pushBusy || support === 'unsupported'}
        onChange={async (on) => {
          setPushBusy(true);
          try {
            if (on) {
              const res = await enablePush(me.vapidPublicKey);
              if (!res.ok) {
                toast(res.reason, 'error');
                return;
              }
            } else await disablePush();
            await save({ notifications: { push: on } });
          } finally {
            setPushBusy(false);
          }
        }}
      />
    </Section>
  );
}

// ---- voice ----------------------------------------------------------------------------------------------------------------

function VoiceSection() {
  const s = useSettings();
  const me = useStore(appStore, (st) => st.me!);
  const save = useCommit();
  const calls = me.features.calls;
  return (
    <Section title="Voice">
      <SelectRow
        label="Call mode"
        hint={calls.realtime || calls.cascaded ? 'Realtime is the most natural. Cascaded works with any model and keeps audio processing on the server.' : 'Calls are not available on this server.'}
        value={s.voice.callMode}
        options={[
          { value: 'realtime', label: calls.realtime ? 'Realtime' : 'Realtime (unavailable)' },
          { value: 'cascaded', label: calls.cascaded ? 'Cascaded' : 'Cascaded (unavailable)' },
        ]}
        onChange={(v) => save({ voice: { callMode: v } })}
      />
      <SelectRow
        label="Coach voice"
        value={s.voice.voice}
        options={(VOICES.includes(s.voice.voice) ? VOICES : [s.voice.voice, ...VOICES]).map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))}
        onChange={(v) => save({ voice: { voice: v } })}
      />
      <SelectRow
        label="Reply with voice notes"
        value={s.voice.replyWithVoiceNotes}
        options={[
          { value: 'never', label: 'Never' },
          { value: 'when_athlete_does', label: 'When I send one' },
          { value: 'always', label: 'Always' },
        ]}
        onChange={(v) => save({ voice: { replyWithVoiceNotes: v } })}
      />
    </Section>
  );
}

// ---- privacy & budgets --------------------------------------------------------------------------------------------------------

function PrivacySection() {
  const s = useSettings();
  const save = useCommit();
  return (
    <Section title="Privacy">
      <Toggle
        label="Keep photo location"
        hint="Off: GPS data is removed from photos before your coach sees them."
        checked={s.privacy.keepImageLocation}
        onChange={(v) => save({ privacy: { keepImageLocation: v } })}
      />
      <Toggle
        label="Share feedback with developers"
        hint="Off by default. Lets your coach's notes about the app reach its developers."
        checked={s.privacy.shareFeedbackWithDevelopers}
        onChange={(v) => save({ privacy: { shareFeedbackWithDevelopers: v } })}
      />
    </Section>
  );
}

function BudgetSection() {
  const s = useSettings();
  const save = useCommit();
  return (
    <Section title="Spending limits" hint="Caps on what your coach may spend on AI each day and month. When a limit is reached your coach pauses.">
      <NumberRow label="Daily limit" unit="USD" value={s.budgets.dailyUsd} min={0} max={1000} step={0.5} onCommit={(v) => save({ budgets: { dailyUsd: v } })} />
      <NumberRow label="Monthly limit" unit="USD" value={s.budgets.monthlyUsd} min={0} max={10000} step={1} onCommit={(v) => save({ budgets: { monthlyUsd: v } })} />
    </Section>
  );
}

// ---- devices ---------------------------------------------------------------------------------------------------------------------

function DevicesSection() {
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  useTick(1000, !!pair);
  const remaining = pair ? Date.parse(pair.expiresAt) - clock.nowMs() : 0;
  useEffect(() => {
    if (pair && remaining <= 0) setPair(undefined);
  }, [pair, remaining]);

  return (
    <Section title="Devices" hint="Sign in on another phone or computer with a one-time code, or add a passkey to this device.">
      <div className="row stack">
        <button
          type="button"
          className="btn block"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(undefined);
            try {
              setPair(await auth.pairingCode());
            } catch (e) {
              setMsg(describeError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Pair a new device
        </button>
        {pair && (
          <div className="code-box" role="status">
            <code aria-label={`Pairing code ${pair.code.split('').join(' ')}`}>{pair.code}</code>
            <span className="hint">Expires in {formatDuration(Math.max(0, remaining))}. Enter it on the new device's sign-in screen.</span>
            <button type="button" className="btn link small" onClick={() => void navigator.clipboard?.writeText(pair.code)}>
              Copy
            </button>
          </div>
        )}
        {passkeysSupported() && (
          <button
            type="button"
            className="btn block"
            onClick={async () => {
              setMsg(undefined);
              try {
                await addPasskey();
                toast('Passkey added', 'success');
              } catch (e) {
                if (!isPasskeyCancelled(e)) setMsg(describeError(e));
              }
            }}
          >
            Add a passkey
          </button>
        )}
        {msg && (
          <p className="form-error" role="alert">
            {msg}
          </p>
        )}
      </div>
    </Section>
  );
}

function CalendarSection() {
  const [url, setUrl] = useState<string | undefined>();
  const [msg, setMsg] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Calendar" hint="Subscribe in Google, Apple or Outlook calendar to see your coach's plan. Anyone with the link can see your schedule, so keep it private.">
      <div className="row stack">
        {!url ? (
          <button
            type="button"
            className="btn block"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg(undefined);
              try {
                const r = await settingsApi.calendarUrl();
                setUrl(new URL(r.url, location.origin).href);
              } catch (e) {
                setMsg(describeError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Show subscribe link
          </button>
        ) : (
          <>
            <input readOnly value={url} aria-label="Calendar subscribe URL" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn block"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast('Link copied', 'success');
                } catch {
                  toast('Select the link and copy it', 'info');
                }
              }}
            >
              Copy link
            </button>
          </>
        )}
        {msg && (
          <p className="form-error" role="alert">
            {msg}
          </p>
        )}
      </div>
    </Section>
  );
}

function AboutSection() {
  const me = useStore(appStore, (s) => s.me!);
  return (
    <Section title="About">
      <dl className="about">
        <Item k="OpenCoach" v={`harness ${me.harnessVersion}`} />
        <Item k="Account" v={me.athlete.id} />
        <Item k="Features" v={[me.features.calls.realtime && 'realtime calls', me.features.calls.cascaded && 'cascaded calls', me.features.voiceNotes && 'voice notes', me.features.push && 'push', me.features.passkeys && 'passkeys'].filter(Boolean).join(', ') || 'basic'} />
      </dl>
      {me.demoMode && (
        <p className="note" role="note">
          <strong>Demo mode.</strong> This server runs a scripted demo coach without an AI model. Replies are pre-written and nothing you say is analysed.
        </p>
      )}
      <p className="hint">Your coach is an AI. It is not a doctor and cannot diagnose. If something feels wrong, stop and see a professional.</p>
    </Section>
  );
}

function Item({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
