/**
 * Rendered transcripts (/history/YYYY/MM/DD.md) and the one-line event renderer the runtime also
 * uses for the epoch transcript. Output is plain text/markdown, one line per event, with
 * continuation lines indented by two spaces. Pure trace events render as ''.
 */
import * as path from 'node:path';
import { EVENT_TYPES, type AnyEvent, type AthletePaths, type EventType, type Store } from '@opencoach/protocol';
import { atomicWriteFile } from './fsutil';
import { extForMime } from './mime';
import { localDate, localDateTime, localDayRange, localHm, parseYmd, weekdayName } from './tz';

/** Events that carry no transcript value. */
const TRACE_TYPES: ReadonlySet<string> = new Set(['coach.turn', 'user.read', 'device.context']);

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function short(s: string, n = 300): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function json(v: unknown, n = 300): string {
  try {
    return short(JSON.stringify(v) ?? '', n);
  } catch {
    return '(unserializable)';
  }
}

function duration(s: unknown): string {
  const total = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** First line after `head`; further lines indented so they never look like a new event. */
function lines(head: string, text: string): string {
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  return [head + parts[0], ...parts.slice(1).map((l) => (l.length ? `  ${l}` : ''))].join('\n');
}

function blobRaw(b: unknown): string {
  const r = rec(b);
  const mime = str(r['mime']) || 'application/octet-stream';
  const name = str(r['name']);
  return `/raw/${str(r['sha256'])}.${extForMime(mime)} (${mime}${name ? `, "${name}"` : ''})`;
}

function blobPlain(b: unknown): string {
  const r = rec(b);
  const mime = str(r['mime']) || 'application/octet-stream';
  const name = str(r['name']);
  return `${name ? `"${name}"` : `blob ${str(r['sha256']).slice(0, 8)}`} (${mime})`;
}

function attachmentList(label: string, items: string[]): string {
  return items.length ? `\n  ${label}: ${items.join(', ')}` : '';
}

/**
 * Render one event as markdown/plain text for transcripts (one or more lines, no trailing newline),
 * with times in `tz`. Returns '' for pure trace events (coach.turn, user.read, device.context).
 */
export function renderEventLine(e: AnyEvent, tz: string): string {
  if (TRACE_TYPES.has(e.type)) return '';
  const ms = new Date(e.ts).getTime();
  const time = Number.isNaN(ms) ? '??:??' : localHm(ms, tz);
  const head = `${time} · `;
  try {
    return renderBody(e, tz, ms, head);
  } catch {
    return `${head}${e.type} (unrenderable payload)`;
  }
}

function renderBody(e: AnyEvent, tz: string, ms: number, head: string): string {
  const p = rec(e.payload);
  switch (e.type) {
    case 'user.message': {
      const channel = str(p['channel']);
      const who = channel && channel !== 'app' ? `Athlete (${channel})` : 'Athlete';
      const text = typeof p['text'] === 'string' ? p['text'] : '[deleted]';
      return lines(`${head}${who}: `, text) + attachmentList('Attachments', arr(p['attachments']).map(blobRaw));
    }
    case 'user.upload': {
      const blobs = arr(p['blobs']);
      const caption = str(p['caption']);
      return `${head}Athlete: (uploaded ${blobs.length} file${blobs.length === 1 ? '' : 's'})${caption ? ` ${short(caption, 1000)}` : ''}` + attachmentList('Attachments', blobs.map(blobRaw));
    }
    case 'user.voice_note': {
      const transcript = str(p['transcript']);
      return lines(`${head}Athlete (voice note, ${duration(p['durationS'])}): `, transcript || '(no transcript)') + attachmentList('Audio', [blobRaw(p['blob'])]);
    }
    case 'user.ui_action': {
      const src = rec(p['source']);
      const action = str(p['action']);
      const payload = rec(p['payload']);
      const where = [src['messageId'] ? `on message ${str(src['messageId'])}` : '', src['viewId'] ? `in view ${str(src['viewId'])}` : ''].filter(Boolean).join(' ');
      let what: string;
      if (action === 'quick_reply') what = `Athlete tapped quick reply "${str(payload['value'])}"`;
      else if (action === 'form_submit') {
        const values = rec(payload['values']);
        const kv = Object.entries(values).map(([k, v]) => `${k}=${typeof v === 'string' ? v : json(v, 80)}`);
        what = `Athlete submitted form "${str(payload['form_id'] ?? payload['formId'])}"${kv.length ? `: ${short(kv.join(', '), 600)}` : ''}`;
      } else if (action === 'notification_action') what = `Athlete chose notification action "${str(payload['value'])}"`;
      else what = `Athlete UI action "${action}"${p['payload'] !== undefined ? ` ${json(p['payload'], 200)}` : ''}`;
      return `${head}${what}${where ? ` ${where}` : ''}${p['wake'] === false ? ' (no wake)' : ''}`;
    }
    case 'user.ui_write': {
      const op = str(p['op']);
      const key = p['key'] !== undefined ? ` key ${json(p['key'], 120)}` : '';
      return `${head}Athlete edited data in view ${str(p['viewId'])}: ${op} ${str(p['target'])}${key} ${json(p['row'], 300)}`.trimEnd();
    }
    case 'user.reaction':
      return `${head}Athlete reacted ${str(p['reaction'])} to message ${str(p['messageId'])}`;
    case 'user.settings_changed': {
      const diff = rec(p['diff']);
      const changes = Object.entries(diff).map(([k, v]) => `${k}: ${json(rec(v)['from'], 60)} → ${json(rec(v)['to'], 60)}`);
      return lines(`${head}Athlete changed settings: `, changes.length ? changes.join('; ') : '(no differences)');
    }
    case 'user.message_deleted':
      return `${head}Athlete deleted message ${str(p['messageId'])}`;
    case 'user.view_reverted':
      return `${head}Athlete reverted view ${str(p['viewId'])} from v${str(p['fromVersion'])} to v${str(p['toVersion'])}`;
    case 'call.started':
      return `${head}Call started (${str(p['mode'])}, ${str(p['provider'])}/${str(p['model'])})`;
    case 'call.ended':
      return `${head}Call ended after ${duration(p['durationS'])} (by ${str(p['endedBy'])}). Transcript: ${str(p['transcriptPath'])}, notes: ${str(p['notesPath'])}`;
    case 'schedule.fired':
      return lines(`${head}Schedule fired: `, str(p['purpose']) || '(no purpose)');
    case 'system.heartbeat':
      return `${head}Heartbeat`;
    case 'system.consolidate':
      return `${head}Nightly consolidation started`;
    case 'task.completed': {
      const outputs = arr(p['outputs']).map(str);
      return lines(`${head}Task ${str(p['taskId'])}${p['profile'] ? ` (${str(p['profile'])})` : ''} completed: `, str(p['summary'])) + (outputs.length ? `\n  Outputs: ${outputs.join(', ')}` : '');
    }
    case 'task.failed':
      return lines(`${head}Task ${str(p['taskId'])}${p['profile'] ? ` (${str(p['profile'])})` : ''} failed: `, `${str(p['summary'])}${p['error'] ? ` [${short(str(p['error']), 300)}]` : ''}`);
    case 'ui.error':
      return `${head}UI error in ${str(p['viewId'])}@${str(p['version'])}: ${short(str(p['message']), 300)}`;
    case 'workspace.external_change':
      return lines(`${head}Workspace edited outside the coach (${str(p['filesChanged'])} files): `, str(p['summary']));
    case 'harness.upgraded':
      return `${head}Harness upgraded from ${str(p['from'])} to ${str(p['to'])} (changelog: ${str(p['changelogPath'])})`;
    case 'data.synced': {
      const blobs = arr(p['blobs']);
      const range = arr(p['range']).map(str);
      return `${head}Data synced from ${str(p['source'])} (${blobs.length} file${blobs.length === 1 ? '' : 's'}${range.length === 2 ? `, ${range[0]} to ${range[1]}` : ''})` + attachmentList('Files', blobs.map(blobRaw));
    }
    case 'coach.message': {
      let out = lines(`${head}Coach: `, str(p['text']));
      if (p['delivery'] === 'held') {
        const until = p['heldUntil'] ? new Date(str(p['heldUntil'])).getTime() : NaN;
        let when = '';
        if (!Number.isNaN(until)) when = localDate(until, tz) === localDate(ms, tz) ? localHm(until, tz) : localDateTime(until, tz);
        out += ` (held until ${when || 'later'})`;
      }
      const atts: string[] = [];
      for (const a of arr(p['attachments'])) {
        const r = rec(a);
        if (r['kind'] === 'file') atts.push(`${str(r['path'])} (${str(rec(r['blob'])['mime'])})`);
        else if (r['kind'] === 'blob') atts.push(blobPlain(r['blob']));
        else if (r['kind'] === 'view_card') atts.push(`view card ${str(r['viewId'])}`);
      }
      out += attachmentList('Attachments', atts);
      if (p['voiceNote']) out += `\n  Voice note: ${blobPlain(p['voiceNote'])}`;
      const ui = rec(p['ui']);
      const qr = arr(ui['quick_replies']).map((q) => {
        const r = rec(q);
        return str(r['label']) === str(r['value']) ? `"${str(r['label'])}"` : `"${str(r['label'])}" (${str(r['value'])})`;
      });
      if (qr.length) out += `\n  Quick replies: ${qr.join(', ')}`;
      const form = rec(ui['form']);
      if (Object.keys(form).length) {
        const fields = arr(form['fields']).map((f) => `${str(rec(f)['label'])} [${str(rec(f)['type'])}]`);
        out += `\n  Form ${form['title'] ? `"${str(form['title'])}" ` : ''}(${str(form['id'])}): ${fields.join(', ')}`;
      }
      const na = arr(ui['notification_actions']).map((q) => `"${str(rec(q)['label'])}"`);
      if (na.length) out += `\n  Notification actions: ${na.join(', ')}`;
      return out;
    }
    case 'coach.ui_published':
      return `${head}Coach published view ${str(p['viewId'])} v${str(p['version'])}: ${short(str(p['summary']), 300)}`;
    case 'coach.schedule_changed': {
      const purpose = str(p['purpose']);
      const verb = ({ create: 'created', update: 'updated', cancel: 'cancelled' } as Record<string, string>)[str(p['op'])] ?? str(p['op']);
      return `${head}Coach ${verb} schedule ${str(p['scheduleId'])}${purpose ? `: ${short(purpose, 300)}` : ''}`;
    }
    case 'harness.notice': {
      const visible = p['athleteVisible'] === true;
      const text = str(p['text']) || (p['detail'] !== undefined ? json(p['detail'], 200) : '');
      return lines(`${head}Notice (${visible ? 'shown to athlete' : 'internal'}, ${str(p['kind'])}): `, text || '(no text)');
    }
    default:
      return `${head}${(e as { type: string }).type}`;
  }
}

/** Render one local day's markdown (header + event lines). */
export function renderDayMarkdown(ymd: string, events: AnyEvent[], tz: string): string {
  const header = `# ${ymd} (${weekdayName(ymd)})\n`;
  const body = events.map((e) => renderEventLine(e, tz)).filter((l) => l.length > 0);
  return `${header}\n${body.length ? body.join('\n') : '_No events._'}\n`;
}

const RENDERED_TYPES: EventType[] = EVENT_TYPES.filter((t) => !TRACE_TYPES.has(t));

/**
 * (Re)render /history/YYYY/MM/DD.md for each athlete-local day in `days` ("YYYY-MM-DD", in `tz`).
 * The UTC range of each local day is computed per day, so DST days (23/25 h) are exact.
 * Existing files are overwritten.
 */
export async function renderHistory(opts: { paths: AthletePaths; store: Store; athleteId: string; tz: string; days: string[] }): Promise<void> {
  const { paths, store, athleteId, tz } = opts;
  const days = [...new Set(opts.days)].sort();
  for (const day of days) parseYmd(day); // validate before touching disk
  for (const day of days) {
    const { start, end } = localDayRange(day, tz);
    const collected: AnyEvent[] = [];
    let afterId: string | undefined;
    for (;;) {
      const batch = await store.listEvents({
        athleteId,
        types: RENDERED_TYPES,
        since: new Date(start - 1).toISOString(),
        until: new Date(end).toISOString(),
        order: 'asc',
        limit: 500,
        ...(afterId ? { afterId } : {}),
      });
      for (const e of batch) {
        const t = new Date(e.ts).getTime();
        if (t >= start && t < end) collected.push(e);
      }
      if (batch.length < 500) break;
      const last = batch[batch.length - 1]!.id;
      if (last === afterId) break;
      afterId = last;
    }
    collected.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [y, m, d] = day.split('-') as [string, string, string];
    await atomicWriteFile(path.join(paths.history, y, m, `${d}.md`), renderDayMarkdown(day, collected, tz));
  }
}

