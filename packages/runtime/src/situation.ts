import { COACH_TOOLS, type AnyEvent, type AthleteSettings, type ResolvedModel, type SafetyScreenResult, type ToolName, type TriggerClass } from '@opencoach/protocol';
import { readUiManifests } from '@opencoach/workspace';
import { capabilityLines, unavailableTools } from './capabilities';
import type { PinnedReport } from './context';
import type { Core } from './core';
import { formatLocal, localDayStartIso, localMonthStartIso, quietHoursEnd } from './time';

export interface SituationInput {
  athleteId: string;
  settings: AthleteSettings;
  cls: TriggerClass;
  triggers: AnyEvent[];
  model: ResolvedModel;
  tools: ToolName[];
  epoch: { localDate: string; seq: number };
  pinned: PinnedReport;
  replyRequired: boolean;
  proactive: boolean;
  limits: { maxSteps: number; maxWallMs: number };
  safety?: SafetyScreenResult;
  firstContact: boolean;
  extra?: string[];
}

function ago(fromIso: string | undefined, now: Date): string {
  if (!fromIso) return 'never';
  const ms = now.getTime() - new Date(fromIso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The per-turn harness-written ground truth (SPEC §5.3.4). */
export async function buildSituation(core: Core, s: SituationInput): Promise<string> {
  const now = core.clock.now();
  const tz = s.settings.profile.tz;
  const store = core.store;
  const lines: string[] = [];
  const local = formatLocal(now, tz);
  lines.push(`now: ${now.toISOString()} · athlete local time: ${local} (${tz})`);
  const types = [...new Set(s.triggers.map((t) => t.type))].join(', ');
  lines.push(`trigger: ${s.cls}${types ? ` (${types})` : ''} · reply required: ${s.replyRequired ? 'yes' : 'no'}${s.proactive ? ' · anything you send now is PROACTIVE' : ''}`);
  lines.push(`athlete: ${s.settings.profile.name} · units: ${s.settings.profile.units} · locale: ${s.settings.profile.locale}${s.firstContact ? ' · FIRST CONTACT (new athlete; no intake yet)' : ''}`);

  lines.push(
    `presentation: theme ${s.settings.appearance.theme} · accent ${s.settings.appearance.accent ?? 'default'} · reply language ${s.settings.profile.locale} · your name ${s.settings.profile.coachName}, avatar ${s.settings.coachIdentity.avatarSha256 ?? 'initials'} (current settings; older notes may differ)`,
  );

  const [lastAthlete] = await store.listEvents({ athleteId: s.athleteId, types: ['user.message', 'user.upload', 'user.voice_note'], order: 'desc', limit: 1 });
  const unread = await store.countUnreadCoachMessages(s.athleteId);
  lines.push(`last athlete message: ${ago(lastAthlete?.ts, now)} · your messages the athlete hasn't opened yet: ${unread}`);

  const n = s.settings.notifications;
  const held = (await store.listHeldMessages(s.athleteId)).length;
  const today = (await store.countProactiveSince(s.athleteId, localDayStartIso(now, tz))) + held;
  const week = (await store.countProactiveSince(s.athleteId, new Date(now.getTime() - 7 * 86_400_000).toISOString())) + held;
  const quietEnd = quietHoursEnd(now, tz, n.quietHours);
  const quiet = n.quietHours
    ? `quiet hours ${n.quietHours.start}–${n.quietHours.end}${quietEnd ? ` (ACTIVE: proactive messages are held until ${formatLocal(quietEnd, tz).slice(11, 16)})` : ''}`
    : 'no quiet hours';
  const paused = n.pauseUntil && new Date(n.pauseUntil).getTime() > now.getTime() ? ` · coaching PAUSED by the athlete until ${formatLocal(n.pauseUntil, tz)}` : '';
  lines.push(`proactive message limits (ceilings, NOT targets): at most ${n.proactivePerDay} per local day and ${n.proactivePerWeek} across the last 7 days; remaining allowance ${Math.max(0, n.proactivePerDay - today)} today, ${Math.max(0, n.proactivePerWeek - week)} across the last 7 days. Replies and requested task results do not count. ${n.proactivePerDay === 0 || n.proactivePerWeek === 0 ? 'Proactive messaging is disabled by a zero limit. ' : ''}${quiet}${held ? ` · ${held} held message(s) pending` : ''}${paused}`);

  const tasks = await store.listTasks(s.athleteId, { state: 'running' });
  const schedules = (await core.scheduler.list(s.athleteId)).filter((x) => x.kind === 'coach');
  const nextWake = schedules[0];
  lines.push(
    `pending: ${tasks.length ? tasks.map((t) => `${t.id} (${t.profile ?? 'helper'})`).join(', ') : 'no helper tasks'} · ${schedules.length} wake(s) scheduled${
      nextWake?.nextFireAt ? ` (next ${formatLocal(nextWake.nextFireAt, tz)}: ${nextWake.purpose.slice(0, 80)}${nextWake.purpose.length > 80 ? '…' : ''})` : ''
    } · heartbeat ${s.settings.heartbeat.enabled ? `daily ${s.settings.heartbeat.time}` : 'off'}`,
  );

  const pinnedNote = [s.pinned.truncated.length ? `TRUNCATED: ${s.pinned.truncated.join(', ')} — condense them` : '', s.pinned.missing.length ? `missing: ${s.pinned.missing.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ');
  lines.push(
    `context: epoch ${s.epoch.localDate} #${s.epoch.seq} · pinned ${(s.pinned.tokens / 1000).toFixed(1)}k/${(s.pinned.cap / 1000).toFixed(0)}k tokens${pinnedNote ? ` (${pinnedNote})` : ''} · model ${s.model.model} (${s.model.provider.id}, ${s.model.tier} tier, vision ${s.model.capabilities.vision ? 'yes' : 'NO'})`,
  );
  const imageSpend = await store.sumUsage(s.athleteId, localMonthStartIso(now, tz), 'image');
  lines.push(...capabilityLines(core, s.athleteId, s.settings, s.model, s.tools, imageSpend.costUsd));
  const toolChange = await toolsChanged(core, s.athleteId);
  if (toolChange) lines.push(toolChange);

  const dayCost = (await store.sumUsage(s.athleteId, localDayStartIso(now, tz))).costUsd;
  const monthCost = (await store.sumUsage(s.athleteId, localMonthStartIso(now, tz))).costUsd;
  const b = s.settings.budgets;
  lines.push(`budget: $${dayCost.toFixed(2)} of $${b.dailyUsd.toFixed(2)} today · $${monthCost.toFixed(2)} of $${b.monthlyUsd.toFixed(2)} this month${monthCost >= 0.8 * b.monthlyUsd || dayCost >= 0.8 * b.dailyUsd ? ' — over 80%: be economical' : ''}`);
  lines.push(`turn step limit: ${s.limits.maxSteps}`);

  lines.push(await sinceLastTurn(core, s, now));

  const views = await store.getCurrentUiVersions(s.athleteId);
  const sources = await readUiManifests(core.paths(s.athleteId).workspace).catch(() => undefined);
  // A published view whose source is gone from ui/views/ stays published until rolled back or replaced: say so.
  const label = (id: string) => (sources && !sources.views[id] ? ' (no longer in ui/views/)' : '');
  lines.push(`app views published: ${views.length ? views.map((v) => `${v.viewId} v${v.version}${label(v.viewId)}`).join(', ') : 'none'}`);

  if (s.safety?.flagged) {
    lines.push(
      `SAFETY: the harness flagged a possible ${s.safety.categories.join(', ')} signal${s.safety.acute ? ' (possibly happening now)' : ''} in the athlete's message. Apply the safety protocol in your constitution. The athlete is also being shown an emergency-guidance banner.`,
    );
  }
  for (const x of s.extra ?? []) lines.push(x);
  return `<situation>\n${lines.join('\n')}\n</situation>`;
}

/**
 * Tools the coach gained or lost since its previous turn (an operator configured search, a service went away).
 * Without it, a note the coach wrote about the old set would quietly outrank the new tool list.
 */
async function toolsChanged(core: Core, athleteId: string): Promise<string | undefined> {
  // What the server offers, not this turn's grant: consolidation, for one, never gets the messaging tools.
  const unavailable = unavailableTools(core, athleteId);
  const tools = COACH_TOOLS.filter((t) => !unavailable.has(t));
  const key = `tools-seen:${athleteId}`;
  let previous = await core.store.getKv(key);
  // On the first upgrade that introduced this ledger, use the last observed situation rather than
  // silently treating an existing coach as new. In particular, newly enabled search must not go unannounced.
  if (previous === undefined) {
    const last = (await core.store.listTurns({ athleteId, agent: 'coach', limit: 20 })).find(t => t.steps > 0);
    const context = last ? await core.store.getTurnContext(last.id) as { items?: Array<{ kind?: string; text?: string }> } | undefined : undefined;
    const report = context?.items?.filter(i => i.kind === 'harness' && i.text?.startsWith('<situation>')).at(-1)?.text;
    const line = report?.match(/^tools: (.+)$/m)?.[1];
    if (line) {
      const missing = new Set((line.split(' · not available on this server: ')[1] ?? '').split(', ').filter(Boolean));
      previous = COACH_TOOLS.filter(t => !missing.has(t)).sort().join(',');
    }
  }
  const current = [...tools].sort().join(',');
  if (previous === current) return undefined;
  await core.store.setKv(key, current);
  if (previous === undefined) return undefined;
  const before = new Set(previous.split(',').filter(Boolean));
  const added = tools.filter((t) => !before.has(t));
  const removed = [...before].filter((t) => !tools.includes(t as ToolName));
  if (!added.length && !removed.length) return undefined;
  return `tools changed since your last turn: ${[added.length ? `now available ${added.join(', ')}` : '', removed.length ? `no longer available ${removed.join(', ')}` : ''].filter(Boolean).join(' · ')}`;
}

/** Event types that don't wake the coach, so they would otherwise go unseen until the coach goes looking. */
const QUIET_ATHLETE_TYPES = ['user.ui_write', 'user.ui_action', 'user.reaction', 'user.read', 'user.settings_changed', 'user.message_deleted'] as const;

/**
 * What the athlete did that didn't wake the coach, since its previous turn ended: app writes, quiet taps, reactions,
 * reads, settings. Facts only; with it the coach doesn't have to re-query everything to learn that nothing changed.
 */
async function sinceLastTurn(core: Core, s: SituationInput, now: Date): Promise<string> {
  const previous = (await core.store.listTurns({ athleteId: s.athleteId, agent: 'coach', limit: 5 })).find((t) => t.endedAt);
  if (!previous?.endedAt) return 'since your last turn: this is your first turn';
  const triggerIds = new Set(s.triggers.map((t) => t.id));
  const events = (await core.store.listEvents({ athleteId: s.athleteId, types: QUIET_ATHLETE_TYPES, since: previous.endedAt, order: 'asc', limit: 500 })).filter((e) => !triggerIds.has(e.id));
  const writes = new Map<string, number>();
  const settings = new Set<string>();
  let taps = 0, reactions = 0, reads = 0, deleted = 0;
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'user.ui_write') {
      const key = `${String(p['viewId'])} → ${String(p['target'])}`;
      writes.set(key, (writes.get(key) ?? 0) + 1);
    } else if (e.type === 'user.ui_action') taps += 1;
    else if (e.type === 'user.reaction') reactions += 1;
    else if (e.type === 'user.read') reads += Array.isArray(p['messageIds']) ? p['messageIds'].length : 1;
    else if (e.type === 'user.settings_changed') for (const k of Object.keys((p['diff'] as object | undefined) ?? {})) settings.add(k.split('.')[0]!);
    else if (e.type === 'user.message_deleted') deleted += 1;
  }
  const parts = [
    writes.size ? `app writes ${[...writes].map(([k, n]) => `${k} ×${n}`).join(', ')}` : '',
    taps ? `${taps} quiet tap(s)` : '',
    reactions ? `${reactions} reaction(s)` : '',
    reads ? `read ${reads} of your messages` : '',
    settings.size ? `changed settings (${[...settings].join(', ')})` : '',
    deleted ? `deleted ${deleted} message(s)` : '',
  ].filter(Boolean);
  const when = formatLocal(previous.endedAt, s.settings.profile.tz);
  return `since your last turn (ended ${when}, ${ago(previous.endedAt, now)}), athlete activity that didn't wake you: ${parts.length ? parts.join(' · ') : 'none'}`;
}
