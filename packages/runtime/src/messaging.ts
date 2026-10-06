import {
  newId,
  type AnyEvent,
  type Attachment,
  type BlobRef,
  type Channel,
  type EventEnvelope,
  type MessagingPort,
  type SendMessageResult,
  type ToolInput,
  type TriggerClass,
} from '@opencoach/protocol';
import type { Core } from './core';
import { localDayStartIso, nextDailyAt, quietHoursEnd } from './time';

/**
 * Messaging policy & delivery (SPEC §5.4, §5.5, [MSG-1..5]). The coach's ONLY channel to the athlete.
 * Proactive messages (wakes/heartbeats/most follow-ups) are subject to pause, budgets, minimum gap and
 * quiet hours; replies to the athlete never are.
 */

export interface TurnMessagingState {
  athleteId: string;
  turnId: string;
  cls: TriggerClass;
  triggers: AnyEvent[];
  /** Whether messages from this turn are proactive (SPEC §5.5). */
  proactive: boolean;
  /** Messaging disallowed (consolidation, consults during a live call). */
  allowMessaging: boolean;
  channel: Channel;
  replied: boolean;
  noReplyReason?: string;
  /** Texts sent this turn (cascaded call turns speak these). */
  sentTexts: string[];
  /** send_message tool-call ids that are being streamed to clients. */
  streamed: Set<string>;
}

// Parallel send_message calls and scheduler releases must share policy reservations [MSG-4].
const messageLocks = new WeakMap<Core, Map<string, Promise<unknown>>>();
function withMessageLock<T>(core: Core, athleteId: string, job: () => Promise<T>): Promise<T> {
  let locks = messageLocks.get(core);
  if (!locks) {
    locks = new Map();
    messageLocks.set(core, locks);
  }
  const previous = locks.get(athleteId) ?? Promise.resolve();
  const running = previous.then(job, job);
  const settled = running.catch(() => undefined);
  locks.set(athleteId, settled);
  void settled.then(() => { if (locks!.get(athleteId) === settled) locks!.delete(athleteId); });
  return running;
}

/** Follow-up triggers whose resulting messages count as replies, not proactive outreach. */
export function isProactiveTurn(cls: TriggerClass, triggers: AnyEvent[]): boolean {
  if (cls === 'reactive' || cls === 'call') return false;
  if (cls === 'consolidation') return true;
  if (cls === 'followup') {
    return !triggers.some(
      (e) =>
        e.type === 'call.ended' ||
        e.type === 'user.view_reverted' ||
        ((e.type === 'task.completed' || e.type === 'task.failed') && !!e.payload.originEventId) ||
        (e.type === 'schedule.fired' && (e.payload.payload as { kind?: string } | undefined)?.kind === 'first_contact'),
    );
  }
  return true;
}

export function createMessagingPort(core: Core, state: TurnMessagingState, callIdRef: { current: string }): MessagingPort {
  const port: MessagingPort = {
    noReply(reason: string) {
      state.replied = true;
      state.noReplyReason = reason;
    },
    async send(input: ToolInput<'send_message'>): Promise<SendMessageResult> {
      const callId = callIdRef.current;
      try {
        return await withMessageLock(core, state.athleteId, () => sendInner(input, callId));
      } finally {
        // resolved (sent, held or rejected): no longer a provisional bubble
        state.streamed.delete(callId);
      }
    },
  };
  return port;

  async function sendInner(input: ToolInput<'send_message'>, callId: string): Promise<SendMessageResult> {
      const idemKey = `msg:${state.turnId}:${callId}`;
      const prior = (await core.store.getIdempotent(idemKey)) as SendMessageResult | undefined;
      if (prior) return prior;

      const cancelStream = (reason: string) => {
        if (state.streamed.has(callId)) core.bus.publish(state.athleteId, { t: 'message.cancel', streamId: callId, reason });
      };

      if (!state.allowMessaging) {
        cancelStream('not allowed');
        return {
          ok: false,
          code: 'NOT_ALLOWED',
          message:
            state.cls === 'consolidation'
              ? 'You cannot message the athlete during nightly consolidation. Leave a note for tomorrow instead.'
              : 'Messaging is not available in this context (the athlete is on a live call — answer in your reply instead).',
        };
      }

      const now = core.clock.now();
      const settings = await core.store.getSettings(state.athleteId);
      const tz = settings.profile.tz;
      let heldUntil: Date | null = null;

      if (state.proactive) {
        const pause = settings.notifications.pauseUntil ? new Date(settings.notifications.pauseUntil) : null;
        if (pause && pause.getTime() > now.getTime() && !input.during_pause) {
          cancelStream('paused');
          return { ok: false, code: 'PAUSED', message: `The athlete has paused coaching until ${settings.notifications.pauseUntil}. Don't message unless it's safety-related or the agreed return date (then set during_pause: true).` };
        }
        const held = (await core.store.listHeldMessages(state.athleteId)).length;
        const today = (await core.store.countProactiveSince(state.athleteId, localDayStartIso(now, tz))) + held;
        if (today >= settings.notifications.proactivePerDay) {
          cancelStream('budget');
          return {
            ok: false,
            code: 'PROACTIVE_BUDGET_EXHAUSTED',
            message: `Daily proactive message budget reached (${settings.notifications.proactivePerDay}/day, set by the athlete). Wait for tomorrow or for the athlete to write.`,
          };
        }
        const week = (await core.store.countProactiveSince(state.athleteId, new Date(now.getTime() - 7 * 86_400_000).toISOString())) + held;
        if (week >= settings.notifications.proactivePerWeek) {
          cancelStream('budget');
          return { ok: false, code: 'PROACTIVE_BUDGET_EXHAUSTED', message: `Weekly proactive message budget reached (${settings.notifications.proactivePerWeek}/week).` };
        }
        const quietEnd = quietHoursEnd(now, tz, settings.notifications.quietHours);
        const last = await core.store.lastProactiveAt(state.athleteId);
        const gapEnd = last ? new Date(new Date(last).getTime() + settings.notifications.minGapMinutes * 60_000) : null;
        for (const c of [quietEnd, gapEnd]) {
          if (c && c.getTime() > now.getTime() && (!heldUntil || c.getTime() > heldUntil.getTime())) heldUntil = c;
        }
      }

      // attachments
      const attachments: Attachment[] = [];
      for (const a of input.attachments ?? []) {
        if (a.kind === 'blob') {
          const rec = await core.store.getBlob(state.athleteId, a.sha256);
          if (!rec) return { ok: false, code: 'NOT_FOUND', message: `No blob ${a.sha256}.` };
          attachments.push({ kind: 'blob', blob: { sha256: rec.sha256, mime: rec.mime, bytes: rec.bytes, name: rec.name } });
        } else if (a.kind === 'file') {
          const fs = core.fsFor(state.athleteId);
          const r = fs.resolve(a.path, 'read');
          const data = await fs.readFile(r.virtual);
          const name = r.virtual.split('/').pop() ?? 'file';
          const stored = await core.deps.blobs.put(state.athleteId, data, { mime: mimeFor(name), name, origin: 'coach' });
          attachments.push({ kind: 'file', path: r.virtual, blob: { sha256: stored.sha256, mime: stored.mime, bytes: stored.bytes, name } });
        } else {
          const views = await core.ui.currentViews(state.athleteId);
          if (!views.some((v) => v.viewId === a.view_id)) {
            return { ok: false, code: 'NOT_FOUND', message: `View "${a.view_id}" is not published. Publish it first (publish_ui).` };
          }
          attachments.push({ kind: 'view_card', viewId: a.view_id, params: a.params });
        }
      }

      // voice note
      let voiceNote: BlobRef | undefined;
      const wantsVoice =
        input.voice_note ??
        (settings.voice.replyWithVoiceNotes === 'always' ||
          (settings.voice.replyWithVoiceNotes === 'when_athlete_does' && state.triggers.some((e) => e.type === 'user.voice_note')));
      if (wantsVoice && core.deps.synthesizer && state.channel !== 'call') {
        try {
          const speech = await core.deps.synthesizer.synthesize(stripMarkdown(input.text), { voice: settings.voice.voice });
          const stored = await core.deps.blobs.put(state.athleteId, speech.audio, { mime: speech.mime, name: 'voice-note', origin: 'coach' });
          voiceNote = { sha256: stored.sha256, mime: stored.mime, bytes: stored.bytes, name: 'voice-note' };
        } catch (e) {
          core.log.warn('voice note synthesis failed', { error: (e as Error).message });
        }
      }

      const messageId = newId('evt', core.clock);
      const delivery = heldUntil ? 'held' : 'sent';
      const replyTo = input.reply_to ?? (state.proactive ? undefined : state.triggers.find((e) => e.actor === 'athlete')?.id);
      const event = (await core.store.appendEvent({
        id: messageId,
        athleteId: state.athleteId,
        type: 'coach.message',
        actor: 'coach',
        turnId: state.turnId,
        causationId: replyTo ?? state.triggers[0]?.id,
        payload: {
          messageId,
          text: input.text,
          attachments,
          ui: input.ui,
          voiceNote,
          notify: input.notify ?? 'normal',
          delivery,
          heldUntil: heldUntil?.toISOString(),
          proactive: state.proactive,
          channel: state.channel,
          replyTo,
        },
      })) as EventEnvelope<'coach.message'>;
      await core.store.putMessageState({
        messageId,
        athleteId: state.athleteId,
        delivery,
        heldUntil: heldUntil?.toISOString(),
        sentAt: delivery === 'sent' ? now.toISOString() : undefined,
        proactive: state.proactive,
      });

      state.replied = true;
      state.sentTexts.push(input.text);

      let result: SendMessageResult;
      if (delivery === 'sent') {
        core.bus.publish(state.athleteId, { t: 'message.end', streamId: state.streamed.has(callId) ? callId : undefined, event });
        await deliver(core, state.athleteId, event);
        result = { ok: true, messageId, delivery: 'sent' };
      } else {
        cancelStream('held');
        await core.scheduler.ensureRelease(state.athleteId, heldUntil!);
        await core.store.appendEvent({
          athleteId: state.athleteId,
          type: 'harness.notice',
          actor: 'harness',
          turnId: state.turnId,
          payload: { kind: 'held_quiet_hours', athleteVisible: false, detail: { messageId, heldUntil: heldUntil!.toISOString() } },
        });
        result = { ok: true, messageId, delivery: 'held', heldUntil: heldUntil!.toISOString() };
      }
      await core.store.putIdempotent(idemKey, result, new Date(now.getTime() + 7 * 86_400_000).toISOString());
      return result;
  }
}

/** Out-of-band delivery (push etc.) via the gateway's hook. Never throws. */
export async function deliver(core: Core, athleteId: string, event: EventEnvelope<'coach.message'>): Promise<void> {
  if (!core.deps.delivery) return;
  try {
    await core.deps.delivery(athleteId, event, { connectedClients: core.bus.connected(athleteId) });
  } catch (e) {
    core.log.warn('delivery hook failed', { athleteId, error: (e as Error).message });
  }
}

/** Release held messages whose time has come (called by the scheduler). */
export async function releaseHeld(core: Core, athleteId: string): Promise<number> {
  return withMessageLock(core, athleteId, () => releaseHeldInner(core, athleteId));
}

async function releaseHeldInner(core: Core, athleteId: string): Promise<number> {
  const now = core.clock.now();
  const settings = await core.store.getSettings(athleteId);
  const held = (await core.store.listHeldMessages(athleteId)).filter((m) => m.heldUntil && new Date(m.heldUntil).getTime() <= now.getTime());
  let n = 0;
  for (const m of held) {
    const original = await core.store.getEvent(m.messageId);
    if (!original || original.type !== 'coach.message' || Object.hasOwn(original.payload, 'tombstoned')) {
      await core.store.putMessageState({ ...m, delivery: 'sent', sentAt: now.toISOString() });
      continue;
    }
    if (m.proactive) {
      const tz = settings.profile.tz;
      const pause = settings.notifications.pauseUntil ? new Date(settings.notifications.pauseUntil) : null;
      const quietEnd = quietHoursEnd(now, tz, settings.notifications.quietHours);
      const last = await core.store.lastProactiveAt(athleteId);
      const gapEnd = last ? new Date(new Date(last).getTime() + settings.notifications.minGapMinutes * 60_000) : null;
      const today = await core.store.countProactiveSince(athleteId, localDayStartIso(now, tz));
      const week = await core.store.countProactiveSince(athleteId, new Date(now.getTime() - 7 * 86_400_000).toISOString());
      const budgetEnd = today >= settings.notifications.proactivePerDay || week >= settings.notifications.proactivePerWeek
        ? nextDailyAt(now, tz, '00:00') : null;
      const postponed = [pause, quietEnd, gapEnd, budgetEnd].filter((at): at is Date => !!at && at.getTime() > now.getTime());
      if (postponed.length) {
        const at = new Date(Math.max(...postponed.map((date) => date.getTime())));
        await core.store.putMessageState({ ...m, heldUntil: at.toISOString() });
        await core.scheduler.ensureRelease(athleteId, at);
        continue;
      }
    }
    const released = (await core.store.appendEvent({
      athleteId,
      type: 'coach.message',
      actor: 'coach',
      turnId: original.turnId,
      causationId: original.id,
      payload: { ...original.payload, delivery: 'sent', heldUntil: undefined },
    })) as EventEnvelope<'coach.message'>;
    await core.store.putMessageState({ ...m, delivery: 'sent', heldUntil: undefined, sentAt: now.toISOString() });
    core.bus.publish(athleteId, { t: 'message.end', event: released });
    await deliver(core, athleteId, released);
    n++;
  }
  return n;
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_]([^*_]+)[*_]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();
}

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    csv: 'text/csv',
    json: 'application/json',
    md: 'text/markdown',
    txt: 'text/plain',
    ics: 'text/calendar',
    html: 'text/html',
    mp3: 'audio/mpeg',
    gpx: 'application/gpx+xml',
    fit: 'application/vnd.ant.fit',
  };
  return map[ext] ?? 'application/octet-stream';
}
