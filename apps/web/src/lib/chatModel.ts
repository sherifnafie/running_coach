import type { AnyEvent, EventEnvelope, StreamMessage } from '@opencoach/protocol';

/**
 * Chat state and its reducer (pure, unit-tested). Events are the durable truth; on top of them live
 * optimistic athlete bubbles (`pending`, keyed by clientId) and provisional coach bubbles (`provisional`,
 * keyed by streamId) that are replaced by the authoritative event (SPEC §5.4 [MSG-3], protocol StreamMessage).
 */

export interface PendingAttachment {
  name: string;
  mime: string;
  bytes: number;
  previewUrl?: string;
}

export interface PendingMessage {
  clientId: string;
  ts: string;
  kind: 'text' | 'upload' | 'voice';
  text: string;
  attachments: PendingAttachment[];
  voice?: { durationMs: number; previewUrl?: string };
  status: 'sending' | 'queued' | 'failed';
  /** 0..1 while uploading. */
  progress?: number;
  error?: string;
  /** sha256s already uploaded for this bubble (lets an echoed user.upload event replace it). */
  blobShas?: string[];
}

export interface Provisional {
  streamId: string;
  text: string;
  replyTo?: string;
  startedAt: string;
}

export interface LocalAnswer {
  action: 'quick_reply' | 'form_submit';
  value?: string;
  label?: string;
  formId?: string;
  values?: Record<string, unknown>;
  status: 'sending' | 'queued';
}

export interface SystemNotice {
  id: string;
  ts: string;
  kind: string;
  text: string;
}

export interface ChatState {
  /** Sorted ascending (ts, id), unique by id. */
  events: AnyEvent[];
  hasMore: boolean;
  initialLoaded: boolean;
  lastEventId?: string;
  provisional: Provisional[];
  pending: PendingMessage[];
  localAnswers: Record<string, LocalAnswer>;
  reactions: Record<string, string>;
  notices: SystemNotice[];
}

export const initialChatState: ChatState = {
  events: [],
  hasMore: false,
  initialLoaded: false,
  provisional: [],
  pending: [],
  localAnswers: {},
  reactions: {},
  notices: [],
};

export type ChatAction =
  | { type: 'history'; events: AnyEvent[]; hasMore?: boolean; mode: 'initial' | 'older' | 'newer' }
  | { type: 'event'; event: AnyEvent }
  | { type: 'stream'; message: StreamMessage; nowIso: string }
  | { type: 'pending/add'; message: PendingMessage }
  | { type: 'pending/patch'; clientId: string; patch: Partial<PendingMessage> }
  | { type: 'pending/remove'; clientId: string }
  | { type: 'answer/set'; messageId: string; answer: LocalAnswer }
  | { type: 'answer/clear'; messageId: string }
  | { type: 'reaction'; messageId: string; reaction: string | null }
  | { type: 'notice'; notice: SystemNotice }
  | { type: 'reset' };

export function compareEvents(a: AnyEvent, b: AnyEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Merge events by id (incoming wins: a held coach message is later returned as sent), keep sorted. */
export function mergeEvents(existing: AnyEvent[], incoming: AnyEvent[]): AnyEvent[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, AnyEvent>();
  for (const e of existing) byId.set(e.id, e);
  let changed = false;
  for (const e of incoming) {
    const prev = byId.get(e.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(e)) continue;
    byId.set(e.id, e);
    changed = true;
  }
  if (!changed) return existing;
  return [...byId.values()].sort(compareEvents);
}

function maxId(current: string | undefined, events: AnyEvent[]): string | undefined {
  let m = current;
  for (const e of events) if (!m || e.id > m) m = e.id;
  return m;
}

function withoutPendingMatching(pending: PendingMessage[], events: AnyEvent[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const clientIds = new Set<string>();
  const shas = new Set<string>();
  for (const e of events) {
    if (e.type === 'user.message' && e.payload.clientId) clientIds.add(e.payload.clientId);
    if (e.type === 'user.upload') for (const b of e.payload.blobs) shas.add(b.sha256);
  }
  if (clientIds.size === 0 && shas.size === 0) return pending;
  const next = pending.filter((p) => {
    if (clientIds.has(p.clientId)) return false;
    if (p.blobShas?.length && p.blobShas.every((s) => shas.has(s))) return false;
    return true;
  });
  return next.length === pending.length ? pending : next;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history': {
      const events = mergeEvents(state.events, action.events);
      return {
        ...state,
        events,
        hasMore: action.mode === 'newer' ? state.hasMore : (action.hasMore ?? state.hasMore),
        initialLoaded: state.initialLoaded || action.mode === 'initial',
        lastEventId: maxId(state.lastEventId, action.events),
        pending: withoutPendingMatching(state.pending, action.events),
      };
    }
    case 'event':
      return {
        ...state,
        events: mergeEvents(state.events, [action.event]),
        lastEventId: maxId(state.lastEventId, [action.event]),
        pending: withoutPendingMatching(state.pending, [action.event]),
      };
    case 'stream':
      return reduceStream(state, action.message, action.nowIso);
    case 'pending/add':
      if (state.pending.some((p) => p.clientId === action.message.clientId)) return state;
      return { ...state, pending: [...state.pending, action.message] };
    case 'pending/patch':
      return { ...state, pending: state.pending.map((p) => (p.clientId === action.clientId ? { ...p, ...action.patch } : p)) };
    case 'pending/remove':
      return { ...state, pending: state.pending.filter((p) => p.clientId !== action.clientId) };
    case 'answer/set':
      return { ...state, localAnswers: { ...state.localAnswers, [action.messageId]: action.answer } };
    case 'answer/clear': {
      if (!(action.messageId in state.localAnswers)) return state;
      const { [action.messageId]: _gone, ...rest } = state.localAnswers;
      return { ...state, localAnswers: rest };
    }
    case 'reaction': {
      const reactions = { ...state.reactions };
      if (action.reaction === null) delete reactions[action.messageId];
      else reactions[action.messageId] = action.reaction;
      return { ...state, reactions };
    }
    case 'notice':
      return { ...state, notices: [...state.notices.filter((n) => n.id !== action.notice.id), action.notice].slice(-20) };
    case 'reset':
      return initialChatState;
  }
}

/** Streaming reducer: message.start creates a provisional bubble, delta appends, end replaces, cancel removes. */
export function reduceStream(state: ChatState, m: StreamMessage, nowIso: string): ChatState {
  switch (m.t) {
    case 'message.start': {
      if (state.provisional.some((p) => p.streamId === m.streamId)) return state;
      return { ...state, provisional: [...state.provisional, { streamId: m.streamId, text: '', replyTo: m.replyTo, startedAt: nowIso }] };
    }
    case 'message.delta': {
      const idx = state.provisional.findIndex((p) => p.streamId === m.streamId);
      if (idx === -1) {
        // Resumed mid-stream: no start was seen. Create the bubble from the delta so text is not lost.
        return { ...state, provisional: [...state.provisional, { streamId: m.streamId, text: m.textDelta, startedAt: nowIso }] };
      }
      const provisional = state.provisional.slice();
      const cur = provisional[idx]!;
      provisional[idx] = { ...cur, text: cur.text + m.textDelta };
      return { ...state, provisional };
    }
    case 'message.end': {
      const provisional = m.streamId ? state.provisional.filter((p) => p.streamId !== m.streamId) : state.provisional;
      return {
        ...state,
        provisional,
        events: mergeEvents(state.events, [m.event]),
        lastEventId: maxId(state.lastEventId, [m.event]),
      };
    }
    case 'message.cancel': {
      if (!state.provisional.some((p) => p.streamId === m.streamId)) return state;
      return { ...state, provisional: state.provisional.filter((p) => p.streamId !== m.streamId) };
    }
    case 'event':
      return chatReducer(state, { type: 'event', event: m.event });
    default:
      return state;
  }
}

// ---- timeline ----------------------------------------------------------------------------------

export interface AnswerView {
  action: 'quick_reply' | 'form_submit' | 'notification_action';
  value?: string;
  label?: string;
  formId?: string;
  values?: Record<string, unknown>;
  /** Not yet confirmed by an event (optimistic or queued offline). */
  local?: 'sending' | 'queued';
}

export type TimelineItem =
  | { kind: 'user.message'; key: string; ts: string; event: EventEnvelope<'user.message'> }
  | { kind: 'user.upload'; key: string; ts: string; event: EventEnvelope<'user.upload'> }
  | { kind: 'user.voice_note'; key: string; ts: string; event: EventEnvelope<'user.voice_note'> }
  | { kind: 'coach.message'; key: string; ts: string; event: EventEnvelope<'coach.message'>; answer?: AnswerView }
  | { kind: 'system'; key: string; ts: string; text: string; viewId?: string; viewUpdate?: { title: string; summary: string } }
  | { kind: 'provisional'; key: string; ts: string; item: Provisional }
  | { kind: 'pending'; key: string; ts: string; item: PendingMessage };

const NOTICE_TEXT: Record<string, string> = {
  budget_warning: 'You are close to your usage budget. You can change it in Settings.',
  budget_exhausted: 'Your usage budget is used up, so your coach is paused. You can raise it in Settings.',
  allowance_exhausted: 'Your monthly AI allowance is used up, so your coach is paused. Ask your administrator to raise it, or connect your own OpenRouter key in Settings.',
  held_quiet_hours: 'A message is waiting until quiet hours end.',
  delivery_failed: 'A message could not be delivered.',
  fallback_used: 'Your coach switched to a backup model for a moment.',
  reply_fallback: 'Your coach had trouble replying and sent a short fallback.',
  turn_failed: 'Your coach hit a problem. Try again in a moment.',
  message_released: '',
  safety_flag: 'Your coach flagged something about your safety.',
};

export function noticeText(kind: string, text?: string): string {
  return text?.trim() || NOTICE_TEXT[kind] || '';
}

export interface TimelineOptions {
  viewTitle?: (viewId: string) => string | undefined;
}

export function answerFromEvent(e: EventEnvelope<'user.ui_action'>): AnswerView | undefined {
  const action = e.payload.action;
  const p = (e.payload.payload ?? {}) as Record<string, unknown>;
  if (action === 'quick_reply' || action === 'notification_action') {
    return {
      action,
      value: typeof p.value === 'string' ? p.value : undefined,
      label: typeof p.label === 'string' ? p.label : typeof p.value === 'string' ? p.value : undefined,
    };
  }
  if (action === 'form_submit') {
    return {
      action,
      formId: typeof p.form_id === 'string' ? p.form_id : undefined,
      values: p.values && typeof p.values === 'object' ? (p.values as Record<string, unknown>) : undefined,
    };
  }
  return undefined;
}

export function buildTimeline(state: ChatState, opts: TimelineOptions = {}): TimelineItem[] {
  const deleted = new Set<string>();
  const answers = new Map<string, AnswerView>();
  for (const e of state.events) {
    if (e.type === 'user.message_deleted') deleted.add(e.payload.messageId);
    else if (e.type === 'user.ui_action' && e.payload.source.messageId) {
      const a = answerFromEvent(e);
      if (a) answers.set(e.payload.source.messageId, a);
    }
  }
  const out: TimelineItem[] = [];
  for (const e of state.events) {
    if (deleted.has(e.id)) continue;
    switch (e.type) {
      case 'user.message':
        out.push({ kind: 'user.message', key: e.id, ts: e.ts, event: e });
        break;
      case 'user.upload':
        out.push({ kind: 'user.upload', key: e.id, ts: e.ts, event: e });
        break;
      case 'user.voice_note':
        out.push({ kind: 'user.voice_note', key: e.id, ts: e.ts, event: e });
        break;
      case 'coach.message': {
        // Held messages (quiet hours) are not shown until released.
        if (e.payload.delivery === 'held') break;
        if (deleted.has(e.payload.messageId)) break;
        const ev = answers.get(e.payload.messageId) ?? answers.get(e.id);
        const local = state.localAnswers[e.payload.messageId] ?? state.localAnswers[e.id];
        const answer: AnswerView | undefined = ev ?? (local ? { ...local, local: local.status } : undefined);
        out.push({ kind: 'coach.message', key: e.id, ts: e.ts, event: e, answer });
        break;
      }
      case 'coach.ui_published': {
        const title = opts.viewTitle?.(e.payload.viewId) ?? e.payload.viewId;
        out.push({ kind: 'system', key: e.id, ts: e.ts, text: `Your coach updated ${title}${e.payload.summary ? `: ${e.payload.summary}` : ''}`, viewId: e.payload.viewId,
          viewUpdate: { title, summary: e.payload.summary } });
        break;
      }
      case 'call.started':
        out.push({ kind: 'system', key: e.id, ts: e.ts, text: 'Call started' });
        break;
      case 'call.ended':
        out.push({ kind: 'system', key: e.id, ts: e.ts, text: `Call ended · ${formatCallDuration(e.payload.durationS)}` });
        break;
      case 'harness.notice': {
        if (!e.payload.athleteVisible) break;
        const text = noticeText(e.payload.kind, e.payload.text);
        if (text && e.payload.kind !== 'safety_flag') out.push({ kind: 'system', key: e.id, ts: e.ts, text });
        break;
      }
      default:
        break;
    }
  }
  for (const n of state.notices) out.push({ kind: 'system', key: `n:${n.id}`, ts: n.ts, text: n.text });
  const live: TimelineItem[] = [
    ...state.provisional.map((p): TimelineItem => ({ kind: 'provisional', key: `s:${p.streamId}`, ts: p.startedAt, item: p })),
    ...state.pending.map((p): TimelineItem => ({ kind: 'pending', key: `p:${p.clientId}`, ts: p.ts, item: p })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return [...out, ...live];
}

export function formatCallDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** Ids of coach messages that can be marked read. */
export function unreadCoachMessageIds(state: ChatState): string[] {
  return state.events.filter((e) => e.type === 'coach.message' && e.payload.delivery !== 'held').map((e) => (e as EventEnvelope<'coach.message'>).payload.messageId);
}
