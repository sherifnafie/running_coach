import WebSocket from 'ws';
import {
  ProviderError,
  SystemClock,
  silentLogger,
  type Clock,
  type Logger,
  type RealtimeSideband,
  type RealtimeSidebandHandlers,
  type VoiceTranscriptEntry,
} from '@opencoach/protocol';
import { toProviderError } from './errors';

/**
 * Server-side control channel for an OpenAI Realtime call ("sideband", SPEC §11.2 step 4):
 * `wss://…/v1/realtime?call_id=<id>` with the server API key. Media flows client ↔ OpenAI over
 * WebRTC; tools, instructions and transcripts stay here.
 *
 * Server events handled (GA names, with the beta-era aliases that differ):
 *  - `response.function_call_arguments.done`            → onToolCall → function_call_output + response.create
 *  - `conversation.item.input_audio_transcription.completed` → onTranscript(athlete)
 *  - `response.output_audio_transcript.done` (beta: `response.audio_transcript.done`) → onTranscript(coach)
 *  - `input_audio_buffer.speech_stopped` / `.committed`  → remembers when the athlete finished speaking, so the
 *    (often late) athlete transcript carries a timestamp that sorts before the coach's reply
 *  - `response.done`                                     → releases a deferred response.create (see below)
 *  - `error`                                             → logged
 */

export interface SidebandOptions {
  /** Full ws(s) URL including `?call_id=`. */
  url: string;
  apiKey: string;
  handlers: RealtimeSidebandHandlers;
  clock?: Clock;
  logger?: Logger;
  /**
   * `response.create` must not be sent while a response is still active (the API rejects it). A tool call
   * arrives before its response is `done`, so the follow-up is held until `response.done`; this is the
   * safety net if that event never shows up. Default 2000 ms.
   */
  responseDoneGraceMs?: number;
}

interface ToolGroup {
  /** Tool calls of one model response still running. */
  pending: number;
  /** The response that issued the calls has finished (response.done seen). */
  responseDone: boolean;
  /** All outputs are sent; waiting for response.done before response.create. */
  needsCreate: boolean;
  fallback?: AbortController;
}

const MAX_TRACKED = 256;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function remember(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size > MAX_TRACKED) set.delete(set.values().next().value as string);
}

export class OpenAISideband implements RealtimeSideband {
  private readonly ws: WebSocket;
  private readonly handlers: RealtimeSidebandHandlers;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly graceMs: number;

  private closeRequested?: 'coach' | 'timeout' | 'error';
  private lastError?: string;
  private endDelivered = false;
  private resolveClosed!: () => void;
  private readonly closedPromise: Promise<void>;

  private readonly handledToolCalls = new Set<string>();
  private readonly doneResponses = new Set<string>();
  private readonly groups = new Map<string, ToolGroup>();
  private readonly speechAt = new Map<string, string>();

  private constructor(ws: WebSocket, opts: SidebandOptions) {
    this.ws = ws;
    this.handlers = opts.handlers;
    this.clock = opts.clock ?? new SystemClock();
    this.log = opts.logger ?? silentLogger;
    this.graceMs = opts.responseDoneGraceMs ?? 2000;
    this.closedPromise = new Promise<void>((r) => (this.resolveClosed = r));
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', (err) => {
      this.lastError = err.message;
      this.log.error('realtime sideband socket error', { error: err.message });
    });
    ws.on('close', (code, reason) => this.onClose(code, reason.toString()));
  }

  /** Open the socket; rejects with a ProviderError if the handshake fails. */
  static connect(opts: SidebandOptions): Promise<OpenAISideband> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(opts.url, { headers: { Authorization: `Bearer ${opts.apiKey}` }, handshakeTimeout: 15_000 });
      let settled = false;
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        reject(e);
      };
      ws.once('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        fail(
          new ProviderError(`realtime sideband handshake rejected (HTTP ${status})`, {
            kind: status === 401 || status === 403 ? 'auth' : status >= 500 ? 'unknown' : 'invalid_request',
            retryable: status >= 500,
            status,
          }),
        );
      });
      ws.once('error', (err) => fail(toProviderError(err, 'realtime sideband connect')));
      ws.once('open', () => {
        if (settled) return;
        settled = true;
        ws.removeAllListeners('error');
        ws.removeAllListeners('unexpected-response');
        resolve(new OpenAISideband(ws, opts));
      });
    });
  }

  // ------------------------------------------------------------------ RealtimeSideband

  async updateInstructions(instructions: string): Promise<void> {
    await this.send({ type: 'session.update', session: { type: 'realtime', instructions } });
  }

  async say(text: string): Promise<void> {
    await this.send({ type: 'response.create', response: { instructions: `Say this to the athlete naturally, in your own voice: ${text}` } });
  }

  /**
   * Close the socket; `onEnd` fires exactly once. `reason` is what `onEnd` reports when we are the one
   * closing (default 'coach'); a close initiated by the provider reports 'athlete'.
   */
  async close(reason: 'coach' | 'timeout' | 'error' = 'coach'): Promise<void> {
    if (!this.closeRequested) this.closeRequested = reason;
    if (this.ws.readyState === WebSocket.CLOSED) return;
    if (this.ws.readyState !== WebSocket.CLOSING) {
      try {
        this.ws.close(1000, 'call ended');
      } catch (e) {
        this.log.debug('sideband close threw', { error: String(e) });
        this.ws.terminate();
      }
    }
    const t = setTimeout(() => this.ws.terminate(), 2000);
    t.unref?.();
    await this.closedPromise;
    clearTimeout(t);
  }

  // ------------------------------------------------------------------ inbound

  private onMessage(raw: string): void {
    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      ev = parsed as Record<string, unknown>;
    } catch {
      this.log.warn('realtime sideband: unparseable frame');
      return;
    }
    switch (ev.type) {
      case 'response.function_call_arguments.done':
        this.onToolCallEvent(ev);
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const text = str(ev.transcript)?.trim();
        if (!text) break;
        const itemId = str(ev.item_id);
        const at = (itemId ? this.speechAt.get(itemId) : undefined) ?? this.now();
        if (itemId) this.speechAt.delete(itemId);
        this.emitTranscript({ role: 'athlete', text, at });
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const text = str(ev.transcript)?.trim();
        if (text) this.emitTranscript({ role: 'coach', text, at: this.now() });
        break;
      }
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed': {
        const itemId = str(ev.item_id);
        if (itemId && !this.speechAt.has(itemId)) {
          this.speechAt.set(itemId, this.now());
          if (this.speechAt.size > MAX_TRACKED) this.speechAt.delete(this.speechAt.keys().next().value as string);
        }
        break;
      }
      case 'response.done': {
        const id = str((ev.response as { id?: unknown } | undefined)?.id);
        if (id) this.onResponseDone(id);
        break;
      }
      case 'error': {
        const e = (ev.error ?? {}) as { type?: unknown; code?: unknown; message?: unknown };
        this.log.error('realtime sideband error event', { type: e.type, code: e.code, message: e.message });
        break;
      }
      default:
        break;
    }
  }

  private emitTranscript(entry: VoiceTranscriptEntry): void {
    try {
      this.handlers.onTranscript(entry);
    } catch (e) {
      this.log.error('onTranscript handler threw', { error: String(e) });
    }
  }

  private onToolCallEvent(ev: Record<string, unknown>): void {
    const callId = str(ev.call_id);
    const name = str(ev.name);
    if (!callId || !name) {
      this.log.warn('realtime sideband: function call event without call_id/name');
      return;
    }
    if (this.handledToolCalls.has(callId)) return;
    remember(this.handledToolCalls, callId);

    const responseId = str(ev.response_id);
    const key = responseId ?? `call:${callId}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { pending: 0, responseDone: !responseId || this.doneResponses.has(responseId), needsCreate: false };
      this.groups.set(key, group);
    }
    group.pending++;
    void this.runTool(key, group, callId, name, ev.arguments);
  }

  private async runTool(key: string, group: ToolGroup, callId: string, name: string, rawArgs: unknown): Promise<void> {
    let output: unknown;
    let args: unknown;
    let argsOk = true;
    try {
      args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {});
    } catch (e) {
      argsOk = false;
      this.log.warn('realtime sideband: tool call arguments are not valid JSON', { name, callId });
      output = { error: `invalid_arguments: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (argsOk) {
      try {
        output = await this.handlers.onToolCall({ id: callId, name, arguments: args });
      } catch (e) {
        this.log.warn('tool call handler threw', { name, callId, error: String(e) });
        output = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    let sent = true;
    try {
      await this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output ?? null) } });
    } catch (e) {
      sent = false;
      this.log.warn('could not deliver function_call_output', { name, callId, error: String(e) });
    }
    group.pending--;
    if (group.pending > 0) return;
    if (!sent) {
      this.groups.delete(key);
      return;
    }
    if (group.responseDone) {
      this.groups.delete(key);
      await this.sendResponseCreate();
    } else {
      group.needsCreate = true;
      this.armFallback(key, group);
    }
  }

  private onResponseDone(id: string): void {
    remember(this.doneResponses, id);
    const group = this.groups.get(id);
    if (!group) return;
    group.responseDone = true;
    if (group.needsCreate && group.pending === 0) {
      group.fallback?.abort();
      this.groups.delete(id);
      void this.sendResponseCreate();
    }
  }

  private armFallback(key: string, group: ToolGroup): void {
    const ac = new AbortController();
    group.fallback = ac;
    this.clock.sleepUntil(new Date(this.clock.now().getTime() + this.graceMs), ac.signal).then(
      () => {
        if (this.groups.get(key) !== group) return;
        this.groups.delete(key);
        this.log.debug('response.done not seen; sending response.create after grace period', { key });
        void this.sendResponseCreate();
      },
      () => {
        /* aborted: response.done arrived or the socket closed */
      },
    );
  }

  private async sendResponseCreate(): Promise<void> {
    try {
      await this.send({ type: 'response.create' });
    } catch (e) {
      this.log.warn('could not send response.create', { error: String(e) });
    }
  }

  // ------------------------------------------------------------------ outbound / lifecycle

  private send(msg: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('realtime sideband is closed'));
        return;
      }
      this.ws.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve()));
    });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private onClose(code: number, text: string): void {
    for (const g of this.groups.values()) g.fallback?.abort();
    this.groups.clear();
    this.resolveClosed();
    if (this.endDelivered) return;
    this.endDelivered = true;
    const reason = this.closeRequested ?? (this.lastError ? 'error' : 'athlete');
    const detail = this.lastError ?? `socket closed (${code}${text ? `: ${text}` : ''})`;
    try {
      this.handlers.onEnd(reason, detail);
    } catch (e) {
      this.log.error('onEnd handler threw', { error: String(e) });
    }
  }
}
