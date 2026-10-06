import { estimateTokens, newId, type ConvItem, type EpochRecord, type ResolvedModel, type SystemBlock } from '@opencoach/protocol';
import { listSkills, readPinnedList } from '@opencoach/workspace';
import type { Core } from './core';
import { epochDate } from './time';

/**
 * Context layers (SPEC §5.3): L0 constitution, L2 skills index, L3 pinned memory, L4 briefing
 * (+ compaction carryover) form the epoch's FROZEN system prompt; L5 is the append-only epoch
 * transcript; L6 (situation report) is appended per turn by the turn runner.
 */

export interface EpochState {
  epoch: EpochRecord;
  system: SystemBlock[];
  pinned: PinnedReport;
  items: ConvItem[];
  opened: boolean;
}

export interface PinnedReport {
  tokens: number;
  cap: number;
  truncated: string[];
  missing: string[];
}

interface StoredSystem {
  system: SystemBlock[];
  pinned: PinnedReport;
}

const SYSTEM_KEY = (epochId: string) => `epoch-system:${epochId}`;

export async function renderConstitution(core: Core, athleteId: string): Promise<string> {
  const settings = await core.store.getSettings(athleteId);
  const raw = await core.readSystemFile('constitution.md');
  return fill(raw, {
    coach_name: settings.profile.coachName,
    athlete_name: settings.profile.name,
    harness_version: core.harnessVersion,
    pack_version: core.pack.version,
  });
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

async function buildSystem(core: Core, athleteId: string, carryover?: string): Promise<StoredSystem> {
  const paths = core.paths(athleteId);
  const fs = core.fsFor(athleteId);
  const cfg = core.config.limits;

  const constitution = await renderConstitution(core, athleteId);

  // L2: skills index
  let skillsText = '';
  try {
    const skills = await listSkills({ systemDir: core.systemDir, workspaceDir: paths.workspace });
    skillsText = skills.length
      ? skills.map((s) => `- ${s.name} (${s.source}): ${s.description} → ${s.path}`).join('\n')
      : '(no skills found)';
  } catch (e) {
    skillsText = `(could not list skills: ${(e as Error).message})`;
  }

  // L3: pinned memory
  const pinned: PinnedReport = { tokens: 0, cap: cfg.pinnedTokenCap, truncated: [], missing: [] };
  const pinnedParts: string[] = [];
  let list: string[] = [];
  try {
    list = await readPinnedList(paths.workspace);
  } catch {
    list = [];
  }
  if (!list.includes('AGENTS.md')) list = ['AGENTS.md', ...list];
  for (const rel of list) {
    const vpath = rel.startsWith('/') ? rel : `/workspace/${rel}`;
    let text: string;
    try {
      text = await fs.readText(vpath);
    } catch {
      pinned.missing.push(vpath);
      continue;
    }
    const t = estimateTokens(text) + 10;
    if (pinned.tokens + t > pinned.cap) {
      const remaining = Math.max(0, pinned.cap - pinned.tokens);
      if (remaining > 200) {
        const chars = Math.floor(remaining * 3.6);
        pinnedParts.push(`### ${vpath} (TRUNCATED to fit the pinned-context cap)\n${text.slice(0, chars)}`);
        pinned.tokens += remaining;
      }
      pinned.truncated.push(vpath);
      continue;
    }
    pinnedParts.push(`### ${vpath}\n${text.trim()}`);
    pinned.tokens += t;
  }

  // L4: briefing (+ carryover)
  let briefing = '';
  try {
    briefing = (await fs.readText('/workspace/briefing.md')).trim();
  } catch {
    briefing = '';
  }
  const briefingCapChars = Math.floor(cfg.briefingTokenCap * 3.6);
  if (briefing.length > briefingCapChars) briefing = `${briefing.slice(0, briefingCapChars)}\n[briefing truncated to the cap]`;

  const workspaceBlock = [
    '# Your workspace at the start of this context',
    'These files were loaded when this context began (they are a snapshot; read the live files if you have changed them since).',
    '',
    '## Skills available (read a SKILL.md when relevant)',
    skillsText,
    '',
    '## Pinned files',
    pinnedParts.join('\n\n') || '(none)',
    '',
    '## Your briefing for today (briefing.md)',
    briefing || '(empty — no consolidation has run yet)',
    ...(carryover ? ['', '## Earlier today (summary carried over from the previous context)', carryover] : []),
  ].join('\n');

  return {
    system: [
      { text: constitution, cache: true },
      { text: workspaceBlock, cache: true },
    ],
    pinned,
  };
}

export type EpochCloseReason = NonNullable<EpochRecord['closeReason']>;

/**
 * Get the athlete's current epoch, opening a new one when needed (no open epoch, day boundary passed,
 * model/provider changed, or the previous one was closed for compaction/forced).
 */
export async function ensureEpoch(core: Core, athleteId: string, model: ResolvedModel): Promise<EpochState> {
  const settings = await core.store.getSettings(athleteId);
  const now = core.clock.now();
  const date = epochDate(now, settings.profile.tz, settings.epoch.dayBoundary);
  const open = await core.store.getOpenEpoch(athleteId);

  if (open) {
    let reason: EpochCloseReason | null = null;
    if (open.localDate !== date) reason = 'day_boundary';
    else if (open.provider !== model.provider.id || open.model !== model.model) reason = 'model_change';
    if (!reason) {
      const stored = await loadSystem(core, open.id);
      if (stored) {
        const items = (await core.store.listEpochItems(open.id)).map((r) => r.item);
        return { epoch: open, system: stored.system, pinned: stored.pinned, items, opened: false };
      }
      reason = 'error';
    }
    await core.store.closeEpoch(open.id, reason, now.toISOString());
  }

  // carryover from an epoch closed by compaction earlier the same local day
  const recent = await core.store.listEpochs(athleteId, 1);
  const prev = recent[0];
  const sameDay = prev && prev.localDate === date;
  const carryover = sameDay && prev.closeReason === 'compaction' ? prev.carryover : undefined;
  const seq = sameDay ? prev.seq + 1 : 1;

  const built = await buildSystem(core, athleteId, carryover);
  const epoch: EpochRecord = {
    id: newId('ep', core.clock),
    athleteId,
    localDate: date,
    seq,
    provider: model.provider.id,
    model: model.model,
    openedAt: now.toISOString(),
  };
  await core.store.createEpoch(epoch);
  await core.store.setKv(SYSTEM_KEY(epoch.id), JSON.stringify(built));
  return { epoch, system: built.system, pinned: built.pinned, items: [], opened: true };
}

async function loadSystem(core: Core, epochId: string): Promise<StoredSystem | undefined> {
  const raw = await core.store.getKv(SYSTEM_KEY(epochId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredSystem;
  } catch {
    return undefined;
  }
}

export async function closeOpenEpoch(core: Core, athleteId: string, reason: EpochCloseReason, carryover?: string): Promise<void> {
  const open = await core.store.getOpenEpoch(athleteId);
  if (open) await core.store.closeEpoch(open.id, reason, core.clock.now().toISOString(), carryover);
}

/** Total tokens currently in the epoch (system + items), estimated. */
export function epochTokens(state: { system: SystemBlock[]; items: ConvItem[] }): number {
  return estimateTokens(state.system) + estimateTokens(state.items);
}
