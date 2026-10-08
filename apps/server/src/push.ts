import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webPush from 'web-push';
import type { DeliveryHook, Logger, PushNotification, PushProvider, Store } from '@opencoach/protocol';

interface VapidKeys { publicKey: string; privateKey: string }

/** Deployment credentials stay on the trusted host, outside all athlete mounts [SEC-2]. */
export async function createWebPushProvider(opts: { dataDir: string; subject: string }): Promise<PushProvider> {
  const dir = join(opts.dataDir, 'secrets');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, 'vapid.json');
  let keys: VapidKeys;
  try {
    keys = JSON.parse(await readFile(file, 'utf8')) as VapidKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    keys = webPush.generateVAPIDKeys();
    try { await writeFile(file, JSON.stringify(keys), { mode: 0o600, flag: 'wx' }); }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      keys = JSON.parse(await readFile(file, 'utf8')) as VapidKeys;
    }
  }
  if (!keys.publicKey || !keys.privateKey) throw new Error('Invalid VAPID key file');
  await chmod(file, 0o600);
  return {
    kind: 'webpush',
    publicKey: () => keys.publicKey,
    async send(sub, notification) {
      if (!sub.keys) return { ok: false, gone: true, error: 'Missing subscription keys' };
      try {
        await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(notification), {
          vapidDetails: { subject: opts.subject, ...keys }, TTL: 3600, timeout: 15_000, urgency: 'high',
        });
        return { ok: true };
      } catch (error) {
        const e = error as { statusCode?: number; message?: string };
        return { ok: false, gone: e.statusCode === 404 || e.statusCode === 410, error: e.message ?? 'Push failed' };
      }
    },
  };
}

/** A live socket is not evidence that an athlete saw a message on any device [MSG-1]. */
export function createPushDelivery(opts: { store: Store; provider: PushProvider; logger: Logger }): DeliveryHook {
  return async (athleteId, event) => {
    const message = event.payload;
    if (message.delivery !== 'sent' || message.channel === 'call' || message.notify === 'none') return;
    const settings = await opts.store.getSettings(athleteId);
    if (!settings.notifications.push) return;
    const notification: PushNotification = {
      title: settings.profile.coachName,
      body: message.text.slice(0, 240),
      tag: message.messageId,
      data: { athleteId, messageId: message.messageId, url: '/chat', kind: 'message' },
      actions: message.ui?.notification_actions?.map((a) => ({ action: a.value, title: a.label })),
      silent: message.notify === 'silent',
    };
    for (const sub of await opts.store.listPushSubscriptions(athleteId)) {
      if (sub.kind !== opts.provider.kind) continue;
      const result = await opts.provider.send(sub, notification);
      if (result.gone) await opts.store.deletePushSubscription(sub.id);
      else if (!result.ok) opts.logger.warn('push delivery failed', { athleteId, subscriptionId: sub.id, error: result.error });
    }
  };
}
