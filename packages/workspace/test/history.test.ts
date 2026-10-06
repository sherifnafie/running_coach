import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { athletePaths, type AnyEvent, type EventType } from '@opencoach/protocol';
import { extForMime, renderEventLine, renderHistory } from '../src';
import { newFakeStore, tmpDir } from './helpers';

const TZ = 'Europe/Amsterdam';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

let n = 0;
function ev(type: EventType, payload: Record<string, unknown>, ts = '2026-10-07T04:58:00.000Z', actor = 'athlete', extra: Record<string, unknown> = {}): AnyEvent {
  return { id: `evt_${String(++n).padStart(5, '0')}`, athleteId: 'ath_h', ts, type, actor, payload, ...extra } as unknown as AnyEvent;
}
const line = (e: AnyEvent) => renderEventLine(e, TZ);

describe('renderEventLine', () => {
  it('renders athlete messages with local time and attachments under /raw', () => {
    expect(line(ev('user.message', { text: 'Tempo done, brutal 😅', attachments: [], channel: 'app' }))).toBe('06:58 · Athlete: Tempo done, brutal 😅');
    expect(line(ev('user.message', { text: 'splits', attachments: [{ sha256: SHA, mime: 'image/png', bytes: 10 }, { sha256: SHA2, mime: 'image/jpeg', bytes: 5, name: 'IMG_1.jpg' }] }))).toBe(
      `06:58 · Athlete: splits\n  Attachments: /raw/${SHA}.png (image/png), /raw/${SHA2}.jpg (image/jpeg, "IMG_1.jpg")`,
    );
    expect(line(ev('user.message', { text: 'line one\nline two\n\nline four', attachments: [] }))).toBe('06:58 · Athlete: line one\n  line two\n\n  line four');
    expect(line(ev('user.message', { text: 'hi', channel: 'telegram' }))).toBe('06:58 · Athlete (telegram): hi');
  });

  it('uses the same extension mapping as the blob store (extForMime)', () => {
    for (const mime of ['image/png', 'image/jpeg', 'audio/mp4', 'application/json', 'application/pdf']) {
      expect(line(ev('user.upload', { blobs: [{ sha256: SHA, mime, bytes: 1 }] }))).toContain(`/raw/${SHA}.${extForMime(mime)} `);
    }
  });

  it('renders uploads, voice notes and synced data', () => {
    expect(line(ev('user.upload', { blobs: [{ sha256: SHA, mime: 'image/png', bytes: 1 }, { sha256: SHA2, mime: 'image/png', bytes: 1 }], caption: 'long run' }))).toBe(
      `06:58 · Athlete: (uploaded 2 files) long run\n  Attachments: /raw/${SHA}.png (image/png), /raw/${SHA2}.png (image/png)`,
    );
    expect(line(ev('user.upload', { blobs: [{ sha256: SHA, mime: 'application/pdf', bytes: 1 }] }))).toBe(`06:58 · Athlete: (uploaded 1 file)\n  Attachments: /raw/${SHA}.pdf (application/pdf)`);
    expect(line(ev('user.voice_note', { blob: { sha256: SHA, mime: 'audio/mp4', bytes: 1 }, durationS: 42, transcript: 'felt great', transcriptModel: 'whisper' }))).toBe(
      `06:58 · Athlete (voice note, 0:42): felt great\n  Audio: /raw/${SHA}.m4a (audio/mp4)`,
    );
    expect(line(ev('data.synced', { source: 'health_connect', blobs: [{ sha256: SHA, mime: 'application/json', bytes: 1 }], range: ['2026-10-06T00:00:00Z', '2026-10-07T00:00:00Z'] }, undefined, 'device'))).toBe(
      `06:58 · Data synced from health_connect (1 file, 2026-10-06T00:00:00Z to 2026-10-07T00:00:00Z)\n  Files: /raw/${SHA}.txt (application/json)`,
    );
  });

  it('renders coach messages, held delivery, quick replies, forms and attachments', () => {
    const base = { messageId: 'evt_x', attachments: [], notify: 'normal', delivery: 'sent', proactive: false, channel: 'app' };
    expect(line(ev('coach.message', { ...base, text: 'Nice work!' }, undefined, 'coach'))).toBe('06:58 · Coach: Nice work!');
    expect(line(ev('coach.message', { ...base, text: 'Morning!', delivery: 'held', heldUntil: '2026-10-07T05:00:00.000Z', proactive: true }, '2026-10-07T00:30:00.000Z', 'coach'))).toBe('02:30 · Coach: Morning! (held until 07:00)');
    expect(line(ev('coach.message', { ...base, text: 'Later', delivery: 'held', heldUntil: '2026-10-08T05:00:00.000Z' }, '2026-10-07T20:30:00.000Z', 'coach'))).toBe('22:30 · Coach: Later (held until 2026-10-08 07:00)');
    expect(
      line(ev('coach.message', { ...base, text: 'How hard was it?', ui: { quick_replies: [{ label: '8', value: '8' }, { label: 'Easy', value: 'rpe_3' }] } }, undefined, 'coach')),
    ).toBe('06:58 · Coach: How hard was it?\n  Quick replies: "8", "Easy" (rpe_3)');
    expect(
      line(ev('coach.message', { ...base, text: 'Check-in', ui: { form: { id: 'sleep', title: 'Sleep', fields: [{ id: 'h', label: 'Hours', type: 'number' }, { id: 'q', label: 'Quality', type: 'scale', min: 1, max: 5 }] } } }, undefined, 'coach')),
    ).toBe('06:58 · Coach: Check-in\n  Form "Sleep" (sleep): Hours [number], Quality [scale]');
    expect(
      line(
        ev(
          'coach.message',
          {
            ...base,
            text: 'See attached',
            attachments: [{ kind: 'file', path: 'exports/plan.pdf', blob: { sha256: SHA, mime: 'application/pdf', bytes: 1 } }, { kind: 'blob', blob: { sha256: SHA2, mime: 'image/png', bytes: 1, name: 'chart.png' } }, { kind: 'view_card', viewId: 'calendar' }],
            voiceNote: { sha256: SHA, mime: 'audio/mpeg', bytes: 1 },
          },
          undefined,
          'coach',
        ),
      ),
    ).toBe('06:58 · Coach: See attached\n  Attachments: exports/plan.pdf (application/pdf), "chart.png" (image/png), view card calendar\n  Voice note: blob aaaaaaaa (audio/mpeg)');
  });

  it('renders UI actions and writes', () => {
    expect(line(ev('user.ui_action', { source: { messageId: 'evt_9' }, action: 'quick_reply', payload: { value: '8' }, wake: true }))).toBe('06:58 · Athlete tapped quick reply "8" on message evt_9');
    expect(line(ev('user.ui_action', { source: { messageId: 'evt_9' }, action: 'form_submit', payload: { form_id: 'sleep', values: { h: 7, q: 'ok' } }, wake: true }))).toBe('06:58 · Athlete submitted form "sleep": h=7, q=ok on message evt_9');
    expect(line(ev('user.ui_action', { source: { viewId: 'calendar' }, action: 'workout_moved', payload: { id: 'pw_1', to: '2026-10-09' }, wake: false }))).toBe(
      '06:58 · Athlete UI action "workout_moved" {"id":"pw_1","to":"2026-10-09"} in view calendar (no wake)',
    );
    expect(line(ev('user.ui_write', { viewId: 'today', target: 'planned_workouts', op: 'update', row: { status: 'done' }, key: { id: 'pw_1' } }))).toBe(
      '06:58 · Athlete edited data in view today: update planned_workouts key {"id":"pw_1"} {"status":"done"}',
    );
    expect(line(ev('user.reaction', { messageId: 'evt_3', reaction: '👍' }))).toBe('06:58 · Athlete reacted 👍 to message evt_3');
  });

  it('renders schedules, heartbeat, tasks, calls, publishes and notices', () => {
    expect(line(ev('schedule.fired', { scheduleId: 'sch_1', purpose: 'Check whether the tempo was logged', scheduledFor: '2026-10-07T04:58:00Z', createdAt: '2026-10-05T10:00:00Z' }, undefined, 'harness'))).toBe('06:58 · Schedule fired: Check whether the tempo was logged');
    expect(line(ev('system.heartbeat', {}, '2026-10-07T05:30:00Z', 'harness'))).toBe('07:30 · Heartbeat');
    expect(line(ev('task.completed', { taskId: 'tsk_1', profile: 'analyst', summary: 'Weekly load computed', outputs: ['journal/a.md', 'exports/b.png'] }, undefined, 'helper'))).toBe(
      '06:58 · Task tsk_1 (analyst) completed: Weekly load computed\n  Outputs: journal/a.md, exports/b.png',
    );
    expect(line(ev('task.failed', { taskId: 'tsk_2', summary: 'Could not parse FIT file', error: 'EOF' }, undefined, 'helper'))).toBe('06:58 · Task tsk_2 failed: Could not parse FIT file [EOF]');
    expect(line(ev('call.started', { callId: 'call_1', mode: 'realtime', provider: 'openai', model: 'gpt-realtime' }, undefined, 'voice'))).toBe('06:58 · Call started (realtime, openai/gpt-realtime)');
    expect(line(ev('call.ended', { callId: 'call_1', durationS: 252, transcriptPath: 'calls/1.md', notesPath: 'calls/1-notes.md', endedBy: 'athlete' }, undefined, 'voice'))).toBe(
      '06:58 · Call ended after 4:12 (by athlete). Transcript: calls/1.md, notes: calls/1-notes.md',
    );
    expect(line(ev('coach.ui_published', { viewId: 'plan', version: '3', commit: 'abc', summary: 'Added phases timeline' }, undefined, 'coach'))).toBe('06:58 · Coach published view plan v3: Added phases timeline');
    expect(line(ev('harness.notice', { kind: 'held_quiet_hours', athleteVisible: true, text: 'Message held until 07:00' }, undefined, 'harness'))).toBe('06:58 · Notice (shown to athlete, held_quiet_hours): Message held until 07:00');
    expect(line(ev('harness.notice', { kind: 'budget_warning', athleteVisible: false, detail: { pct: 80 } }, undefined, 'harness'))).toBe('06:58 · Notice (internal, budget_warning): {"pct":80}');
    expect(line(ev('user.settings_changed', { diff: { 'notifications.proactivePerDay': { from: 3, to: 1 }, 'profile.units': { from: 'metric', to: 'imperial' } } }))).toBe(
      '06:58 · Athlete changed settings: notifications.proactivePerDay: 3 → 1; profile.units: "metric" → "imperial"',
    );
    expect(line(ev('coach.schedule_changed', { scheduleId: 'sch_3', op: 'cancel' }, undefined, 'coach'))).toBe('06:58 · Coach cancelled schedule sch_3');
    expect(line(ev('harness.upgraded', { from: '0.1.0', to: '0.2.0', changelogPath: '/system/CHANGELOG-for-coach.md' }, undefined, 'harness'))).toContain('Harness upgraded from 0.1.0 to 0.2.0');
    expect(line(ev('workspace.external_change', { commits: ['abc'], filesChanged: 2, summary: 'edited plan' }, undefined, 'harness'))).toBe('06:58 · Workspace edited outside the coach (2 files): edited plan');
    expect(line(ev('user.view_reverted', { viewId: 'plan', fromVersion: '3', toVersion: '2' }))).toBe('06:58 · Athlete reverted view plan from v3 to v2');
    expect(line(ev('user.message_deleted', { messageId: 'evt_4' }))).toBe('06:58 · Athlete deleted message evt_4');
    expect(line(ev('ui.error', { viewId: 'plan', version: '3', message: 'x is undefined', device: { ua: 'u', viewport: '1x1' } }, undefined, 'device'))).toBe('06:58 · UI error in plan@3: x is undefined');
  });

  it('returns "" for pure trace events', () => {
    expect(line(ev('coach.turn', { turnId: 't', note: 'secret reasoning' }, undefined, 'coach'))).toBe('');
    expect(line(ev('user.read', { messageIds: ['a'] }))).toBe('');
    expect(line(ev('device.context', { tz: 'UTC', locale: 'en' }, undefined, 'device'))).toBe('');
  });

  it('never throws on odd or tombstoned payloads', () => {
    expect(line(ev('user.message', { text: undefined as never }))).toBe('06:58 · Athlete: [deleted]');
    expect(line(ev('coach.message', {} as never, undefined, 'coach'))).toContain('Coach:');
    expect(line(ev('user.upload', null as never))).toContain('06:58');
    expect(renderEventLine({ ...ev('user.message', { text: 'x' }), ts: 'not a date' } as AnyEvent, TZ)).toBe('??:?? · Athlete: x');
    expect(line(ev('nope.unknown' as EventType, {}))).toBe('06:58 · nope.unknown');
  });
});

describe('renderHistory', () => {
  async function setup() {
    const dataDir = await tmpDir('hist-');
    const paths = athletePaths(dataDir, 'ath_h');
    const { fake, store } = newFakeStore();
    return { paths, fake, store };
  }
  const msg = (text: string, ts: string) => ev('user.message', { text, attachments: [], channel: 'app' }, ts);

  it('writes history/YYYY/MM/DD.md per local day with a weekday header, overwriting', async () => {
    const { paths, fake, store } = await setup();
    fake.events.push(
      msg('before midnight local (22:30Z = 00:30 next day)', '2026-10-06T22:30:00.000Z'), // local 2026-10-07 00:30
      msg('late evening local 06th (21:59Z = 23:59)', '2026-10-06T21:59:00.000Z'),
      msg('morning', '2026-10-07T04:58:00.000Z'),
      ev('coach.message', { messageId: 'm', text: 'Great!', attachments: [], notify: 'normal', delivery: 'sent', proactive: false, channel: 'app' }, '2026-10-07T05:10:00.000Z', 'coach'),
      ev('coach.turn', { turnId: 't' }, '2026-10-07T05:10:01.000Z', 'coach'),
      ev('user.read', { messageIds: ['m'] }, '2026-10-07T05:11:00.000Z'),
      msg('next local day (22:00Z = 00:00)', '2026-10-07T22:00:00.000Z'),
    );
    await renderHistory({ paths, store, athleteId: 'ath_h', tz: TZ, days: ['2026-10-07'] });
    const file = path.join(paths.history, '2026/10/07.md');
    expect(await fsp.readFile(file, 'utf8')).toBe(
      ['# 2026-10-07 (Wednesday)', '', '00:30 · Athlete: before midnight local (22:30Z = 00:30 next day)', '06:58 · Athlete: morning', '07:10 · Coach: Great!', ''].join('\n'),
    );
    await expect(fsp.stat(path.join(paths.history, '2026/10/06.md'))).rejects.toThrow();

    // re-render overwrites
    fake.events.push(msg('added later', '2026-10-07T10:00:00.000Z'));
    await renderHistory({ paths, store, athleteId: 'ath_h', tz: TZ, days: ['2026-10-07', '2026-10-06', '2026-10-08'] });
    expect(await fsp.readFile(file, 'utf8')).toContain('12:00 · Athlete: added later');
    expect(await fsp.readFile(path.join(paths.history, '2026/10/06.md'), 'utf8')).toBe('# 2026-10-06 (Tuesday)\n\n23:59 · Athlete: late evening local 06th (21:59Z = 23:59)\n');
    expect(await fsp.readFile(path.join(paths.history, '2026/10/08.md'), 'utf8')).toBe('# 2026-10-08 (Thursday)\n\n00:00 · Athlete: next local day (22:00Z = 00:00)\n');
    expect((await fsp.readdir(path.join(paths.history, '2026/10'))).sort()).toEqual(['06.md', '07.md', '08.md']);
  });

  it('is exact on DST days (23h and 25h) and writes a placeholder for empty days', async () => {
    const { paths, fake, store } = await setup();
    // 2026-10-25 in Amsterdam: 00:00 CEST = 2026-10-24T22:00Z ... 24:00 CET = 2026-10-25T23:00Z (25 h)
    fake.events.push(
      msg('last of the 24th', '2026-10-24T21:59:59.999Z'),
      msg('first of the 25th', '2026-10-24T22:00:00.000Z'),
      msg('second 02:30 (CET)', '2026-10-25T01:30:00.000Z'),
      msg('last of the 25th', '2026-10-25T22:59:59.999Z'),
      msg('first of the 26th', '2026-10-25T23:00:00.000Z'),
    );
    await renderHistory({ paths, store, athleteId: 'ath_h', tz: TZ, days: ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'] });
    const read = (d: string) => fsp.readFile(path.join(paths.history, `2026/10/${d}.md`), 'utf8');
    expect(await read('24')).toContain('23:59 · Athlete: last of the 24th');
    expect(await read('24')).not.toContain('first of the 25th');
    const d25 = await read('25');
    expect(d25).toContain('# 2026-10-25 (Sunday)');
    expect(d25).toContain('00:00 · Athlete: first of the 25th');
    expect(d25).toContain('02:30 · Athlete: second 02:30 (CET)');
    expect(d25).toContain('23:59 · Athlete: last of the 25th');
    expect(d25).not.toContain('first of the 26th');
    expect(await read('26')).toContain('00:00 · Athlete: first of the 26th');
    expect(await read('27')).toBe('# 2026-10-27 (Tuesday)\n\n_No events._\n');

    // spring: 2026-03-29 is 23 hours
    fake.events.length = 0;
    fake.events.push(msg('in the 28th', '2026-03-28T22:59:59.999Z'), msg('start of 29th', '2026-03-28T23:00:00.000Z'), msg('end of 29th', '2026-03-29T21:59:59.999Z'), msg('start of 30th', '2026-03-29T22:00:00.000Z'));
    await renderHistory({ paths, store, athleteId: 'ath_h', tz: TZ, days: ['2026-03-29'] });
    const spring = await fsp.readFile(path.join(paths.history, '2026/03/29.md'), 'utf8');
    expect(spring).toContain('00:00 · Athlete: start of 29th');
    expect(spring).toContain('23:59 · Athlete: end of 29th');
    expect(spring).not.toContain('start of 30th');
    expect(spring).not.toContain('in the 28th');
  });

  it('pages through more events than one store page', async () => {
    const { paths, fake, store } = await setup();
    for (let i = 0; i < 1234; i++) fake.events.push(msg(`m${i}`, new Date(Date.UTC(2026, 9, 7, 6, 0, 0) + i * 1000).toISOString()));
    await renderHistory({ paths, store, athleteId: 'ath_h', tz: 'UTC', days: ['2026-10-07'] });
    const text = await fsp.readFile(path.join(paths.history, '2026/10/07.md'), 'utf8');
    expect(text.split('\n').filter((l) => l.includes('Athlete: m')).length).toBe(1234);
    expect(text.indexOf('Athlete: m0\n')).toBeLessThan(text.indexOf('Athlete: m1233\n'));
  });

  it('only includes this athlete, and rejects invalid days before writing anything', async () => {
    const { paths, fake, store } = await setup();
    fake.events.push({ ...msg('mine', '2026-10-07T10:00:00Z') }, { ...msg('theirs', '2026-10-07T10:00:00Z'), athleteId: 'ath_other' } as AnyEvent);
    await renderHistory({ paths, store, athleteId: 'ath_h', tz: TZ, days: ['2026-10-07'] });
    const text = await fsp.readFile(path.join(paths.history, '2026/10/07.md'), 'utf8');
    expect(text).toContain('mine');
    expect(text).not.toContain('theirs');
    await expect(renderHistory({ paths, store, athleteId: 'ath_h', tz: TZ, days: ['2026-10-08', 'garbage'] })).rejects.toThrow(/invalid local date/);
    await expect(fsp.stat(path.join(paths.history, '2026/10/08.md'))).rejects.toThrow();
  });
});
