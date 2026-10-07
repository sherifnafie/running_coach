import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clock } from '../lib/clock';
import { formatDuration } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { Icon } from './Icon';

/** Sanitized markdown (see lib/markdown.ts). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // Content is sanitized by DOMPurify with a strict allow-list.
  return <div className="md" dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Full-screen image viewer. */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <button ref={closeRef} className="icon-btn lightbox-close" type="button" aria-label="Close image" onClick={onClose}>
        <Icon name="x" />
      </button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

/** Image thumbnail that opens the lightbox. */
export function ImageThumb({ src, alt, width, height }: { src: string; alt: string; width?: number; height?: number }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (failed) return <div className="thumb-failed">Image unavailable</div>;
  return (
    <>
      <button className="thumb" type="button" onClick={() => setOpen(true)} aria-label={`Open image: ${alt}`}>
        <img src={src} alt={alt} loading="lazy" decoding="async" width={width} height={height} onError={() => setFailed(true)} />
      </button>
      {open && <Lightbox src={src} alt={alt} onClose={close} />}
    </>
  );
}

/** Compact audio player (voice notes, coach voice replies). */
export function AudioPlayer({ src, durationMs, label = 'Voice note' }: { src: string; durationMs?: number; label?: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(durationMs ? durationMs / 1000 : 0);
  const [error, setError] = useState(false);

  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setError(true));
    else a.pause();
  };
  return (
    <div className="audio-player">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPos(0);
        }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDur(d);
        }}
        onError={() => setError(true)}
      />
      <button className="icon-btn round" type="button" onClick={toggle} aria-label={playing ? `Pause ${label}` : `Play ${label}`} disabled={error}>
        <Icon name={playing ? 'pause' : 'play'} size={18} />
      </button>
      <input
        className="audio-seek"
        type="range"
        min={0}
        max={dur || 1}
        step={0.1}
        value={Math.min(pos, dur || 1)}
        aria-label={`${label} position`}
        onChange={(e) => {
          const a = ref.current;
          if (a) a.currentTime = Number(e.target.value);
          setPos(Number(e.target.value));
        }}
      />
      <span className="audio-time">{error ? 'Unavailable' : formatDuration((playing || pos > 0 ? pos : dur) * 1000)}</span>
    </div>
  );
}

/** True once an ISO `expires_at` has passed (re-renders at that moment). */
export function useExpired(expiresAt: string | undefined): boolean {
  const compute = () => (expiresAt ? Date.parse(expiresAt) <= clock.nowMs() : false);
  const [expired, setExpired] = useState(compute);
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - clock.nowMs();
    if (!(remaining > 0)) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const t = setTimeout(() => setExpired(true), Math.min(remaining, 2_000_000_000));
    return () => clearTimeout(t);
  }, [expiresAt]);
  return expired;
}

/** Re-render every `ms` (live timers). */
export function useTick(ms: number, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return n;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

/** Title and hint arrive already translated by the caller. */
export function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      <div className="card">{children}</div>
    </section>
  );
}
