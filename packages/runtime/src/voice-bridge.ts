import { COACH_TOOLS, ToolError, type AnyEvent } from '@opencoach/protocol';
import { readPinnedList, runViewQuery } from '@opencoach/workspace';
import type { Core } from './core';
import { formatLocal } from './time';

/**
 * Runtime side of voice (SPEC §11): the realtime voice front-end is a "mouth" briefed from the
 * workspace; heavy questions go to the main coach (consult); cascaded calls run `call` turns.
 */

const MAX_BRIEFING_CHARS = 30_000;

export async function callBriefing(core: Core, athleteId: string, purpose?: string): Promise<string> {
  const settings = await core.store.getSettings(athleteId);
  const tz = settings.profile.tz;
  const fs = core.fsFor(athleteId);
  const read = async (p: string) => {
    try {
      return (await fs.readText(p)).trim();
    } catch {
      return '';
    }
  };
  const vars = { coach_name: settings.profile.coachName, athlete_name: settings.profile.name };
  const addendum = (await core.addendum('voice', vars)) || `You are the voice of ${settings.profile.coachName}, ${settings.profile.name}'s coach, on a phone call. Speak naturally and briefly.`;
  const sections: string[] = [addendum];
  const persona = await read('/workspace/coach/persona.md');
  if (persona) sections.push(`## Your persona\n${persona}`);
  let pinned: string[] = [];
  try {
    pinned = await readPinnedList(core.paths(athleteId).workspace);
  } catch {
    pinned = [];
  }
  for (const p of pinned.filter((x) => x !== 'coach/persona.md')) {
    const t = await read(`/workspace/${p}`);
    if (t) sections.push(`## ${p}\n${t}`);
  }
  const briefing = await read('/workspace/briefing.md');
  if (briefing) sections.push(`## Coach's briefing\n${briefing}`);

  const since = new Date(core.clock.now().getTime() - 72 * 3_600_000).toISOString();
  const recent = await core.store.listEvents({ athleteId, since, types: ['user.message', 'user.voice_note', 'coach.message'], order: 'desc', limit: 40 });
  if (recent.length) {
    const lines = recent
      .reverse()
      .map((e: AnyEvent) => {
        const t = formatLocal(e.ts, tz);
        if (e.type === 'user.message') return `${t} Athlete: ${e.payload.text}`;
        if (e.type === 'user.voice_note') return `${t} Athlete (voice): ${e.payload.transcript}`;
        if (e.type === 'coach.message' && e.payload.delivery === 'sent') return `${t} Coach: ${e.payload.text}`;
        return '';
      })
      .filter(Boolean);
    sections.push(`## Recent conversation (last 72 h)\n${lines.join('\n')}`);
  }
  const wakes = (await core.scheduler.list(athleteId)).filter((s) => s.kind === 'coach').slice(0, 5);
  if (wakes.length) sections.push(`## Your upcoming check-ins\n${wakes.map((w) => `- ${w.nextFireAt ? formatLocal(w.nextFireAt, tz) : '?'}: ${w.purpose}`).join('\n')}`);
  sections.push(`## This call\nAthlete local time: ${formatLocal(core.clock.now(), tz)}.${purpose ? ` The athlete said the call is about: ${purpose}` : ''}`);
  let text = sections.join('\n\n');
  if (text.length > MAX_BRIEFING_CHARS) text = `${text.slice(0, MAX_BRIEFING_CHARS)}\n[briefing truncated]`;
  return text;
}

/** Fast read-only lookup for the voice front-end. */
export async function lookup(core: Core, athleteId: string, query: string): Promise<string> {
  const fs = core.fsFor(athleteId);
  const out: string[] = [];
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9äöüéèàçñ]+/i)
    .filter((w) => w.length >= 4)
    .slice(0, 6);
  if (terms.length) {
    const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    try {
      const matches = await fs.grep({ pattern, path: '/workspace', glob: '{athlete,plan,journal,coach}/**/*.md', max: 25, caseInsensitive: true });
      if (matches.length) out.push(`Notes:\n${matches.map((m) => `${m.path}:${m.line}: ${m.text.slice(0, 200)}`).join('\n')}`);
    } catch {
      /* ignore */
    }
  }
  const ws = core.paths(athleteId).workspace;
  const today = core.clock.now().toISOString().slice(0, 10);
  try {
    const planned = await runViewQuery({
      workspaceDir: ws,
      sql: 'SELECT date, type, title, status, target_distance_m, target_duration_s FROM planned_workouts WHERE date >= ? ORDER BY date LIMIT 10',
      params: [today],
      allowedTables: ['planned_workouts'],
      maxRows: 10,
      timeoutMs: 1500,
    });
    if (planned.length) out.push(`Upcoming sessions:\n${planned.map((r) => `- ${r.date} ${r.type}: ${r.title} (${r.status})`).join('\n')}`);
  } catch {
    /* table may not exist */
  }
  try {
    const recent = await runViewQuery({
      workspaceDir: ws,
      sql: 'SELECT started_at, sport, distance_m, duration_s, avg_hr, rpe, feel FROM activities ORDER BY started_at DESC LIMIT 5',
      allowedTables: ['activities'],
      maxRows: 5,
      timeoutMs: 1500,
    });
    if (recent.length) {
      out.push(
        `Recent activities:\n${recent
          .map((r) => `- ${String(r.started_at).slice(0, 16)} ${r.sport} ${r.distance_m ? `${(Number(r.distance_m) / 1000).toFixed(1)} km` : ''} ${r.duration_s ? `${Math.round(Number(r.duration_s) / 60)} min` : ''}${r.avg_hr ? ` HR ${r.avg_hr}` : ''}${r.rpe ? ` RPE ${r.rpe}` : ''}${r.feel ? ` "${r.feel}"` : ''}`)
          .join('\n')}`,
      );
    }
  } catch {
    /* ignore */
  }
  const text = out.join('\n\n') || 'Nothing relevant found in the notes. Ask the athlete, or consult the coach for a decision.';
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** consult_coach: run a non-messaging turn on the main coach and return its final text. */
export async function consult(core: Core, athleteId: string, question: string, context?: string): Promise<string> {
  const settings = await core.store.getSettings(athleteId);
  const header = `[${formatLocal(core.clock.now(), settings.profile.tz)} · voice.consult]`;
  const text =
    `${header}\nYour voice front-end is on a LIVE CALL with the athlete and asks you:\n${question}` +
    (context ? `\nContext from the call: ${context}` : '') +
    '\n\nAnswer in your final reply text (it is relayed to the voice model, which will say it in its own words). Keep it short and speakable. ' +
    'You may look things up and update your notes or plan if the athlete agreed to a change; do not message the athlete (they are on the call).';
  const outcome = await core.minds.get(athleteId).runExclusive(() =>
    core.turns.run(athleteId, [], 'call', {
      allowMessaging: false,
      replyRequired: false,
      extraTriggerText: text,
      tools: COACH_TOOLS.filter((t) => t !== 'send_message' && t !== 'no_reply'),
      limits: { maxSteps: 12, maxWallMs: 60_000 },
      effort: 'low',
    }),
  );
  if (outcome.status === 'skipped') throw new ToolError('NOT_CONFIGURED', 'The coach is unavailable right now.');
  return outcome.finalText.trim() || "I'll need to think about that after the call and follow up in writing.";
}

/** Cascaded calls: one athlete utterance → a `call` turn whose send_message text is spoken. */
export async function callTurn(core: Core, athleteId: string, callId: string, utterance: string): Promise<{ replyText: string }> {
  const settings = await core.store.getSettings(athleteId);
  const style = await core.addendum('call-cascaded', { coach_name: settings.profile.coachName, athlete_name: settings.profile.name });
  const header = `[${formatLocal(core.clock.now(), settings.profile.tz)} · call.utterance · ${callId}]`;
  const text = `${header}\nAthlete (speaking on a call with you): ${utterance}${style ? `\n\n${style}` : '\n\n(Your send_message text will be spoken aloud: keep it short, conversational, no markdown.)'}`;
  const outcome = await core.minds.get(athleteId).runExclusive(() =>
    core.turns.run(athleteId, [], 'call', { channel: 'call', replyRequired: true, extraTriggerText: text, limits: { maxSteps: 10, maxWallMs: 45_000 }, effort: 'low' }),
  );
  return { replyText: outcome.replyTexts.join(' ').trim() };
}
