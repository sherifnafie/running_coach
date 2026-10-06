import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { Bridge, type ParentLike } from '../src/browser/bridge';
import { createCoach } from '../src/browser/coach';

const windows: HappyWindow[] = [];
const bridges: Bridge[] = [];
function setup() {
  const dom = new HappyWindow();
  windows.push(dom);
  const win = dom as unknown as Window & typeof globalThis;
  const posted: Array<{ id: string; method: string; params: unknown }> = [];
  const parent: ParentLike = { postMessage: (m) => posted.push(m as typeof posted[number]) };
  const reply = (data: unknown, source: unknown = parent) => win.dispatchEvent(new dom.MessageEvent('message', {
    data, source: source as never,
  }) as unknown as MessageEvent);
  return { win, parent, posted, reply };
}
afterEach(async () => {
  for (const b of bridges.splice(0)) b.dispose();
  for (const w of windows.splice(0)) await w.happyDOM.abort();
  vi.useRealTimers();
});

describe('[SEC-3] view-side JSON-RPC transport', () => {
  it('accepts a response only from its parent and routes results/errors by request id', async () => {
    const { win, parent, posted, reply } = setup();
    const bridge = new Bridge({ win, parent });
    bridges.push(bridge);
    const result = bridge.request('db.query', { sql: 'SELECT 1' });
    expect(posted[0]).toMatchObject({ jsonrpc: '2.0', id: 'c1', method: 'db.query' });
    reply({ jsonrpc: '2.0', id: 'c1', result: ['attack'] }, {});
    expect(bridge.inflight).toBe(1);
    reply({ jsonrpc: '2.0', id: 'c1', result: [{ value: 1 }] });
    await expect(result).resolves.toEqual([{ value: 1 }]);
    const rejected = bridge.request('files.read', { path: 'private.md' });
    reply({ jsonrpc: '2.0', id: 'c2', error: { code: -32000, message: 'not declared', data: 'detail' } });
    await expect(rejected).rejects.toMatchObject({ code: -32000, message: 'not declared', data: 'detail' });
    expect(bridge.inflight).toBe(0);
  });

  it('bounds request lifetimes and rejects outstanding requests when disposed', async () => {
    vi.useFakeTimers();
    const { win, parent } = setup();
    const bridge = new Bridge({ win, parent, timeoutMs: 20 });
    bridges.push(bridge);
    const timed = expect(bridge.request('env.get')).rejects.toMatchObject({ code: -32002 });
    await vi.advanceTimersByTimeAsync(21);
    await timed;
    const disposed = expect(bridge.request('env.get')).rejects.toMatchObject({ code: -32003 });
    bridge.dispose();
    await disposed;
    expect(bridge.inflight).toBe(0);
  });
});

describe('[UI-1] kit API and shell bridge contract', () => {
  it('applies bare ViewEnv, returns bare rows/text, writes exact mutation params', async () => {
    const { win, parent, posted, reply } = setup();
    const coach = createCoach({ win, parent, bare: true });
    const env = { theme: 'dark', locale: 'en-GB', units: 'imperial', tz: 'Europe/Amsterdam', nowMs: 1_000,
      safeArea: { top: 5, right: 0, bottom: 0, left: 0 }, viewport: { w: 390, h: 844 },
      online: true, viewId: 'today', params: { date: '2026-10-06' }, mode: 'preview' };
    reply({ jsonrpc: '2.0', id: posted[0]?.id, result: env });
    await coach.ready;
    expect(coach.env).toMatchObject(env);
    expect(coach.env.weekStartsOn).toBe(1);
    expect(win.document.documentElement.getAttribute('data-theme')).toBe('dark');
    const rows = coach.db.query('SELECT 1', [1]);
    reply({ jsonrpc: '2.0', id: posted.at(-1)?.id, result: [{ value: 1 }] });
    await expect(rows).resolves.toEqual([{ value: 1 }]);
    const file = coach.files.read('plan/current.md');
    reply({ jsonrpc: '2.0', id: posted.at(-1)?.id, result: '# Plan' });
    await expect(file).resolves.toBe('# Plan');
    const write = coach.db.write('planned_workouts', 'update', { status: 'done' }, { id: 'pw1' });
    expect(posted.at(-1)).toMatchObject({ method: 'db.write', params: { target: 'planned_workouts', op: 'update', row: { status: 'done' }, key: { id: 'pw1' } } });
    reply({ jsonrpc: '2.0', id: posted.at(-1)?.id, result: null });
    await write;
  });

  it('routes plural subscriptionIds and handles teardown before subscribe acknowledgment', async () => {
    const { win, parent, posted, reply } = setup();
    const coach = createCoach({ win, parent, bare: true });
    reply({ jsonrpc: '2.0', id: posted[0]?.id, result: {} });
    await coach.ready;
    const a = vi.fn(), b = vi.fn(), dead = vi.fn();
    coach.subscribe(['db:activities'], a);
    reply({ jsonrpc: '2.0', id: posted.at(-1)?.id, result: { subscriptionId: 'sub_1' } });
    coach.subscribe(['db:races'], b);
    reply({ jsonrpc: '2.0', id: posted.at(-1)?.id, result: { subscriptionId: 'sub_2' } });
    await Promise.resolve();
    reply({ jsonrpc: '2.0', method: 'changed', params: { subscriptionIds: ['sub_2'], targets: ['db:races'] } });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(['db:races']);
    const cancel = coach.subscribe(['file:plan/*'], dead);
    const id = posted.at(-1)?.id;
    cancel();
    reply({ jsonrpc: '2.0', id, result: { subscriptionId: 'sub_3' } });
    await Promise.resolve();
    expect(posted.at(-1)).toMatchObject({ method: 'unsubscribe', params: { subscriptionId: 'sub_3' } });
    reply({ jsonrpc: '2.0', id: posted.at(-1)?.id, result: null });
    reply({ jsonrpc: '2.0', method: 'changed', params: { subscriptionIds: ['sub_3'], targets: ['file:plan/current.md'] } });
    expect(dead).not.toHaveBeenCalled();
  });
});
