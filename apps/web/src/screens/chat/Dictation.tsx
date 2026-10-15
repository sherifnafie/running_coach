import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../../lib/api';
import { clock } from '../../lib/clock';
import { joinDraft, startDictation, type ActiveDictation } from '../../lib/dictation';
import { describeMicError, MicPermissionError } from '../../lib/recorder';

export type DictationPhase = 'idle' | 'connecting' | 'live' | 'finishing';
const WAVE_BARS = 36;
const isHidden = () => document.visibilityState === 'hidden';

/**
 * Live dictation into the composer draft. While active, dictated text is shown after the existing draft;
 * done keeps it for editing, cancel restores the draft as it was. Nothing is sent automatically.
 */
export function useDictation(opts: { visible: boolean; text: string; setText: (text: string) => void; onDone: () => void }) {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0));
  const [startedAt, setStartedAt] = useState(0);
  const [error, setError] = useState<string>();
  const session = useRef<ActiveDictation | undefined>(undefined);
  const base = useRef('');
  const attempt = useRef<AbortController | undefined>(undefined);
  const latest = useRef(opts);
  latest.current = opts;

  const reset = () => {
    session.current = undefined;
    setPhase('idle');
    setLevels(Array(WAVE_BARS).fill(0));
  };

  const cancel = useCallback(() => {
    const pending = attempt.current;
    attempt.current = undefined;
    pending?.abort();
    session.current?.cancel();
    if (pending) latest.current.setText(base.current);
    reset();
  }, []);

  const finish = useCallback(async () => {
    const active = session.current;
    if (!active) { cancel(); return; }
    setPhase('finishing');
    const text = await active.finish();
    if (session.current !== active) return;
    attempt.current = undefined;
    latest.current.setText(joinDraft(base.current, text));
    reset();
    latest.current.onDone();
  }, [cancel]);

  const start = useCallback(async () => {
    if (attempt.current || phase !== 'idle' || !latest.current.visible || isHidden()) return;
    const mine = new AbortController();
    attempt.current = mine;
    base.current = latest.current.text;
    setError(undefined);
    setPhase('connecting');
    setStartedAt(clock.nowMs());
    try {
      const active = await startDictation({
        onText: (text) => { if (attempt.current === mine) latest.current.setText(joinDraft(base.current, text)); },
        onLevel: (level) => { if (attempt.current === mine) setLevels((l) => [...l.slice(1), level]); },
        onLive: () => {
          if (attempt.current !== mine) return;
          if (!latest.current.visible || isHidden()) { cancel(); return; }
          setPhase('live'); setStartedAt(clock.nowMs());
        },
        onError: (message) => { if (attempt.current === mine) { attempt.current = undefined; mine.abort(); session.current = undefined; setError(message); reset(); } },
        onLimit: () => { if (attempt.current === mine) void finish(); },
      }, mine.signal);
      if (attempt.current !== mine) { active.cancel(); return; }
      session.current = active;
      if (!latest.current.visible || isHidden()) void finish();
    } catch (e) {
      if (attempt.current !== mine) return;
      attempt.current = undefined;
      mine.abort();
      latest.current.setText(base.current);
      reset();
      setError(e instanceof MicPermissionError || (e instanceof DOMException && e.name === 'NotAllowedError') ? describeMicError(e) : describeError(e));
    }
  }, [phase, finish, cancel]);

  // Leaving the chat or the app finishes dictation (keeping the text) so the session stops billing.
  useEffect(() => {
    if (phase === 'idle') return;
    if (!opts.visible || isHidden()) { void finish(); return; }
    const hide = () => { if (isHidden()) void finish(); };
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('keydown', escape); };
  }, [phase, opts.visible, finish, cancel]);

  useEffect(() => () => {
    const pending = attempt.current;
    attempt.current = undefined;
    pending?.abort();
    session.current?.cancel();
  }, []);

  return { phase, levels, startedAt, error, start, finish, cancel, clearError: () => setError(undefined) };
}

export type DictationControls = ReturnType<typeof useDictation>;

