import type { AnyEvent, AthleteSettings, ResolvedModel, SafetyScreenResult, ToolName, TriggerClass } from '@opencoach/protocol';
import { capabilityLines } from './capabilities';
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
  nudge?: string;
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

  const [lastAthlete] = await store.listEvents({ athleteId: s.athleteId, types: ['user.message', 'user.upload', 'user.voice_note'], order: 'desc', limit: 1 });
  const unread = await store.countUnreadCoachMessages(s.athleteId);
  lines.push(`last athlete message: ${ago(lastAthlete?.ts, now)} · your unread messages: ${unread}`);

  const n = s.settings.notifications;
  const held = (await store.listHeldMessages(s.athleteId)).length;
  const today = (await store.countProactiveSince(s.athleteId, localDayStartIso(now, tz))) + held;
  const week = (await store.countProactiveSince(s.athleteId, new Date(now.getTime() - 7 * 86_400_000).toISOString())) + held;
  const quietEnd = quietHoursEnd(now, tz, n.quietHours);
  const quiet = n.quietHours
    ? `quiet hours ${n.quietHours.start}–${n.quietHours.end}${quietEnd ? ` (ACTIVE: proactive messages are held until ${formatLocal(quietEnd, tz).slice(11, 16)})` : ''}`
    : 'no quiet hours';
  const paused = n.pauseUntil && new Date(n.pauseUntil).getTime() > now.getTime() ? ` · coaching PAUSED by the athlete until ${formatLocal(n.pauseUntil, tz)}` : '';
  lines.push(`proactive messages left: ${Math.max(0, n.proactivePerDay - today)}/${n.proactivePerDay} today, ${Math.max(0, n.proactivePerWeek - week)}/${n.proactivePerWeek} this week · ${quiet}${held ? ` · ${held} held message(s) pending` : ''}${paused}`);

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
  lines.push(...capabilityLines(core, s.settings, s.model, s.tools));

  const dayCost = (await store.sumUsage(s.athleteId, localDayStartIso(now, tz))).costUsd;
  const monthCost = (await store.sumUsage(s.athleteId, localMonthStartIso(now, tz))).costUsd;
  const b = s.settings.budgets;
  lines.push(`budget: $${dayCost.toFixed(2)} of $${b.dailyUsd.toFixed(2)} today · $${monthCost.toFixed(2)} of $${b.monthlyUsd.toFixed(2)} this month${monthCost >= 0.8 * b.monthlyUsd || dayCost >= 0.8 * b.dailyUsd ? ' — over 80%: be economical' : ''}`);
  lines.push(`turn limits: ${s.limits.maxSteps} steps, ${Math.round(s.limits.maxWallMs / 60_000)} min`);

  const views = await store.getCurrentUiVersions(s.athleteId);
  lines.push(`app views published: ${views.length ? views.map((v) => `${v.viewId} v${v.version}`).join(', ') : 'none'}`);

  if (s.safety?.flagged) {
    lines.push(
      `SAFETY: the harness flagged a possible ${s.safety.categories.join(', ')} signal${s.safety.acute ? ' (possibly happening now)' : ''} in the athlete's message. Apply the safety protocol in your constitution. The athlete is also being shown an emergency-guidance banner.`,
    );
  }
  if (s.nudge) lines.push(`reminder: ${s.nudge}`);
  for (const x of s.extra ?? []) lines.push(x);
  return `<situation>\n${lines.join('\n')}\n</situation>`;
}
