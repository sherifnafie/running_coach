import { describe, expect, it } from 'vitest';
import type { AnyEvent, AppInfo, PublishedView } from '@opencoach/protocol';
import { contrastRatio, contrastText } from './color';
import { classifyExportResponse } from './exportJob';
import { presenceLabel } from './format';
import { computeNav, isActive } from './nav';
import { EnergyVad, extensionForMime, pickRecorderMime, rms } from './recorder';
import { parseHash, formatRoute } from './router';
import { addDismissed, bannerFromEvent, bannerFromHistory, bannerFromStream, guidanceFor, isDismissed } from './safety';
import { initialLoadState, reduceLoad } from './viewLoad';
import { providerCallIdFrom } from './calls';
import { notificationActionRequest, parsePushPayload, safeTargetUrl } from '../sw-shared';

const view = (id: string, extra: Partial<PublishedView> = {}): PublishedView => ({
  manifest: { id, title: id.toUpperCase(), icon: 'circle', placement: { nav: 0 }, entry: 'index.html', kit: '1', reads: [], writes: [], actions: [], refresh: 'on-change' },
  version: '1',
  url: `http://views/${id}`,
  ...extra,
});
const appWith = (ids: string[], extra: string[] = []): AppInfo => ({
  app: { version: 1, nav: ids, theme: {} },
  views: [...ids, ...extra].map((i) => view(i)),
  kitUrl: 'http://views/kit',
});

describe('navigation slots', () => {
  it('Chat is first and Settings last, even with no app info (the shell never breaks)', () => {
    expect(computeNav(undefined).slots.map((s) => s.key)).toEqual(['chat', 'settings']);
    expect(computeNav(appWith([])).slots.map((s) => s.key)).toEqual(['chat', 'settings']);
  });

  it('fits up to three coach views between Chat and Settings', () => {
    const { slots, overflow } = computeNav(appWith(['today', 'calendar', 'plan']));
    expect(slots.map((s) => s.key)).toEqual(['chat', 'view:today', 'view:calendar', 'view:plan', 'settings']);
    expect(overflow).toEqual([]);
  });

  it('overflows into More, keeping Settings reachable', () => {
    const { slots, overflow } = computeNav(appWith(['today', 'calendar', 'plan', 'progress', 'race']));
    expect(slots).toHaveLength(5);
    expect(slots.map((s) => s.key)).toEqual(['chat', 'view:today', 'view:calendar', 'more', 'settings']);
    expect(overflow.map((o) => o.key)).toEqual(['view:plan', 'view:progress', 'view:race']);
  });

  it('ignores nav entries without a published view and duplicates; a coach cannot remove Chat', () => {
    const app = appWith(['today']);
    app.app.nav = ['ghost', 'today', 'today', 'chat'];
    const keys = computeNav(app).slots.map((s) => s.key);
    expect(keys).toEqual(['chat', 'view:today', 'settings']);
  });

  it('marks the active item, including More for overflowed views', () => {
    const nav = computeNav(appWith(['a', 'b', 'c', 'd']));
    const more = nav.slots.find((s) => s.more)!;
    expect(isActive(more, { name: 'view', viewId: 'd', params: {} }, nav.overflow)).toBe(true);
    expect(isActive(more, { name: 'view', viewId: 'a', params: {} }, nav.overflow)).toBe(false);
    expect(isActive(nav.slots[0]!, { name: 'chat' })).toBe(true);
  });
});

describe('router', () => {
  it('round-trips routes through the hash', () => {
    const r = parseHash('#/view/calendar?date=2026-10-07');
    expect(r).toEqual({ name: 'view', viewId: 'calendar', params: { date: '2026-10-07' } });
    expect(formatRoute(r)).toBe('#/view/calendar?date=2026-10-07');
    expect(parseHash('')).toEqual({ name: 'chat' });
    expect(parseHash('#/settings/privacy')).toEqual({ name: 'settings', section: 'privacy' });
    expect(parseHash('#/view')).toEqual({ name: 'chat' });
    expect(parseHash('#/nonsense')).toEqual({ name: 'chat' });
  });
});

describe('last-known-good view loading', () => {
  it('falls back to the previous version on error or timeout before ready, then fails', () => {
    let s = reduceLoad(initialLoadState, { type: 'error', message: 'boom' }, true);
    expect(s).toEqual({ phase: 'loading', source: 'previous', reason: 'boom' });
    s = reduceLoad(s, { type: 'timeout' }, true);
    expect(s).toMatchObject({ phase: 'failed', source: 'previous' });
    expect(reduceLoad(initialLoadState, { type: 'timeout' }, true)).toMatchObject({ source: 'previous' });
  });

  it('fails immediately when there is no previous version', () => {
    expect(reduceLoad(initialLoadState, { type: 'timeout' }, false)).toMatchObject({ phase: 'failed', source: 'current' });
  });

  it('ready ends loading; later errors never swap the version under the athlete', () => {
    let s = reduceLoad(initialLoadState, { type: 'ready' }, true);
    expect(s.phase).toBe('ready');
    s = reduceLoad(s, { type: 'error', message: 'late' }, true);
    expect(s).toMatchObject({ phase: 'ready', source: 'current' });
    s = reduceLoad(s, { type: 'timeout' }, true);
    expect(s.phase).toBe('ready');
  });

  it('reset starts over (retry)', () => {
    const failed = reduceLoad(initialLoadState, { type: 'timeout' }, false);
    expect(reduceLoad(failed, { type: 'reset' }, false)).toEqual(initialLoadState);
  });
});

describe('safety banner (harness-owned)', () => {
  const ev = (over: object): AnyEvent =>
    ({ id: 'evt_s1', athleteId: 'a', ts: '2026-10-06T10:00:00.000Z', type: 'harness.notice', actor: 'harness', payload: { kind: 'safety_flag', athleteVisible: true, text: 'Please stop.', detail: { categories: ['cardiac'], acute: true }, ...over } }) as AnyEvent;

  it('is derived from the stream safety message', () => {
    const b = bannerFromStream({ t: 'safety', categories: ['heat_illness'], acute: false, text: 'Hot day' }, 1000);
    expect(b).toMatchObject({ categories: ['heat_illness'], acute: false, text: 'Hot day', atMs: 1000 });
  });

  it('is derived from athlete-visible safety_flag notices only', () => {
    expect(bannerFromEvent(ev({}))).toMatchObject({ key: 'evt_s1', acute: true, categories: ['cardiac'], text: 'Please stop.' });
    expect(bannerFromEvent(ev({ athleteVisible: false }))).toBeUndefined();
    expect(bannerFromEvent(ev({ kind: 'budget_warning' }))).toBeUndefined();
  });

  it('re-shows a recent notice from history, but not an old one', () => {
    const t = Date.parse('2026-10-06T10:00:00.000Z');
    expect(bannerFromHistory([ev({})], t + 60_000)).toBeDefined();
    expect(bannerFromHistory([ev({})], t + 7 * 3600_000)).toBeUndefined();
  });

  it('always includes emergency guidance and the AI-not-a-clinician line', () => {
    const lines = guidanceFor(['self_harm']);
    expect(lines[0]).toMatch(/emergency number/i);
    expect(lines.some((l) => /crisis line/i.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/AI/);
    expect(guidanceFor([])[0]).toMatch(/emergency/i);
  });

  it('remembers dismissals per notice (dismiss for now)', () => {
    const b = bannerFromStream({ t: 'safety', categories: [], acute: false, text: '' }, 5);
    const dismissed = addDismissed([], b.key);
    expect(isDismissed(b, dismissed)).toBe(true);
    expect(isDismissed(bannerFromStream({ t: 'safety', categories: [], acute: false, text: '' }, 6), dismissed)).toBe(false);
    expect(addDismissed(Array.from({ length: 30 }, (_, i) => `k${i}`), 'new')).toHaveLength(20);
  });
});

describe('service worker helpers', () => {
  it('parses a protocol PushNotification payload', () => {
    const p = parsePushPayload(JSON.stringify({ title: 'Coach', body: 'Easy 8k today', tag: 'm1', data: { url: '/#/chat', messageId: 'evt_1', athleteId: 'a' }, actions: [{ action: 'done', title: 'Done' }, { action: 'skip', title: 'Skipped' }] }));
    expect(p).toMatchObject({ title: 'Coach', body: 'Easy 8k today', tag: 'm1', data: { messageId: 'evt_1' } });
    expect(p.actions).toHaveLength(2);
  });

  it('also accepts the fields nested under payload.data', () => {
    const p = parsePushPayload({ data: { title: 'Nested', body: 'b', data: { url: '/x', messageId: 'evt_2' }, actions: [{ action: 'a', title: 'A' }] } });
    expect(p).toMatchObject({ title: 'Nested', body: 'b', data: { url: '/x', messageId: 'evt_2' } });
    expect(p.actions).toEqual([{ action: 'a', title: 'A' }]);
  });

  it('survives plain text and junk', () => {
    expect(parsePushPayload('hello')).toMatchObject({ title: 'OpenCoach', body: 'hello' });
    expect(parsePushPayload(undefined)).toMatchObject({ title: 'OpenCoach', body: '' });
    expect(parsePushPayload({ title: 5, actions: [{ nope: 1 }, 'x'] }).actions).toEqual([]);
  });

  it('limits actions to three', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ action: `a${i}`, title: `A${i}` }));
    expect(parsePushPayload({ title: 't', actions }).actions).toHaveLength(3);
  });

  it('builds the ui-action for a tapped notification button', () => {
    expect(notificationActionRequest({ messageId: 'evt_9', athleteId: 'a' }, 'done')).toEqual({
      url: '/v1/ui-actions',
      body: { source: { messageId: 'evt_9' }, action: 'notification_action', payload: { value: 'done' }, wake: true },
    });
  });

  it('only opens same-origin targets', () => {
    expect(safeTargetUrl('/#/chat', 'https://app.example')).toBe('/#/chat');
    expect(safeTargetUrl('https://app.example/view/x?y=1', 'https://app.example')).toBe('/view/x?y=1');
    expect(safeTargetUrl('https://evil.example/phish', 'https://app.example')).toBe('/');
    expect(safeTargetUrl(undefined, 'https://app.example')).toBe('/');
  });
});

describe('export polling', () => {
  it('classifies gateway responses', () => {
    expect(classifyExportResponse({ status: 202, contentType: 'application/json' })).toEqual({ state: 'pending' });
    expect(classifyExportResponse({ status: 404, contentType: 'application/json' })).toEqual({ state: 'pending' });
    expect(classifyExportResponse({ status: 200, contentType: 'application/json', json: { status: 'pending' } })).toEqual({ state: 'pending' });
    expect(classifyExportResponse({ status: 200, contentType: 'application/json', json: { status: 'ready', url: '/f' } })).toEqual({ state: 'ready', url: '/f' });
    expect(classifyExportResponse({ status: 200, contentType: 'application/json', json: { status: 'failed', error: 'disk full' } })).toEqual({ state: 'failed', message: 'disk full' });
    expect(classifyExportResponse({ status: 200, contentType: 'application/zip' })).toEqual({ state: 'ready' });
    expect(classifyExportResponse({ status: 500, contentType: 'application/json', json: { error: { message: 'nope' } } })).toEqual({ state: 'failed', message: 'nope' });
  });
});

describe('recording helpers', () => {
  it('prefers webm/opus, falls back to mp4 on Safari', () => {
    expect(pickRecorderMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecorderMime(() => false)).toBeUndefined();
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
  });

  it('measures level', () => {
    expect(rms(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(rms(new Uint8Array([255, 1, 255, 1]))).toBeGreaterThan(0.9);
  });

  it('energy VAD: detects speech start, end after silence, and discards blips', () => {
    const vad = new EnergyVad({ threshold: 0.05, silenceMs: 1000, minSpeechMs: 400 });
    expect(vad.push(0.01, 0)).toBeUndefined();
    expect(vad.push(0.2, 100)).toBe('start');
    expect(vad.push(0.2, 300)).toBeUndefined();
    expect(vad.push(0.2, 700)).toBeUndefined();
    expect(vad.push(0.01, 1200)).toBeUndefined();
    expect(vad.push(0.01, 1800)).toBe('end');
    expect(vad.push(0.2, 2000)).toBe('start');
    expect(vad.push(0.01, 3100)).toBe('discard');
  });
});

describe('misc', () => {
  it('presence label reads like a person', () => {
    expect(presenceLabel('Coach', 'Looking at your splits…', 'working')).toBe('Coach is looking at your splits…');
    expect(presenceLabel('Coach', undefined, 'typing')).toBe('Coach is typing…');
    expect(presenceLabel('Coach', undefined, 'idle')).toBe('');
    expect(presenceLabel('Maya', 'Pace data ready', 'working')).toBe('Maya: Pace data ready');
  });

  it('picks readable text for any coach accent colour', () => {
    expect(contrastText('#E4572E')).toBe('#111214');
    expect(contrastText('#1a3a8f')).toBe('#ffffff');
    for (const c of ['#E4572E', '#ffffff', '#000000', '#22aa55', '#c8431c']) {
      expect(contrastRatio(c, contrastText(c))).toBeGreaterThan(4.5);
    }
  });

  it('extracts the provider call id from the Location header', () => {
    expect(providerCallIdFrom('https://api.openai.com/v1/realtime/calls/rtc_u1_abc123')).toBe('rtc_u1_abc123');
    expect(providerCallIdFrom('/v1/realtime/calls/rtc_x?foo=1')).toBe('rtc_x');
    expect(providerCallIdFrom(null)).toBeUndefined();
  });
});
