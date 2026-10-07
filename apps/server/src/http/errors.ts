import { ProviderError, ToolError, type ApiError, type ToolErrorCode } from '@opencoach/protocol';

/** An error that maps to an HTTP response of the shape `{ error: { code, message, details? } }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, opts: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.headers = opts.headers;
  }
}

export const badRequest = (message: string, details?: unknown): HttpError => new HttpError(400, 'invalid_request', message, { details });
export const unauthorized = (message = 'Authentication required.'): HttpError => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed.', code = 'forbidden'): HttpError => new HttpError(403, code, message);
export const notFound = (message = 'Not found.'): HttpError => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict'): HttpError => new HttpError(409, code, message);
export const unavailable = (message: string, code = 'unavailable'): HttpError => new HttpError(503, code, message);
export const tooMany = (retryAfterSec: number, message = 'Too many requests. Try again later.'): HttpError =>
  new HttpError(429, 'rate_limited', message, { headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) } });

const TOOL_STATUS: Record<ToolErrorCode, number> = {
  INVALID_INPUT: 400,
  EISDIR: 400,
  ENOENT: 404,
  NOT_FOUND: 404,
  EACCES: 403,
  NOT_ALLOWED: 403,
  EOUTOFSCOPE: 403,
  TIMEOUT: 408,
  ETOOBIG: 413,
  NOT_UNIQUE: 409,
  NOT_CONFIGURED: 503,
  LIMIT: 429,
  PAUSED: 409,
  MIN_GAP: 409,
  PROACTIVE_BUDGET_EXHAUSTED: 409,
  GATES_FAILED: 422,
  INTERNAL: 500,
};

/** Voice package reasons (VoiceError extends ToolError and carries a stable `reason`). */
const VOICE_STATUS: Record<string, number> = {
  voice_notes_unavailable: 503,
  calls_unavailable: 503,
  call_not_found: 404,
  call_ended: 409,
  wrong_mode: 400,
  already_attached: 409,
  dictation_unavailable: 503,
  dictation_not_found: 404,
  dictation_rate_limited: 429,
  budget_exhausted: 402,
};

function isZodError(e: unknown): e is { issues: Array<{ path: Array<string | number>; message: string }> } {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues);
}

/** What the athlete reads when an AI provider fails; the provider's own detail goes to the server log only. */
const PROVIDER_MESSAGE: Partial<Record<ProviderError['kind'], string>> = {
  rate_limit: 'The AI service is busy right now. Try again in a minute.',
  overloaded: 'The AI service is busy right now. Try again in a minute.',
  timeout: 'The AI service took too long to answer. Try again.',
  network: 'Could not reach the AI service. Try again in a moment.',
  auth: 'The AI service did not accept this server\'s key. Ask your administrator to check it.',
  unknown: 'The AI service could not handle that request. Try again, and tell your administrator if it keeps happening.',
};

/** Convert anything thrown into an HttpError (never leaks internals for unexpected errors). */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;

  if (isZodError(e)) {
    const first = e.issues[0];
    const where = first && first.path.length ? `${first.path.join('.')}: ` : '';
    return new HttpError(400, 'invalid_request', `Invalid request: ${where}${first?.message ?? 'validation failed'}`, {
      details: e.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }

  if (e instanceof ToolError || (e as { name?: string } | null)?.name === 'ToolError' || (e as { name?: string } | null)?.name === 'VoiceError') {
    const te = e as ToolError & { reason?: string };
    const status = (te.reason && VOICE_STATUS[te.reason]) || TOOL_STATUS[te.code] || 500;
    const code = (te.reason ?? te.code ?? 'internal').toString().toLowerCase();
    if (status >= 500 && status !== 503) return new HttpError(500, 'internal', 'Internal server error.');
    return new HttpError(status, code, te.message);
  }

  if (e instanceof ProviderError || (e as { name?: string } | null)?.name === 'ProviderError') {
    const pe = e as ProviderError;
    const status = pe.kind === 'rate_limit' ? 429 : pe.kind === 'timeout' ? 504 : 502;
    return new HttpError(status, 'provider_error', PROVIDER_MESSAGE[pe.kind] ?? PROVIDER_MESSAGE.unknown!);
  }

  // Fastify / plugin errors carry statusCode (FST_ERR_CTP_BODY_TOO_LARGE, FST_REQ_FILE_TOO_LARGE, ...).
  const sc = (e as { statusCode?: unknown } | null)?.statusCode;
  if (typeof sc === 'number' && sc >= 400 && sc < 500) {
    const code = String((e as { code?: unknown }).code ?? 'invalid_request').toLowerCase();
    return new HttpError(sc, code.startsWith('fst_') ? fastifyCode(sc) : code, (e as Error).message || 'Bad request.');
  }

  return new HttpError(500, 'internal', 'Internal server error.');
}

function fastifyCode(status: number): string {
  switch (status) {
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return 'invalid_request';
  }
}

export function toApiError(e: HttpError): ApiError {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
}
