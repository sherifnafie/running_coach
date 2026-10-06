import { clock } from './clock';
import { account } from './endpoints';
import { ApiRequestError, NetworkError } from './api';

/**
 * Full export (SPEC §13 [SEC-5]): `POST /v1/export → {jobId}`, then `GET /v1/export/:jobId` returns the file when
 * ready. While the bundle is being built the gateway may answer 202 / 404-not-yet / a JSON status object; we poll
 * until the response is the file (anything that is not JSON status) and then let the browser download it natively
 * (streaming, so large bundles never sit in memory).
 */
export type ExportProbe = { state: 'ready'; url?: string } | { state: 'pending' } | { state: 'failed'; message: string };

/** Pure classification of a poll response (unit-tested). */
export function classifyExportResponse(r: { status: number; contentType: string; json?: unknown }): ExportProbe {
  if (r.status === 202 || r.status === 425) return { state: 'pending' };
  if (r.status >= 400) {
    const msg = (r.json as { error?: { message?: string } } | undefined)?.error?.message;
    return r.status === 404 ? { state: 'pending' } : { state: 'failed', message: msg ?? `Export failed (${r.status})` };
  }
  if (r.contentType.includes('application/json')) {
    const j = (r.json ?? {}) as { status?: string; state?: string; url?: string; error?: string; message?: string };
    const st = j.status ?? j.state;
    if (st === 'failed' || st === 'error' || j.error) return { state: 'failed', message: j.error ?? j.message ?? 'Export failed' };
    if (st === 'ready' || st === 'done' || st === 'complete' || j.url) return { state: 'ready', url: j.url };
    return { state: 'pending' };
  }
  return { state: 'ready' };
}

export async function probeExport(jobId: string, signal?: AbortSignal): Promise<ExportProbe> {
  const res = await fetch(account.exportUrl(jobId), { credentials: 'include', signal, headers: { accept: 'application/octet-stream, application/zip, application/json;q=0.8, */*;q=0.5' } });
  const contentType = res.headers.get('content-type') ?? '';
  if (res.ok && !contentType.includes('application/json') && res.status !== 202) {
    void res.body?.cancel().catch(() => undefined); // it is the file: let the browser download it itself
    return { state: 'ready' };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return classifyExportResponse({ status: res.status, contentType, json });
}

export async function waitForExport(jobId: string, opts: { signal?: AbortSignal; intervalMs?: number; maxMs?: number; onTick?: () => void } = {}): Promise<{ url: string }> {
  const interval = opts.intervalMs ?? 2000;
  const deadline = clock.nowMs() + (opts.maxMs ?? 10 * 60_000);
  for (;;) {
    let probe: ExportProbe;
    try {
      probe = await probeExport(jobId, opts.signal);
    } catch (e) {
      if (e instanceof NetworkError || e instanceof ApiRequestError || e instanceof TypeError) probe = { state: 'pending' };
      else throw e;
    }
    if (probe.state === 'ready') return { url: probe.url ?? account.exportUrl(jobId) };
    if (probe.state === 'failed') throw new Error(probe.message);
    opts.onTick?.();
    if (clock.nowMs() > deadline) throw new Error('The export is taking too long. Try again later.');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  }
}
