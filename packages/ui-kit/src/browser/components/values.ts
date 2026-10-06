/** Shared value formatting for components: `format="distance|duration|pace|number|integer|percent|date|time|text"`. */
import type { Coach } from '../coach';
import { num } from '../util';

export const VALUE_FORMATS = ['distance', 'duration', 'pace', 'number', 'integer', 'percent', 'date', 'time', 'text'] as const;

export function formatValue(coach: Coach, v: unknown, fmt?: string | null, signed = false): string {
  if (v == null || v === '') return '';
  const n = num(v);
  const f = coach.format;
  if (!fmt || fmt === 'text' || (n === null && fmt !== 'date' && fmt !== 'time')) return String(v);
  if (fmt === 'date') return f.date(v, 'short');
  if (fmt === 'time') return f.time(v);
  const abs = signed ? Math.abs(n as number) : (n as number);
  let out: string;
  switch (fmt) {
    case 'distance':
      out = f.distance(abs);
      break;
    case 'duration':
      out = f.duration(abs, abs >= 3600 || signed ? 'short' : 'clock');
      break;
    case 'pace':
      out = f.pace(abs);
      break;
    case 'integer':
      out = f.number(abs, 0);
      break;
    case 'percent':
      out = f.percent(abs, 0);
      break;
    default:
      out = f.number(abs, Math.abs(abs) >= 100 ? 0 : 1);
  }
  if (!signed) return out;
  const x = n as number;
  return (x > 0 ? '+' : x < 0 ? '−' : '') + out;
}

/** Pick the first defined property of a row. */
export function pick(row: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!row) return undefined;
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
}
