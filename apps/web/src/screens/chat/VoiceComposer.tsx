import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioPlayer, Spinner, useTick } from '../../components/Atoms';
import { Icon } from '../../components/Icon';
import { clock } from '../../lib/clock';
import { sendVoiceNote } from '../../lib/controller';
import { formatDuration } from '../../lib/format';
import { describeMicError, startRecording, type ActiveRecorder, type Recording } from '../../lib/recorder';

type Phase = 'idle' | 'starting' | 'recording' | 'stopping' | 'ready';

/** Tap to record; permission acquisition and review never implicitly send anything. */
export function useVoiceRecorder(visible: boolean) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{ audio: Recording; url: string }>();
  const recorder = useRef<ActiveRecorder | undefined>(undefined);
  const meter = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);
  const previewUrl = useRef<string | undefined>(undefined);

  const release = useCallback(() => {
    generation.current++;
    busy.current = false;
    if (meter.current) clearInterval(meter.current);
    recorder.current?.cancel();
    recorder.current = undefined;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = undefined;
  }, []);
  const cancel = useCallback(() => {
    release();
    setPhase('idle');
    setPreview(undefined);
    setLevel(0);
  }, [release]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; release(); };
  }, [release]);

  useEffect(() => {
    if (phase === 'idle' || phase === 'ready') return;
    if (!visible) { cancel(); return; }
    const hide = () => { if (document.visibilityState === 'hidden') cancel(); };
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('keydown', escape); };
  }, [phase, visible, cancel]);

  const begin = useCallback(async () => {
    if (busy.current || !visible) return;
    busy.current = true;
    const attempt = ++generation.current;
    setError(undefined);
    setPhase('starting');
    try {
      const active = await startRecording();
      if (!mounted.current || attempt !== generation.current) { active.cancel(); return; }
      recorder.current = active;
      setStartedAt(clock.nowMs());
      setPhase('recording');
      meter.current = setInterval(() => setLevel(active.level()), 100);
    } catch (e) {
      if (mounted.current && attempt === generation.current) {
        busy.current = false;
        setPhase('idle');
        setError(describeMicError(e));
      }
    }
  }, [visible]);

  const stop = useCallback(async () => {
    const active = recorder.current;
    if (!active) return;
    if (meter.current) clearInterval(meter.current);
    const attempt = generation.current;
    setPhase('stopping');
    try {
      const audio = await active.stop();
      if (!mounted.current || attempt !== generation.current) return;
      recorder.current = undefined;
      if (audio.durationMs < 600 || !audio.blob.size) {
        cancel();
        setError('That recording was too short. Tap the microphone and speak before stopping.');
        return;
      }
      const url = URL.createObjectURL(audio.blob);
      previewUrl.current = url;
      setPreview({ audio, url });
      setPhase('ready');
    } catch (e) {
      if (mounted.current && attempt === generation.current) { cancel(); setError(describeMicError(e)); }
    }
  }, [cancel]);

  const send = () => {
    if (!preview) return;
    void sendVoiceNote(preview.audio);
    cancel();
  };
  return { phase, startedAt, level, preview, error, begin, stop, cancel, send, clearError: () => setError(undefined) };
}

export function VoiceComposer({ voice, online }: { voice: ReturnType<typeof useVoiceRecorder>; online: boolean }) {
  useTick(200);
  const recording = voice.phase === 'recording';
  return (
    <div className="voice-composer">
      <div className="voice-heading" role="status" aria-live="polite">
        {recording ? <><span className="rec-dot" aria-hidden="true" /><strong>Recording</strong></> :
          voice.phase === 'ready' ? <><Icon name="mic" size={18} /><strong>Voice note</strong><span>Listen before sending</span></> :
          <><Spinner label={voice.phase === 'starting' ? 'Starting microphone' : 'Preparing preview'} /><strong>{voice.phase === 'starting' ? 'Starting microphone…' : 'Preparing preview…'}</strong></>}
      </div>
      {voice.phase === 'ready' && voice.preview ?
        <AudioPlayer src={voice.preview.url} durationMs={voice.preview.audio.durationMs} label="voice note preview" /> :
        <div className="voice-wave" aria-hidden="true">
          <span className="rec-time">{recording ? formatDuration(clock.nowMs() - voice.startedAt) : '0:00'}</span>
          <div className="voice-level">{Array.from({ length: 24 }, (_, i) => <i key={i} style={{ height: `${4 + (recording ? voice.level : 0) * (12 + (i % 5) * 10)}px` }} />)}</div>
        </div>}
      <div className="voice-controls">
        <button type="button" className="btn voice-discard" onClick={voice.cancel}><Icon name="x" size={18} />{voice.phase === 'ready' ? 'Discard' : 'Cancel'}</button>
        {recording && <button type="button" autoFocus className="btn primary" onClick={() => void voice.stop()}><Icon name="stop" size={17} /> Stop recording</button>}
        {voice.phase === 'ready' && <button type="button" autoFocus className="btn primary" onClick={voice.send} disabled={!online}><Icon name="arrow-up" size={18} /> Send voice note</button>}
      </div>
      {!online && voice.phase === 'ready' && <p className="voice-offline">Reconnect to send. Your recording is kept here.</p>}
    </div>
  );
}
