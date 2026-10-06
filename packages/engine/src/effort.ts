import type { Effort } from '@opencoach/protocol';

export const EFFORT_LADDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Pick the effort to send to a model: the requested level when supported, otherwise the nearest
 * supported level below it (so 'max' degrades to the highest the model accepts), otherwise the
 * lowest supported level. `undefined` when the model takes no effort control.
 * `fallback` is used when the caller did not request an effort (undefined = send none).
 */
export function resolveEffort(requested: Effort | undefined, supported: readonly Effort[], fallback?: Effort): Effort | undefined {
  if (supported.length === 0) return undefined;
  const want = requested ?? fallback;
  if (want === undefined) return undefined;
  if (supported.includes(want)) return want;
  for (let i = EFFORT_LADDER.indexOf(want) - 1; i >= 0; i--) {
    const e = EFFORT_LADDER[i]!;
    if (supported.includes(e)) return e;
  }
  return EFFORT_LADDER.find((e) => supported.includes(e));
}
