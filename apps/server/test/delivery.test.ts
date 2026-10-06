import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualClock, defaultSettings, parseEventPayload, silentLogger, type EventEnvelope, type PushProvider } from '@opencoach/protocol';
import { openSqliteStore } from '@opencoach/store';
import { createPushDelivery, createWebPushProvider } from '../src/push';
import { createTelegramAdapter } from '../src/telegram';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup() {
  const clock = new VirtualClock('2026-10-06T09:00:00Z');
  const store = await openSqliteStore({ path: ':memory:', clock });
  cleanup.push(() => store.close());
  const athlete = await store.createAthlete({ displayName: 'Sam', isAdmin: false, settings: defaultSettings() });
  const event = { id: 'evt_test', athleteId: athlete.id, ts: clock.now().toISOString(), type: 'coach.message', actor: 'coach',
    payload: parseEventPayload('coach.message', { messageId: 'm1', text: 'How was the run?', proactive: false, notify: 'normal', delivery: 'sent', ui: { notification_actions: [{ label: 'Easy', value: '3' }] } }),
  } satisfies EventEnvelope<'coach.message'>;
  await store.addPushSubscription({ id: 'p1', athleteId: athlete.id, kind: 'webpush', endpoint: 'https://push.example/a', keys: { p256dh: 'public', auth: 'secret' }, createdAt: clock.now().toISOString() });
  return { clock, store, athlete, event };
}
describe('delivery guarantees [MSG-1] [SEC-2]', () => {
  it('persists VAPID credentials with private permissions and reuses them across restarts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oc-vapid-')); cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const a = await createWebPushProvider({ dataDir, subject: 'mailto:admin@example.com' });
    const b = await createWebPushProvider({ dataDir, subject: 'mailto:admin@example.com' });
    expect(a.publicKey?.()).toBe(b.publicKey?.());
    expect((await stat(join(dataDir, 'secrets/vapid.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dataDir, 'secrets/vapid.json'), 'utf8')).privateKey).toBeTruthy();
  });
  it('skips connected clients, held messages, calls, disabled push and notify none', async () => {
    const { store, athlete, event } = await setup();
    const send = vi.fn(async () => ({ ok: true }));
    const deliver = createPushDelivery({ store, provider: { kind: 'webpush', send }, logger: silentLogger });
    await deliver(athlete.id, event, { connectedClients: 1 });
    for (const patch of [{ delivery: 'held' }, { channel: 'call' }, { notify: 'none' }] as const) {
      await deliver(athlete.id, { ...event, payload: { ...event.payload, ...patch } }, { connectedClients: 0 });
    }
    await store.updateSettings(athlete.id, { notifications: { push: false } });
    await deliver(athlete.id, event, { connectedClients: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it('delivers declared notification actions and removes expired subscriptions', async () => {
    const { store, athlete, event } = await setup();
    const send = vi.fn<PushProvider['send']>(async () => ({ ok: false, gone: true }));
    await createPushDelivery({ store, provider: { kind: 'webpush', send }, logger: silentLogger })(athlete.id, event, { connectedClients: 0 });
    expect(send.mock.calls[0]![1].actions).toEqual([{ action: '3', title: 'Easy' }]);
    expect(await store.listPushSubscriptions(athlete.id)).toEqual([]);
  });
  it('links Telegram through an expiring code, accepts only linked private messages, and revokes the mapping', async () => {
    const { clock, store, athlete } = await setup();
    const ingest = vi.fn(async () => ({}));
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    const adapter = createTelegramAdapter({ token: 'test-token', store, clock, runtime: { ingest } as never, logger: silentLogger, fetch: request as never });
    await adapter.handle({ update_id: 1, message: { text: 'hello', chat: { id: 1, type: 'private' } } });
    expect(ingest).not.toHaveBeenCalled();
    const code = await adapter.createLinkCode(athlete.id);
    await adapter.handle({ update_id: 2, message: { text: `/start ${code}`, chat: { id: 1, type: 'private' } } });
    await adapter.handle({ update_id: 3, message: { text: 'I ran 5k', chat: { id: 1, type: 'group' } } });
    await adapter.handle({ update_id: 4, message: { text: 'I ran 5k', chat: { id: 1, type: 'private' } } });
    expect(ingest).toHaveBeenCalledExactlyOnceWith(athlete.id, { type: 'user.message', payload: { text: 'I ran 5k', channel: 'telegram', clientId: 'telegram:4' } });
    await adapter.unlink(athlete.id);
    await adapter.handle({ update_id: 5, message: { text: 'after unlink', chat: { id: 1, type: 'private' } } });
    expect(ingest).toHaveBeenCalledTimes(1);
    const expired = await adapter.createLinkCode(athlete.id);
    await clock.advanceBy(11 * 60_000);
    await adapter.handle({ update_id: 6, message: { text: `/start ${expired}`, chat: { id: 1, type: 'private' } } });
    expect(await store.getKv('telegram-chat:1')).toBe('');
  });
});
