import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isValidTimeZone, type CallMode, type VoiceTranscriptEntry } from '@opencoach/protocol';

/** Everything the write-back files need (SPEC §11.2 step 3). */
export interface CallRecord {
  callId: string;
  mode: CallMode;
  startedAt: Date;
  endedAt: Date;
  endedBy: 'athlete' | 'coach' | 'error';
  /** Athlete IANA time zone; times are rendered in it (UTC when unknown). */
  tz: string;
  transcript: VoiceTranscriptEntry[];
  /** Notes the voice model took with the `note` tool. */
  notes: Array<{ text: string; at: string }>;
  /** consult_coach exchanges (the voice model asked the head coach something mid-call). */
  consults: Array<{ question: string; context?: string; answer?: string; error?: string; at: string }>;
  /** Reason the voice model gave to `end_call`. */
  endReason?: string;
}

export interface CallFilePaths {
  /** Virtual paths the coach can read, e.g. /history/calls/2026-10-06-call_X/transcript.md */
  transcriptPath: string;
  notesPath: string;
  /** Host directory the files were written to. */
  hostDir: string;
}

interface Stamp {
  date: string;
  time: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Local date (YYYY-MM-DD) and time (HH:MM:SS) of an instant in a time zone. */
export function localStamp(d: Date, tz: string): Stamp {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const parts: Record<string, string> = {};
  for (const p of formatterFor(zone).formatToParts(d)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function zoneName(tz: string): string {
  return isValidTimeZone(tz) ? tz : 'UTC';
}

/** `<YYYY-MM-DD>-<callId>` (local date of the call start). */
export function callDirName(startedAt: Date, callId: string, tz: string): string {
  return `${localStamp(startedAt, tz).date}-${callId}`;
}

function when(iso: string, tz: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : localStamp(d, tz).time;
}

function duration(startedAt: Date, endedAt: Date): string {
  const s = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
}

function header(title: string, rec: CallRecord): string {
  const start = localStamp(rec.startedAt, rec.tz);
  const end = localStamp(rec.endedAt, rec.tz);
  const zone = zoneName(rec.tz);
  return [
    `# ${title}`,
    '',
    `- Call: ${rec.callId} (${rec.mode})`,
    `- Started: ${start.date} ${start.time} (${zone})`,
    `- Ended: ${end.date} ${end.time} (${zone})`,
    `- Duration: ${duration(rec.startedAt, rec.endedAt)}`,
    `- Ended by: ${rec.endedBy}`,
    '',
  ].join('\n');
}

/** Entries in the order they happened (stable by timestamp; arrival order breaks ties and bad timestamps). */
export function orderedTranscript(entries: VoiceTranscriptEntry[]): VoiceTranscriptEntry[] {
  return entries
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => (Number.isNaN(a.t) || Number.isNaN(b.t) ? a.i - b.i : a.t - b.t || a.i - b.i))
    .map((x) => x.e);
}

export function renderTranscript(rec: CallRecord): string {
  const lines: string[] = [header('Call transcript', rec), '## Conversation', ''];
  const entries = orderedTranscript(rec.transcript);
  if (entries.length === 0) lines.push('_No speech was transcribed._', '');
  for (const e of entries) {
    lines.push(`**${e.role === 'athlete' ? 'Athlete' : 'Coach'}** (${when(e.at, rec.tz)}): ${e.text.trim()}`, '');
  }
  return lines.join('\n');
}

export function renderNotes(rec: CallRecord): string {
  const lines: string[] = [
    header('Call notes', rec),
    'Notes the voice front-end took during the call (facts learned, commitments). The voice front-end never writes the plan or memory; follow up on these in your own turn.',
    '',
    '## Notes',
    '',
  ];
  if (rec.notes.length === 0) lines.push('_No notes were taken._');
  for (const n of rec.notes) lines.push(`- (${when(n.at, rec.tz)}) ${n.text.trim().replace(/\n+/g, ' ')}`);
  lines.push('');
  if (rec.consults.length > 0) {
    lines.push('## Questions the voice front-end put to you during the call', '');
    for (const c of rec.consults) {
      lines.push(`### ${when(c.at, rec.tz)}`, '', `Question: ${c.question.trim()}`);
      if (c.context?.trim()) lines.push(`Context: ${c.context.trim()}`);
      lines.push(c.answer !== undefined ? `Answer given to the athlete: ${c.answer.trim()}` : `No answer (${c.error ?? 'failed'}).`, '');
    }
  }
  if (rec.endReason?.trim()) lines.push('## Ending', '', `The voice front-end ended the call: ${rec.endReason.trim()}`, '');
  return lines.join('\n');
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

/** Virtual (coach-visible) paths of a call's files, whether or not they could be written. */
export function virtualCallPaths(startedAt: Date, callId: string, tz: string): { transcriptPath: string; notesPath: string } {
  const name = callDirName(startedAt, callId, tz);
  return { transcriptPath: `/history/calls/${name}/transcript.md`, notesPath: `/history/calls/${name}/notes.md` };
}

/** Write transcript.md and notes.md under `<historyDir>/calls/<YYYY-MM-DD>-<callId>/`. */
export async function writeCallFiles(historyDir: string, rec: CallRecord): Promise<CallFilePaths> {
  const hostDir = `${historyDir.replace(/\/+$/, '')}/calls/${callDirName(rec.startedAt, rec.callId, rec.tz)}`;
  await mkdir(hostDir, { recursive: true });
  await writeAtomic(`${hostDir}/transcript.md`, renderTranscript(rec));
  await writeAtomic(`${hostDir}/notes.md`, renderNotes(rec));
  return { ...virtualCallPaths(rec.startedAt, rec.callId, rec.tz), hostDir };
}
