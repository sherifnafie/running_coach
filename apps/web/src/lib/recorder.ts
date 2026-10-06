import { clock } from './clock';

/** MediaRecorder helpers for voice notes and cascaded call utterances. */

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

/** Best supported recording mime type (webm/opus on Chromium/Firefox, mp4 on Safari). */
export function pickRecorderMime(isSupported: (m: string) => boolean = (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)): string | undefined {
  return CANDIDATES.find((m) => {
    try {
      return isSupported(m);
    } catch {
      return false;
    }
  });
}

export function extensionForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'bin';
}

export class MicPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicPermissionError';
  }
}

/** Friendly message for getUserMedia failures. */
export function describeMicError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'MicPermissionError':
      return 'Microphone access is blocked. Allow the microphone for this site in your browser settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
      return 'The microphone is in use by another app.';
    default:
      return e instanceof Error && e.message ? e.message : 'Could not start the microphone.';
  }
}

export interface Recording {
  blob: Blob;
  mime: string;
  durationMs: number;
}

export interface ActiveRecorder {
  /** Stop and resolve with the audio. */
  stop(): Promise<Recording>;
  /** Stop and discard. */
  cancel(): void;
  /** Live input level 0..1 (for a meter). */
  level(): number;
  readonly stream: MediaStream;
}

export async function getMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicPermissionError('Microphone is not available in this browser.');
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

/** Start recording from `stream` (or a fresh mic stream). */
export async function startRecording(existing?: MediaStream): Promise<ActiveRecorder> {
  const stream = existing ?? (await getMicStream());
  const mime = pickRecorderMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  const startedAt = clock.nowMs();
  let analyser: AnalyserNode | undefined;
  let ctx: AudioContext | undefined;
  let buf: Uint8Array<ArrayBuffer> | undefined;
  try {
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    buf = new Uint8Array(analyser.fftSize);
  } catch {
    /* level meter is optional */
  }
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const release = () => {
    if (!existing) stream.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
  };
  rec.start(250);
  return {
    stream,
    level() {
      if (!analyser || !buf) return 0;
      analyser.getByteTimeDomainData(buf);
      return rms(buf);
    },
    stop() {
      return new Promise<Recording>((resolve, reject) => {
        rec.onstop = () => {
          release();
          const type = rec.mimeType || mime || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), mime: type, durationMs: clock.nowMs() - startedAt });
        };
        rec.onerror = () => {
          release();
          reject(new Error('Recording failed'));
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      });
    },
    cancel() {
      rec.onstop = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* ignore */
      }
      release();
    },
  };
}

/** Root-mean-square of unsigned 8-bit time-domain samples, 0..1. */
export function rms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const v = (s - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Simple energy-based voice activity detector for hands-free cascaded calls. Feed it level samples (0..1)
 * with their timestamps; it reports "speech started" / "speech ended" transitions.
 */
export class EnergyVad {
  private speaking = false;
  private lastVoiceAt = 0;
  private speechStartedAt = 0;

  constructor(
    private readonly opts: { threshold?: number; silenceMs?: number; minSpeechMs?: number } = {},
  ) {}

  /** Returns 'start' | 'end' | 'discard' (speech too short) | undefined. */
  push(level: number, nowMs: number): 'start' | 'end' | 'discard' | undefined {
    const threshold = this.opts.threshold ?? 0.04;
    const silenceMs = this.opts.silenceMs ?? 1100;
    const minSpeechMs = this.opts.minSpeechMs ?? 400;
    if (level >= threshold) {
      this.lastVoiceAt = nowMs;
      if (!this.speaking) {
        this.speaking = true;
        this.speechStartedAt = nowMs;
        return 'start';
      }
      return undefined;
    }
    if (this.speaking && nowMs - this.lastVoiceAt >= silenceMs) {
      this.speaking = false;
      return this.lastVoiceAt - this.speechStartedAt >= minSpeechMs ? 'end' : 'discard';
    }
    return undefined;
  }

  reset(): void {
    this.speaking = false;
  }
}
