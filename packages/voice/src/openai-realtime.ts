import {
  ProviderError,
  SystemClock,
  silentLogger,
  type Clock,
  type Logger,
  type RealtimeClientConnect,
  type RealtimeSideband,
  type RealtimeVoiceProvider,
} from '@opencoach/protocol';
import { toProviderError } from './errors';
import { OpenAISideband } from './openai-sideband';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Model used for the athlete-side transcript shown to us over the sideband (SPEC §11.4). */
export const REALTIME_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';

export interface OpenAIRealtimeOptions {
  apiKey: string;
  baseUrl?: string;
  /** Clock for transcript timestamps and the response.done grace timer. Default: system clock. */
  clock?: Clock;
  logger?: Logger;
  /** Timeout for the client_secrets request. Default 15 s. */
  requestTimeoutMs?: number;
  /** See SidebandOptions.responseDoneGraceMs. */
  responseDoneGraceMs?: number;
}

/** `expires_at` is unix seconds in the API; tolerate ms, numeric strings and ISO strings. */
function toIso(v: unknown, fallback: () => Date): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return toIso(n, fallback);
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback().toISOString();
}

/** OpenAI Realtime (WebRTC + server sideband via call_id). */
export function createOpenAIRealtimeProvider(opts: OpenAIRealtimeOptions): RealtimeVoiceProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const clock = opts.clock ?? new SystemClock();
  const log = (opts.logger ?? silentLogger).child({ component: 'openai-realtime' });
  const timeoutMs = opts.requestTimeoutMs ?? 15_000;

  return {
    id: 'openai',

    async createSession({ instructions, tools, voice, model }): Promise<RealtimeClientConnect> {
      const body = {
        session: {
          type: 'realtime',
          model,
          instructions,
          audio: {
            input: { transcription: { model: REALTIME_TRANSCRIPTION_MODEL }, turn_detection: { type: 'semantic_vad' } },
            output: { voice },
          },
          tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema })),
          tool_choice: 'auto',
        },
      };
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/realtime/client_secrets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw toProviderError(e, 'realtime session creation');
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw toProviderError({ status: res.status, message: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ''}` }, 'realtime session creation');
      }
      let json: { value?: unknown; expires_at?: unknown; client_secret?: { value?: unknown; expires_at?: unknown } };
      try {
        json = (await res.json()) as typeof json;
      } catch (e) {
        throw toProviderError(e, 'realtime session creation (response body)');
      }
      const value = typeof json.value === 'string' ? json.value : typeof json.client_secret?.value === 'string' ? json.client_secret.value : undefined;
      if (!value) throw new ProviderError('realtime session creation returned no client secret', { kind: 'unknown', retryable: false });
      const expiresAt = toIso(json.expires_at ?? json.client_secret?.expires_at, () => new Date(clock.now().getTime() + 60_000));
      return { type: 'openai-webrtc', callsUrl: `${baseUrl}/realtime/calls`, ephemeralKey: value, expiresAt, model };
    },

    async attachSideband({ providerCallId, model, handlers }): Promise<RealtimeSideband> {
      const url = new URL(`${baseUrl}/realtime`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('call_id', providerCallId);
      log.debug('attaching realtime sideband', { providerCallId, model });
      return OpenAISideband.connect({
        url: url.toString(),
        apiKey: opts.apiKey,
        handlers,
        clock,
        logger: log.child({ providerCallId }),
        responseDoneGraceMs: opts.responseDoneGraceMs,
      });
    },
  };
}
