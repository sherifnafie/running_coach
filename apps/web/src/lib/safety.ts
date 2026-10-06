import type { AnyEvent, SafetyCategory, StreamMessage } from '@opencoach/protocol';

/**
 * Harness-owned safety banner (SPEC §12.2 [SAFE-2]). The coach cannot write or hide this: it is derived only from
 * `{t:'safety'}` stream messages and athlete-visible `harness.notice` events of kind `safety_flag`.
 * The guidance text below is fixed shell copy; server text (if any) is shown in addition, never instead.
 */
export interface SafetyBannerData {
  /** Dedup / dismissal key. */
  key: string;
  categories: SafetyCategory[];
  acute: boolean;
  /** Server-provided text (may be empty). */
  text: string;
  atMs: number;
}

/** A banner older than this is not re-shown when history is reloaded. */
export const BANNER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const EMERGENCY_GUIDANCE =
  'If this is an emergency, or you have chest pain, trouble breathing, fainting, confusion or severe pain, stop exercising and call your local emergency number now (for example 112, 911 or 999).';

const BY_CATEGORY: Partial<Record<SafetyCategory, string>> = {
  cardiac: 'Chest pain or pressure, palpitations or fainting need medical attention. Stop training until a clinician has seen you.',
  heat_illness: 'Confusion, vomiting or stopping sweating in the heat can be heat illness. Get out of the heat, cool down and seek urgent medical help.',
  stress_fracture: 'Sharp bone pain, or pain at rest or at night, can mean a stress injury. Stop running and have it checked.',
  neuro: 'Numbness, weakness or a head injury needs prompt medical assessment.',
  rhabdo: 'Dark urine and severe muscle pain after hard exercise need urgent medical care.',
  dvt: 'A swollen, painful calf after travel or rest can be a clot. Seek medical care promptly.',
  eating_disorder: 'If food, weight or exercise feels out of control, talking to a doctor or an eating-disorder helpline can help. You deserve support.',
  self_harm: 'If you are thinking about harming yourself, please contact your local emergency number or a crisis line in your country right now. You are not alone.',
  other_acute: 'This may need medical attention. If you are unsure, contact a clinician or your local emergency number.',
};

export function guidanceFor(categories: SafetyCategory[]): string[] {
  const lines = [EMERGENCY_GUIDANCE];
  for (const c of categories) {
    const t = BY_CATEGORY[c];
    if (t && !lines.includes(t)) lines.push(t);
  }
  lines.push('Your coach is an AI and cannot diagnose or replace a clinician.');
  return lines;
}

export function bannerFromStream(m: Extract<StreamMessage, { t: 'safety' }>, nowMs: number): SafetyBannerData {
  return { key: `s:${nowMs}`, categories: m.categories, acute: m.acute, text: m.text, atMs: nowMs };
}

/** `harness.notice` (safety_flag, athleteVisible) → banner, or undefined for any other event. */
export function bannerFromEvent(e: AnyEvent): SafetyBannerData | undefined {
  if (e.type !== 'harness.notice' || e.payload.kind !== 'safety_flag' || !e.payload.athleteVisible) return undefined;
  const d = (e.payload.detail ?? {}) as { categories?: unknown; acute?: unknown };
  const categories = Array.isArray(d.categories) ? (d.categories.filter((c) => typeof c === 'string') as SafetyCategory[]) : [];
  return { key: e.id, categories, acute: d.acute === true, text: e.payload.text ?? '', atMs: Date.parse(e.ts) };
}

/** Pick the banner to (re)show from loaded history: the newest recent safety notice. */
export function bannerFromHistory(events: AnyEvent[], nowMs: number): SafetyBannerData | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const b = bannerFromEvent(events[i]!);
    if (b) return nowMs - b.atMs <= BANNER_MAX_AGE_MS ? b : undefined;
  }
  return undefined;
}

export function isDismissed(b: SafetyBannerData, dismissed: readonly string[]): boolean {
  return dismissed.includes(b.key);
}

/** Keep the dismissed list short. */
export function addDismissed(dismissed: readonly string[], key: string): string[] {
  return [...dismissed.filter((k) => k !== key), key].slice(-20);
}
