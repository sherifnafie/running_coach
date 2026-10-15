import type { DictationSessionInfo } from '@opencoach/protocol';
import { clock } from './clock';
import { dictation as dictationApi } from './endpoints';
import { EnergyVad, getMicStream, rms } from './recorder';

/**
 * Live dictation: the microphone streams straight to the provider (OpenAI realtime transcription) over
 * WebRTC with a short-lived credential from our server, and transcript text streams back into the composer.
 * Nothing is sent to the coach until the athlete presses send. The server bills the session; we end it
 * as soon as the athlete is done.
 */

/** Provider events we read (OpenAI realtime transcription). Everything else is ignored. */
export interface TranscriptionEvent {
  type?: string;
  item_id?: string;
  previous_item_id?: string | null;
  delta?: string;
  transcript?: string;
  error?: { code?: string; message?: string };
}

/** Assembles transcript deltas and finals from possibly out-of-order turns into one string. Pure. */
export class TranscriptAssembler {
  private order: string[] = [];
  private items = new Map<string, { text: string; final: boolean }>();

  /** Returns true when the visible text changed. */
  apply(ev: TranscriptionEvent): boolean {
    const id = ev.item_id;
    if (!id) return false;
    switch (ev.type) {
      case 'input_audio_buffer.committed':
        this.place(id, ev.previous_item_id ?? undefined);
        return false;
      case 'conversation.item.input_audio_transcription.delta': {
        if (!ev.delta) return false;
        const item = this.place(id);
        if (item.final) return false;
        item.text += ev.delta;
        return true;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const item = this.place(id);
        const changed = item.text !== (ev.transcript ?? '') || !item.final;
        item.text = ev.transcript ?? '';
        item.final = true;
        return changed;
      }
      default:
        return false;
    }
  }

  /** Every committed turn has its final transcript. */
  settled(): boolean {
    return [...this.items.values()].every((i) => i.final);
  }

  text(): string {
    return this.order.map((id) => this.items.get(id)!.text.trim()).filter(Boolean).join(' ');
  }

  private place(id: string, after?: string): { text: string; final: boolean } {
    let item = this.items.get(id);
    if (!item) {
      item = { text: '', final: false };
      this.items.set(id, item);
      const at = after ? this.order.indexOf(after) : -1;
      if (at >= 0) this.order.splice(at + 1, 0, id);
      else this.order.push(id);
    } else if (after && this.order.indexOf(after) >= 0 && this.order.indexOf(id) < this.order.indexOf(after)) {
      this.order.splice(this.order.indexOf(id), 1);
      this.order.splice(this.order.indexOf(after) + 1, 0, id);
    }
    return item;
  }
}

/** Join the athlete's existing draft and dictated text with sensible spacing. */
export function joinDraft(base: string, dictated: string): string {
  if (!dictated) return base;
  if (!base) return dictated;
  return /\s$/.test(base) ? base + dictated : `${base} ${dictated}`;
}

export interface DictationHandlers {
  onText(text: string): void;
  onLevel(level: number): void;
  onLive(): void;
  onError(message: string): void;
  /** The session reached its maximum length: finish it (keeping the text). */
  onLimit(): void;
}

export interface ActiveDictation {
  readonly info: DictationSessionInfo;
  /** Commit the last words, wait briefly for final text, then close. Resolves with the final text. */
  finish(): Promise<string>;
  /** Close immediately and discard. */
  cancel(): void;
}

const COMMIT_SILENCE_MS = 900;
const FINISH_WAIT_MS = 3000;
const START_WAIT_MS = 15_000;

/** Start a dictation session. Rejects with a readable error (microphone, server or network). */
export async function startDictation(h: DictationHandlers, signal?: AbortSignal): Promise<ActiveDictation> {
  const abort = new AbortController();
  let mic: MediaStream | undefined;
  let info: DictationSessionInfo | undefined;
  let pc: RTCPeerConnection | undefined;
  let dc: RTCDataChannel | undefined;
  const assembler = new TranscriptAssembler();
  let closed = false;
  let pendingCommits = 0; // commits sent but not yet acknowledged by the provider
  let settleWaiters: Array<() => void> = [];
  const quiet = () => pendingCommits === 0 && assembler.settled();
  const wakeIfQuiet = () => {
    if (quiet() && settleWaiters.length) { settleWaiters.forEach((w) => w()); settleWaiters = []; }
  };
  let audioCtx: AudioContext | undefined;
  let meter: ReturnType<typeof setInterval> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', cancel);
    clearTimeout(startTimer);
    abort.abort();
    if (meter) clearInterval(meter);
    if (maxTimer) clearTimeout(maxTimer);
    try { dc?.close(); } catch { /* ignore */ }
    pc?.close();
    mic?.getTracks().forEach((t) => t.stop());
    void audioCtx?.close().catch(() => undefined);
    if (info) void dictationApi.end(info.sessionId).catch(() => undefined); // stops billing; best effort
    settleWaiters.forEach((w) => w());
    settleWaiters = [];
  };
  const commit = () => {
    if (dc?.readyState !== 'open') return;
    dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    pendingCommits++;
  };
  const fail = (message: string) => {
    if (closed) return;
    close();
    h.onError(message);
  };

  const cancel = () => close();
  const startTimer = setTimeout(() => fail('Connecting to dictation timed out. Please try again.'), START_WAIT_MS);
  const cancelled = new Promise<never>((_, reject) => {
    abort.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    const value = await Promise.race([pending, cancelled]);
    abort.signal.throwIfAborted();
    return value;
  };
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    if (signal?.aborted) close();
    await wait(Promise.resolve());
    const stream = await wait(getMicStream().then((stream) => {
      mic = stream;
      if (closed) stream.getTracks().forEach((t) => t.stop());
      return stream;
    }));
    // Keep the mint response so even a session created after cancellation can be ended.
    const sessionInfo = await wait(dictationApi.start().then((created) => {
      info = created;
      if (closed) void dictationApi.end(created.sessionId).catch(() => undefined);
      return created;
    }));
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel('oai-events');
    dc.onmessage = (ev) => {
      if (closed) return;
      let event: TranscriptionEvent;
      try { event = JSON.parse(String(ev.data)) as TranscriptionEvent; } catch { return; }
      if (event.type === 'error') {
        // Committing a buffer with no speech is harmless (e.g. tapping done during silence).
        if (event.error?.code === 'input_audio_buffer_commit_empty') { pendingCommits = Math.max(0, pendingCommits - 1); wakeIfQuiet(); return; }
        fail(event.error?.message ? `Dictation stopped: ${event.error.message}` : 'Dictation stopped because of a service error.');
        return;
      }
      if (event.type === 'input_audio_buffer.committed') pendingCommits = Math.max(0, pendingCommits - 1);
      if (assembler.apply(event)) h.onText(assembler.text());
      wakeIfQuiet();
    };
    dc.onopen = () => {
      if (closed) return;
      clearTimeout(startTimer);
      h.onLive();
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed') fail('The connection to the dictation service was lost.');
    };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const offer = await wait(pc.createOffer());
    await wait(pc.setLocalDescription(offer));
    const res = await wait(fetch(sessionInfo.connect.callsUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${sessionInfo.connect.ephemeralKey}`, 'Content-Type': 'application/sdp' },
      credentials: 'omit',
      signal: abort.signal,
    }));
    if (!res.ok) throw new Error(`Could not reach the dictation service (${res.status}).`);
    const answer = await wait(res.text());
    await wait(pc.setRemoteDescription({ type: 'answer', sdp: answer }));

    // Level meter for the waveform, and pause detection so each phrase gets its final, polished text.
    try {
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const vad = new EnergyVad({ silenceMs: COMMIT_SILENCE_MS, minSpeechMs: 250 });
      meter = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        const level = rms(buf);
        h.onLevel(level);
        const transition = vad.push(level, clock.nowMs());
        if (transition === 'end') commit();
      }, 80);
    } catch {
      /* no meter: commits still happen when the athlete taps done */
    }
    maxTimer = setTimeout(() => h.onLimit(), sessionInfo.maxDurationS * 1000);

    return {
      info: sessionInfo,
      async finish() {
        if (!closed) {
          commit(); // the last words since the previous pause
          if (!quiet()) {
            await new Promise<void>((resolve) => {
              settleWaiters.push(resolve);
              setTimeout(resolve, FINISH_WAIT_MS);
            });
          }
          close();
        }
        return assembler.text();
      },
      cancel: close,
    };
  } catch (e) {
    close();
    throw e;
  }
}
