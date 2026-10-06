import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { OfflineQueue, idbQueueStorage, memoryQueueStorage, type QueuedRequest, type SendResult } from './offlineQueue';

const msg = (text: string, clientId: string) => ({ kind: 'message' as const, method: 'POST' as const, path: '/v1/messages', body: { text, clientId }, clientId });

function make(send: (r: QueuedRequest) => Promise<SendResult>, storage = memoryQueueStorage()) {
  const sent: QueuedRequest[] = [];
  const dropped: QueuedRequest[] = [];
  const queue = new OfflineQueue(storage, send, { onSent: (r) => sent.push(r), onDropped: (r) => dropped.push(r) });
  return { queue, sent, dropped, storage };
}

describe('OfflineQueue', () => {
  it('persists requests and replays them oldest first', async () => {
    const order: string[] = [];
    const { queue, sent } = make(async (r) => {
      order.push((r.body as { text: string }).text);
      return { ok: true, data: {} };
    });
    await queue.enqueue(msg('one', 'c1'));
    await queue.enqueue(msg('two', 'c2'));
    await queue.enqueue(msg('three', 'c3'));
    expect(await queue.list()).toHaveLength(3);
    const res = await queue.flush();
    expect(order).toEqual(['one', 'two', 'three']);
    expect(res).toEqual({ sent: 3, dropped: 0, remaining: 0 });
    expect(sent).toHaveLength(3);
    expect(await queue.list()).toHaveLength(0);
  });

  it('stops at the first retryable failure so later messages never overtake earlier ones', async () => {
    let calls = 0;
    const { queue, sent } = make(async (r) => {
      calls++;
      if ((r.body as { text: string }).text === 'two') return { ok: false, retryable: true, error: new Error('offline') };
      return { ok: true, data: {} };
    });
    await queue.enqueue(msg('one', 'c1'));
    await queue.enqueue(msg('two', 'c2'));
    await queue.enqueue(msg('three', 'c3'));
    const res = await queue.flush();
    expect(calls).toBe(2);
    expect(sent.map((r) => r.clientId)).toEqual(['c1']);
    expect(res).toEqual({ sent: 1, dropped: 0, remaining: 2 });
    const left = await queue.list();
    expect(left.map((r) => r.clientId)).toEqual(['c2', 'c3']);
    expect(left[0]?.attempts).toBe(1);
  });

  it('drops requests the server rejects for good and carries on', async () => {
    const { queue, sent, dropped } = make(async (r) => (r.clientId === 'bad' ? { ok: false, retryable: false, error: new Error('400') } : { ok: true, data: {} }));
    await queue.enqueue(msg('a', 'bad'));
    await queue.enqueue(msg('b', 'good'));
    const res = await queue.flush();
    expect(res).toEqual({ sent: 1, dropped: 1, remaining: 0 });
    expect(dropped.map((r) => r.clientId)).toEqual(['bad']);
    expect(sent.map((r) => r.clientId)).toEqual(['good']);
  });

  it('treats a throwing sender as retryable', async () => {
    const { queue } = make(async () => {
      throw new Error('kaboom');
    });
    await queue.enqueue(msg('a', 'c1'));
    const res = await queue.flush();
    expect(res.remaining).toBe(1);
  });

  it('does not queue the same message twice (retries are idempotent by clientId)', async () => {
    const { queue } = make(async () => ({ ok: true, data: {} }));
    await queue.enqueue(msg('a', 'c1'));
    await queue.enqueue(msg('a', 'c1'));
    expect(await queue.list()).toHaveLength(1);
  });

  it('concurrent flushes share one run (no double sends)', async () => {
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, data: {} } as SendResult;
    });
    const { queue } = make(send);
    await queue.enqueue(msg('a', 'c1'));
    await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('survives a reload with IndexedDB storage', async () => {
    const storage1 = idbQueueStorage('test-queue-1');
    const q1 = new OfflineQueue(storage1, async () => ({ ok: false, retryable: true, error: new Error('offline') }));
    await q1.enqueue(msg('persist me', 'c9'));
    // "reload": a new queue over the same database
    const delivered: string[] = [];
    const q2 = new OfflineQueue(idbQueueStorage('test-queue-1'), async (r) => {
      delivered.push(r.clientId!);
      return { ok: true, data: {} };
    });
    expect((await q2.list()).map((r) => r.clientId)).toEqual(['c9']);
    await q2.flush();
    expect(delivered).toEqual(['c9']);
    expect(await q2.list()).toHaveLength(0);
  });

  it('remove() deletes a single entry', async () => {
    const { queue } = make(async () => ({ ok: true, data: {} }));
    const a = await queue.enqueue(msg('a', 'c1'));
    await queue.enqueue(msg('b', 'c2'));
    await queue.remove(a.id);
    expect((await queue.list()).map((r) => r.clientId)).toEqual(['c2']);
  });
});
