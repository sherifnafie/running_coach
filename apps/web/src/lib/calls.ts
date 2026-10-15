import type { CallSessionInfo, RealtimeClientConnect } from '@opencoach/protocol';
import { describeError } from './api';
import { clock } from './clock';
import { calls } from './endpoints';
import { EnergyVad, describeMicError, extensionForMime, getMicStream, rms, startRecording, type ActiveRecorder } from './recorder';
import { createStore } from './store';

/**
 * Calls (SPEC §11): realtime (WebRTC to the provider with a gateway-minted ephemeral key; the server holds the
 * sideband) and cascaded (push-to-talk or hands-free utterances → gateway STT → coach → TTS audio URL).
 * The client only carries media; tools, instructions and transcripts stay server-side.
 */
export type CallPhase = 'idle' | 'starting' | 'connecting' | 'live' | 'ended' | 'error';
export type AgentState = 'listening' | 'speaking' | 'thinking';

export interface TranscriptLine {
  id: number;
  role: 'athlete' | 'coach';
  text: string;
}

export interface CallState {
  phase: CallPhase;
  mode?: 'realtime' | 'cascaded';
  callId?: string;
  agent: AgentState;
  muted: boolean;
  speakerOn: boolean;
  /** Cascaded: the mic is currently being recorded. */
  recording: boolean;
  handsFree: boolean;
  transcript: TranscriptLine[];
  startedAtMs?: number;
  maxDurationS?: number;
  error?: string;
  notice?: string;
}

const initial: CallState = { phase: 'idle', agent: 'listening', muted: false, speakerOn: true, recording: false, handsFree: false, transcript: [] };
export const callStore = createStore<CallState>(initial);
const patch = (p: Partial<CallState>) => callStore.setState((s) => ({ ...s, ...p }));

let lineSeq = 0;
function addLine(role: TranscriptLine['role'], text: string): void {
  const t = text.trim();
  if (!t) return;
  callStore.setState((s) => ({ ...s, transcript: [...s.transcript, { id: lineSeq++, role, text: t }].slice(-100) }));
}

interface Live {
  abort: AbortController;
  callId?: string;
  mic?: MediaStream;
  pc?: RTCPeerConnection;
  audioEl?: HTMLAudioElement;
  replyAudio?: HTMLAudioElement;
  recorder?: ActiveRecorder;
  vadTimer?: ReturnType<typeof setInterval>;
  ctx?: AudioContext;
  analyser?: AnalyserNode;
  endTimer?: ReturnType<typeof setTimeout>;
  lostTimer?: ReturnType<typeof setTimeout>;
}
let live: Live = { abort: new AbortController() };

function isCurrent(attempt: Live): boolean {
  return live === attempt && !attempt.abort.signal.aborted;
}

export function isCallActive(): boolean {
  const p = callStore.getState().phase;
  return p === 'starting' || p === 'connecting' || p === 'live';
}

export async function startCall(mode?: 'realtime' | 'cascaded', purpose?: string): Promise<void> {
  if (isCallActive()) return;
  const attempt: Live = { abort: new AbortController() };
  live = attempt;
  callStore.setState({ ...initial, phase: 'starting' });
  try {
    // Ask for the mic first so a denied permission never creates a server-side call.
    const mic = await getMicStream();
    if (!isCurrent(attempt)) { mic.getTracks().forEach((t) => t.stop()); return; }
    attempt.mic = mic;
  } catch (e) {
    if (!isCurrent(attempt)) return;
    patch({ phase: 'error', error: describeMicError(e) });
    return;
  }
  let info: CallSessionInfo;
  try {
    info = await calls.create(mode, purpose);
    if (!isCurrent(attempt)) { void calls.end(info.callId).catch(() => undefined); return; }
    attempt.callId = info.callId;
  } catch (e) {
    if (!isCurrent(attempt)) return;
    releaseMedia();
    patch({ phase: 'error', error: describeError(e) });
    return;
  }
  patch({ callId: info.callId, mode: info.mode, maxDurationS: info.maxDurationS, phase: 'connecting' });
  try {
    if (info.mode === 'realtime') {
      if (!info.connect) throw new Error('The server did not return realtime connection details.');
      await connectRealtime(attempt, info, info.connect);
    } else {
      startCascaded();
    }
    if (!isCurrent(attempt)) return;
    patch({ phase: 'live', startedAtMs: clock.nowMs() });
    if (info.maxDurationS > 0) live.endTimer = setTimeout(() => void endCall(), info.maxDurationS * 1000);
  } catch (e) {
    if (!isCurrent(attempt)) return;
    patch({ phase: 'error', error: describeCallError(e) });
    await endCall({ keepError: true });
  }
}

function describeCallError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') return describeMicError(e);
  return describeError(e);
}

// ---- realtime (WebRTC) ---------------------------------------------------------------------------------------

async function connectRealtime(attempt: Live, info: CallSessionInfo, connect: RealtimeClientConnect): Promise<void> {
  const pc = new RTCPeerConnection();
  attempt.pc = pc;
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.setAttribute('playsinline', '');
  attempt.audioEl = audioEl;
  pc.ontrack = (e) => {
    if (!isCurrent(attempt)) return;
    audioEl.srcObject = e.streams[0] ?? null;
    void audioEl.play().catch(() => undefined);
  };
  for (const track of attempt.mic!.getTracks()) pc.addTrack(track, attempt.mic!);
  const dc = pc.createDataChannel('oai-events');
  dc.onmessage = (ev) => {
    if (!isCurrent(attempt)) return;
    try {
      handleProviderEvent(JSON.parse(String(ev.data)) as ProviderEvent);
    } catch {
      /* ignore malformed */
    }
  };
  pc.onconnectionstatechange = () => {
    if (!isCurrent(attempt)) return;
    if (pc.connectionState === 'failed') {
      patch({ phase: 'error', error: 'The connection to the call was lost.' });
      void endCall({ keepError: true });
    } else if (pc.connectionState === 'disconnected') {
      attempt.lostTimer = setTimeout(() => {
        if (isCurrent(attempt) && pc.connectionState !== 'connected') {
          patch({ phase: 'error', error: 'The connection to the call was lost.' });
          void endCall({ keepError: true });
        }
      }, 6000);
    } else if (attempt.lostTimer) clearTimeout(attempt.lostTimer);
  };

  const offer = await pc.createOffer();
  if (!isCurrent(attempt)) return;
  await pc.setLocalDescription(offer);
  if (!isCurrent(attempt)) return;
  const res = await fetch(connect.callsUrl, {
    method: 'POST',
    body: offer.sdp,
    headers: { Authorization: `Bearer ${connect.ephemeralKey}`, 'Content-Type': 'application/sdp' },
    credentials: 'omit',
    signal: attempt.abort.signal,
  });
  if (!isCurrent(attempt)) return;
  if (!res.ok) throw new Error(`Could not reach the voice service (${res.status}).`);
  const answer = await res.text();
  if (!isCurrent(attempt)) return;
  const providerCallId = providerCallIdFrom(res.headers.get('Location'));
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  if (!isCurrent(attempt)) return;
  if (providerCallId) await calls.attach(info.callId, providerCallId);
  else patch({ notice: 'Connected, but your coach could not attach to the call, so lookups may be unavailable.' });
}

/** `.../v1/realtime/calls/rtc_abc123` → `rtc_abc123` */
export function providerCallIdFrom(location: string | null): string | undefined {
  if (!location) return undefined;
  return location.split('?')[0]!.split('/').filter(Boolean).pop();
}

interface ProviderEvent {
  type?: string;
  transcript?: string;
}

function handleProviderEvent(ev: ProviderEvent): void {
  switch (ev.type) {
    case 'input_audio_buffer.speech_started':
      patch({ agent: 'listening' });
      break;
    case 'input_audio_buffer.speech_stopped':
      patch({ agent: 'thinking' });
      break;
    case 'response.created':
    case 'output_audio_buffer.started':
      patch({ agent: 'speaking' });
      break;
    case 'output_audio_buffer.stopped':
    case 'response.done':
      patch({ agent: 'listening' });
      break;
    case 'conversation.item.input_audio_transcription.completed':
      addLine('athlete', ev.transcript ?? '');
      break;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      addLine('coach', ev.transcript ?? '');
      break;
  }
}

/** `{t:'call'}` stream messages update presence; transcript comes from WebRTC or the utterance response. */
export function applyServerCallMessage(m: { callId: string; state: 'speaking' | 'listening' | 'thinking' | 'ended'; text?: string }): void {
  const s = callStore.getState();
  if (!isCallActive() || m.callId !== s.callId) return;
  if (m.state === 'ended') {
    if (isCallActive()) void endCall({ remote: true });
    return;
  }
  patch({ agent: m.state });
}

// ---- cascaded (push-to-talk / hands-free) ---------------------------------------------------------------------

function startCascaded(): void {
  patch({ agent: 'listening' });
  try {
    live.ctx = new AudioContext();
    const src = live.ctx.createMediaStreamSource(live.mic!);
    live.analyser = live.ctx.createAnalyser();
    live.analyser.fftSize = 512;
    src.connect(live.analyser);
  } catch {
    /* hands-free needs the analyser; push-to-talk does not */
  }
}

export async function pttStart(): Promise<void> {
  const s = callStore.getState();
  if (s.phase !== 'live' || s.mode !== 'cascaded' || live.recorder || s.agent === 'thinking' || s.muted) return;
  const attempt = live;
  stopReplyAudio();
  try {
    const recorder = await startRecording(attempt.mic);
    if (!isCurrent(attempt)) { recorder.cancel(); return; }
    attempt.recorder = recorder;
    patch({ recording: true, agent: 'listening' });
  } catch (e) {
    if (!isCurrent(attempt)) return;
    patch({ notice: describeMicError(e) });
  }
}

export async function pttEnd(): Promise<void> {
  const attempt = live;
  const rec = live.recorder;
  if (!rec) return;
  live.recorder = undefined;
  patch({ recording: false });
  let audio;
  try {
    audio = await rec.stop();
    if (!isCurrent(attempt)) return;
  } catch (e) {
    if (!isCurrent(attempt)) return;
    patch({ notice: describeError(e) });
    return;
  }
  if (audio.durationMs < 400 || audio.blob.size < 800) {
    patch({ notice: 'Hold the button while you speak.' });
    return;
  }
  await sendUtterance(audio.blob, audio.mime);
}

export function pttCancel(): void {
  live.recorder?.cancel();
  live.recorder = undefined;
  patch({ recording: false });
}

async function sendUtterance(blob: Blob, mime: string): Promise<void> {
  const attempt = live;
  const callId = attempt.callId;
  if (!callId || !isCurrent(attempt)) return;
  patch({ agent: 'thinking', notice: undefined });
  try {
    const res = await calls.utterance(callId, blob, `utterance.${extensionForMime(mime)}`, attempt.abort.signal);
    if (!isCurrent(attempt)) return;
    addLine('athlete', res.transcript);
    addLine('coach', res.replyText);
    if (res.audioUrl && callStore.getState().speakerOn) playReply(res.audioUrl);
    else patch({ agent: 'listening' });
  } catch (e) {
    if (!isCurrent(attempt)) return;
    patch({ agent: 'listening', notice: describeError(e) });
  }
}

function playReply(url: string): void {
  stopReplyAudio();
  const a = new Audio(url);
  live.replyAudio = a;
  patch({ agent: 'speaking' });
  const done = () => {
    if (live.replyAudio === a) patch({ agent: 'listening' });
  };
  a.onended = done;
  a.onerror = done;
  void a.play().catch(done);
}

function stopReplyAudio(): void {
  if (live.replyAudio) {
    live.replyAudio.onended = live.replyAudio.onerror = null;
    live.replyAudio.pause();
    live.replyAudio = undefined;
  }
}

/** Toggle hands-free mode (simple energy-based VAD). */
export function setHandsFree(on: boolean): void {
  patch({ handsFree: on });
  if (live.vadTimer) clearInterval(live.vadTimer);
  live.vadTimer = undefined;
  if (!on) {
    pttCancel();
    return;
  }
  if (!live.analyser) {
    patch({ handsFree: false, notice: 'Hands-free is not supported in this browser.' });
    return;
  }
  const vad = new EnergyVad();
  const buf = new Uint8Array(live.analyser.fftSize);
  live.vadTimer = setInterval(() => {
    const s = callStore.getState();
    if (s.phase !== 'live' || s.muted || !live.analyser) return;
    if (s.agent !== 'listening') {
      vad.reset();
      return;
    }
    live.analyser.getByteTimeDomainData(buf);
    const ev = vad.push(rms(buf), clock.nowMs());
    if (ev === 'start') void pttStart();
    else if (ev === 'end') void pttEnd();
    else if (ev === 'discard') pttCancel();
  }, 100);
}

// ---- controls --------------------------------------------------------------------------------------------------

export function toggleMute(): void {
  const muted = !callStore.getState().muted;
  live.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  if (muted) pttCancel();
  patch({ muted });
}

export function toggleSpeaker(): void {
  const speakerOn = !callStore.getState().speakerOn;
  if (live.audioEl) live.audioEl.muted = !speakerOn;
  if (live.replyAudio) live.replyAudio.muted = !speakerOn;
  patch({ speakerOn });
}

function releaseMedia(): void {
  live.abort.abort();
  if (live.lostTimer) clearTimeout(live.lostTimer);
  if (live.vadTimer) clearInterval(live.vadTimer);
  if (live.endTimer) clearTimeout(live.endTimer);
  live.recorder?.cancel();
  stopReplyAudio();
  try {
    live.pc?.close();
  } catch {
    /* ignore */
  }
  if (live.audioEl) {
    live.audioEl.pause();
    live.audioEl.srcObject = null;
  }
  live.mic?.getTracks().forEach((t) => t.stop());
  void live.ctx?.close().catch(() => undefined);
}

export async function endCall(opts: { keepError?: boolean; remote?: boolean } = {}): Promise<void> {
  const s = callStore.getState();
  if (live.abort.signal.aborted) return;
  const callId = s.callId;
  releaseMedia();
  if (opts.keepError) patch({ recording: false, handsFree: false });
  else patch({ phase: 'ended', recording: false, handsFree: false });
  if (callId && !opts.remote) {
    try {
      await calls.end(callId);
    } catch {
      /* the server also ends calls on timeout */
    }
  }
}

export function resetCall(): void {
  if (isCallActive()) return;
  callStore.setState({ ...initial });
}
