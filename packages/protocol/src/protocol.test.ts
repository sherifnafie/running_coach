import { describe, expect, it } from 'vitest';
import {
  AppManifest,
  EventPayloads,
  ToolInputs,
  ViewManifest,
  VirtualClock,
  defaultSettings,
  mergeSettings,
  newId,
  parseEventPayload,
  toToolJsonSchema,
  ServerConfig,
  athletePaths,
} from './index';

describe('settings', () => {
  it('fills defaults', () => {
    const s = defaultSettings();
    expect(s.notifications.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect(s.notifications.proactivePerDay).toBe(3);
    expect(s.heartbeat.time).toBe('07:30');
    expect(s.profile.tz).toBe('UTC');
    expect(s.images).toEqual({ mode: 'requested', monthlyUsd: .25 });
  });
  it('merges patches and reports a diff', () => {
    const { settings, diff } = mergeSettings(defaultSettings(), { notifications: { proactivePerDay: 1 }, profile: { tz: 'Europe/Amsterdam' } });
    expect(settings.notifications.proactivePerDay).toBe(1);
    expect(settings.notifications.minGapMinutes).toBe(120);
    expect(diff['notifications.proactivePerDay']).toEqual({ from: 3, to: 1 });
    expect(diff['profile.tz']).toEqual({ from: 'UTC', to: 'Europe/Amsterdam' });
  });
});

describe('events', () => {
  it('applies payload defaults', () => {
    const p = parseEventPayload('user.message', { text: 'hi' });
    expect(p.attachments).toEqual([]);
    expect(p.channel).toBe('app');
  });
  it('rejects invalid payloads', () => {
    expect(() => EventPayloads['user.upload'].parse({ blobs: [] })).toThrow();
  });
});

describe('views', () => {
  it('parses a manifest with defaults', () => {
    const m = ViewManifest.parse({ id: 'calendar', title: 'Calendar', reads: ['db:planned_workouts', 'file:plan/current.md'] });
    expect(m.entry).toBe('index.html');
    expect(m.kit).toBe('1');
    expect(m.placement).toEqual({ hidden: true });
    expect(() => ViewManifest.parse({ id: 'Bad Id', title: 'x' })).toThrow();
    expect(AppManifest.parse({ nav: ['today'] }).version).toBe(1);
  });
});

describe('tool schemas', () => {
  it('[MSG-3] send_message rejects an empty ui or one with unknown keys instead of silently dropping it', () => {
    expect(ToolInputs.send_message.safeParse({ text: 'hi', ui: {} }).success).toBe(false);
    expect(ToolInputs.send_message.safeParse({ text: 'hi', ui: { forms: [{ id: 'x' }] } }).success).toBe(false);
    expect(ToolInputs.send_message.safeParse({ text: 'hi', ui: { quick_replies: [{ label: 'ok', value: 'ok' }] } }).success).toBe(true);
    expect(ToolInputs.send_message.safeParse({ text: 'hi' }).success).toBe(true);
  });

  it('produce object JSON schemas', () => {
    for (const [name, schema] of Object.entries(ToolInputs)) {
      const js = toToolJsonSchema(schema);
      expect(js.type, name).toBe('object');
      expect(js.$schema).toBeUndefined();
    }
    const send = toToolJsonSchema(ToolInputs.send_message) as { properties: Record<string, unknown>; required: string[] };
    expect(send.required).toContain('text');
    expect(Object.keys(send.properties)).toContain('quick_replies' in send.properties ? 'quick_replies' : 'ui');
  });
});

describe('VirtualClock', () => {
  it('resolves sleepers in order as time advances', async () => {
    const clock = new VirtualClock('2026-10-07T00:00:00Z');
    const order: string[] = [];
    void clock.sleepUntil(new Date('2026-10-07T02:00:00Z')).then(() => order.push('b'));
    void clock.sleepUntil(new Date('2026-10-07T01:00:00Z')).then(() => order.push('a'));
    expect(clock.nextWakeAt()?.toISOString()).toBe('2026-10-07T01:00:00.000Z');
    await clock.advanceTo('2026-10-07T01:30:00Z');
    expect(order).toEqual(['a']);
    await clock.advanceTo('2026-10-07T03:00:00Z');
    expect(order).toEqual(['a', 'b']);
    expect(clock.now().toISOString()).toBe('2026-10-07T03:00:00.000Z');
  });
  it('ids are time-sortable under a virtual clock', () => {
    const clock = new VirtualClock('2030-01-01T00:00:00Z');
    const a = newId('evt', clock);
    const b = newId('evt', clock);
    expect(a < b).toBe(true);
    expect(a.startsWith('evt_')).toBe(true);
  });
});

describe('config', () => {
  it('parses an empty config with defaults', () => {
    const c = ServerConfig.parse({});
    expect(c.port).toBe(8080);
    expect(c.sandbox.provider).toBe('local');
    expect(c.limits.pinnedTokenCap).toBe(12000);
    expect(c.voice.realtime.model).toBe('gpt-realtime-2.1');
    expect(athletePaths('/data', 'ath_1').workspace).toBe('/data/athletes/ath_1/workspace');
  });
});
