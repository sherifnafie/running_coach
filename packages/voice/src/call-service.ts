import {
  ToolInputs,
  athletePaths,
  newId,
  type AthleteSettings,
  type CallMode,
  type CallSessionInfo,
  type Logger,
  type RealtimeSideband,
  type RealtimeSidebandHandlers,
  type VoiceTranscriptEntry,
} from '@opencoach/protocol';
import { virtualCallPaths, writeCallFiles, type CallRecord } from './call-files';
import { VoiceError } from './errors';
import type { CallService, CallServiceDeps } from './types';
import { voiceToolSpecs } from './voice-tools';

/** How long `end` waits for a cascaded utterance that is still being processed. */
const DRAIN_GRACE_S = 30;
/** How many finished call ids are remembered (so a repeated `end` stays a no-op). */
const ENDED_MEMORY = 1000;

const noop = (): void => {};

type EndedBy = 'athlete' | 'coach' | 'error';

interface ActiveCall {
  callId: string;
  athleteId: string;
  mode: CallMode;
  provider: string;
  model: string;
  voice: string;
  tz: string;
  startedAt: Date;
  maxDurationS: number;
  transcript: VoiceTranscriptEntry[];
  notes: CallRecord['notes'];
  consults: CallRecord['consults'];
  endReason?: string;
  providerCallId?: string;
  attaching?: Promise<void>;
  sideband?: RealtimeSideband;
  /** Utterance chain (cascaded). Never rejects. */
  queue: Promise<void>;
  inflight: number;
  /** Cancels the max-duration timer. */
  timer: AbortController;
  /** Set as soon as the call starts ending; the same promise is returned to every later `end`. */
  ending?: Promise<void>;
  finished: boolean;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function invalid(name: string, issues: { message: string }): { error: string } {
  return { error: `invalid arguments for ${name}: ${issues.message}` };
}

class CallServiceImpl implements CallService {
  private readonly calls = new Map<string, ActiveCall>();
  /** callId → athleteId of calls that already finished. */
  private readonly ended = new Map<string, string>();
  private readonly log: Logger;
  private disposed = false;

  constructor(private readonly deps: CallServiceDeps) {
    this.log = deps.logger.child({ component: 'voice' });
  }

  features(): { realtime: boolean; cascaded: boolean; voiceNotes: boolean } {
    const { realtime, transcriber, synthesizer } = this.deps;
    return { realtime: !!realtime, cascaded: !!(transcriber && synthesizer), voiceNotes: !!transcriber };
  }

  // ------------------------------------------------------------------ start

  async start(athleteId: string, opts: { mode?: CallMode; purpose?: string }): Promise<CallSessionInfo> {
    if (this.disposed) throw new VoiceError('calls_unavailable', 'The voice service is shutting down');
    const { deps } = this;
    const settings = await deps.store.getSettings(athleteId);
    const mode = this.resolveMode(opts.mode, settings);
    const callId = newId('call', deps.clock);
    const maxDurationS = deps.config.realtime.maxDurationS;
    const tz = settings.profile.tz;

    let info: CallSessionInfo;
    let voice: string;
    if (mode === 'realtime') {
      const realtime = deps.realtime!;
      voice = settings.voice.voice || deps.config.realtime.voice;
      // The briefing already carries persona, memory and the voice addendum (SPEC §11.2 step 1).
      const instructions = await deps.runtime.callBriefing(athleteId, opts.purpose);
      const connect = await realtime.createSession({ instructions, tools: voiceToolSpecs(), voice, model: deps.config.realtime.model });
      info = { callId, mode, provider: realtime.id, model: connect.model || deps.config.realtime.model, connect, maxDurationS };
    } else {
      const { transcriber, synthesizer } = deps;
      voice = settings.voice.voice || deps.config.tts.voice;
      info = {
        callId,
        mode,
        provider: `${transcriber!.id}+${synthesizer!.id}`,
        model: `${deps.config.stt.model}+${deps.config.tts.model}`,
        maxDurationS,
      };
    }

    await deps.runtime.appendSystemEvent({
      athleteId,
      type: 'call.started',
      actor: 'harness',
      payload: { callId, mode, provider: info.provider, model: info.model },
    });

    const call: ActiveCall = {
      callId,
      athleteId,
      mode,
      provider: info.provider,
      model: info.model,
      voice,
      tz,
      startedAt: deps.clock.now(),
      maxDurationS,
      transcript: [],
      notes: [],
      consults: [],
      queue: Promise.resolve(),
      inflight: 0,
      timer: new AbortController(),
      finished: false,
    };
    this.calls.set(callId, call);
    this.armTimer(call);
    this.log.info('call started', { athleteId, callId, mode, provider: info.provider, model: info.model });
    return info;
  }

  private resolveMode(requested: CallMode | undefined, settings: AthleteSettings): CallMode {
    const avail = this.features();
    if (requested) {
      if (!avail[requested]) throw new VoiceError('calls_unavailable', `${requested} calls are not available on this server`);
      return requested;
    }
    const preferred = settings.voice.callMode;
    const other: CallMode = preferred === 'realtime' ? 'cascaded' : 'realtime';
    if (avail[preferred]) return preferred;
    if (avail[other]) return other;
    throw new VoiceError('calls_unavailable', 'Voice calls are not configured on this server');
  }

  /** Max-duration guard (a code-level guarantee): ends the call through the injected Clock. */
  private armTimer(call: ActiveCall): void {
    const at = new Date(call.startedAt.getTime() + call.maxDurationS * 1000);
    this.deps.clock.sleepUntil(at, call.timer.signal).then(
      () => {
        this.log.info('call reached its maximum duration', { callId: call.callId, maxDurationS: call.maxDurationS });
        return this.finish(call, 'coach');
      },
      (e: unknown) => {
        if ((e as { name?: string } | undefined)?.name !== 'AbortError') this.log.error('call timer failed', { callId: call.callId, error: errMessage(e) });
      },
    ).catch((e: unknown) => this.log.error('ending call at max duration failed', { callId: call.callId, error: errMessage(e) }));
  }

  // ------------------------------------------------------------------ lookups

  /** Find a call the athlete owns. Unknown ids and other athletes' ids look the same. */
  private find(athleteId: string, callId: string): { call?: ActiveCall; endedAlready: boolean } {
    const doneFor = this.ended.get(callId);
    if (doneFor !== undefined) {
      if (doneFor !== athleteId) throw this.notFound(callId);
      return { endedAlready: true };
    }
    const call = this.calls.get(callId);
    if (!call || call.athleteId !== athleteId) throw this.notFound(callId);
    return { call, endedAlready: false };
  }

  private notFound(callId: string): VoiceError {
    return new VoiceError('call_not_found', `No such call: ${callId}`);
  }

  private requireActive(athleteId: string, callId: string, mode: CallMode): ActiveCall {
    const { call, endedAlready } = this.find(athleteId, callId);
    if (endedAlready || !call || call.ending) throw new VoiceError('call_ended', `Call ${callId} has ended`);
    if (call.mode !== mode) throw new VoiceError('wrong_mode', `Call ${callId} is a ${call.mode} call`);
    return call;
  }

  // ------------------------------------------------------------------ realtime: sideband

  async attach(athleteId: string, callId: string, providerCallId: string): Promise<void> {
    const call = this.requireActive(athleteId, callId, 'realtime');
    if (call.providerCallId) {
      if (call.providerCallId !== providerCallId) throw new VoiceError('already_attached', `Call ${callId} is already attached to another provider call`);
      await call.attaching;
      return;
    }
    call.providerCallId = providerCallId;
    call.attaching = this.openSideband(call, providerCallId);
    try {
      await call.attaching;
    } catch (e) {
      call.providerCallId = undefined;
      call.attaching = undefined;
      throw e;
    }
  }

  private async openSideband(call: ActiveCall, providerCallId: string): Promise<void> {
    const sideband = await this.deps.realtime!.attachSideband({ providerCallId, model: call.model, handlers: this.handlersFor(call) });
    if (call.ending) {
      await sideband.close().catch(noop);
      throw new VoiceError('call_ended', `Call ${call.callId} ended while attaching`);
    }
    call.sideband = sideband;
  }

  private handlersFor(call: ActiveCall): RealtimeSidebandHandlers {
    return {
      onToolCall: (tc) => this.handleToolCall(call, tc),
      onTranscript: (entry) => {
        if (call.finished) return;
        const text = entry.text.trim();
        if (text) call.transcript.push({ role: entry.role, text, at: entry.at });
      },
      onEnd: (reason, detail) => {
        this.log.info('sideband ended', { callId: call.callId, reason, detail });
        void this.finish(call, reason === 'timeout' ? 'coach' : reason).catch((e: unknown) =>
          this.log.error('ending call after sideband close failed', { callId: call.callId, error: errMessage(e) }),
        );
      },
    };
  }

  private async handleToolCall(call: ActiveCall, tc: { id: string; name: string; arguments: unknown }): Promise<unknown> {
    const { runtime, clock } = this.deps;
    try {
      switch (tc.name) {
        case 'lookup': {
          const p = ToolInputs.lookup.safeParse(tc.arguments);
          if (!p.success) return invalid(tc.name, p.error);
          return { result: await runtime.lookup(call.athleteId, p.data.query) };
        }
        case 'consult_coach': {
          const p = ToolInputs.consult_coach.safeParse(tc.arguments);
          if (!p.success) return invalid(tc.name, p.error);
          const entry: CallRecord['consults'][number] = { question: p.data.question, context: p.data.context, at: clock.now().toISOString() };
          call.consults.push(entry);
          try {
            // May take seconds; the voice model keeps the conversation going meanwhile.
            entry.answer = await runtime.consult(call.athleteId, p.data.question, p.data.context);
          } catch (e) {
            entry.error = errMessage(e);
            throw e;
          }
          return { answer: entry.answer };
        }
        case 'note': {
          const p = ToolInputs.note.safeParse(tc.arguments);
          if (!p.success) return invalid(tc.name, p.error);
          call.notes.push({ text: p.data.text, at: clock.now().toISOString() });
          return { ok: true };
        }
        case 'end_call': {
          const p = ToolInputs.end_call.safeParse(tc.arguments ?? {});
          if (!p.success) return invalid(tc.name, p.error);
          if (p.data.reason) call.endReason = p.data.reason;
          // After this returns, the sideband delivers the tool output; only then do we close it.
          setImmediate(() => {
            void this.finish(call, 'coach').catch((e: unknown) => this.log.error('end_call failed', { callId: call.callId, error: errMessage(e) }));
          });
          return { ok: true };
        }
        default:
          return { error: `unknown tool: ${tc.name}` };
      }
    } catch (e) {
      this.log.warn('voice tool failed', { callId: call.callId, tool: tc.name, error: errMessage(e) });
      return { error: errMessage(e) };
    }
  }

  // ------------------------------------------------------------------ cascaded

  async utterance(athleteId: string, callId: string, audio: Uint8Array, mime: string): Promise<{ transcript: string; replyText: string; audioSha256?: string }> {
    const call = this.requireActive(athleteId, callId, 'cascaded');
    call.inflight++;
    // Serialize per call: one utterance at a time, in arrival order.
    const result = call.queue.then(() => this.runUtterance(call, audio, mime));
    call.queue = result.then(noop, noop);
    try {
      return await result;
    } finally {
      call.inflight--;
    }
  }

  private async runUtterance(call: ActiveCall, audio: Uint8Array, mime: string): Promise<{ transcript: string; replyText: string; audioSha256?: string }> {
    const { runtime, clock, transcriber, synthesizer, blobs } = this.deps;
    const stt = await transcriber!.transcribe(audio, mime);
    const transcript = stt.text.trim();
    if (!transcript) return { transcript: '', replyText: '' };
    call.transcript.push({ role: 'athlete', text: transcript, at: clock.now().toISOString() });

    const turn = await runtime.callTurn(call.athleteId, call.callId, transcript);
    const replyText = turn.replyText.trim();
    if (!replyText) return { transcript, replyText: '' };
    call.transcript.push({ role: 'coach', text: replyText, at: clock.now().toISOString() });

    let audioSha256: string | undefined;
    try {
      const speech = await synthesizer!.synthesize(replyText, { voice: call.voice });
      const blob = await blobs.put(call.athleteId, speech.audio, { mime: speech.mime, origin: 'call', extra: { callId: call.callId, model: speech.model } });
      audioSha256 = blob.sha256;
    } catch (e) {
      // The reply text is still useful on its own; the client shows it without audio.
      this.log.warn('speech synthesis failed; returning text only', { callId: call.callId, error: errMessage(e) });
    }
    return { transcript, replyText, ...(audioSha256 ? { audioSha256 } : {}) };
  }

  // ------------------------------------------------------------------ end / write-back

  async end(athleteId: string, callId: string, endedBy: EndedBy): Promise<void> {
    const { call, endedAlready } = this.find(athleteId, callId);
    if (endedAlready || !call) return;
    return this.finish(call, endedBy);
  }

  private finish(call: ActiveCall, endedBy: EndedBy): Promise<void> {
    // Deferred by a microtask so `call.ending` is set before any re-entrant `finish` (e.g. from sideband onEnd).
    call.ending ??= Promise.resolve().then(() => this.doFinish(call, endedBy));
    return call.ending;
  }

  private async doFinish(call: ActiveCall, endedBy: EndedBy): Promise<void> {
    const { deps } = this;
    call.timer.abort();
    try {
      if (endedBy !== 'error') await this.drain(call);
      if (call.attaching) await call.attaching.catch(noop);
      if (call.sideband) await call.sideband.close().catch((e: unknown) => this.log.warn('closing sideband failed', { callId: call.callId, error: errMessage(e) }));

      const endedAt = deps.clock.now();
      const record: CallRecord = {
        callId: call.callId,
        mode: call.mode,
        startedAt: call.startedAt,
        endedAt,
        endedBy,
        tz: call.tz,
        transcript: call.transcript,
        notes: call.notes,
        consults: call.consults,
        endReason: call.endReason,
      };
      let paths = virtualCallPaths(call.startedAt, call.callId, call.tz);
      try {
        const written = await writeCallFiles(athletePaths(deps.dataDir, call.athleteId).history, record);
        paths = { transcriptPath: written.transcriptPath, notesPath: written.notesPath };
      } catch (e) {
        // Still announce the end so the runtime can close the loop; the coach will find no files.
        this.log.error('writing call transcript failed', { callId: call.callId, error: errMessage(e) });
      }

      const durationS = Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000));
      // The runtime turns call.ended into a follow-up turn where the main coach processes the call.
      await deps.runtime.appendSystemEvent({
        athleteId: call.athleteId,
        type: 'call.ended',
        actor: 'harness',
        payload: { callId: call.callId, durationS, transcriptPath: paths.transcriptPath, notesPath: paths.notesPath, endedBy },
      });
      this.log.info('call ended', { athleteId: call.athleteId, callId: call.callId, endedBy, durationS });
    } finally {
      call.finished = true;
      this.calls.delete(call.callId);
      this.ended.set(call.callId, call.athleteId);
      if (this.ended.size > ENDED_MEMORY) this.ended.delete(this.ended.keys().next().value as string);
    }
  }

  /** Let a cascaded utterance that is still being processed land in the transcript (bounded wait). */
  private async drain(call: ActiveCall): Promise<void> {
    if (call.inflight === 0) return;
    const { clock } = this.deps;
    const ac = new AbortController();
    const grace = clock.sleepUntil(new Date(clock.now().getTime() + DRAIN_GRACE_S * 1000), ac.signal).catch(noop);
    await Promise.race([call.queue, grace]);
    ac.abort();
  }

  // ------------------------------------------------------------------ voice notes, shutdown

  async transcribeVoiceNote(audio: Uint8Array, mime: string): Promise<{ text: string; model: string; durationS?: number }> {
    const { transcriber } = this.deps;
    if (!transcriber) throw new VoiceError('voice_notes_unavailable', 'Voice notes are unavailable: no speech-to-text provider is configured');
    return transcriber.transcribe(audio, mime);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = [...this.calls.values()];
    const results = await Promise.allSettled(active.map((c) => this.finish(c, 'error')));
    for (const r of results) if (r.status === 'rejected') this.log.error('ending call during dispose failed', { error: errMessage(r.reason) });
  }
}

export function createCallService(deps: CallServiceDeps): CallService {
  return new CallServiceImpl(deps);
}
