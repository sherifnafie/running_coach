import type { ModelProvider } from '@opencoach/protocol';
import { z } from 'zod';
import type { Persona } from './personas';
import type { DailyCues } from './physiology';
import { addMinutes, inWindow, localParts, zonedInstant } from './util/dates';
import { rngFor } from './util/rng';

export const AthleteDecision = z.object({ run: z.boolean(), text: z.string().max(4000), disclose: z.array(z.string()).default([]) });
export type AthleteDecision = z.infer<typeof AthleteDecision>;
export interface AthleteAgent {
  decide(day: number, cues: DailyCues, coachMessages: string[]): Promise<AthleteDecision>;
  replyAt(now: Date, day: number, tz?: string): Date;
}

export function createScriptedAthlete(persona: Persona, seed: number): AthleteAgent {
  const disclosed = new Set<string>();
  return {
    async decide(day, cues, messages) {
      const rng = rngFor(seed, persona.id, day, 'athlete');
      const asked = messages.join('\n');
      const facts = persona.hidden.filter(f => !disclosed.has(f.id) && f.askedPatterns.some(p => new RegExp(p, 'i').test(asked)));
      facts.forEach(f => disclosed.add(f.id));
      const symptoms = cues.symptoms.filter(s => !s.includes('pain') || rng.chance(persona.painHonesty));
      const run = rng.chance(persona.compliance) && !cues.lifeEvents.some(e => e.type === 'illness' && e.fever);
      return { run, text: [...facts.map(f => f.answer), ...symptoms, run ? 'I did the session.' : 'I missed the session today.'].join(' '), disclose: facts.map(f => f.id) };
    },
    replyAt: (now, day, tz = persona.profile.tz) => replyAt(persona, seed, now, day, tz),
  };
}

function replyAt(persona: Persona, seed: number, now: Date, day: number, tz: string): Date {
  const latency = rngFor(seed, persona.id, day, 'latency').lognormal(persona.communication.replyLatencyMin.median, persona.communication.replyLatencyMin.p90);
  let at = addMinutes(now, latency);
  // Advance to the next active local minute, including windows spanning midnight and DST.
  for (let i = 0; i < 1440; i++) {
    if (inWindow(localParts(at, tz).minutes, persona.communication.activeHours.start, persona.communication.activeHours.end)) return at;
    at = addMinutes(at, 1);
  }
  throw new Error('Persona active hours must contain a reply window');
}

/** Optional fast-tier athlete. Calls only the explicitly supplied provider; tests supply cassettes. */
export function createModelAthlete(persona: Persona, seed: number, provider: ModelProvider, model: string): AthleteAgent {
  return {
    async decide(day, cues, coachMessages) {
      let text = '';
      for await (const event of provider.stream({ model, system: [{ text: 'Play this simulated athlete. Return only JSON {run:boolean,text:string,disclose:string[]}. Keep hidden facts private unless the coach asks. Never invent an activity or symptom.', cache: false }], items: [{ kind: 'user', parts: [{ type: 'text', text: JSON.stringify({ persona, day, symptoms: cues.symptoms, coachMessages }) }] }], tools: [], maxOutputTokens: 1200 })) {
        if (event.type === 'text_delta') text += event.text;
      }
      const decision = AthleteDecision.parse(JSON.parse(text));
      if (decision.disclose.some(id => !persona.hidden.some(f => f.id === id))) throw new Error('Athlete disclosed an unknown fact');
      return decision;
    },
    replyAt: (now, day, tz = persona.profile.tz) => replyAt(persona, seed, now, day, tz),
  };
}
