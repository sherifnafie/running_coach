import { ProviderError, ToolError, type ToolErrorCode } from '@opencoach/protocol';

/** Why a voice operation was refused. Stable strings the gateway can map to HTTP statuses. */
export type VoiceErrorReason =
  /** No transcriber configured (voice notes unavailable). */
  | 'voice_notes_unavailable'
  /** Neither realtime nor cascaded calls are configured, or the requested mode is not. */
  | 'calls_unavailable'
  /** Unknown call id, or the call belongs to another athlete (deliberately indistinguishable). */
  | 'call_not_found'
  /** The call has already ended (or is ending) and cannot take more input. */
  | 'call_ended'
  /** e.g. `utterance` on a realtime call, or `attach` on a cascaded call. */
  | 'wrong_mode'
  /** `attach` called twice with different provider call ids. */
  | 'already_attached'
  /** Live dictation needs an OpenAI key (realtime transcription) and is not configured or disabled. */
  | 'dictation_unavailable'
  /** Unknown dictation session, or one belonging to another athlete. */
  | 'dictation_not_found'
  /** Too many dictation sessions started in the last hour. */
  | 'dictation_rate_limited'
  /** The athlete's daily or monthly AI budget is used up. */
  | 'budget_exhausted';

const CODES: Record<VoiceErrorReason, ToolErrorCode> = {
  voice_notes_unavailable: 'NOT_CONFIGURED',
  calls_unavailable: 'NOT_CONFIGURED',
  call_not_found: 'NOT_FOUND',
  call_ended: 'NOT_ALLOWED',
  wrong_mode: 'INVALID_INPUT',
  already_attached: 'NOT_ALLOWED',
  dictation_unavailable: 'NOT_CONFIGURED',
  dictation_not_found: 'NOT_FOUND',
  dictation_rate_limited: 'LIMIT',
  budget_exhausted: 'LIMIT',
};

/** Typed error thrown by the voice package (a `ToolError`, so the usual code mapping applies). */
export class VoiceError extends ToolError {
  readonly reason: VoiceErrorReason;
  constructor(reason: VoiceErrorReason, message: string) {
    super(CODES[reason], message, false);
    this.name = 'VoiceError';
    this.reason = reason;
  }
}

/** Map an SDK / fetch failure onto the protocol's ProviderError. */
export function toProviderError(e: unknown, what: string): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as { status?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const name = typeof err?.name === 'string' ? err.name : '';
  const detail = typeof err?.message === 'string' ? err.message : String(e);
  const message = `${what} failed: ${detail}`;
  if (status !== undefined) {
    if (status === 401 || status === 403) return new ProviderError(message, { kind: 'auth', retryable: false, status, cause: e });
    if (status === 429) return new ProviderError(message, { kind: 'rate_limit', retryable: true, status, cause: e });
    if (status === 408) return new ProviderError(message, { kind: 'timeout', retryable: true, status, cause: e });
    if (status >= 500) return new ProviderError(message, { kind: status === 503 || status === 529 ? 'overloaded' : 'unknown', retryable: true, status, cause: e });
    if (status >= 400) return new ProviderError(message, { kind: 'invalid_request', retryable: false, status, cause: e });
  }
  if (/timeout/i.test(name)) return new ProviderError(message, { kind: 'timeout', retryable: true, cause: e });
  if (/connection/i.test(name) || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(detail)) {
    return new ProviderError(message, { kind: 'network', retryable: true, cause: e });
  }
  return new ProviderError(message, { kind: 'unknown', retryable: false, cause: e });
}
