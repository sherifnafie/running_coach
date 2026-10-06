import type { ApiError } from '@opencoach/protocol';

/** The server answered with a non-2xx status. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The request never got an answer (offline, DNS, connection reset, CORS). */
export class NetworkError extends Error {
  constructor(message = 'Network unavailable') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Errors worth retrying later (offline queue): no answer, timeouts, rate limits, server faults. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof ApiRequestError) return e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  return false;
}

let unauthorizedHandler: (() => void) | undefined;
/** Called once when an authenticated request gets 401 (session expired / revoked). */
export function setUnauthorizedHandler(fn: (() => void) | undefined): void {
  unauthorizedHandler = fn;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Do not treat 401 as "session expired" (auth endpoints). */
  noAuthRedirect?: boolean;
}

async function toError(res: Response): Promise<ApiRequestError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `Request failed (${res.status})`;
  let details: unknown;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as Partial<ApiError>;
        if (body?.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          details = body.error.details;
        } else {
          message = text.slice(0, 300);
        }
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    /* ignore */
  }
  return new ApiRequestError(res.status, code, message, details);
}

export async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'include', signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new NetworkError(e instanceof Error ? e.message : undefined);
  }
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 401 && !opts.noAuthRedirect) unauthorizedHandler?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

/** Multipart upload with progress (fetch has no upload progress, so XHR). */
export function upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new NetworkError());
    xhr.ontimeout = () => reject(new NetworkError('Upload timed out'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          resolve(undefined as T);
        }
        return;
      }
      let code = `http_${xhr.status}`;
      let message = xhr.statusText || 'Upload failed';
      try {
        const body = JSON.parse(xhr.responseText) as Partial<ApiError>;
        if (body?.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
        }
      } catch {
        /* keep defaults */
      }
      if (xhr.status === 401) unauthorizedHandler?.();
      reject(new ApiRequestError(xhr.status, code, message));
    };
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

/** User-presentable message for any thrown value. */
export function describeError(e: unknown): string {
  if (e instanceof NetworkError) return 'You appear to be offline.';
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
