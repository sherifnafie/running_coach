import { describe, expect, it } from 'vitest';
import { epochDate, minRecurrenceGapMinutes, nextDailyAt, nextFire, quietHoursEnd } from '../src/time';
import { heuristicScreen } from '../src/safety';
import { describeChanges, partialText } from '../src/turn';
import { isPrivateAddress, htmlToText } from '../src/web';
import { isProactiveTurn } from '../src/messaging';

const AMS = 'Europe/Amsterdam';

describe('nextFire', () => {
  it('handles one-shot schedules', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    expect(nextFire({ at: '2026-10-07T12:00:00Z' }, now, AMS)?.toISOString()).toBe('2026-10-07T12:00:00.000Z');
    expect(nextFire({ at: '2026-10-07T09:00:00Z' }, now, AMS)).toBeNull();
  });

  it('evaluates daily rules in local wall time across the DST change', () => {
    // Europe/Amsterdam leaves DST on 2026-10-25 (03:00 CEST → 02:00 CET)
    const before = new Date('2026-10-24T06:00:00Z'); // 08:00 local CEST
    const a = nextFire({ rrule: 'FREQ=DAILY', time: '07:30' }, before, AMS)!;
    expect(a.toISOString()).toBe('2026-10-25T06:30:00.000Z'); // 07:30 CET = 06:30Z
    const b = nextFire({ rrule: 'FREQ=DAILY', time: '07:30' }, a, AMS)!;
    expect(b.toISOString()).toBe('2026-10-26T06:30:00.000Z');
  });

  it('supports weekly BYDAY rules and until', () => {
    const now = new Date('2026-10-07T12:00:00Z'); // Wednesday
    const next = nextFire({ rrule: 'FREQ=WEEKLY;BYDAY=SU', time: '18:00' }, now, AMS)!;
    expect(next.toISOString()).toBe('2026-10-11T16:00:00.000Z');
    expect(nextFire({ rrule: 'FREQ=WEEKLY;BYDAY=SU', time: '18:00', until: '2026-10-10T00:00:00Z' }, now, AMS)).toBeNull();
  });

  it('measures recurrence gaps', () => {
    expect(minRecurrenceGapMinutes({ rrule: 'FREQ=DAILY', time: '07:00' }, new Date('2026-10-07T00:00:00Z'), AMS)).toBe(24 * 60);
    expect(minRecurrenceGapMinutes({ at: '2026-10-08T00:00:00Z' }, new Date('2026-10-07T00:00:00Z'), AMS)).toBeNull();
  });
});

describe('quiet hours', () => {
  const q = { start: '22:00', end: '07:00' };
  it('detects a window that wraps midnight and returns its end', () => {
    const late = new Date('2026-10-07T21:30:00Z'); // 23:30 CEST
    expect(quietHoursEnd(late, AMS, q)?.toISOString()).toBe('2026-10-08T05:00:00.000Z');
    const early = new Date('2026-10-08T03:00:00Z'); // 05:00 CEST
    expect(quietHoursEnd(early, AMS, q)?.toISOString()).toBe('2026-10-08T05:00:00.000Z');
    const day = new Date('2026-10-08T10:00:00Z');
    expect(quietHoursEnd(day, AMS, q)).toBeNull();
    expect(quietHoursEnd(late, AMS, null)).toBeNull();
  });
});

describe('epochDate', () => {
  it('assigns early-morning activity to the previous day until the boundary', () => {
    expect(epochDate(new Date('2026-10-07T23:30:00Z'), AMS, '04:00')).toBe('2026-10-07'); // 01:30 local on the 8th
    expect(epochDate(new Date('2026-10-08T02:30:00Z'), AMS, '04:00')).toBe('2026-10-08'); // 04:30 local
  });
  it('nextDailyAt moves to tomorrow when the time has passed', () => {
    expect(nextDailyAt(new Date('2026-10-07T10:00:00Z'), AMS, '07:30').toISOString()).toBe('2026-10-08T05:30:00.000Z');
  });
});

describe('safety heuristic', () => {
  it('flags red flags and acute language', () => {
    const r = heuristicScreen('Had chest tightness and felt faint during my run today');
    expect(r.flagged).toBe(true);
    expect(r.categories).toContain('cardiac');
    expect(r.acute).toBe(true);
  });
  it('does not flag ordinary soreness', () => {
    expect(heuristicScreen('legs are a bit sore after yesterday, quads tight').flagged).toBe(false);
  });

  it('[SAFE-2] screens lifting and other-sport red flags without flagging ordinary gym soreness', () => {
    const caudaEquina = heuristicScreen('lower back pain after deadlifts and now my groin is numb and I can\'t control my bladder');
    expect(caudaEquina).toMatchObject({ flagged: true, categories: ['neuro'] });
    expect(heuristicScreen('both legs went weak after squats and my back hurts').categories).toContain('neuro');
    expect(heuristicScreen('sudden severe headache during a heavy set right now')).toMatchObject({ flagged: true, acute: true });
    expect(heuristicScreen('felt a pop in my bicep on the last rep, now there is a lump and it is weak').categories).toContain('other_acute');
    expect(heuristicScreen('I fainted mid-set').acute).toBe(true);
    for (const ordinary of ['my legs are weak after leg day', 'DOMS from squats, glutes sore', 'heard my knee pop, no pain at all', 'bench felt heavy today']) {
      expect(heuristicScreen(ordinary).flagged, ordinary).toBe(false);
    }
  });
  it('flags crisis language as acute', () => {
    const r = heuristicScreen("honestly I don't want to be alive anymore");
    expect(r.categories).toContain('self_harm');
    expect(r.acute).toBe(true);
  });
});

describe('misc helpers', () => {
  it('extracts streamed send_message text from partial JSON', () => {
    expect(partialText('{"text": "Nice wo')).toBe('Nice wo');
    expect(partialText('{"reply_to": "evt_1"')).toBeUndefined();
  });
  it('describes changes without leaking private notes', () => {
    expect(describeChanges([])).toBe('Coach turn');
    expect(describeChanges(['a.md', 'b.md', 'c.md', 'd.md'])).toBe('Updated a.md, b.md, c.md (+1 more)');
  });
  it('blocks private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('converts html to text', () => {
    expect(htmlToText('<html><head><title>x</title><script>bad()</script></head><body><h1>Race</h1><p>Start &amp; finish</p></body></html>')).toBe('Race\n Start & finish');
  });
  it('classifies proactive turns', () => {
    const ev = (type: string, payload: unknown = {}) => ({ id: 'e', athleteId: 'a', ts: '', type, actor: 'harness', payload }) as never;
    expect(isProactiveTurn('reactive', [])).toBe(false);
    expect(isProactiveTurn('scheduled', [ev('schedule.fired', { payload: {} })])).toBe(true);
    expect(isProactiveTurn('followup', [ev('call.ended')])).toBe(false);
    expect(isProactiveTurn('followup', [ev('task.completed', { originEventId: 'x', outputs: [] })])).toBe(false);
    expect(isProactiveTurn('followup', [ev('ui.error')])).toBe(true);
    expect(isProactiveTurn('followup', [ev('schedule.fired', { payload: { kind: 'first_contact' } })])).toBe(false);
  });
});
