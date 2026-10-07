import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewEnv } from '@opencoach/protocol';
import { ApiRequestError, NetworkError } from './api';
import { BRIDGE_ERR, BridgeHost, normalizeFile, normalizeRows, type BridgeActions, type BridgeBackend } from './bridge';

const ENV: ViewEnv = {
  theme: 'dark',
  locale: 'en-GB',
  units: 'metric',
  tz: 'Europe/Amsterdam',
  nowMs: 1_800_000_000_000,
  safeArea: { top: 0, right: 0, bottom: 20, left: 0 },
  viewport: { w: 390, h: 700 },
  online: true,
  viewId: 'plan',
  params: { week: '3' },
  mode: 'live',
};

function setup() {
  const viewWindow = { name: 'view-iframe' };
  const posted: any[] = [];
  const backend = {
    query: vi.fn(async () => ({ rows: [{ a: 1 }] })),
    file: vi.fn(async () => ({ content: '# plan' })),
    write: vi.fn(async () => ({ ok: true })),
    act: vi.fn(async () => ({ ok: true })),
    error: vi.fn(async (..._args: Parameters<BridgeBackend['error']>) => ({ ok: true })),
  } satisfies BridgeBackend;
  const actions = {
    navigate: vi.fn(),
    openChat: vi.fn(),
    toast: vi.fn(),
    resize: vi.fn(),
    ready: vi.fn(),
    viewError: vi.fn(),
    wrote: vi.fn(),
    activity: vi.fn(),
  } satisfies BridgeActions;
  const host = new BridgeHost({
    viewId: 'plan',
    version: '4',
    getWindow: () => viewWindow,
    postToView: (m) => posted.push(m),
    backend,
    actions,
    getEnv: () => ENV,
    getViewport: () => '390x700',
    debounceMs: 300,
  });
  const send = (data: unknown, source: unknown = viewWindow) => host.handleMessage({ source, data });
  const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });
  return { host, posted, backend, actions, send, req, viewWindow };
}

describe('BridgeHost message validation', () => {
  it('ignores messages whose source is not the iframe window', async () => {
    const { send, req, posted, backend } = setup();
    expect(await send(req(1, 'db.query', { sql: 'select 1' }), { name: 'attacker' })).toBe('ignored');
    expect(await send(req(2, 'db.query', { sql: 'select 1' }), null)).toBe('ignored');
    expect(posted).toHaveLength(0);
    expect(backend.query).not.toHaveBeenCalled();
  });

  it('ignores anything that is not JSON-RPC 2.0 (no reply, no side effects)', async () => {
    const { send, posted } = setup();
    expect(await send('hello')).toBe('ignored');
    expect(await send({ id: 1, method: 'ready' })).toBe('ignored');
    expect(await send(null)).toBe('ignored');
    expect(posted).toHaveLength(0);
  });

  it('rejects an invalid request shape with -32600 when it has an id', async () => {
    const { send, posted } = setup();
    expect(await send({ jsonrpc: '2.0', id: 7 })).toBe('rejected');
    expect(posted[0]).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: BRIDGE_ERR.invalidRequest } });
  });

  it('rejects unknown methods with -32601 and reports them once', async () => {
    const { send, req, posted, backend } = setup();
    expect(await send(req(1, 'fs.deleteEverything'))).toBe('rejected');
    expect(await send(req(2, 'fs.deleteEverything'))).toBe('rejected');
    expect(posted[0]).toMatchObject({ id: 1, error: { code: BRIDGE_ERR.methodNotFound } });
    expect(backend.error).toHaveBeenCalledTimes(1);
    expect(backend.error.mock.calls[0]?.[1]).toMatchObject({ version: '4', viewport: '390x700' });
  });

  it('rejects invalid params with -32602 and never calls the backend', async () => {
    const { send, req, posted, backend } = setup();
    await send(req(1, 'db.query', { sql: 123 }));
    await send(req(2, 'db.write', { target: 'x', op: 'truncate', row: {} }));
    await send(req(3, 'navigate', { viewId: 'Bad ID!' }));
    await send(req(4, 'resize', { height: -5 }));
    expect(posted.map((p) => p.error?.code)).toEqual([BRIDGE_ERR.invalidParams, BRIDGE_ERR.invalidParams, BRIDGE_ERR.invalidParams, BRIDGE_ERR.invalidParams]);
    expect(backend.query).not.toHaveBeenCalled();
    expect(backend.write).not.toHaveBeenCalled();
  });
});

describe('BridgeHost method routing', () => {
  it('ready and env.get return the ViewEnv; ready also signals the shell', async () => {
    const { send, req, posted, actions } = setup();
    await send(req(1, 'ready'));
    await send(req('abc', 'env.get'));
    expect(actions.ready).toHaveBeenCalledTimes(1);
    expect(posted[0]).toEqual({ jsonrpc: '2.0', id: 1, result: ENV });
    expect(posted[1]).toEqual({ jsonrpc: '2.0', id: 'abc', result: ENV });
  });

  it('db.query goes to the backend with the view id and returns rows', async () => {
    const { send, req, posted, backend } = setup();
    await send(req(1, 'db.query', { sql: 'select * from t where x=?', params: [1] }));
    expect(backend.query).toHaveBeenCalledWith('plan', 'select * from t where x=?', [1]);
    expect(posted[0]).toMatchObject({ id: 1, result: [{ a: 1 }] });
  });

  it('db.write / act / files.read are routed and writes notify the shell', async () => {
    const { send, req, posted, backend, actions } = setup();
    await send(req(1, 'db.write', { target: 'checkins', op: 'insert', row: { note: 'x' } }));
    await send(req(2, 'act', { name: 'ask_coach', payload: { a: 1 }, wake: true }));
    await send(req(3, 'files.read', { path: 'plan/current.md' }));
    expect(backend.write).toHaveBeenCalledWith('plan', { target: 'checkins', op: 'insert', row: { note: 'x' } });
    expect(backend.act).toHaveBeenCalledWith('plan', { name: 'ask_coach', payload: { a: 1 }, wake: true });
    expect(backend.file).toHaveBeenCalledWith('plan', 'plan/current.md');
    expect(posted[2]).toMatchObject({ id: 3, result: '# plan' });
    expect(actions.wrote).toHaveBeenCalledTimes(2);
  });

  it('navigate, openChat, toast and resize call the shell actions', async () => {
    const { send, req, actions } = setup();
    await send(req(1, 'navigate', { viewId: 'calendar', params: { date: '2026-10-07' } }));
    await send(req(2, 'openChat', { prefill: 'About my plan: ' }));
    await send(req(3, 'toast', { text: 'Saved' }));
    await send(req(4, 'resize', { height: 180 }));
    expect(actions.navigate).toHaveBeenCalledWith('calendar', { date: '2026-10-07' });
    expect(actions.openChat).toHaveBeenCalledWith({ prefill: 'About my plan: ' });
    expect(actions.toast).toHaveBeenCalledWith('Saved');
    expect(actions.resize).toHaveBeenCalledWith(180);
  });

  it('report(error) is forwarded to the gateway with version and viewport; warn/info are not', async () => {
    const { send, req, backend, actions } = setup();
    await send(req(1, 'report', { level: 'error', message: 'boom', detail: { stack: 'Error: boom\n at x' } }));
    await send(req(2, 'report', { level: 'warn', message: 'meh' }));
    expect(backend.error).toHaveBeenCalledTimes(1);
    expect(backend.error).toHaveBeenCalledWith('plan', { version: '4', message: 'boom', stack: 'Error: boom\n at x', viewport: '390x700' });
    expect(actions.viewError).toHaveBeenCalledWith({ message: 'boom', stack: 'Error: boom\n at x' });
  });

  it('fire-and-forget methods are accepted as JSON-RPC notifications (no id, no reply)', async () => {
    const { send, posted, actions } = setup();
    expect(await send({ jsonrpc: '2.0', method: 'toast', params: { text: 'hi' } })).toBe('handled');
    expect(actions.toast).toHaveBeenCalledWith('hi');
    // data methods need an id: without one they are not executed
    expect(await send({ jsonrpc: '2.0', method: 'db.query', params: { sql: 'select 1' } })).toBe('rejected');
    expect(posted).toHaveLength(0);
  });

  it('maps backend failures to JSON-RPC errors', async () => {
    const { send, req, posted, backend } = setup();
    backend.query.mockRejectedValueOnce(new ApiRequestError(403, 'forbidden', 'not declared in reads'));
    backend.query.mockRejectedValueOnce(new NetworkError());
    backend.query.mockRejectedValueOnce(new Error('weird'));
    await send(req(1, 'db.query', { sql: 'select 1' }));
    await send(req(2, 'db.query', { sql: 'select 1' }));
    await send(req(3, 'db.query', { sql: 'select 1' }));
    expect(posted[0].error).toMatchObject({ code: BRIDGE_ERR.server, message: 'not declared in reads', data: { status: 403, code: 'forbidden' } });
    expect(posted[1].error).toMatchObject({ code: BRIDGE_ERR.offline });
    expect(posted[2].error).toMatchObject({ code: BRIDGE_ERR.internal });
  });
});

describe('BridgeHost activity (first paint) ', () => {
  it('reports requests in flight and returns to zero after the reply is posted, even on errors', async () => {
    const { send, req, actions, posted } = setup();
    const both = Promise.all([send(req(1, 'db.query', { sql: 'select 1' })), send(req(2, 'files.read', { path: '../escape' }))]);
    expect(actions.activity).toHaveBeenNthCalledWith(1, 1);
    expect(actions.activity).toHaveBeenNthCalledWith(2, 2);
    await both;
    expect(actions.activity).toHaveBeenLastCalledWith(0);
    expect(posted).toHaveLength(2);
  });
});

describe('BridgeHost subscriptions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pushes one debounced `changed` notification to subscribed views', async () => {
    const { host, send, req, posted } = setup();
    await send(req(1, 'subscribe', { targets: ['db:planned_workouts'] }));
    expect(posted[0]).toMatchObject({ id: 1, result: { subscriptionId: 'sub_1' } });
    posted.length = 0;
    host.notifyChanged();
    host.notifyChanged();
    host.notifyChanged();
    expect(posted).toHaveLength(0);
    vi.advanceTimersByTime(299);
    expect(posted).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ jsonrpc: '2.0', method: 'changed', params: { subscriptionIds: ['sub_1'], targets: ['db:planned_workouts'] } });
  });

  it('does not notify views that never subscribed, or after unsubscribe / dispose', async () => {
    const { host, send, req, posted } = setup();
    host.notifyChanged();
    vi.advanceTimersByTime(500);
    expect(posted).toHaveLength(0);
    await send(req(1, 'subscribe', { targets: ['file:plan/current.md'] }));
    await send(req(2, 'unsubscribe', { subscriptionId: 'sub_1' }));
    posted.length = 0;
    host.notifyChanged();
    vi.advanceTimersByTime(500);
    expect(posted).toHaveLength(0);
    await send(req(3, 'subscribe', { targets: [] }));
    host.dispose();
    host.notifyChanged();
    vi.advanceTimersByTime(500);
    expect(posted.filter((p) => p.method === 'changed')).toHaveLength(0);
  });

  it('notifyEnvChanged sends env.changed with the current env', () => {
    const { host, posted } = setup();
    host.notifyEnvChanged();
    expect(posted[0]).toEqual({ jsonrpc: '2.0', method: 'env.changed', params: ENV });
  });
});

describe('normalizers', () => {
  it('accept the shapes a gateway may return', () => {
    expect(normalizeRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(normalizeRows({ rows: [{ a: 2 }] })).toEqual([{ a: 2 }]);
    expect(normalizeRows({ nope: 1 })).toEqual([]);
    expect(normalizeFile('x')).toBe('x');
    expect(normalizeFile({ content: 'y' })).toBe('y');
    expect(normalizeFile({})).toBe('');
  });
});
