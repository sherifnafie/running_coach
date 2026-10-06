import { ProviderError, type ProviderErrorKind } from '@opencoach/protocol';
import { errorMessage, isRecord } from './util';

/**
 * Shared error mapping for the SDK adapters. Each adapter owns the `instanceof` checks for its own
 * SDK's connection/timeout/abort classes and delegates everything status/body based to
 * `classifyHttpError`.
 */

const CONTEXT_LENGTH_RE =
  /prompt is too long|prompt_too_long|context[_ ]length|context window|maximum context|too many tokens|input is too long|exceeds? the (?:model'?s )?(?:maximum|context|limit)|request_too_large|reduce the length|string too long/i;

export interface HttpErrorInfo {
  status?: number;
  message: string;
  /** Provider error type string from the response body (e.g. "overloaded_error"). */
  bodyType?: string | null;
  /** Provider error code (e.g. OpenAI "context_length_exceeded"). */
  code?: string | null;
  headers?: unknown;
}

export function classifyHttpError(info: HttpErrorInfo): { kind: ProviderErrorKind; retryable: boolean } {
  const { status, message, bodyType, code } = info;
  const t = (bodyType ?? '').toLowerCase();
  const c = (code ?? '').toLowerCase();

  if (c === 'context_length_exceeded' || (status === 413) || ((status === 400 || status === undefined) && CONTEXT_LENGTH_RE.test(message))) {
    return { kind: 'context_length', retryable: false };
  }
  if (status === 429 || t === 'rate_limit_error' || c === 'rate_limit_exceeded' || c === 'insufficient_quota') {
    // insufficient_quota is not going to heal in a few seconds, but a fallback model/provider may work.
    return { kind: 'rate_limit', retryable: c !== 'insufficient_quota' };
  }
  if (status === 529 || status === 503 || t === 'overloaded_error') return { kind: 'overloaded', retryable: true };
  if (status === 408 || t === 'timeout_error') return { kind: 'timeout', retryable: true };
  if (status !== undefined && status >= 500) return { kind: 'unknown', retryable: true };
  if (t === 'api_error') return { kind: 'unknown', retryable: true };
  if (status === 409) return { kind: 'unknown', retryable: true };
  if (status === 401 || status === 403 || t === 'authentication_error' || t === 'permission_error' || t === 'billing_error') {
    return { kind: 'auth', retryable: false };
  }
  if (status !== undefined && status >= 400) return { kind: 'invalid_request', retryable: false };
  if (t === 'invalid_request_error' || t === 'not_found_error') return { kind: 'invalid_request', retryable: false };
  return { kind: 'unknown', retryable: false };
}

/**
 * `retry-after-ms` / `retry-after` (seconds) from a Headers object or plain record. The HTTP-date form
 * of retry-after is ignored on purpose: it needs "now", and all time goes through Clock.
 */
export function retryAfterFromHeaders(headers: unknown): number | undefined {
  const get = (name: string): string | undefined => {
    if (!headers) return undefined;
    if (typeof (headers as { get?: unknown }).get === 'function') {
      const v = (headers as { get(n: string): string | null }).get(name);
      return v ?? undefined;
    }
    if (isRecord(headers)) {
      for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name && (typeof v === 'string' || typeof v === 'number')) return String(v);
    }
    return undefined;
  };
  const ms = get('retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const s = get('retry-after');
  if (s !== undefined) {
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  }
  return undefined;
}

export function abortError(message = 'Aborted'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError');
}

/** Pull `status`/`headers`/body type/code off an SDK APIError (or anything shaped like one). */
export function httpInfoFromSdkError(e: unknown): HttpErrorInfo | undefined {
  if (!isRecord(e) && !(e instanceof Error)) return undefined;
  const r = e as unknown as Record<string, unknown>;
  const status = typeof r.status === 'number' ? r.status : undefined;
  const body = isRecord(r.error) ? r.error : undefined;
  const inner = body && isRecord(body.error) ? body.error : undefined;
  const bodyType =
    (typeof r.type === 'string' ? r.type : undefined) ??
    (inner && typeof inner.type === 'string' ? inner.type : undefined) ??
    (body && typeof body.type === 'string' && body.type !== 'error' ? body.type : undefined);
  const code =
    (typeof r.code === 'string' ? r.code : undefined) ?? (inner && typeof inner.code === 'string' ? inner.code : undefined) ?? (body && typeof body.code === 'string' ? body.code : undefined);
  if (status === undefined && bodyType === undefined && code === undefined) return undefined;
  return { status, message: errorMessage(e), bodyType, code, headers: r.headers };
}

export function providerErrorFromHttp(info: HttpErrorInfo, cause?: unknown): ProviderError {
  const { kind, retryable } = classifyHttpError(info);
  return new ProviderError(info.message, { kind, retryable, status: info.status, retryAfterMs: retryAfterFromHeaders(info.headers), cause });
}
