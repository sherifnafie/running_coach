import { randomToken, type Clock, type DeliveryHook, type Logger, type Store, type CoachRuntimeAPI } from '@opencoach/protocol';

type TelegramUpdate = { update_id: number; message?: { text?: string; chat: { id: number; type: string } } };

/** Optional private-chat adapter. Linking requires a short-lived code issued by an authenticated app. */
export function createTelegramAdapter(opts: { token: string; store: Store; clock: Clock; runtime: CoachRuntimeAPI; logger: Logger; fetch?: typeof fetch }) {
  const request = opts.fetch ?? fetch;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  async function api(method: string, body: unknown, signal?: AbortSignal) {
    const response = await request(`https://api.telegram.org/bot${opts.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`Telegram ${method} HTTP ${response.status}`);
    const result = await response.json() as { ok: boolean; result: unknown };
    if (!result.ok) throw new Error(`Telegram ${method} failed`);
    return result.result;
  }
  async function reply(chatId: number, text: string) { await api('sendMessage', { chat_id: chatId, text: text.slice(0, 4096) }); }
  async function handle(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text || message.chat.type !== 'private') return;
    const chatId = message.chat.id;
    const key = `telegram-chat:${chatId}`;
    const link = /^\/start(?:@\S+)?\s+([A-Za-z0-9_-]+)$/.exec(message.text);
    if (link) {
      const codeKey = `telegram-link:${link[1]}`;
      const raw = await opts.store.getKv(codeKey);
      await opts.store.setKv(codeKey, '');
      const data = raw ? JSON.parse(raw) as { athleteId: string; expires: number } : undefined;
      if (!data || data.expires <= opts.clock.now().getTime() || (await opts.store.getAthlete(data.athleteId))?.status !== 'active') {
        await reply(chatId, 'This link code has expired. Create a new code in OpenCoach settings.'); return;
      }
      await unlink(data.athleteId);
      const oldAthlete = await opts.store.getKv(key);
      if (oldAthlete) await unlink(oldAthlete);
      await opts.store.setKv(key, data.athleteId);
      await opts.store.setKv(`telegram-athlete:${data.athleteId}`, String(chatId));
      await reply(chatId, 'Linked to OpenCoach. Your messages here go to your coach.'); return;
    }
    const athleteId = await opts.store.getKv(key);
    if (!athleteId || (await opts.store.getAthlete(athleteId))?.status !== 'active') return;
    if (message.text === '/unlink') { await unlink(athleteId); await reply(chatId, 'OpenCoach has been unlinked.'); return; }
    await opts.runtime.ingest(athleteId, { type: 'user.message', payload: { text: message.text.slice(0, 20_000), channel: 'telegram', clientId: `telegram:${update.update_id}` } });
  }
  async function unlink(athleteId: string) {
    const chat = await opts.store.getKv(`telegram-athlete:${athleteId}`);
    if (chat) await opts.store.setKv(`telegram-chat:${chat}`, '');
    await opts.store.setKv(`telegram-athlete:${athleteId}`, '');
  }
  return {
    async createLinkCode(athleteId: string) {
      const code = randomToken(18);
      await opts.store.setKv(`telegram-link:${code}`, JSON.stringify({ athleteId, expires: opts.clock.now().getTime() + 10 * 60_000 }));
      return code;
    }, unlink,
    /** Also exposed for deterministic adapter tests. */
    handle,
    delivery: (async (athleteId, event) => {
      if (event.payload.delivery !== 'sent' || event.payload.channel !== 'telegram') return;
      const chat = await opts.store.getKv(`telegram-athlete:${athleteId}`);
      if (chat) await reply(Number(chat), event.payload.text);
    }) satisfies DeliveryHook,
    start() {
      if (running) return;
      controller = new AbortController();
      const signal = controller.signal;
      running = (async () => {
        let offset = Number(await opts.store.getKv('telegram-offset') ?? '0');
        while (!signal.aborted) {
          try {
            const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, signal) as TelegramUpdate[];
            for (const update of updates) {
              await handle(update);
              offset = update.update_id + 1;
              await opts.store.setKv('telegram-offset', String(offset));
            }
          } catch (error) {
            if (signal.aborted) break;
            // Errors can contain provider URLs with credentials; report only a generic operation failure.
            opts.logger.warn('Telegram polling failed; retrying');
            await opts.clock.sleepUntil(new Date(opts.clock.now().getTime() + 5000), signal).catch(() => {});
          }
        }
      })();
    },
    async stop() { controller?.abort(); await running; running = undefined; },
  };
}
