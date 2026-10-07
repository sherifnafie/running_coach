import { newId, ZERO_USAGE, type Clock, type DictationSessionInfo, type Logger, type RealtimeVoiceProvider, type Store, type VoiceConfig } from '@opencoach/protocol';
import { VoiceError } from './errors';

/** Extra time the server waits past maxDurationS before closing a session the client never ended. */
const END_GRACE_S = 30;

export interface DictationBudget {
  /** Spend so far in the athlete-local day and month, and the athlete's limits. */
  dayUsd: number;
  monthUsd: number;
  dailyUsd: number;
  monthlyUsd: number;
}

export interface DictationServiceDeps {
  store: Store;
  clock: Clock;
  logger: Logger;
  config: VoiceConfig['dictation'];
  realtime?: RealtimeVoiceProvider;
  /** Current spend and limits for this athlete (the server computes athlete-local day and month). */
  budget(athleteId: string): Promise<DictationBudget>;
}

export interface DictationService {
  available(): boolean;
  /** Mint a transcription session for the athlete's browser. Ends (and bills) any session still open. */
  start(athleteId: string): Promise<DictationSessionInfo>;
  /** The athlete finished or cancelled. Idempotent. Bills server-measured open time, capped at the session maximum. */
  end(athleteId: string, sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

interface Active {
  sessionId: string;
  athleteId: string;
  model: string;
  startedAt: number;
  maxDurationS: number;
  timer: AbortController;
}

/**
 * Live dictation (SPEC §10.4): the browser streams microphone audio straight to the provider with an
 * ephemeral credential and shows transcript deltas in the composer. Nothing is stored and the coach is not
 * involved; the text is only sent if the athlete sends it. The server owns limits and billing [COST-1]:
 * one open session per athlete, a per-hour start limit, the AI budget, and usage recorded per session.
 */
export function createDictationService(deps: DictationServiceDeps): DictationService {
  const { config, clock, store } = deps;
  const log = deps.logger.child({ component: 'dictation' });
  const active = new Map<string, Active>(); // by athleteId
  const starts = new Map<string, number[]>(); // athleteId -> start times (ms) in the last hour
  const provider = deps.realtime?.createTranscriptionSession ? deps.realtime : undefined;

  async function close(session: Active, reason: 'ended' | 'replaced' | 'timeout' | 'shutdown'): Promise<void> {
    if (active.get(session.athleteId)?.sessionId !== session.sessionId) return;
    active.delete(session.athleteId);
    session.timer.abort();
    const openS = Math.max(0, (clock.now().getTime() - session.startedAt) / 1000);
    const billedS = Math.min(openS, session.maxDurationS);
    const costUsd = Math.round(((billedS / 60) * config.costPerMinuteUsd) * 1e6) / 1e6;
    try {
      await store.recordUsage({
        athleteId: session.athleteId, at: clock.now().toISOString(), provider: provider!.id, model: session.model, kind: 'stt',
        usage: { ...ZERO_USAGE }, costUsd,
      });
    } catch (e) {
      log.error('could not record dictation usage', { sessionId: session.sessionId, error: (e as Error).message });
    }
    log.info('dictation session closed', { sessionId: session.sessionId, reason, billedS: Math.round(billedS) });
  }

  return {
    available: () => config.enabled && !!provider,

    async start(athleteId) {
      if (!config.enabled || !provider) throw new VoiceError('dictation_unavailable', 'Live dictation is not configured on this server.');
      const now = clock.now().getTime();
      const recent = (starts.get(athleteId) ?? []).filter((t) => now - t < 3600_000);
      if (recent.length >= config.maxSessionsPerHour) {
        throw new VoiceError('dictation_rate_limited', 'Too many dictation sessions in the last hour. Try again later, or type your message.');
      }
      const previous = active.get(athleteId);
      if (previous) await close(previous, 'replaced');

      const budget = await deps.budget(athleteId);
      const remainingUsd = Math.min(budget.dailyUsd - budget.dayUsd, budget.monthlyUsd - budget.monthUsd);
      // Never let one session spend past the budget: shorten it instead, and refuse when under ~10 s remain.
      const affordableS = config.costPerMinuteUsd > 0 ? Math.floor((remainingUsd / config.costPerMinuteUsd) * 60) : config.maxDurationS;
      const maxDurationS = Math.min(config.maxDurationS, affordableS);
      if (maxDurationS < 10) throw new VoiceError('budget_exhausted', 'Your AI budget for today or this month is used up. You can still type, or record a voice note later.');

      recent.push(now);
      starts.set(athleteId, recent);
      const connect = await provider.createTranscriptionSession!({ model: config.model, ...(config.delay ? { delay: config.delay } : {}) });
      const session: Active = { sessionId: newId('dict', clock), athleteId, model: config.model, startedAt: clock.now().getTime(), maxDurationS, timer: new AbortController() };
      active.set(athleteId, session);
      // A client that vanishes is billed for the full session and the slot is freed.
      clock.sleepUntil(new Date(session.startedAt + (maxDurationS + END_GRACE_S) * 1000), session.timer.signal).then(
        () => close(session, 'timeout'),
        () => undefined,
      );
      return { sessionId: session.sessionId, model: config.model, connect, maxDurationS };
    },

    async end(athleteId, sessionId) {
      const session = active.get(athleteId);
      if (!session || session.sessionId !== sessionId) {
        if (!/^dict_[A-Za-z0-9]+$/.test(sessionId)) throw new VoiceError('dictation_not_found', 'Unknown dictation session.');
        return; // already closed (timeout, replaced) or never existed for this athlete: nothing to do
      }
      await close(session, 'ended');
    },

    async dispose() {
      await Promise.all([...active.values()].map((s) => close(s, 'shutdown')));
    },
  };
}
