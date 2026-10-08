import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageStateRecord, Store } from '@opencoach/protocol';
import { openSqliteStore } from './index';
import { loadSqlite } from './sqlite';
import { MIGRATIONS } from './migrations';
import { addAthlete, makeClock, memStore, T0, tmpDir } from './test-helpers';

const stores: Store[] = [];
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); });
async function open() {
  const h = await memStore();
  stores.push(h.store);
  await addAthlete(h.store, 'ath_1');
  return h;
}
async function hold(store: Store, id = 'draft') {
  const messageState: MessageStateRecord = { messageId: id, athleteId: 'ath_1', delivery: 'held', heldUntil: T0, proactive: true };
  await store.appendEvent({ id, athleteId: 'ath_1', type: 'coach.message', actor: 'coach', payload: {
    messageId: id, text: 'Which town?', delivery: 'held', heldUntil: T0, proactive: true, channel: 'app', notify: 'normal',
  } }, { messageState });
  return messageState;
}

describe('durable inputs and held outreach [RT-3, RT-4, MSG-4]', () => {
  it('atomically cancels held outreach on input without delivering or charging it; terminal state cannot be resurrected', async () => {
    const { store } = await open();
    const draft = await hold(store);
    const { event, cancelledMessageIds } = await store.appendCoachInput({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'The Hague', clientId: 'town' } });
    expect(cancelledMessageIds).toEqual(['draft']);
    expect(await store.getMessageState('draft')).toMatchObject({ delivery: 'cancelled' });
    expect(await store.getMessageState('draft')).not.toHaveProperty('sentAt');
    expect(await store.listPendingCoachInputs('ath_1')).toEqual([event]);
    await store.putMessageState({ ...draft, heldUntil: '2026-10-08T06:00:00Z' });
    expect((await store.getMessageState('draft'))?.delivery).toBe('cancelled');
    expect(await store.releaseHeldMessage('ath_1', 'draft', ['user.message'])).toEqual({ status: 'gone' });
    expect(await store.countProactiveSince('ath_1', T0)).toBe(0);
    expect(await store.countUnreadCoachMessages('ath_1')).toBe(0);
    expect((await store.getEvent('draft'))?.payload).toMatchObject({ delivery: 'held', text: 'Which town?' });
  });

  it('checks append order even with identical timestamps and acknowledged or legacy inputs', async () => {
    const { store } = await open();
    await hold(store);
    // This predates the durable-input API (or represents a non-waking UI update).
    await store.appendEvent({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'Already answered', clientId: 'legacy' } });
    expect(await store.releaseHeldMessage('ath_1', 'draft', ['user.message'])).toEqual({ status: 'cancelled' });
    expect(await store.listEvents({ athleteId: 'ath_1', types: ['coach.message'] })).toHaveLength(1);
  });

  it('releases an unchanged draft exactly once, preserving its stable message id', async () => {
    const { store } = await open();
    const draft = await hold(store);
    const result = await store.releaseHeldMessage('ath_1', 'draft', ['user.message']);
    expect(result.status).toBe('released');
    if (result.status === 'released') expect(result.event).toMatchObject({ causationId: 'draft', payload: { messageId: 'draft', delivery: 'sent' } });
    expect(await store.releaseHeldMessage('ath_1', 'draft', ['user.message'])).toEqual({ status: 'gone' });
    await store.putMessageState(draft);
    expect((await store.getMessageState('draft'))?.delivery).toBe('sent');
    expect(await store.countProactiveSince('ath_1', T0)).toBe(1);
  });

  it('ignores read/device telemetry, respects the release time and isolates athletes', async () => {
    const { store, clock } = await open();
    const draft = await hold(store);
    await store.putMessageState({ ...draft, heldUntil: '2026-10-07T08:00:00.000Z' });
    await store.appendEvent({ athleteId: 'ath_1', type: 'user.read', actor: 'athlete', payload: { messageIds: ['previous'] } });
    await store.appendEvent({ athleteId: 'ath_1', type: 'device.context', actor: 'device', payload: { tz: 'Europe/Amsterdam', locale: 'en' } });
    expect(await store.releaseHeldMessage('ath_other', 'draft', ['user.message'])).toEqual({ status: 'gone' });
    expect(await store.releaseHeldMessage('ath_1', 'draft', ['user.message'])).toEqual({ status: 'gone' });
    await clock.advanceTo('2026-10-07T08:00:00.000Z');
    expect((await store.releaseHeldMessage('ath_1', 'draft', ['user.message'])).status).toBe('released');
  });

  it('removes pending inputs on account reset and deletion without affecting another athlete', async () => {
    const { store } = await open();
    await addAthlete(store, 'ath_2');
    for (const athleteId of ['ath_1', 'ath_2']) await store.appendCoachInput({ athleteId, type: 'user.message', actor: 'athlete', payload: { text: 'pending', clientId: athleteId } });
    await store.resetAthleteCoach('ath_1');
    expect(await store.listPendingCoachInputs('ath_1')).toEqual([]);
    expect(await store.listPendingCoachInputs('ath_2')).toHaveLength(1);
    await store.deleteAthlete('ath_2');
    expect(await store.listPendingCoachInputs('ath_2')).toEqual([]);
  });

  it('acknowledges only consumed inputs atomically with a reply, and rolls back on invalid replies', async () => {
    const { store } = await open();
    const a = await store.appendCoachInput({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'town', clientId: 'a' } });
    const b = await store.appendCoachInput({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'new detail', clientId: 'b' } });
    await expect(store.appendEvent({ id: 'reply', athleteId: 'ath_1', type: 'coach.message', actor: 'coach', payload: { text: 'bad', messageId: 'reply' } as never }, { acknowledgeInputs: [a.event.id] })).rejects.toThrow();
    expect(await store.listPendingCoachInputs('ath_1')).toHaveLength(2);
    await store.appendEvent({ id: 'reply', athleteId: 'ath_1', type: 'coach.message', actor: 'coach', payload: { text: 'Noted', messageId: 'reply', delivery: 'sent', proactive: false, channel: 'app', notify: 'normal' } }, {
      messageState: { athleteId: 'ath_1', messageId: 'reply', delivery: 'sent', proactive: false, sentAt: T0 }, acknowledgeInputs: [a.event.id],
    });
    expect((await store.listPendingCoachInputs('ath_1')).map((e) => e.id)).toEqual([b.event.id]);
    await store.acknowledgeCoachInputs('ath_other', [b.event.id]);
    expect(await store.listPendingCoachInputs('ath_1')).toHaveLength(1);
    await store.tombstoneEvent(b.event.id);
    expect(await store.listPendingCoachInputs('ath_1')).toEqual([]);
  });

  it('rejects outreach created before newly arrived steering is consumed, without persisting a partial event', async () => {
    const { store } = await open();
    await store.appendCoachInput({ athleteId: 'ath_1', type: 'user.message', actor: 'athlete', payload: { text: 'new answer', clientId: 'c' } });
    await expect(hold(store)).rejects.toThrow(/New athlete input/);
    expect(await store.getEvent('draft')).toBeUndefined();
    expect(await store.getMessageState('draft')).toBeUndefined();
  });

  it('upgrades v3 without losing delivery/read state and recovers only the unanswered tail', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const path = join(dir, 'legacy.db');
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(path);
      for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
      db.exec('PRAGMA user_version = 3');
      db.prepare('INSERT INTO athletes (id, display_name, created_at) VALUES (?, ?, ?)').run('ath_1', 'Sam', T0);
      const add = (id: string, type: string, actor: string, payload: unknown) => db.prepare('INSERT INTO events (id, athlete_id, ts, type, actor, payload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'ath_1', T0, type, actor, JSON.stringify(payload));
      add('answered', 'user.message', 'athlete', { text: 'old input', clientId: 'a' });
      add('reply', 'coach.message', 'coach', { messageId: 'reply', text: 'answered', delivery: 'sent', proactive: false, channel: 'app' });
      db.prepare('INSERT INTO message_state (message_id, athlete_id, delivery, sent_at, read_at, proactive) VALUES (?, ?, ?, ?, ?, ?)').run('reply', 'ath_1', 'sent', T0, T0, 0);
      add('pending', 'user.message', 'athlete', { text: 'unanswered', clientId: 'b' });
      add('quick', 'user.ui_action', 'athlete', { action: 'answer', source: { viewId: 'plan' }, wake: true });
      add('passive', 'user.ui_action', 'athlete', { action: 'navigate', source: { viewId: 'plan' }, wake: false });
      db.close();
      const store = await openSqliteStore({ path, clock: makeClock() });
      try {
        expect((await store.listPendingCoachInputs('ath_1')).map((e) => e.id)).toEqual(['pending', 'quick']);
        expect(await store.getMessageState('reply')).toMatchObject({ delivery: 'sent', sentAt: T0, readAt: T0 });
        await store.migrate();
        expect(await store.listPendingCoachInputs('ath_1')).toHaveLength(2);
      } finally { await store.close(); }
    } finally { cleanup(); }
  });
});
