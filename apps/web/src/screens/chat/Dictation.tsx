import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../../lib/api';
import { clock } from '../../lib/clock';
import { joinDraft, startDictation, type ActiveDictation } from '../../lib/dictation';
import { describeMicError, MicPermissionError } from '../../lib/recorder';

export type DictationPhase = 'idle' | 'connecting' | 'live' | 'finishing';
const WAVE_BARS = 36;

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
  const attempt = useRef(0);
  const latest = useRef(opts);
  latest.current = opts;

  const reset = () => {
    session.current = undefined;
    setPhase('idle');
    setLevels(Array(WAVE_BARS).fill(0));
  };

  const finish = useCallback(async () => {
    const active = session.current;
    if (!active) return;
    setPhase('finishing');
    const text = await active.finish();
    if (session.current !== active) return;
    latest.current.setText(joinDraft(base.current, text));
    reset();
    latest.current.onDone();
  }, []);

  const cancel = useCallback(() => {
    attempt.current++;
    session.current?.cancel();
    if (session.current || phase === 'connecting') latest.current.setText(base.current);
    reset();
  }, [phase]);

  const start = useCallback(async () => {
    if (session.current || phase !== 'idle') return;
    const mine = ++attempt.current;
    base.current = latest.current.text;
    setError(undefined);
    setPhase('connecting');
    setStartedAt(clock.nowMs());
    try {
      const active = await startDictation({
        onText: (text) => { if (attempt.current === mine) latest.current.setText(joinDraft(base.current, text)); },
        onLevel: (level) => { if (attempt.current === mine) setLevels((l) => [...l.slice(1), level]); },
        onLive: () => { if (attempt.current === mine) { setPhase('live'); setStartedAt(clock.nowMs()); } },
        onError: (message) => { if (attempt.current === mine) { session.current = undefined; setError(message); reset(); } },
        onLimit: () => { if (attempt.current === mine) void finish(); },
      });
      if (attempt.current !== mine) { active.cancel(); return; }
      session.current = active;
    } catch (e) {
      if (attempt.current !== mine) return;
      attempt.current++; // late events from the failed attempt must not touch the draft
      latest.current.setText(base.current);
      reset();
      setError(e instanceof MicPermissionError || (e instanceof DOMException && e.name === 'NotAllowedError') ? describeMicError(e) : describeError(e));
    }
  }, [phase, finish]);

  // Leaving the chat or the app finishes dictation (keeping the text) so the session stops billing.
  useEffect(() => {
    if (phase === 'idle') return;
    if (!opts.visible) { void finish(); return; }
    const hide = () => { if (document.visibilityState === 'hidden') void finish(); };
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('keydown', escape); };
  }, [phase, opts.visible, finish, cancel]);

  useEffect(() => () => { attempt.current++; session.current?.cancel(); }, []);

  return { phase, levels, startedAt, error, start, finish, cancel, clearError: () => setError(undefined) };
}

export type DictationControls = ReturnType<typeof useDictation>;

