/**
 * Session and sport type metadata shared by calendar, week strip, lists and badges. Types are free text
 * written by the coach: known words get a fixed colour, label and letter; any other word gets a stable
 * colour from a hash (classes rc-type-x1..x8), a humanized label and its first letter, so a new sport or
 * session type is always distinguishable without a kit change.
 */
import { humanize } from '../util';

export interface TypeMeta {
  label: string;
  /** One letter shown in chips so type is never conveyed by colour alone. */
  glyph: string;
}

export const TYPE_META: Record<string, TypeMeta> = {
  // session intent, any sport
  easy: { label: 'Easy', glyph: 'E' },
  recovery: { label: 'Recovery', glyph: 'R' },
  technique: { label: 'Technique', glyph: 'T' },
  skill: { label: 'Skill', glyph: 'K' },
  test: { label: 'Test', glyph: '!' },
  mobility: { label: 'Mobility', glyph: 'M' },
  conditioning: { label: 'Conditioning', glyph: 'C' },
  competition: { label: 'Competition', glyph: '★' },
  rest: { label: 'Rest', glyph: '–' },
  cross: { label: 'Cross-train', glyph: 'X' },
  other: { label: 'Other', glyph: '•' },
  // endurance
  long: { label: 'Long', glyph: 'L' },
  tempo: { label: 'Tempo', glyph: 'T' },
  intervals: { label: 'Intervals', glyph: 'I' },
  hills: { label: 'Hills', glyph: 'H' },
  race: { label: 'Race', glyph: '★' },
  // strength
  strength: { label: 'Strength', glyph: 'S' },
  heavy: { label: 'Heavy', glyph: 'H' },
  power: { label: 'Power', glyph: 'P' },
  hypertrophy: { label: 'Hypertrophy', glyph: 'V' },
  meet: { label: 'Meet', glyph: '★' },
  // sports
  run: { label: 'Run', glyph: 'R' },
  walk: { label: 'Walk', glyph: 'W' },
  hike: { label: 'Hike', glyph: 'H' },
  bike: { label: 'Bike', glyph: 'B' },
  swim: { label: 'Swim', glyph: 'S' },
  row: { label: 'Row', glyph: 'R' },
  climb: { label: 'Climb', glyph: 'C' },
  yoga: { label: 'Yoga', glyph: 'Y' },
};

const HASHED_CLASSES = 8;

function norm(type: unknown): string {
  return String(type ?? '').trim().toLowerCase();
}

/** CSS-safe key for a type: the known word itself, or x1..x8 chosen by a stable hash of the word. */
export function typeKey(type: unknown): string {
  const t = norm(type);
  if (!t) return 'other';
  if (TYPE_META[t]) return t;
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `x${(h % HASHED_CLASSES) + 1}`;
}

export function typeLabel(type: unknown): string {
  const t = norm(type);
  return TYPE_META[t]?.label ?? (t ? humanize(t) : 'Other');
}

export function typeGlyph(type: unknown): string {
  const t = norm(type);
  if (TYPE_META[t]) return TYPE_META[t].glyph;
  const first = humanize(t).charAt(0);
  return first ? first.toUpperCase() : '•';
}

export const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  done: 'Done',
  partial: 'Partly done',
  skipped: 'Skipped',
  moved: 'Moved',
};

export function statusLabel(status: unknown): string {
  const s = String(status ?? 'planned');
  return STATUS_LABEL[s] ?? humanize(s);
}

/** A plan/activity row as consumed by rc-calendar and rc-week-strip. */
export interface DayItem {
  id: string;
  date: string;
  type: string;
  title: string;
  status: string;
  movable: boolean;
  row: Record<string, unknown>;
}

export function toDayItems(rows: Array<Record<string, unknown>> | null | undefined, movableStatuses: string[]): DayItem[] {
  const out: DayItem[] = [];
  for (const r of rows ?? []) {
    const date = typeof r.date === 'string' ? r.date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const status = r.status == null || r.status === '' ? 'planned' : String(r.status);
    const source = r.source == null ? '' : String(r.source);
    out.push({
      id: String(r.id ?? `${date}-${out.length}`),
      date,
      type: String(r.type ?? 'other').toLowerCase(),
      title: String(r.title ?? typeLabel(r.type)),
      status,
      movable: (source === '' || source === 'planned') && movableStatuses.includes(status) && r.movable !== 0 && r.movable !== false,
      row: r,
    });
  }
  return out;
}

export const DONE_STATUSES = ['done', 'partial'];
