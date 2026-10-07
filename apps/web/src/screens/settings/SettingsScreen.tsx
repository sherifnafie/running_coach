import { useI18n } from '../../lib/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isValidTimeZone } from '@opencoach/protocol';
import { Section, useTick } from '../../components/Atoms';
import { describeError } from '../../lib/api';
import { appStore, type ThemePref } from '../../lib/appState';
import { signOut, toast, updateSettings } from '../../lib/controller';
import { Icon } from '../../components/Icon';
import { CoachAvatar } from '../../components/CoachAvatar';
import { clock } from '../../lib/clock';
import { auth, settingsApi } from '../../lib/endpoints';
import { formatDuration, localDayKey, toDateInputValue } from '../../lib/format';
import { addPasskey, isPasskeyCancelled, passkeysSupported } from '../../lib/passkey';
import { disablePush, enablePush, isStandalone, pushSupport } from '../../lib/push';
import { useRoute } from '../../lib/router';
import { useStore } from '../../lib/store';
import { AdminSection } from './AdminSection';
import { AiSection } from './AiSection';
import { ChangesSection, DataSection, DeleteSection, ViewHistorySection } from './DataSections';
import { HealthConnectSection } from './HealthConnectSection';
import { NumberRow, Row, SaveContext, SelectRow, TextRow, TimeRow, Toggle, useCommit, type SaveStatus } from './Controls';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const GAPS = [0, 30, 60, 120, 180, 240, 360, 720];

export function SettingsScreen() {
  const t = useI18n();
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
        <header className="settings-intro">
          <div className="settings-avatar" aria-hidden="true">{me.settings.profile.name.slice(0, 1).toUpperCase()}</div>
          <div><p className="settings-eyebrow">{me.settings.profile.name}</p><h2>{t('Your coach, your way')}</h2><p>{t('Make OpenCoach feel like you. Changes save automatically.')}</p></div>
        </header>
        <div className="settings-toolbar">
          <nav aria-label={t('Settings')} className="settings-jumps">
            {[['personalize', t("Personalize")], ['coaching', t("Coaching")], ['account', t("Account & data")]].map(([id, label]) => <button type="button" key={id} onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{label}</button>)}
          </nav>
          <p className={`save-status ${status}`} role="status" aria-live="polite">
            {status === 'saving' ? t('Saving…') : status === 'saved' ? t('Saved') : status === 'error' ? t('Could not save') : ''}
          </p>
        </div>
        <div className="settings-grid" id="settings-personalize">
        <AppearanceSection />
        <ProfileSection />
        <h2 className="settings-group" id="settings-coaching">{t('Coaching')}</h2>
        <NotificationsSection />
        <VoiceSection />
        <AiSection />
        <h2 className="settings-group" id="settings-account">{t('Account & data')}</h2>
        <PrivacySection />
        <DevicesSection />
        <CalendarSection />
        <HealthConnectSection />
        <ChangesSection />
        <ViewHistorySection />
        <DataSection />
        <DeleteSection />
        {me.athlete.isAdmin && <AdminSection />}
        <AboutSection />
        </div>
        <div className="settings-signout">
          <button type="button" className="btn block" onClick={() => void signOut()}>
            {t("Sign out of this device")}</button>
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
  const t = useI18n();
  const s = useSettings();
  const save = useCommit();
  const imageGeneration = useStore(appStore, state => state.me?.features.imageGeneration);
  return (
    <Section title={t("Profile")}>
      <TextRow label={t("Your name")} value={s.profile.name} maxLength={80} autoComplete="name" onCommit={(v) => save({ profile: { name: v } })} />
      <TextRow label={t("Coach name")} value={s.profile.coachName} maxLength={40} onCommit={(v) => save({ profile: { coachName: v } })} />
      <Row label={t("Coach avatar")}>
        <CoachAvatar name={s.profile.coachName} sha256={s.coachIdentity?.avatarSha256} />
        {s.coachIdentity?.avatarSha256 && <button type="button" className="btn" onClick={() => void save({ coachIdentity: { avatarSha256: null } })}>{t('Reset avatar')}</button>}
      </Row>
      <Toggle label={t("Let my coach change its name and avatar")} hint={t("Optional. Ask in chat for a name or image; turn this off at any time.")} checked={s.coachIdentity?.allowChanges ?? false} onChange={(allowChanges) => void save({ coachIdentity: { allowChanges } })} />
      <p className="section-hint">{t(imageGeneration ? 'Avatar generation uses a separate image service and counts toward your AI budget. Only the visual prompt is sent.' : 'Image generation is not configured. Your coach can still change its name when allowed.')}</p>
      <SelectRow
        label={t("Units")}
        value={s.profile.units}
        options={[
          { value: 'metric', label: t("Metric (km)") },
          { value: 'imperial', label: t("Imperial (mi)") },
        ]}
        onChange={(v) => save({ profile: { units: v } })}
      />
      <TextRow
        label={t("Time zone")}
        hint={t("Quiet hours and your coach's schedule follow this.")}
        value={s.profile.tz}
        list="tz-list-settings"
        validate={(v) => (isValidTimeZone(v) ? undefined : t("Unknown time zone"))}
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

// ---- persistent presentation ------------------------------------------------------------------------------------------

function AppearanceSection() {
  const t = useI18n();
  const s = useSettings();
  const save = useCommit();
  const colors = ['#c8431c', '#2563eb', '#047857', '#7c3aed', '#be185d', '#334155'];
  const { theme, accent } = s.appearance;
  const languages = [{ value: 'en', label: 'English' }, { value: 'nl', label: 'Nederlands' }, { value: 'ar', label: 'العربية' }];
  if (!languages.some((l) => l.value === s.profile.locale)) languages.push({ value: s.profile.locale, label: new Intl.DisplayNames([s.profile.locale], { type: 'language' }).of(s.profile.locale) ?? s.profile.locale });
  return (
    <Section title={t("Appearance")} hint={t("Saved across your devices. You can also ask your coach in chat.")}>
      <SelectRow label={t("App and coach language")} hint={t("Your coach replies in this language. Saved across your devices.")} value={s.profile.locale} options={languages} onChange={(locale) => save({ profile: { locale } })} />
      <fieldset className="theme-choices"><legend>{t('Theme')}</legend>
        {(['system', 'light', 'dark'] as ThemePref[]).map((value) => <button type="button" key={value} aria-pressed={theme === value} onClick={() => void save({ appearance: { theme: value } })}>
          <span className={`theme-preview ${value}`} aria-hidden="true"><span /><span /><span /></span>
          <span>{value === 'system' ? t("Match my device") : value === 'light' ? t("Light") : t("Dark")}</span>
          {theme === value && <Icon name="check" size={14} />}
        </button>)}
      </fieldset>
      <fieldset className="accent-choices"><legend>{t('Accent color')}</legend>
        <div className="accent-swatches">{colors.map((color) => <button type="button" key={color} aria-label={`${t('Choose a color')} ${color}`} aria-pressed={accent === color} style={{ '--swatch': color } as React.CSSProperties} onClick={() => void save({ appearance: { accent: color } })}>{accent === color && <Icon name="check" size={18} />}</button>)}
          <CustomColor value={accent ?? colors[0]!} />
          <button type="button" className="btn link small" onClick={() => void save({ appearance: { accent: null } })}>{t('Default')}</button>
        </div>
      </fieldset>
    </Section>
  );
}

/** Native colour picker: preview while dragging, save once when the picker commits (native `change`). */
function CustomColor({ value }: { value: string }) {
  const t = useI18n();
  const save = useCommit();
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const commit = () => {
      if (input.value !== value) void save({ appearance: { accent: input.value } }).then((ok) => { if (!ok) setDraft(value); });
    };
    input.addEventListener('change', commit);
    return () => input.removeEventListener('change', commit);
  }, [value, save]);
  return (
    <label className="custom-color" title={t('Choose a color')}>
      <input ref={ref} aria-label={t('Choose a color')} type="color" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <Icon name="plus" size={18} />
    </label>
  );
}

// ---- notifications -------------------------------------------------------------------------------------------------------

function NotificationsSection() {
  const t = useI18n();
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
    <Section title={t("Notifications")} hint={t("Your limits. Your coach cannot change them: messages are held during quiet hours and capped by these budgets.")}>
      <Toggle
        label={t("Quiet hours")}
        hint={t("Messages written during this window wait until it ends.")}
        checked={!!qh}
        onChange={(on) => save({ notifications: { quietHours: on ? { start: '22:00', end: '07:00' } : null } })}
      />
      {qh && (
        <>
          <TimeRow label={t("From")} value={qh.start} onCommit={(v) => save({ notifications: { quietHours: { start: v, end: qh.end } } })} />
          <TimeRow label={t("Until")} value={qh.end} onCommit={(v) => save({ notifications: { quietHours: { start: qh.start, end: v } } })} />
        </>
      )}
      <NumberRow label={t("Maximum proactive messages per day")} hint={t("Only messages your coach starts count. This is a ceiling, not a target. 0 means replies only.")} value={n.proactivePerDay} min={0} max={10} integer onCommit={(v) => save({ notifications: { proactivePerDay: v } })} />
      <NumberRow label={t("Maximum proactive messages per week")} hint={t("Across the last 7 days. Your coach decides when a message is useful, within both limits.")} value={n.proactivePerWeek} min={0} max={50} integer onCommit={(v) => save({ notifications: { proactivePerWeek: v } })} />
      <SelectRow
        label={t("Minimum gap between them")}
        value={n.minGapMinutes}
        options={GAPS.concat(GAPS.includes(n.minGapMinutes) ? [] : [n.minGapMinutes])
          .sort((a, b) => a - b)
          .map((m) => ({ value: m, label: m === 0 ? t("No minimum") : new Intl.NumberFormat(s.profile.locale, { style: 'unit', unit: m < 60 ? 'minute' : 'hour', unitDisplay: 'long' }).format(m < 60 ? m : m / 60) }))}
        onChange={(v) => save({ notifications: { minGapMinutes: v } })}
      />
      <Row label={t("Pause until")} hint={t("Vacation mode: your coach stays quiet until this date.")} htmlFor="pause-until">
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
              {t("Resume now")}</button>
          )}
        </div>
      </Row>
      <Toggle
        label={t("Push notifications")}
        hint={
          support === 'unsupported'
            ? t("This browser does not support push notifications.")
            : support === 'needs-install' && !isStandalone()
              ? t("On iPhone and iPad, add OpenCoach to your Home Screen first.")
              : blocked
                ? t("Blocked in your browser settings.")
                : t("On this device.")
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
  const t = useI18n();
  const s = useSettings();
  const me = useStore(appStore, (st) => st.me!);
  const save = useCommit();
  const calls = me.features.calls;
  return (
    <Section title={t("Voice")}>
      <SelectRow
        label={t("Call mode")}
        hint={calls.realtime || calls.cascaded ? t("Realtime is the most natural. Cascaded works with any model and keeps audio processing on the server.") : t("Calls are not available on this server.")}
        value={s.voice.callMode}
        options={[
          { value: 'realtime', label: calls.realtime ? t("Realtime") : t("Realtime (unavailable)") },
          { value: 'cascaded', label: calls.cascaded ? t("Cascaded") : t("Cascaded (unavailable)") },
        ]}
        onChange={(v) => save({ voice: { callMode: v } })}
      />
      <SelectRow
        label={t("Coach voice")}
        value={s.voice.voice}
        options={(VOICES.includes(s.voice.voice) ? VOICES : [s.voice.voice, ...VOICES]).map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))}
        onChange={(v) => save({ voice: { voice: v } })}
      />
      <SelectRow
        label={t("Reply with voice notes")}
        value={s.voice.replyWithVoiceNotes}
        options={[
          { value: 'never', label: t("Never") },
          { value: 'when_athlete_does', label: t("When I send one") },
          { value: 'always', label: t("Always") },
        ]}
        onChange={(v) => save({ voice: { replyWithVoiceNotes: v } })}
      />
    </Section>
  );
}

// ---- privacy & budgets --------------------------------------------------------------------------------------------------------

function PrivacySection() {
  const t = useI18n();
  const s = useSettings();
  const save = useCommit();
  return (
    <Section title={t("Privacy")}>
      <Toggle
        label={t("Keep photo location")}
        hint={t("Off: GPS data is removed from photos before your coach sees them.")}
        checked={s.privacy.keepImageLocation}
        onChange={(v) => save({ privacy: { keepImageLocation: v } })}
      />
      <Toggle
        label={t("Share feedback with developers")}
        hint={t("Off by default. Lets your coach's notes about the app reach its developers.")}
        checked={s.privacy.shareFeedbackWithDevelopers}
        onChange={(v) => save({ privacy: { shareFeedbackWithDevelopers: v } })}
      />
    </Section>
  );
}

// ---- devices ---------------------------------------------------------------------------------------------------------------------

function DevicesSection() {
  const t = useI18n();
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  useTick(1000, !!pair);
  const remaining = pair ? Date.parse(pair.expiresAt) - clock.nowMs() : 0;
  useEffect(() => {
    if (pair && remaining <= 0) setPair(undefined);
  }, [pair, remaining]);

  return (
    <Section title={t("Devices")} hint={t("Sign in on another phone or computer with a one-time code, or add a passkey to this device.")}>
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
          {t("Pair a new device")}</button>
        {pair && (
          <div className="code-box" role="status">
            <code aria-label={`Pairing code ${pair.code.split('').join(' ')}`}>{pair.code}</code>
            <span className="hint">{t("Expires in")} {formatDuration(Math.max(0, remaining))}. {t("Enter it on the new device's sign-in screen.")}</span>
            <button type="button" className="btn link small" onClick={() => void navigator.clipboard?.writeText(pair.code)}>
              {t("Copy")}</button>
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
                toast(t("Passkey added"), 'success');
              } catch (e) {
                if (!isPasskeyCancelled(e)) setMsg(describeError(e));
              }
            }}
          >
            {t("Add a passkey")}</button>
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
  const t = useI18n();
  const [url, setUrl] = useState<string | undefined>();
  const [msg, setMsg] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Section title={t("Calendar")} hint={t("Subscribe in Google, Apple or Outlook calendar to see your coach's plan. Anyone with the link can see your schedule, so keep it private.")}>
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
            {t("Show subscribe link")}</button>
        ) : (
          <>
            <input readOnly value={url} aria-label={t("Calendar subscribe URL")} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn block"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast(t("Link copied"), 'success');
                } catch {
                  toast(t("Select the link and copy it"), 'info');
                }
              }}
            >
              {t("Copy link")}</button>
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
  const t = useI18n();
  const me = useStore(appStore, (s) => s.me!);
  return (
    <Section title={t("About")}>
      <dl className="about">
        <Item k="OpenCoach" v={`harness ${me.harnessVersion}`} />
        <Item k="Account" v={me.athlete.id} />
        <Item k="Features" v={[me.features.calls.realtime && 'realtime calls', me.features.calls.cascaded && 'cascaded calls', me.features.voiceNotes && 'voice notes', me.features.push && 'push', me.features.passkeys && 'passkeys'].filter(Boolean).join(', ') || 'basic'} />
      </dl>
      {me.demoMode && (
        <p className="note" role="note">
          <strong>{t("Demo mode.")}</strong> {t("This server runs a scripted demo coach without an AI model. Replies are pre-written and nothing you say is analysed.")}</p>
      )}
      <p className="hint">{t("Your coach is an AI. It is not a doctor and cannot diagnose. If something feels wrong, stop and see a professional.")}</p>
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
