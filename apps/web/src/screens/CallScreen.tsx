import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';
import { useI18n } from '../lib/i18n';
import { CoachAvatar } from '../components/CoachAvatar';
import { useTick } from '../components/Atoms';
import { appStore } from '../lib/appState';
import { callStore, endCall, isCallActive, pttCancel, pttEnd, pttStart, resetCall, setHandsFree, startCall, toggleMute, toggleSpeaker } from '../lib/calls';
import { clock } from '../lib/clock';
import { formatDuration } from '../lib/format';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';

export function pickCallMode(me: ReturnType<typeof appStore.getState>['me']): 'realtime' | 'cascaded' | undefined {
  if (!me) return undefined;
  const { realtime, cascaded } = me.features.calls;
  const pref = me.settings.voice.callMode;
  if (pref === 'realtime' && realtime) return 'realtime';
  if (pref === 'cascaded' && cascaded) return 'cascaded';
  if (realtime) return 'realtime';
  if (cascaded) return 'cascaded';
  return undefined;
}

const STATUS: Record<string, string> = {
  starting: 'Starting call…',
  connecting: 'Connecting…',
  ended: 'Call ended',
  error: 'Call failed',
};

/** The timer starts showing how long is left once the call is this close to its limit. */
const WARN_BEFORE_END_MS = 2 * 60 * 1000;

export function CallScreen() {
  const t = useI18n();
  const me = useStore(appStore, (s) => s.me);
  const call = useStore(callStore, (s) => s);
  const startedRef = useRef(false);
  const coachName = me?.settings.profile.coachName ?? 'Coach';
  const mode = pickCallMode(me);
  useTick(1000, call.phase === 'live');

  // Entering the screen starts a call unless one is already running.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (isCallActive()) return;
    resetCall();
    if (mode) void startCall(mode);
  }, [mode]);

  const live = call.phase === 'live';
  const active = live || call.phase === 'starting' || call.phase === 'connecting';
  const finished = call.phase === 'ended' || call.phase === 'error';
  const elapsed = call.startedAtMs ? clock.nowMs() - call.startedAtMs : 0;
  const leftMs = call.maxDurationS ? call.maxDurationS * 1000 - elapsed : Infinity;
  const status = live
    ? call.mode === 'cascaded' && call.recording
      ? t('Listening to you…')
      : call.agent === 'speaking'
        ? t('Speaking')
        : call.agent === 'thinking'
          ? t('Thinking…')
          : call.muted
            ? t("You're muted")
            : t('Listening')
    : t(STATUS[call.phase] ?? '');
  // Drives the animation around the avatar.
  const stage = live ? (call.muted && call.agent === 'listening' ? 'muted' : call.agent) : call.phase;

  const leave = async () => {
    if (isCallActive()) await endCall();
    navigate({ name: 'chat' });
  };

  // Minimizing keeps the call running; the bar on other screens leads back here.
  const top = (
    <div className="call-top">
      <button type="button" className="icon-btn" aria-label={t(active ? 'Minimize call' : 'Back to chat')} onClick={() => navigate({ name: 'chat' })}>
        <Icon name={active ? 'chevron-down' : 'back'} />
      </button>
      <span className="call-top-title">{t('Voice call')}</span>
    </div>
  );

  if (!mode && call.phase === 'idle') {
    return (
      <div className="call">
        {top}
        <div className="call-stage">
          <span className="call-orb-empty"><Icon name="phone-off" size={36} /></span>
          <p className="call-status">{t('Calls are not available on this server.')}</p>
        </div>
        <div className="call-after">
          <button className="btn primary" type="button" onClick={() => navigate({ name: 'chat' })}>
            {t('Back to chat')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="call" role="region" aria-label={t('Call')}>
      {top}
      <div className="call-stage">
        <div className={`call-orb ${stage}`}>
          <span className="call-ring" aria-hidden="true" />
          <span className="call-ring" aria-hidden="true" />
          <CoachAvatar key={me?.athlete.id} className="call-avatar" name={coachName} sha256={me?.settings.coachIdentity?.avatarSha256} />
          {live && call.muted && (
            <span className="call-muted-badge" aria-hidden="true">
              <Icon name="mic-off" size={16} />
            </span>
          )}
        </div>
        <h2>{coachName}</h2>
        <p className="call-status" role="status" aria-live="polite">{status}</p>
        {live && (
          <p className="call-timer">
            <span aria-label={t('Call duration')}>{formatDuration(elapsed)}</span>
            {leftMs <= WARN_BEFORE_END_MS && <span className="call-left"> · {t('Ends in')} {formatDuration(Math.max(0, leftMs))}</span>}
          </p>
        )}
        {call.error && (
          <p className="form-error" role="alert">
            {call.error}
          </p>
        )}
        {call.notice && <p className="note">{call.notice}</p>}
      </div>

      {call.transcript.length > 0 && (
        <ol className="call-captions" aria-label={t('Transcript')} aria-live="polite">
          {call.transcript.slice(-8).map((l) => (
            <li key={l.id} className={l.role}>
              <span className="sr-only">{l.role === 'coach' ? coachName : t('You')}: </span>
              {l.text}
            </li>
          ))}
        </ol>
      )}

      {live && call.mode === 'cascaded' && (
        <div className="ptt-wrap">
          <button
            type="button"
            className={`ptt${call.recording ? ' on' : ''}`}
            disabled={call.agent === 'thinking' || call.muted || call.handsFree}
            aria-pressed={call.recording}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              void pttStart();
            }}
            onPointerUp={() => void pttEnd()}
            onPointerCancel={() => pttCancel()}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault();
                if (call.recording) void pttEnd();
                else void pttStart();
              }
            }}
          >
            <Icon name="mic" size={28} />
            <span>{t(call.handsFree ? 'Hands-free is on' : call.recording ? 'Release to send' : 'Hold to talk')}</span>
          </button>
          <label className="check hands-free">
            <input type="checkbox" checked={call.handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
            <span>{t('Hands-free (detect when I stop talking)')}</span>
          </label>
        </div>
      )}

      {finished ? (
        <div className="call-after">
          {mode && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                resetCall();
                void startCall(mode);
              }}
            >
              <Icon name="phone" size={18} /> {t(call.phase === 'error' ? 'Try again' : 'Call again')}
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => navigate({ name: 'chat' })}>
            {t('Back to chat')}
          </button>
        </div>
      ) : (
        <div className="call-controls">
          <CallControl label={t(call.muted ? 'Unmute' : 'Mute')} icon={call.muted ? 'mic-off' : 'mic'} on={call.muted} disabled={!live} onClick={toggleMute} />
          <CallControl label={t('Speaker')} icon={call.speakerOn ? 'speaker' : 'speaker-off'} on={!call.speakerOn} disabled={!live} onClick={toggleSpeaker} />
          <CallControl label={t('End')} icon="phone-off" end onClick={() => void leave()} />
        </div>
      )}
    </div>
  );
}

function CallControl({ label, icon, on, end, disabled, onClick }: { label: string; icon: string; on?: boolean; end?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <div className="call-control">
      <button
        type="button"
        className={`call-btn${on ? ' on' : ''}${end ? ' end' : ''}`}
        aria-label={label}
        aria-pressed={end ? undefined : !!on}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} size={26} />
      </button>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

/** Slim bar shown on other screens while a call is running. */
export function CallBar() {
  const t = useI18n();
  const call = useStore(callStore, (s) => ({ phase: s.phase, muted: s.muted }));
  const active = call.phase === 'starting' || call.phase === 'connecting' || call.phase === 'live';
  if (!active) return null;
  return (
    <div className="call-bar" role="status">
      <span className="call-bar-dot" aria-hidden="true" />
      <button type="button" className="call-bar-return" onClick={() => navigate({ name: 'call' })}>
        {t('Call in progress')}{call.muted ? ` · ${t('muted')}` : ''}
        <span className="call-bar-hint">{t('Return')}</span>
      </button>
      <button type="button" className="icon-btn call-bar-end" aria-label={t('End call')} onClick={() => void endCall()}>
        <Icon name="phone-off" size={18} />
      </button>
    </div>
  );
}
