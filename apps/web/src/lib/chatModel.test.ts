import { describe, expect, it } from 'vitest';
import type { AnyEvent, EventEnvelope, StreamMessage } from '@opencoach/protocol';
import { buildTimeline, chatReducer, initialChatState, mergeEvents, type ChatAction, type ChatState, type PendingMessage } from './chatModel';

let n = 0;
function coach(text: string, extra: Partial<EventEnvelope<'coach.message'>['payload']> = {}, id = `evt_${String(++n).padStart(4, '0')}`): EventEnvelope<'coach.message'> {
  return {
    id,
    athleteId: 'ath_1',
    ts: `2026-10-06T10:${String(n).padStart(2, '0')}:00.000Z`,
    type: 'coach.message',
    actor: 'coach',
    payload: { messageId: id, text, attachments: [], notify: 'normal', delivery: 'sent', proactive: false, channel: 'app', ...extra },
  };
}
function user(text: string, clientId?: string, id = `evt_${String(++n).padStart(4, '0')}`): EventEnvelope<'user.message'> {
  return { id, athleteId: 'ath_1', ts: `2026-10-06T10:${String(n).padStart(2, '0')}:00.000Z`, type: 'user.message', actor: 'athlete', payload: { text, attachments: [], channel: 'app', clientId } };
}
function uiAction(messageId: string, action: string, payload: unknown): EventEnvelope<'user.ui_action'> {
  return { id: `evt_${String(++n).padStart(4, '0')}`, athleteId: 'ath_1', ts: `2026-10-06T10:${String(n).padStart(2, '0')}:00.000Z`, type: 'user.ui_action', actor: 'athlete', payload: { source: { messageId }, action, payload, wake: true } };
}
const run = (s: ChatState, ...actions: ChatAction[]) => actions.reduce(chatReducer, s);
const stream = (message: StreamMessage): ChatAction => ({ type: 'stream', message, nowIso: '2026-10-06T10:00:00.000Z' });
const pending = (clientId: string, over: Partial<PendingMessage> = {}): PendingMessage => ({ clientId, ts: '2026-10-06T11:00:00.000Z', kind: 'text', text: 'hi', attachments: [], status: 'sending', ...over });

describe('streaming reducer (provisional bubbles)', () => {
  it('message.start creates a provisional bubble keyed by streamId, deltas append', () => {
    let s = run(initialChatState, stream({ t: 'message.start', streamId: 's1', replyTo: 'evt_x' }));
    expect(s.provisional).toEqual([{ streamId: 's1', text: '', replyTo: 'evt_x', startedAt: '2026-10-06T10:00:00.000Z' }]);
    s = run(s, stream({ t: 'message.delta', streamId: 's1', textDelta: 'Hel' }), stream({ t: 'message.delta', streamId: 's1', textDelta: 'lo' }));
    expect(s.provisional[0]?.text).toBe('Hello');
    expect(buildTimeline(s).map((i) => i.kind)).toEqual(['provisional']);
  });

  it('message.end replaces the provisional bubble with the authoritative event', () => {
    const final = coach('Hello there');
    let s = run(initialChatState, stream({ t: 'message.start', streamId: 's1' }), stream({ t: 'message.delta', streamId: 's1', textDelta: 'Hello' }));
    s = run(s, stream({ t: 'message.end', streamId: 's1', event: final }));
    expect(s.provisional).toHaveLength(0);
    const tl = buildTimeline(s);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ kind: 'coach.message', key: final.id });
    expect(s.lastEventId).toBe(final.id);
  });

  it('message.cancel removes only that bubble', () => {
    let s = run(initialChatState, stream({ t: 'message.start', streamId: 'a' }), stream({ t: 'message.start', streamId: 'b' }));
    s = run(s, stream({ t: 'message.cancel', streamId: 'a', reason: 'rejected' }));
    expect(s.provisional.map((p) => p.streamId)).toEqual(['b']);
  });

  it('a delta without a start (resumed mid-stream) still creates the bubble', () => {
    const s = run(initialChatState, stream({ t: 'message.delta', streamId: 'x', textDelta: 'rest of it' }));
    expect(s.provisional[0]).toMatchObject({ streamId: 'x', text: 'rest of it' });
  });

  it('message.end without a streamId just adds the event', () => {
    const s = run(initialChatState, stream({ t: 'message.start', streamId: 'keep' }), stream({ t: 'message.end', event: coach('proactive') }));
    expect(s.provisional).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it('duplicate message.start does not create two bubbles', () => {
    const s = run(initialChatState, stream({ t: 'message.start', streamId: 'a' }), stream({ t: 'message.start', streamId: 'a' }));
    expect(s.provisional).toHaveLength(1);
  });
});

describe('events, optimistic bubbles and held messages', () => {
  it('an echoed user.message with the same clientId replaces the pending bubble', () => {
    let s = run(initialChatState, { type: 'pending/add', message: pending('c1') });
    expect(buildTimeline(s).map((i) => i.kind)).toEqual(['pending']);
    s = run(s, { type: 'event', event: user('hi', 'c1') });
    expect(s.pending).toHaveLength(0);
    expect(buildTimeline(s).map((i) => i.kind)).toEqual(['user.message']);
  });

  it('a pending upload is replaced by a user.upload event with the same blobs', () => {
    const blob = { sha256: 'a'.repeat(64), mime: 'image/png', bytes: 3 };
    let s = run(initialChatState, { type: 'pending/add', message: pending('c2', { kind: 'upload', blobShas: [blob.sha256] }) });
    const ev: EventEnvelope<'user.upload'> = { id: 'evt_u1', athleteId: 'ath_1', ts: '2026-10-06T11:01:00.000Z', type: 'user.upload', actor: 'athlete', payload: { blobs: [blob] } };
    s = run(s, { type: 'event', event: ev });
    expect(s.pending).toHaveLength(0);
  });

  it('keeps pending after the real events (optimistic bubbles stay at the bottom)', () => {
    let s = run(initialChatState, { type: 'history', events: [coach('one'), coach('two')], mode: 'initial', hasMore: false });
    s = run(s, { type: 'pending/add', message: pending('c3') });
    expect(buildTimeline(s).map((i) => i.kind)).toEqual(['coach.message', 'coach.message', 'pending']);
  });

  it('held coach messages are hidden until released (same id, delivery sent)', () => {
    const held = coach('Good morning!', { delivery: 'held', heldUntil: '2026-10-07T07:00:00.000Z' });
    let s = run(initialChatState, { type: 'event', event: held });
    expect(buildTimeline(s)).toHaveLength(0);
    const released = { ...held, payload: { ...held.payload, delivery: 'sent' as const } };
    s = run(s, { type: 'history', events: [released], mode: 'newer' });
    expect(buildTimeline(s)).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it('merges history pages without duplicates and keeps ascending order', () => {
    const a = coach('a');
    const b = coach('b');
    const c = coach('c');
    const merged = mergeEvents([b, c], [c, a]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(mergeEvents(merged, [a])).toBe(merged);
  });

  it('older pages keep hasMore from the page, newer pages do not touch it', () => {
    let s = run(initialChatState, { type: 'history', events: [coach('x')], hasMore: true, mode: 'initial' });
    expect(s.hasMore).toBe(true);
    s = run(s, { type: 'history', events: [coach('y')], mode: 'newer' });
    expect(s.hasMore).toBe(true);
    s = run(s, { type: 'history', events: [coach('z')], hasMore: false, mode: 'older' });
    expect(s.hasMore).toBe(false);
  });

  it('user.message_deleted hides the message', () => {
    const m = user('oops');
    const del: AnyEvent = { id: 'evt_del', athleteId: 'ath_1', ts: '2026-10-06T12:00:00.000Z', type: 'user.message_deleted', actor: 'athlete', payload: { messageId: m.id } };
    const s = run(initialChatState, { type: 'history', events: [m, del], mode: 'initial' });
    expect(buildTimeline(s)).toHaveLength(0);
  });
});

describe('micro-UI answers', () => {
  it('derives the chosen quick reply from user.ui_action events', () => {
    const m = coach('How was it?', { ui: { quick_replies: [{ label: 'Easy', value: 'easy' }, { label: 'Hard', value: 'hard' }] } });
    const s = run(initialChatState, { type: 'history', events: [m, uiAction(m.payload.messageId, 'quick_reply', { value: 'hard', label: 'Hard' })], mode: 'initial' });
    const item = buildTimeline(s)[0];
    expect(item).toMatchObject({ kind: 'coach.message', answer: { action: 'quick_reply', value: 'hard', label: 'Hard' } });
  });

  it('derives a submitted form', () => {
    const m = coach('Check-in', { ui: { form: { id: 'f', fields: [{ id: 'rpe', type: 'scale', label: 'RPE', min: 1, max: 10 }] } } });
    const s = run(initialChatState, { type: 'history', events: [m, uiAction(m.payload.messageId, 'form_submit', { form_id: 'f', values: { rpe: 7 } })], mode: 'initial' });
    expect(buildTimeline(s)[0]).toMatchObject({ answer: { action: 'form_submit', formId: 'f', values: { rpe: 7 } } });
  });

  it('shows an optimistic local answer until the event arrives, then the event wins', () => {
    const m = coach('Q?', { ui: { quick_replies: [{ label: 'Yes', value: 'yes' }] } });
    let s = run(initialChatState, { type: 'event', event: m }, { type: 'answer/set', messageId: m.payload.messageId, answer: { action: 'quick_reply', value: 'yes', label: 'Yes', status: 'sending' } });
    expect(buildTimeline(s)[0]).toMatchObject({ answer: { value: 'yes', local: 'sending' } });
    s = run(s, { type: 'event', event: uiAction(m.payload.messageId, 'quick_reply', { value: 'yes', label: 'Yes' }) });
    const answer = (buildTimeline(s)[0] as { answer?: { local?: string } }).answer;
    expect(answer?.local).toBeUndefined();
    s = run(s, { type: 'answer/clear', messageId: m.payload.messageId });
    expect(s.localAnswers).toEqual({});
  });
});

describe('system lines', () => {
  it('shows ui_published, call and visible notices but not safety_flag or invisible notices', () => {
    const base = { athleteId: 'ath_1', actor: 'harness' as const };
    const events: AnyEvent[] = [
      { ...base, id: 'evt_a', ts: '2026-10-06T10:00:00.000Z', type: 'coach.ui_published', payload: { viewId: 'plan', version: '2', commit: 'c', summary: 'new phases' } },
      { ...base, id: 'evt_b', ts: '2026-10-06T10:01:00.000Z', type: 'call.ended', payload: { callId: 'c1', durationS: 125, transcriptPath: '', notesPath: '', endedBy: 'athlete' } },
      { ...base, id: 'evt_c', ts: '2026-10-06T10:02:00.000Z', type: 'harness.notice', payload: { kind: 'budget_warning', athleteVisible: true } },
      { ...base, id: 'evt_d', ts: '2026-10-06T10:03:00.000Z', type: 'harness.notice', payload: { kind: 'safety_flag', athleteVisible: true } },
      { ...base, id: 'evt_e', ts: '2026-10-06T10:04:00.000Z', type: 'harness.notice', payload: { kind: 'turn_failed', athleteVisible: false } },
    ];
    const tl = buildTimeline(run(initialChatState, { type: 'history', events, mode: 'initial' }), { viewTitle: (id) => (id === 'plan' ? 'Plan' : undefined) });
    const texts = tl.map((i) => (i.kind === 'system' ? i.text : ''));
    expect(texts[0]).toBe('Your coach updated Plan: new phases');
    expect(texts[1]).toBe('Call ended · 2m 05s');
    expect(texts[2]).toContain('budget');
    expect(tl).toHaveLength(3);
  });
});
