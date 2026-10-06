import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';
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
};

export function CallScreen() {
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
  const elapsed = call.startedAtMs ? clock.nowMs() - call.startedAtMs : 0;
  const status =
    call.phase === 'live'
      ? call.mode === 'cascaded' && call.recording
        ? 'Listening to you…'
        : call.agent === 'speaking'
          ? `${coachName} is speaking`
          : call.agent === 'thinking'
            ? `${coachName} is thinking…`
            : call.muted
              ? 'You are muted'
              : 'Listening'
      : (STATUS[call.phase] ?? '');

  const leave = async () => {
    if (isCallActive()) await endCall();
    navigate({ name: 'chat' });
  };

  if (!mode && call.phase === 'idle') {
    return (
      <div className="call">
        <div className="call-body">
          <Icon name="phone-off" size={40} />
          <p>Calls are not available on this server.</p>
          <button className="btn primary" type="button" onClick={() => navigate({ name: 'chat' })}>
            Back to chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="call" role="region" aria-label="Call">
      <div className="call-body">
        <div className={`call-avatar ${call.agent}${live ? ' live' : ''}`} aria-hidden="true">
          {coachName.slice(0, 1).toUpperCase()}
        </div>
        <h2>{coachName}</h2>
        <p className="call-status" role="status" aria-live="polite">
          {call.phase === 'error' ? 'Call failed' : status}
        </p>
        {live && (
          <p className="call-timer" aria-label="Call duration">
            {formatDuration(elapsed)}
            {call.maxDurationS ? ` / ${formatDuration(call.maxDurationS * 1000)}` : ''}
          </p>
        )}
        {call.error && (
          <p className="form-error" role="alert">
            {call.error}
          </p>
        )}
        {call.notice && <p className="note">{call.notice}</p>}

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
              <Icon name="mic" size={32} />
              <span>{call.handsFree ? 'Hands-free is on' : call.recording ? 'Release to send' : 'Hold to talk'}</span>
            </button>
            <label className="check hands-free">
              <input type="checkbox" checked={call.handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
              <span>Hands-free (detect when I stop talking)</span>
            </label>
          </div>
        )}

        {call.transcript.length > 0 && (
          <ol className="call-transcript" aria-label="Transcript" aria-live="polite">
            {call.transcript.slice(-8).map((l) => (
              <li key={l.id} className={l.role}>
                <strong>{l.role === 'coach' ? coachName : 'You'}:</strong> {l.text}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="call-controls">
        {live && (
          <>
            <button type="button" className={`call-btn${call.muted ? ' on' : ''}`} aria-pressed={call.muted} onClick={toggleMute}>
              <Icon name={call.muted ? 'mic-off' : 'mic'} />
              <span>{call.muted ? 'Unmute' : 'Mute'}</span>
            </button>
            <button type="button" className={`call-btn${call.speakerOn ? '' : ' on'}`} aria-pressed={!call.speakerOn} onClick={toggleSpeaker}>
              <Icon name={call.speakerOn ? 'speaker' : 'speaker-off'} />
              <span>Speaker</span>
            </button>
          </>
        )}
        {(live || call.phase === 'starting' || call.phase === 'connecting') && (
          <button type="button" className="call-btn end" onClick={() => void leave()}>
            <Icon name="phone-off" />
            <span>End</span>
          </button>
        )}
        {(call.phase === 'ended' || call.phase === 'error') && (
          <>
            <button type="button" className="btn primary" onClick={() => navigate({ name: 'chat' })}>
              Back to chat
            </button>
            {mode && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  resetCall();
                  void startCall(mode);
                }}
              >
                {call.phase === 'error' ? 'Try again' : 'Call again'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Slim bar shown on other screens while a call is running. */
export function CallBar() {
  const call = useStore(callStore, (s) => ({ phase: s.phase, muted: s.muted }));
  const active = call.phase === 'starting' || call.phase === 'connecting' || call.phase === 'live';
  if (!active) return null;
  return (
    <div className="call-bar" role="status">
      <Icon name="phone" size={18} />
      <span>Call in progress{call.muted ? ' (muted)' : ''}</span>
      <button type="button" className="btn small" onClick={() => navigate({ name: 'call' })}>
        Return
      </button>
      <button type="button" className="btn small danger" onClick={() => void endCall()}>
        End
      </button>
    </div>
  );
}
