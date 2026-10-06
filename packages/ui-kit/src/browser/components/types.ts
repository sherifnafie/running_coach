/** Workout/sport type metadata shared by calendar, week strip, lists and badges. */
import { humanize } from '../util';

export interface TypeMeta {
  label: string;
  /** One letter shown in chips so type is never conveyed by colour alone. */
  glyph: string;
}

export const TYPE_META: Record<string, TypeMeta> = {
  easy: { label: 'Easy', glyph: 'E' },
  long: { label: 'Long run', glyph: 'L' },
  tempo: { label: 'Tempo', glyph: 'T' },
  intervals: { label: 'Intervals', glyph: 'I' },
  hills: { label: 'Hills', glyph: 'H' },
  race: { label: 'Race', glyph: 'R' },
  strength: { label: 'Strength', glyph: 'S' },
  rest: { label: 'Rest', glyph: '–' },
  cross: { label: 'Cross-train', glyph: 'X' },
  other: { label: 'Other', glyph: '•' },
  run: { label: 'Run', glyph: 'R' },
  walk: { label: 'Walk', glyph: 'W' },
  hike: { label: 'Hike', glyph: 'H' },
  bike: { label: 'Bike', glyph: 'B' },
  swim: { label: 'Swim', glyph: 'S' },
};

export function typeKey(type: unknown): string {
  const t = String(type ?? 'other').toLowerCase();
  return TYPE_META[t] ? t : 'other';
}

export function typeLabel(type: unknown): string {
  const t = String(type ?? '').toLowerCase();
  return TYPE_META[t]?.label ?? (t ? humanize(t) : 'Other');
}

export function typeGlyph(type: unknown): string {
  return TYPE_META[typeKey(type)]?.glyph ?? '•';
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
