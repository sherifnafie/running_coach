import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, upload } from './api';
import { browserCsrfHeaders, csrfTokenFromCookie } from './csrf';
import { postWorkerMutation } from '../sw-shared';

const first = 'a'.repeat(64);
const rotated = 'b'.repeat(64);

afterEach(() => {
  document.cookie = 'oc_csrf=; Max-Age=0; Path=/';
  vi.unstubAllGlobals();
});

describe('[SEC-4] browser session proof', () => {
  it('reads only the exact proof cookie and rejects malformed values', () => {
    expect(csrfTokenFromCookie(`other_csrf=${rotated}; oc_csrf=${first}; other=x`)).toBe(first);
    expect(csrfTokenFromCookie(`oc_csrf_extra=${first}`)).toBeUndefined();
    expect(csrfTokenFromCookie('oc_csrf=%0d%0aInjected')).toBeUndefined();
    expect(csrfTokenFromCookie('oc_csrf=')).toBeUndefined();
  });

  it('attaches the current proof to mutations, including replay after a session rotation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    document.cookie = `oc_csrf=${first}; Path=/`;
    await request('POST', '/v1/messages', { text: 'First session' });
    document.cookie = `oc_csrf=${rotated}; Path=/`;
    await request('DELETE', '/v1/account', { confirm: 'DELETE' });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': first }, body: '{"text":"First session"}' });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': rotated }, body: '{"confirm":"DELETE"}' });
    expect(browserCsrfHeaders('GET')).toEqual({});
    expect(browserCsrfHeaders('HEAD')).toEqual({});
    expect(browserCsrfHeaders('OPTIONS')).toEqual({});
  });

  it('allows anonymous authentication requests to leave without a proof', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await request('POST', '/v1/auth/setup', { code: 'setup' }, { noAuthRedirect: true });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it('adds the same proof to credentialed multipart XHR uploads', async () => {
    class FakeXhr {
      static last: FakeXhr;
      headers: Record<string, string> = {};
      withCredentials = false;
      upload: { onprogress?: unknown } = {};
      status = 200;
      responseText = '{"ok":true}';
      onload?: () => void;
      constructor() { FakeXhr.last = this; }
      open() {}
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    document.cookie = `oc_csrf=${first}; Path=/`;
    await expect(upload('/v1/uploads', new FormData())).resolves.toEqual({ ok: true });
    expect(FakeXhr.last.withCredentials).toBe(true);
    expect(FakeXhr.last.headers).toMatchObject({ 'X-CSRF-Token': first });
    expect(FakeXhr.last.headers).not.toHaveProperty('content-type'); // browser supplies the multipart boundary
  });
});

describe('[SEC-4] service-worker session proof', () => {
  it('obtains a fresh authenticated proof before each notification or subscription write', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: first })))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: rotated })))
      .mockResolvedValueOnce(new Response('{}'));
    await postWorkerMutation('/v1/ui-actions', { action: 'notification_action' }, fetcher);
    await postWorkerMutation('/v1/push/subscriptions', { endpoint: 'push' }, fetcher);
    expect(fetcher.mock.calls[0]).toEqual(['/v1/auth/csrf', expect.objectContaining({ credentials: 'include', cache: 'no-store' })]);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': first } });
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': rotated } });
  });

  it('does not mutate when the session expired or the proof is malformed', async () => {
    for (const response of [new Response('{}', { status: 401 }), new Response('{"token":"invalid"}')]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      expect(await postWorkerMutation('/v1/ui-actions', { action: 'notification_action' }, fetcher)).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
