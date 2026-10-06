import { clock } from './clock';

/** Presentation helpers (time zone aware, no "now" outside the clock adapter). */

function safeTz(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function formatTime(iso: string, tz?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: safeTz(tz) }).format(new Date(iso));
}

/** yyyy-mm-dd of an instant in a time zone (used to group messages by local day). */
export function localDayKey(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: safeTz(tz) }).format(new Date(iso));
}

export function formatDayLabel(iso: string, tz?: string, locale?: string): string {
  const today = localDayKey(clock.nowIso(), tz);
  const yesterday = localDayKey(new Date(clock.nowMs() - 86_400_000).toISOString(), tz);
  const key = localDayKey(iso, tz);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
    timeZone: safeTz(tz),
  }).format(new Date(iso));
}

export function formatDateTime(iso: string, tz?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: safeTz(tz) }).format(new Date(iso));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function lcFirstIfVerbing(label: string): string {
  const first = label.split(/\s+/)[0] ?? '';
  return /ing[,.…]?$/i.test(first) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** "Looking at your splits…" → "Coach is looking at your splits…" */
export function presenceLabel(coachName: string, progress: string | undefined, state: string): string {
  if (progress) {
    const l = lcFirstIfVerbing(progress.trim());
    return /ing\b/i.test(progress.split(/\s+/)[0] ?? '') ? `${coachName} is ${l}` : `${coachName}: ${progress.trim()}`;
  }
  if (state === 'typing') return `${coachName} is typing…`;
  if (state === 'thinking') return `${coachName} is thinking…`;
  if (state === 'working') return `${coachName} is working on it…`;
  return '';
}

/** Local `YYYY-MM-DD` of an instant (for date inputs). */
export function toDateInputValue(iso: string | null | undefined, tz?: string): string {
  if (!iso) return '';
  return localDayKey(iso, tz);
}

export function timeAgo(iso: string): string {
  const diff = clock.nowMs() - Date.parse(iso);
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
