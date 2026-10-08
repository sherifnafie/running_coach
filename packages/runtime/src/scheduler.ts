import {
  SCHEDULE_LIMITS,
  ToolError,
  isOneShot,
  newId,
  type ScheduleRecord,
  type ScheduleSpec,
  type ToolInput,
} from '@opencoach/protocol';
import type { Core } from './core';
import { releaseHeld } from './messaging';
import { minRecurrenceGapMinutes, nextDailyAt, nextFire } from './time';

const HEARTBEAT_ID = (a: string) => `hb_${a}`;
const CONSOLIDATION_ID = (a: string) => `cons_${a}`;
const RELEASE_ID = (a: string) => `rel_${a}`;
const MAX_IDLE_SLEEP_MS = 60 * 60_000;

/**
 * Durable timers (SPEC §5.5): coach wakes (one-shot / RRULE), daily heartbeat, nightly consolidation,
 * and release of held messages. Sleeps on the injectable Clock until the next due schedule; poke()
 * re-evaluates after changes.
 */
export class Scheduler {
  private stopped = true;
  private wake?: AbortController;
  private loopDone?: Promise<void>;

  constructor(private core: Core) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.abort();
    await this.loopDone?.catch(() => {});
  }

  /** Re-evaluate the next wake time (after schedule changes). */
  poke(): void {
    this.wake?.abort();
  }

  private tickLock: Promise<unknown> = Promise.resolve();

  /** Fire everything due right now (also used directly by tests/sims). Ticks never overlap. */
  tick(): Promise<number> {
    const run = this.tickLock.then(() => this.tickUnlocked());
    this.tickLock = run.catch(() => undefined);
    return run;
  }

  private async tickUnlocked(): Promise<number> {
    const now = this.core.clock.now();
    const due = await this.core.store.dueSchedules(now.toISOString(), 100);
    for (const s of due) {
      try {
        await this.advance(s, now);
        await this.dispatch(s);
      } catch (e) {
        this.core.log.error('schedule fire failed', { scheduleId: s.id, error: (e as Error).message });
      }
    }
    return due.length;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        this.core.log.error('scheduler tick failed', { error: (e as Error).message });
      }
      if (this.stopped) break;
      const now = this.core.clock.now();
      const next = await this.core.store.nextScheduleAt().catch(() => undefined);
      let wakeAt = new Date(now.getTime() + MAX_IDLE_SLEEP_MS);
      if (next) {
        const n = new Date(next);
        if (n.getTime() < wakeAt.getTime()) wakeAt = n;
      }
      if (wakeAt.getTime() <= now.getTime()) continue;
      this.wake = new AbortController();
      try {
        await this.core.clock.sleepUntil(wakeAt, this.wake.signal);
      } catch {
        /* poked or stopped */
      }
    }
  }

  private async advance(s: ScheduleRecord, now: Date): Promise<void> {
    const tz = (await this.core.store.getSettings(s.athleteId)).profile.tz;
    let next: Date | null = null;
    if (!isOneShot(s.spec)) next = nextFire(s.spec, now, tz);
    await this.core.store.upsertSchedule({
      ...s,
      lastFiredAt: now.toISOString(),
      nextFireAt: next ? next.toISOString() : null,
      status: next ? 'active' : 'done',
    });
  }

  private async dispatch(s: ScheduleRecord): Promise<void> {
    const core = this.core;
    const athlete = await core.store.getAthlete(s.athleteId);
    if (!athlete || athlete.status !== 'active') return;
    const settings = await core.store.getSettings(s.athleteId);
    const now = core.clock.now();
    const paused = !!settings.notifications.pauseUntil && new Date(settings.notifications.pauseUntil).getTime() > now.getTime();

    switch (s.kind) {
      case 'release':
        await releaseHeld(core, s.athleteId);
        await this.rescheduleRelease(s.athleteId);
        return;
      case 'heartbeat': {
        if (!settings.heartbeat.enabled || paused) return;
        const e = await core.store.appendEvent({ athleteId: s.athleteId, type: 'system.heartbeat', actor: 'harness', payload: {} });
        core.minds.get(s.athleteId).enqueue(e, 'scheduled');
        return;
      }
      case 'consolidation': {
        if (!settings.consolidation.enabled) return;
        const open = await core.store.getOpenEpoch(s.athleteId);
        if (!open) return;
        const items = await core.store.listEpochItems(open.id);
        if (items.length === 0) return;
        const e = await core.store.appendEvent({ athleteId: s.athleteId, type: 'system.consolidate', actor: 'harness', payload: { epochId: open.id } });
        core.minds.get(s.athleteId).enqueue(e, 'consolidation');
        return;
      }
      case 'coach': {
        if (paused && !s.duringPause) return;
        if ((s.payload as { kind?: string } | undefined)?.kind === 'reply_retry') {
          // Retry original unanswered input as a reply, never as unsolicited outreach [RT-4].
          for (const input of await core.store.listPendingCoachInputs(s.athleteId)) core.minds.get(s.athleteId).enqueue(input, 'reactive');
          return;
        }
        const firstContact = (s.payload as { kind?: string } | undefined)?.kind === 'first_contact';
        const e = await core.store.appendEvent({
          athleteId: s.athleteId,
          type: 'schedule.fired',
          actor: 'harness',
          payload: { scheduleId: s.id, purpose: s.purpose, payload: s.payload, scheduledFor: s.nextFireAt ?? now.toISOString(), createdAt: s.createdAt },
        });
        core.minds.get(s.athleteId).enqueue(e, firstContact ? 'followup' : 'scheduled');
        return;
      }
    }
  }

  // ------------------------------------------------------------------ coach-facing API

  private fullId(athleteId: string, id: string): string {
    if (id.startsWith('sch_') || id.startsWith(`${athleteId}/`)) return id;
    return `${athleteId}/${id}`;
  }

  async upsertCoach(athleteId: string, input: ToolInput<'schedule'>, turnId?: string): Promise<{ scheduleId: string; nextFireAt: string | null }> {
    const core = this.core;
    const settings = await core.store.getSettings(athleteId);
    const tz = settings.profile.tz;
    const now = core.clock.now();
    const spec: ScheduleSpec = input.spec;
    if (!isOneShot(spec) && spec.tz) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: spec.tz });
      } catch {
        throw new ToolError('INVALID_INPUT', `Unknown time zone "${spec.tz}".`);
      }
    }
    const next = nextFire(spec, now, tz);
    if (isOneShot(spec) && !next) throw new ToolError('INVALID_INPUT', `"at" (${spec.at}) is in the past. Current time: ${now.toISOString()}.`);
    const gap = minRecurrenceGapMinutes(spec, now, tz);
    if (gap !== null && gap < SCHEDULE_LIMITS.minIntervalMinutes) {
      throw new ToolError('INVALID_INPUT', `Recurring wakes must be at least ${SCHEDULE_LIMITS.minIntervalMinutes} minutes apart (this rule fires every ${gap} min).`);
    }
    const id = input.id ? this.fullId(athleteId, input.id) : newId('sch', core.clock);
    const existing = await core.store.getSchedule(id);
    if (existing && existing.athleteId !== athleteId) throw new ToolError('NOT_ALLOWED', 'That schedule id belongs to someone else.');
    if (!existing) {
      const active = (await core.store.listSchedules(athleteId, { status: 'active', kind: 'coach' })).length;
      if (active >= SCHEDULE_LIMITS.maxActive) throw new ToolError('LIMIT', `You already have ${active} active wakes (max ${SCHEDULE_LIMITS.maxActive}). Cancel some first.`);
    }
    const rec: ScheduleRecord = {
      id,
      athleteId,
      kind: 'coach',
      spec,
      purpose: input.purpose,
      payload: input.payload,
      duringPause: !!input.during_pause,
      nextFireAt: next ? next.toISOString() : null,
      status: next ? 'active' : 'done',
      createdAt: existing?.createdAt ?? now.toISOString(),
      createdInTurn: turnId ?? existing?.createdInTurn,
    };
    await core.store.upsertSchedule(rec);
    await core.store.appendEvent({
      athleteId,
      type: 'coach.schedule_changed',
      actor: 'coach',
      turnId,
      payload: { scheduleId: id, op: existing ? 'update' : 'create', spec, purpose: input.purpose },
    });
    this.poke();
    return { scheduleId: id, nextFireAt: rec.nextFireAt };
  }

  async list(athleteId: string): Promise<ScheduleRecord[]> {
    const all = await this.core.store.listSchedules(athleteId, { status: 'active' });
    return all.filter((s) => s.kind !== 'release').sort((a, b) => (a.nextFireAt ?? '').localeCompare(b.nextFireAt ?? ''));
  }

  async cancel(athleteId: string, id: string, turnId?: string): Promise<void> {
    const candidates = [id, this.fullId(athleteId, id)];
    for (const c of candidates) {
      const s = await this.core.store.getSchedule(c);
      if (s && s.athleteId === athleteId) {
        if (s.kind !== 'coach') throw new ToolError('NOT_ALLOWED', 'Harness schedules cannot be cancelled; use set_heartbeat for the heartbeat.');
        await this.core.store.upsertSchedule({ ...s, status: 'cancelled', nextFireAt: null });
        await this.core.store.appendEvent({ athleteId, type: 'coach.schedule_changed', actor: 'coach', turnId, payload: { scheduleId: s.id, op: 'cancel' } });
        this.poke();
        return;
      }
    }
    throw new ToolError('NOT_FOUND', `No schedule "${id}". Use list_schedules to see ids.`);
  }

  async setHeartbeat(athleteId: string, input: ToolInput<'set_heartbeat'>, by: 'coach' | 'athlete'): Promise<{ enabled: boolean; time: string }> {
    const settings = await this.core.store.getSettings(athleteId);
    if (by === 'coach' && settings.heartbeat.setBy === 'athlete' && input.time && input.time !== settings.heartbeat.time) {
      throw new ToolError('NOT_ALLOWED', `The athlete set the heartbeat time to ${settings.heartbeat.time} themselves; ask them before changing it.`);
    }
    const { settings: next } = await this.core.store.updateSettings(athleteId, {
      heartbeat: { ...(input.time ? { time: input.time } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), setBy: by },
    });
    await this.ensureHarnessSchedules(athleteId);
    return { enabled: next.heartbeat.enabled, time: next.heartbeat.time };
  }

  // ------------------------------------------------------------------ harness schedules

  /** Create/refresh the per-athlete heartbeat and consolidation schedules from settings. */
  async ensureHarnessSchedules(athleteId: string): Promise<void> {
    const core = this.core;
    const settings = await core.store.getSettings(athleteId);
    const now = core.clock.now();
    const tz = settings.profile.tz;
    const mk = async (id: string, kind: 'heartbeat' | 'consolidation', time: string, enabled: boolean, purpose: string) => {
      const existing = await core.store.getSchedule(id);
      const spec: ScheduleSpec = { rrule: 'FREQ=DAILY', time, tz };
      const sameSpec = existing && !isOneShot(existing.spec) && existing.spec.time === time && existing.spec.tz === tz && existing.status === 'active';
      if (sameSpec && enabled && existing.nextFireAt) return;
      await core.store.upsertSchedule({
        id,
        athleteId,
        kind,
        spec,
        purpose,
        duringPause: false,
        nextFireAt: enabled ? nextDailyAt(now, tz, time).toISOString() : null,
        status: enabled ? 'active' : 'cancelled',
        createdAt: existing?.createdAt ?? now.toISOString(),
      });
    };
    await mk(HEARTBEAT_ID(athleteId), 'heartbeat', settings.heartbeat.time, settings.heartbeat.enabled, 'Daily heartbeat (HEARTBEAT.md)');
    await mk(CONSOLIDATION_ID(athleteId), 'consolidation', settings.consolidation.time, settings.consolidation.enabled, 'Nightly consolidation');
    this.poke();
  }

  /** Make sure held messages are released at (or before) `at`. */
  async ensureRelease(athleteId: string, at: Date): Promise<void> {
    const id = RELEASE_ID(athleteId);
    const existing = await this.core.store.getSchedule(id);
    if (existing && existing.status === 'active' && existing.nextFireAt && new Date(existing.nextFireAt).getTime() <= at.getTime()) return;
    await this.core.store.upsertSchedule({
      id,
      athleteId,
      kind: 'release',
      spec: { at: at.toISOString() },
      purpose: 'Release held messages',
      duringPause: true,
      nextFireAt: at.toISOString(),
      status: 'active',
      createdAt: existing?.createdAt ?? this.core.clock.now().toISOString(),
    });
    this.poke();
  }

  private async rescheduleRelease(athleteId: string): Promise<void> {
    const held = await this.core.store.listHeldMessages(athleteId);
    const times = held.map((h) => h.heldUntil).filter((t): t is string => !!t).sort();
    if (times[0]) await this.ensureRelease(athleteId, new Date(times[0]));
  }

  /** Immediate first-contact wake for a brand-new athlete (counts as a reply, not proactive). */
  async firstContact(athleteId: string, purpose: string): Promise<void> {
    const now = this.core.clock.now();
    await this.core.store.upsertSchedule({
      id: `first_${athleteId}`,
      athleteId,
      kind: 'coach',
      spec: { at: now.toISOString() },
      purpose,
      payload: { kind: 'first_contact' },
      duringPause: true,
      nextFireAt: now.toISOString(),
      status: 'active',
      createdAt: now.toISOString(),
    });
    this.poke();
  }

  /** Schedule a harness-created retry wake (e.g. reply fallback). */
  async harnessWake(athleteId: string, at: Date, purpose: string, payload?: Record<string, unknown>): Promise<void> {
    const id = newId('sch', this.core.clock);
    await this.core.store.upsertSchedule({
      id,
      athleteId,
      kind: 'coach',
      spec: { at: at.toISOString() },
      purpose,
      payload,
      duringPause: true,
      nextFireAt: at.toISOString(),
      status: 'active',
      createdAt: this.core.clock.now().toISOString(),
    });
    this.poke();
  }
}
