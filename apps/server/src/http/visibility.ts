import { ATHLETE_VISIBLE_TYPES, type AnyEvent, type Store, type StreamMessage } from '@opencoach/protocol';

const VISIBLE = new Set<string>(ATHLETE_VISIBLE_TYPES);

/**
 * What an athlete may see in their history (GET /v1/events, WS resume):
 * only ATHLETE_VISIBLE_TYPES; `harness.notice` only when payload.athleteVisible; held coach messages never
 * (the released copy is a separate, sent event).
 */
export function isAthleteVisible(e: AnyEvent): boolean {
  if (!VISIBLE.has(e.type)) return false;
  if (e.type === 'harness.notice') return e.payload.athleteVisible === true;
  if (e.type === 'coach.message') return e.payload.delivery === 'sent';
  return true;
}

/** Stream messages that carry an event are filtered with the same rule; everything else is forwarded. */
export function isAthleteVisibleStreamMessage(m: StreamMessage): boolean {
  if (m.t === 'event') return isAthleteVisible(m.event);
  if (m.t === 'message.end') return m.event.payload.delivery === 'sent';
  return true;
}

export interface VisiblePage {
  events: AnyEvent[];
  hasMore: boolean;
}

/**
 * Page through the athlete-visible events.
 *  - `after` (optionally with `before`): ascending from the cursor.
 *  - otherwise: the newest `limit` events (before `before` if given), returned ascending.
 */
export async function listVisibleEvents(
  store: Store,
  athleteId: string,
  opts: { before?: string; after?: string; limit: number },
): Promise<VisiblePage> {
  const { limit } = opts;
  const want = limit + 1;
  const order: 'asc' | 'desc' = opts.after ? 'asc' : 'desc';
  let afterId = opts.after;
  let beforeId = opts.before;
  const out: AnyEvent[] = [];
  let exhausted = false;

  for (let i = 0; i < 25 && out.length < want; i++) {
    const batchSize = Math.min(Math.max(want - out.length, 50), 500);
    const batch = await store.listEvents({ athleteId, types: ATHLETE_VISIBLE_TYPES, afterId, beforeId, order, limit: batchSize });
    for (const e of batch) {
      if (isAthleteVisible(e)) out.push(e);
      if (out.length >= want) break;
    }
    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
    const last = batch[batch.length - 1]!;
    if (order === 'asc') afterId = last.id;
    else beforeId = last.id;
  }

  const hasMore = out.length > limit || (!exhausted && out.length < want);
  const page = out.slice(0, limit);
  if (order === 'desc') page.reverse();
  return { events: page, hasMore };
}
