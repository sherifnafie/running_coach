import type { ModelRouter, SafetyCategory, SafetyScreen, SafetyScreenResult } from '@opencoach/protocol';

/**
 * Inbound safety screen (SPEC [SAFE-2]). A cheap heuristic always runs; an optional fast-tier model
 * check can upgrade it. False positives are cheap (a protocol reminder + a banner); false negatives
 * are mitigated by the constitution itself.
 */

const PATTERNS: Array<{ cat: SafetyCategory; re: RegExp }> = [
  { cat: 'cardiac', re: /\b(chest (pain|pressure|tightness|tight)|tight(ness)? in (my )?chest|pain in (my )?chest|heart (racing|pounding|skipping|flutter\w*)|palpitations?|irregular heart ?beat|arrhythmia)\b/i },
  { cat: 'cardiac', re: /\b(faint(ed|ing)?|pass(ed)? out|black(ed)? out|collaps(ed|ing)|nearly (fainted|passed out)|dizz(y|iness) (and|with) (chest|short))\b/i },
  { cat: 'cardiac', re: /\b(can'?t (catch|get) my breath|short(ness)? of breath (at rest|while resting)|struggling to breathe)\b/i },
  { cat: 'heat_illness', re: /\b(heat ?stroke|stopped sweating|confused (after|in) the heat|vomit(ed|ing) .{0,30}(heat|hot)|heat exhaustion)\b/i },
  { cat: 'stress_fracture', re: /\b(stress fracture|stress reaction|bone pain|pain (at|in) (the )?(night|rest).{0,40}(shin|foot|hip|bone)|(shin|foot|hip|metatarsal) (hurts|pain) (at night|when resting|even resting))\b/i },
  { cat: 'neuro', re: /\b(numb(ness)?|tingling|weakness) (in|down) (my )?(arm|leg|face)|\b(hit my head|head injury|concussion|worst headache|thunderclap headache|sudden (severe|blinding|explosive) headache)\b/i },
  // Back pain with saddle numbness or bladder/bowel changes (possible cauda equina): an emergency in any sport.
  { cat: 'neuro', re: /\b(numb(ness)?|tingling|no feeling) (in|around) (my )?(groin|crotch|genitals|inner thighs?|saddle|bum|buttocks)|\b(can'?t|cannot|couldn'?t) (control|hold) (my )?(bladder|bowels?|pee|wee)|\b(lost|losing|loss of) (bladder|bowel) control|\bboth (of my )?legs (are |went |going |feel )?(weak|numb|giving (way|out))\b/i },
  // A pop or tear with immediate weakness or deformity (tendon rupture): needs prompt assessment.
  { cat: 'other_acute', re: /\b(felt|heard) (a |something )?(pop|snap|tear|rip)\b.{0,60}\b(weak|can'?t (lift|move|bend|straighten)|bruis\w*|lump|dent|deform\w*|bunched|swollen)\b|\b(torn|ruptured?) (my )?(biceps?|pec\w*|achilles|tendon|acl)\b/i },
  { cat: 'rhabdo', re: /\b(dark|brown|cola[- ]colou?red|tea[- ]colou?red) (urine|pee)\b/i },
  { cat: 'dvt', re: /\b(swollen|swelling) .{0,20}calf\b|\bcalf .{0,20}(swollen|hot and red)\b|\b(blood clot|dvt)\b/i },
  { cat: 'eating_disorder', re: /\b(starv(e|ing) myself|purg(e|ing)|binge|eat(ing)? (only|just) \d{2,4} cal|lose \d{2,} ?(kg|lbs?|pounds) in \d+ (weeks?|days)|missed (my )?periods?|no periods?|haven'?t had (a|my) period)\b/i },
  { cat: 'self_harm', re: /\b(kill myself|suicid\w*|end (it all|my life)|self[- ]harm|hurt(ing)? myself|don'?t want to (live|be alive))\b/i },
];

const ACUTE = /\b(right now|now|currently|at the moment|still|just (now|happened)|this (morning|evening|afternoon)|during (my|the|a) (run|ride|swim|lift|set|session|workout|game|match|training)|mid[- ](run|set|lift|session|workout|game)|today)\b/i;

export function heuristicScreen(text: string): SafetyScreenResult {
  const cats = new Set<SafetyCategory>();
  for (const p of PATTERNS) if (p.re.test(text)) cats.add(p.cat);
  const categories = [...cats];
  const acute = categories.length > 0 && (ACUTE.test(text) || categories.includes('self_harm'));
  return { flagged: categories.length > 0, categories, acute, method: 'heuristic' };
}

export function createSafetyScreen(opts: { router?: ModelRouter; useModel: boolean }): SafetyScreen {
  return {
    async screen(text: string): Promise<SafetyScreenResult> {
      const h = heuristicScreen(text);
      if (!opts.useModel || !opts.router || text.trim().length < 12) return h;
      try {
        const route = opts.router.route('fast')[0];
        if (!route) return h;
        let out = '';
        for await (const ev of route.provider.stream({
          model: route.model,
          system: [
            {
              text:
                'You screen messages from an athlete (any sport) to their coach for acute medical or crisis signals. Reply with ONLY compact JSON: ' +
                '{"categories":[...],"acute":true|false}. Categories: cardiac, heat_illness, stress_fracture, neuro, rhabdo, dvt, eating_disorder, self_harm, other_acute. ' +
                'Use [] when nothing concerning. Ordinary soreness and fatigue are not concerning. Back pain with groin numbness or bladder/bowel changes is neuro; a pop or tear with weakness is other_acute.',
              cache: true,
            },
          ],
          items: [{ kind: 'user', parts: [{ type: 'text', text: text.slice(0, 4000) }] }],
          tools: [],
          effort: 'low',
          maxOutputTokens: 200,
        })) {
          if (ev.type === 'text_delta') out += ev.text;
        }
        const m = /\{[\s\S]*\}/.exec(out);
        if (!m) return h;
        const j = JSON.parse(m[0]) as { categories?: string[]; acute?: boolean };
        const cats = new Set<SafetyCategory>(h.categories);
        for (const c of j.categories ?? []) cats.add(c as SafetyCategory);
        const categories = [...cats];
        return { flagged: categories.length > 0, categories, acute: h.acute || !!j.acute, method: 'model' };
      } catch {
        return h;
      }
    },
  };
}

export function safetyBannerText(categories: SafetyCategory[], acute: boolean): string {
  if (categories.includes('self_harm')) {
    return 'If you are thinking about harming yourself or are in crisis, please contact your local emergency number or a crisis line now. You deserve support from a person right away.';
  }
  return acute
    ? 'If you have chest pain, fainting, severe breathlessness, confusion in the heat or other severe symptoms right now: stop exercising and call your local emergency number.'
    : 'Some symptoms you mentioned can be serious. Stop training and get checked by a doctor before your next session. If symptoms are severe or happening now, call your local emergency number.';
}
