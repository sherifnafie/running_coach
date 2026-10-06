import type { AnyEvent, BlobRef, ContentPart, UserItem } from '@opencoach/protocol';
import { formatLocal } from './time';

/**
 * Rendering of events into the model's context (docs/implementation.md "Context rendering").
 * Header: "[<local time> · <type> · <event id>]" followed by a body.
 */

export const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'application/vnd.ant.fit': 'fit',
  'application/fit': 'fit',
  'application/gpx+xml': 'gpx',
  'application/vnd.garmin.tcx+xml': 'tcx',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/json': 'json',
  'text/plain': 'txt',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

export function rawPath(b: BlobRef): string {
  const fromName = b.name ? /\.([A-Za-z0-9]{1,8})$/.exec(b.name)?.[1]?.toLowerCase() : undefined;
  const ext = EXT_FOR_MIME[b.mime] ?? fromName ?? 'bin';
  return `/raw/${b.sha256}.${ext}`;
}

export function isImage(b: BlobRef): boolean {
  return /^image\/(png|jpeg|webp|gif|heic|heif)$/.test(b.mime);
}

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function duration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function json(v: unknown, max = 1500): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function eventHeader(e: AnyEvent, tz: string): string {
  return `[${formatLocal(e.ts, tz)} · ${e.type} · ${e.id}]`;
}

export interface RenderOptions {
  tz: string;
  /** Extra text for system.heartbeat (HEARTBEAT.md contents). */
  heartbeat?: string;
  /** Extra text for system.consolidate (consolidation addendum). */
  consolidation?: string;
}

/** Body text for a trigger event (what the coach is being woken for). */
export function renderTriggerBody(e: AnyEvent, opts: RenderOptions): string {
  switch (e.type) {
    case 'user.message': {
      const p = e.payload;
      const lines = [`Athlete${p.channel !== 'app' ? ` (via ${p.channel})` : ''}: ${p.text}`];
      if (p.replyTo) lines.push(`(replying to ${p.replyTo})`);
      if (p.attachments.length) lines.push(`Attachments: ${p.attachments.map((a) => `${rawPath(a)} (${a.mime}, ${kb(a.bytes)})`).join(', ')}`);
      return lines.join('\n');
    }
    case 'user.upload': {
      const p = e.payload;
      const lines = [`Athlete sent ${p.blobs.length} file${p.blobs.length === 1 ? '' : 's'}${p.caption ? ` with the message: "${p.caption}"` : ''}:`];
      for (const b of p.blobs) lines.push(`- ${rawPath(b)} (${b.mime}, ${kb(b.bytes)}${b.name ? `, originally "${b.name}"` : ''})`);
      return lines.join('\n');
    }
    case 'user.voice_note': {
      const p = e.payload;
      return `Athlete (voice note, ${duration(p.durationS)}): ${p.transcript}\nAudio: ${rawPath(p.blob)}`;
    }
    case 'user.ui_action':
      return renderUiAction(e);
    case 'schedule.fired': {
      const p = e.payload;
      return `Wake-up you scheduled (${p.scheduleId}, set ${formatLocal(p.createdAt, opts.tz)}): ${p.purpose}${p.payload !== undefined ? `\nPayload: ${json(p.payload)}` : ''}`;
    }
    case 'system.heartbeat':
      return `Daily heartbeat. Work through your checklist (HEARTBEAT.md):\n${opts.heartbeat?.trim() || '(HEARTBEAT.md is empty)'}`;
    case 'system.consolidate':
      return opts.consolidation?.trim() || 'Nightly consolidation: tidy your notes and write briefing.md for tomorrow. Do not message the athlete.';
    case 'task.completed': {
      const p = e.payload;
      return `Helper task ${p.taskId}${p.profile ? ` (${p.profile})` : ''} finished.\nSummary: ${p.summary}${p.outputs.length ? `\nOutputs: ${p.outputs.join(', ')}` : ''}${p.originEventId ? `\n(Started for athlete event ${p.originEventId}.)` : ''}`;
    }
    case 'task.failed': {
      const p = e.payload;
      return `Helper task ${p.taskId}${p.profile ? ` (${p.profile})` : ''} failed: ${p.error}\n${p.summary}`;
    }
    case 'call.started':
      return `A call with the athlete started (${e.payload.mode}, ${e.payload.model}).`;
    case 'call.ended': {
      const p = e.payload;
      return (
        `Your call with the athlete ended (${duration(p.durationS)}, ended by ${p.endedBy}).\n` +
        `Transcript: ${p.transcriptPath}\nNotes from the voice front-end: ${p.notesPath}\n` +
        'Read them, update your notes and plan where needed, and send the athlete a short recap of what you agreed.'
      );
    }
    case 'ui.error': {
      const p = e.payload;
      return `View "${p.viewId}" v${p.version} reported an error on the athlete's device (${p.device.viewport}): ${p.message}${p.stack ? `\n${p.stack.split('\n').slice(0, 6).join('\n')}` : ''}\nThe app fell back to the previous version if one exists. Fix it when you can.`;
    }
    case 'user.view_reverted': {
      const p = e.payload;
      return `The athlete reverted view "${p.viewId}" from v${p.fromVersion} to v${p.toVersion}. Your ui/views/${p.viewId} now matches v${p.toVersion}. Take the hint before changing it again.`;
    }
    case 'workspace.external_change': {
      const p = e.payload;
      return `Your workspace was edited outside a turn (${p.filesChanged} file${p.filesChanged === 1 ? '' : 's'}; commits ${p.commits.map((c) => c.slice(0, 8)).join(', ')}): ${p.summary}\nReview the change (git show) and respect it.`;
    }
    case 'harness.upgraded': {
      const p = e.payload;
      return `The harness was upgraded from ${p.from} to ${p.to}. Read ${p.changelogPath} and adapt your workspace if useful. Only message the athlete if something they'd notice changed.`;
    }
    case 'data.synced': {
      const p = e.payload;
      return `New health data synced from ${p.source} (${p.range[0]} → ${p.range[1]}): ${p.blobs.map(rawPath).join(', ')}`;
    }
    default:
      return renderPassiveLine(e, opts.tz) || json(e.payload);
  }
}

export function renderUiAction(e: AnyEvent): string {
  if (e.type !== 'user.ui_action') return '';
  const p = e.payload;
  const payload = (p.payload ?? {}) as Record<string, unknown>;
  const src = p.source.messageId ? `on message ${p.source.messageId}` : p.source.viewId ? `in view "${p.source.viewId}"` : '';
  switch (p.action) {
    case 'quick_reply':
      return `Athlete tapped quick reply "${String(payload.label ?? payload.value ?? '')}"${payload.value !== undefined && payload.label !== undefined && payload.label !== payload.value ? ` (value: ${String(payload.value)})` : ''} ${src}`.trim();
    case 'form_submit':
      return `Athlete submitted form "${String(payload.form_id ?? '')}" ${src}: ${json(payload.values ?? payload)}`.trim();
    case 'notification_action':
      return `Athlete tapped "${String(payload.label ?? payload.value ?? '')}" on the notification for message ${p.source.messageId ?? '?'}`;
    default:
      return `Athlete triggered "${p.action}" ${src}${p.payload !== undefined ? `: ${json(p.payload)}` : ''}`.trim();
  }
}

/** One line for non-waking events shown under "Also since your last turn". '' = skip. */
export function renderPassiveLine(e: AnyEvent, tz: string): string {
  const t = formatLocal(e.ts, tz).slice(11, 16);
  switch (e.type) {
    case 'user.ui_write': {
      const p = e.payload;
      return `${t} Athlete changed ${p.target} via view "${p.viewId}": ${p.op} ${json(p.row, 400)}${p.key ? ` where ${json(p.key, 200)}` : ''}`;
    }
    case 'user.reaction':
      return `${t} Athlete reacted ${e.payload.reaction} to your message ${e.payload.messageId}`;
    case 'user.message_deleted':
      return `${t} Athlete deleted their message ${e.payload.messageId}`;
    case 'user.settings_changed':
      return `${t} Athlete changed settings: ${Object.entries(e.payload.diff)
        .map(([k, v]) => `${k}: ${json(v.from, 80)} → ${json(v.to, 80)}`)
        .join('; ')}`;
    case 'device.context':
      return `${t} Athlete's device reports time zone ${e.payload.tz}, locale ${e.payload.locale}`;
    case 'user.ui_action':
      return `${t} ${renderUiAction(e)}`;
    case 'coach.ui_published':
      return `${t} View "${e.payload.viewId}" v${e.payload.version} published: ${e.payload.summary}`;
    default:
      return '';
  }
}

/** Build the user item for a turn: trigger events + passive events + image parts. */
export function buildTriggerItem(
  triggers: AnyEvent[],
  passive: AnyEvent[],
  opts: RenderOptions & { images?: ContentPart[]; extraText?: string },
): UserItem {
  const blocks: string[] = [];
  for (const e of triggers) blocks.push(`${eventHeader(e, opts.tz)}\n${renderTriggerBody(e, opts)}`);
  const passiveLines = passive.map((e) => renderPassiveLine(e, opts.tz)).filter(Boolean);
  if (passiveLines.length) blocks.push(`Also since your last turn:\n${passiveLines.map((l) => `- ${l}`).join('\n')}`);
  if (opts.extraText) blocks.push(opts.extraText);
  const parts: ContentPart[] = [{ type: 'text', text: blocks.join('\n\n') }];
  for (const img of opts.images ?? []) parts.push(img);
  return { kind: 'user', parts };
}
