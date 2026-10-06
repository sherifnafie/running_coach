/**
 * Last-known-good loading of a view (SPEC §9.6 step 6): if the current version fails to load or reports an
 * error before `ready` within the timeout, fall back to the previous version; if that fails too, show an error.
 */
export const READY_TIMEOUT_MS = 8000;

export interface LoadState {
  phase: 'loading' | 'ready' | 'failed';
  /** Which published version is in the iframe. */
  source: 'current' | 'previous';
  /** Why we fell back / failed (shown subtly to the athlete). */
  reason?: string;
}

export type LoadAction = { type: 'ready' } | { type: 'error'; message: string } | { type: 'timeout' } | { type: 'reset' };

export const initialLoadState: LoadState = { phase: 'loading', source: 'current' };

export function reduceLoad(state: LoadState, action: LoadAction, hasPrevious: boolean): LoadState {
  if (action.type === 'reset') return initialLoadState;
  if (action.type === 'ready') return state.phase === 'failed' ? state : { ...state, phase: 'ready' };
  // Errors after `ready` are reported to the coach but never swap the version under the athlete.
  if (state.phase !== 'loading') return state;
  const reason = action.type === 'timeout' ? 'did not start in time' : action.message;
  if (state.source === 'current' && hasPrevious) return { phase: 'loading', source: 'previous', reason };
  return { phase: 'failed', source: state.source, reason };
}
