/**
 * Full-text search helpers: which payload text is searchable, how user queries become safe FTS5
 * MATCH expressions, and a plain-JS snippet used by the LIKE fallback.
 */

/**
 * Searchable text of an event payload, or undefined when the event type carries no text worth
 * indexing. Covers: athlete message text, upload captions, voice-note transcripts, schedule
 * purposes, summaries (UI publish, tasks, external changes), notice text and coach message text.
 */
export function extractSearchText(type: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim().length > 0) parts.push(v);
  };
  switch (type) {
    case 'user.message':
    case 'coach.message':
      add(p.text);
      break;
    case 'user.upload':
      add(p.caption);
      break;
    case 'user.voice_note':
      add(p.transcript);
      break;
    case 'schedule.fired':
    case 'coach.schedule_changed':
      add(p.purpose);
      break;
    case 'coach.ui_published':
    case 'task.completed':
    case 'workspace.external_change':
      add(p.summary);
      break;
    case 'task.failed':
      add(p.summary);
      add(p.error);
      break;
    case 'harness.notice':
      add(p.text);
      break;
    default:
      return undefined;
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export interface ParsedQuery {
  /** Plain search terms (phrases kept whole), lowercase-insensitive; punctuation-only terms dropped. */
  terms: Array<{ text: string; prefix: boolean }>;
}

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** Split a user query into terms: "quoted phrases" stay together, `word*` is a prefix term. */
export function parseQuery(query: string): ParsedQuery {
  const terms: ParsedQuery['terms'] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const quoted = m[1] !== undefined;
    let text = (quoted ? m[1]! : m[2]!).replace(/"/g, ' ').trim();
    let prefix = false;
    if (!quoted && text.endsWith('*')) {
      prefix = true;
      text = text.replace(/\*+$/, '');
    }
    if (text && HAS_WORD_CHAR.test(text)) terms.push({ text, prefix });
  }
  return { terms };
}

/**
 * Build a safe FTS5 MATCH expression: every term is double-quoted (so FTS syntax characters and
 * keywords in user input are inert). `mode: 'and'` requires all terms, `'or'` any term.
 */
export function buildMatch(terms: ParsedQuery['terms'], mode: 'and' | 'or'): string {
  return terms.map((t) => `"${t.text.replace(/"/g, '""')}"${t.prefix ? '*' : ''}`).join(mode === 'and' ? ' AND ' : ' OR ');
}

/** Escape a string for use inside a LIKE pattern with ESCAPE '\'. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Excerpt around the first matching term, with the match wrapped in `**`. Used by the LIKE fallback. */
export function plainSnippet(text: string, terms: ParsedQuery['terms'], radius = 60): string {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t.text.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.text.length;
    }
  }
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + len + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, at)}**${text.slice(at, at + len)}**${text.slice(at + len, end)}${end < text.length ? '…' : ''}`;
}
