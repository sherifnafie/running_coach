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
  mic?: MediaStream;
  pc?: RTCPeerConnection;
  audioEl?: HTMLAudioElement;
  replyAudio?: HTMLAudioElement;
  recorder?: ActiveRecorder;
  vadTimer?: ReturnType<typeof setInterval>;
  ctx?: AudioContext;
  analyser?: AnalyserNode;
  endTimer?: ReturnType<typeof setTimeout>;
  ended?: boolean;
}
let live: Live = {};

export function isCallActive(): boolean {
  const p = callStore.getState().phase;
  return p === 'starting' || p === 'connecting' || p === 'live';
}

export async function startCall(mode?: 'realtime' | 'cascaded', purpose?: string): Promise<void> {
  if (isCallActive()) return;
  live = {};
  callStore.setState({ ...initial, phase: 'starting' });
  try {
    // Ask for the mic first so a denied permission never creates a server-side call.
    live.mic = await getMicStream();
  } catch (e) {
    patch({ phase: 'error', error: describeMicError(e) });
    return;
  }
  let info: CallSessionInfo;
  try {
    info = await calls.create(mode, purpose);
  } catch (e) {
    releaseMedia();
    patch({ phase: 'error', error: describeError(e) });
    return;
  }
  patch({ callId: info.callId, mode: info.mode, maxDurationS: info.maxDurationS, phase: 'connecting' });
  try {
    if (info.mode === 'realtime') {
      if (!info.connect) throw new Error('The server did not return realtime connection details.');
      await connectRealtime(info, info.connect);
    } else {
      startCascaded();
    }
    patch({ phase: 'live', startedAtMs: clock.nowMs() });
    if (info.maxDurationS > 0) live.endTimer = setTimeout(() => void endCall(), info.maxDurationS * 1000);
  } catch (e) {
    patch({ phase: 'error', error: describeCallError(e) });
    await endCall({ keepError: true });
  }
}

function describeCallError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') return describeMicError(e);
  return describeError(e);
}

// ---- realtime (WebRTC) ---------------------------------------------------------------------------------------

async function connectRealtime(info: CallSessionInfo, connect: RealtimeClientConnect): Promise<void> {
  const pc = new RTCPeerConnection();
  live.pc = pc;
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.setAttribute('playsinline', '');
  live.audioEl = audioEl;
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0] ?? null;
    void audioEl.play().catch(() => undefined);
  };
  for (const track of live.mic!.getTracks()) pc.addTrack(track, live.mic!);
  const dc = pc.createDataChannel('oai-events');
  dc.onmessage = (ev) => {
    try {
      handleProviderEvent(JSON.parse(String(ev.data)) as ProviderEvent);
    } catch {
      /* ignore malformed */
    }
  };
  let lostTimer: ReturnType<typeof setTimeout> | undefined;
  pc.onconnectionstatechange = () => {
    if (live.pc !== pc) return;
    if (pc.connectionState === 'failed') {
      patch({ phase: 'error', error: 'The connection to the call was lost.' });
      void endCall({ keepError: true });
    } else if (pc.connectionState === 'disconnected') {
      lostTimer = setTimeout(() => {
        if (live.pc === pc && pc.connectionState !== 'connected') {
          patch({ phase: 'error', error: 'The connection to the call was lost.' });
          void endCall({ keepError: true });
        }
      }, 6000);
    } else if (lostTimer) clearTimeout(lostTimer);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await fetch(connect.callsUrl, {
    method: 'POST',
    body: offer.sdp,
    headers: { Authorization: `Bearer ${connect.ephemeralKey}`, 'Content-Type': 'application/sdp' },
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`Could not reach the voice service (${res.status}).`);
  const answer = await res.text();
  const providerCallId = providerCallIdFrom(res.headers.get('Location'));
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
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

/** `{t:'call'}` stream messages from the server (authoritative state, plus text lines). */
export function applyServerCallMessage(m: { callId: string; state: 'speaking' | 'listening' | 'thinking' | 'ended'; text?: string }): void {
  const s = callStore.getState();
  if (s.callId && m.callId !== s.callId) return;
  if (m.state === 'ended') {
    if (isCallActive()) void endCall({ remote: true });
    return;
  }
  patch({ agent: m.state });
  if (m.text && s.mode !== 'realtime') addLine('coach', m.text);
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
  stopReplyAudio();
  try {
    live.recorder = await startRecording(live.mic);
    patch({ recording: true, agent: 'listening' });
  } catch (e) {
    patch({ notice: describeMicError(e) });
  }
}

export async function pttEnd(): Promise<void> {
  const rec = live.recorder;
  if (!rec) return;
  live.recorder = undefined;
  patch({ recording: false });
  let audio;
  try {
    audio = await rec.stop();
  } catch (e) {
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
  const callId = callStore.getState().callId;
  if (!callId) return;
  patch({ agent: 'thinking', notice: undefined });
  try {
    const res = await calls.utterance(callId, blob, `utterance.${extensionForMime(mime)}`);
    addLine('athlete', res.transcript);
    addLine('coach', res.replyText);
    if (res.audioUrl && callStore.getState().speakerOn) playReply(res.audioUrl);
    else patch({ agent: 'listening' });
  } catch (e) {
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
  live = { ended: true };
}

export async function endCall(opts: { keepError?: boolean; remote?: boolean } = {}): Promise<void> {
  const s = callStore.getState();
  if (live.ended && s.phase !== 'live') return;
  const callId = s.callId;
  releaseMedia();
  if (callId && !opts.remote) {
    try {
      await calls.end(callId);
    } catch {
      /* the server also ends calls on timeout */
    }
  }
  if (opts.keepError) patch({ recording: false, handsFree: false });
  else patch({ phase: 'ended', recording: false, handsFree: false });
}

export function resetCall(): void {
  if (isCallActive()) return;
  callStore.setState({ ...initial });
}
