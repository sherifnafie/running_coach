import { ToolError, ZERO_USAGE, type BlobRef, type GeneratedImage, type ImageProvider, type TriggerClass } from '@opencoach/protocol';
import { prepareCoachAvatar } from '@opencoach/workspace';
import { createHash } from 'node:crypto';
import type { Core } from './core';
import { localDayStartIso, localMonthStartIso } from './time';

const imageLocks = new WeakMap<Core, Map<string, Promise<unknown>>>();

export function imageProviderFor(core: Core, athleteId: string): ImageProvider | undefined {
  return core.deps.imageProviderFor?.(athleteId) ?? core.deps.imageProvider;
}

export async function requireImagePermission(core: Core, athleteId: string, cls: TriggerClass): Promise<void> {
  const settings = await core.settings(athleteId);
  if (settings.images.mode === 'off' || settings.images.monthlyUsd === 0) throw new ToolError('NOT_ALLOWED', 'Image generation is off in Settings → Images. The coach cannot change this permission or allowance.');
  if (cls === 'consolidation' || (cls !== 'reactive' && settings.images.mode !== 'automatic')) {
    throw new ToolError('NOT_ALLOWED', 'This image permission allows requested chat images only. Automatic images require the athlete’s Images setting; consolidation cannot generate images.');
  }
  const pause = settings.notifications.pauseUntil;
  if (cls !== 'reactive' && pause && new Date(pause).getTime() > core.clock.now().getTime()) throw new ToolError('NOT_ALLOWED', 'Automatic image generation is paused with coach outreach.');
}

async function workspaceImage(core: Core, athleteId: string, blob: BlobRef, costs?: { reservedCostUsd?: number; reportedCostUsd?: number }): Promise<GeneratedImage> {
  const workspacePath = `/workspace/exports/images/${blob.sha256}.png`;
  await core.fsFor(athleteId).writeFile(workspacePath, await core.deps.blobs.read(athleteId, blob.sha256));
  const record = await core.store.getBlob(athleteId, blob.sha256);
  const reserved = costs?.reservedCostUsd ?? record?.meta?.reservedCostUsd;
  const reported = costs ? costs.reportedCostUsd : record?.meta?.reportedCostUsd;
  return { ...blob, workspacePath,
    ...(typeof reserved === 'number' ? { reservedCostUsd: reserved } : {}),
    ...(typeof reported === 'number' ? { reportedCostUsd: reported } : {}),
  };
}

export async function requireIdentityPermission(core: Core, athleteId: string, cls: TriggerClass): Promise<void> {
  const settings = await core.settings(athleteId);
  if (!settings.coachIdentity.allowChanges) throw new ToolError('NOT_ALLOWED', 'The athlete has not enabled coach name/avatar changes in Settings → Profile. Ask only if they requested personalization; never enable it yourself.');
  if (cls !== 'reactive') throw new ToolError('NOT_ALLOWED', 'Coach identity changes are for athlete-requested chat turns, not automatic check-ins or consolidation.');
}

/** Owned blobs only; no external image URLs or arbitrary sandbox paths [SEC-4]. */
export async function avatarFor(core: Core, athleteId: string, sha: string | null): Promise<string | null> {
  if (sha === null) return null;
  const blob = await core.store.getBlob(athleteId, sha);
  if (!blob || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.mime)) throw new ToolError('INVALID_INPUT', 'Avatar must reference a PNG, JPEG or WebP blob owned by this athlete.');
  let image: Uint8Array;
  try { image = await prepareCoachAvatar(await core.deps.blobs.read(athleteId, sha)); }
  catch { throw new ToolError('INVALID_INPUT', 'Avatar could not be decoded as a safe still raster image.'); }
  if (blob.mime === 'image/png' && createHash('sha256').update(image).digest('hex') === sha) return sha; // retain original generation provenance
  const stored = await core.deps.blobs.put(athleteId, image, { mime: 'image/png', name: 'coach-avatar.png', origin: 'coach', extra: { purpose: 'coach-avatar', sourceBlob: sha } });
  return stored.sha256;
}

/** Serialize attempts so concurrent calls cannot race the image budget [COST-1] [RT-6]. */
export async function generateImage(core: Core, athleteId: string, turnId: string, callId: string, cls: TriggerClass, prompt: string, signal: AbortSignal): Promise<GeneratedImage> {
  let locks = imageLocks.get(core);
  if (!locks) { locks = new Map(); imageLocks.set(core, locks); }
  const previous = locks.get(athleteId) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    await requireImagePermission(core, athleteId, cls);
    const provider = imageProviderFor(core, athleteId);
    const config = core.config.imageGeneration;
    if (!provider || !config) throw new ToolError('NOT_CONFIGURED', 'Image generation has no configured provider. This is separate from chat model vision; naming still works.');
    const attemptKey = `image-attempt:${athleteId}:${turnId}:${callId}`;
    const prior = await core.store.getKv(attemptKey);
    if (prior) {
      const state = JSON.parse(prior) as { blob?: BlobRef; reservedCostUsd?: number; reportedCostUsd?: number };
      if (state.blob) return workspaceImage(core, athleteId, state.blob, state.reservedCostUsd === undefined ? undefined : state);
      throw new ToolError('LIMIT', 'This image attempt already started; its billing/result is uncertain. Do not repeat it automatically.');
    }
    const settings = await core.settings(athleteId);
    const now = core.clock.now();
    const day = (await core.store.sumUsage(athleteId, localDayStartIso(now, settings.profile.tz))).costUsd;
    const month = (await core.store.sumUsage(athleteId, localMonthStartIso(now, settings.profile.tz))).costUsd;
    if (day >= settings.budgets.dailyUsd || month >= settings.budgets.monthlyUsd) throw new ToolError('LIMIT', 'The athlete’s daily or monthly AI budget is exhausted.');
    // Validate the writable parent before any external dispatch; materialization
    // later goes through the same jail and cannot follow an escaping symlink.
    core.fsFor(athleteId).resolve('exports/images/.write-check', 'write');
    const imageMonth = (await core.store.sumUsage(athleteId, localMonthStartIso(now, settings.profile.tz), 'image')).costUsd;
    if (imageMonth >= settings.images.monthlyUsd) throw new ToolError('LIMIT', 'The athlete’s monthly image allowance is exhausted.');
    const quote = await provider.quote?.(signal, prompt);
    const cost = quote?.costUsd ?? config.costPerImageUsd;
    if (!Number.isFinite(cost) || cost < 0 || cost > config.costPerImageUsd) throw new ToolError('LIMIT', 'Image quote exceeds the configured per-image ceiling.');
    // A public pricing request can take time. Re-read limits, usage and credential
    // binding before reserving money, including an athlete's mid-request changes.
    await requireImagePermission(core, athleteId, cls);
    if (imageProviderFor(core, athleteId) !== provider) throw new ToolError('NOT_ALLOWED', 'Image credentials changed before dispatch. No generation was sent.');
    const current = await core.settings(athleteId);
    const reservedAt = core.clock.now();
    const [currentDay, currentMonth, currentImages] = await Promise.all([
      core.store.sumUsage(athleteId, localDayStartIso(reservedAt, current.profile.tz)),
      core.store.sumUsage(athleteId, localMonthStartIso(reservedAt, current.profile.tz)),
      core.store.sumUsage(athleteId, localMonthStartIso(reservedAt, current.profile.tz), 'image'),
    ]);
    if (currentImages.costUsd + cost > current.images.monthlyUsd) throw new ToolError('LIMIT', 'Image generation would exceed the athlete’s monthly image allowance.');
    if (currentDay.costUsd + cost > current.budgets.dailyUsd || currentMonth.costUsd + cost > current.budgets.monthlyUsd) {
      throw new ToolError('LIMIT', 'Image generation would exceed the athlete’s daily or monthly AI budget.');
    }
    signal.throwIfAborted();
    await core.store.setKv(attemptKey, JSON.stringify({ startedAt: reservedAt.toISOString() }));
    // Reserve a conservative attempt cost before dispatch. Never hide uncertain charges on abort/failure.
    await core.store.recordUsage({ athleteId, turnId, at: reservedAt.toISOString(), provider: provider.id, model: provider.model, kind: 'image', usage: { ...ZERO_USAGE }, costUsd: cost });
    await requireImagePermission(core, athleteId, cls);
    const result = await provider.generate(prompt, signal, quote);
    const reportedCost = typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : undefined;
    if (reportedCost !== undefined && reportedCost > cost) {
      await core.store.recordUsage({ athleteId, turnId, at: core.clock.now().toISOString(), provider: provider.id, model: provider.model, kind: 'image', usage: { ...ZERO_USAGE }, costUsd: reportedCost - cost });
      core.log.warn('Image charge exceeded its reserved estimate', { provider: provider.id, model: provider.model, reservedCostUsd: cost, reportedCostUsd: reportedCost });
    }
    signal.throwIfAborted();
    await requireImagePermission(core, athleteId, cls); // permission may have been revoked during the request
    let image: Uint8Array;
    try { image = await prepareCoachAvatar(result.data); }
    catch { throw new ToolError('INVALID_INPUT', 'Provider returned an invalid raster image; no avatar changed.'); }
    const stored = await core.deps.blobs.put(athleteId, image, { mime: 'image/png', name: 'generated-image.png', origin: 'coach', extra: { provider: provider.id, model: provider.model, generatedAt: core.clock.now().toISOString(), reservedCostUsd: cost, ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost }) } });
    const blob = { sha256: stored.sha256, mime: stored.mime, bytes: stored.bytes, name: stored.name };
    const receipt = { blob, reservedCostUsd: cost, ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost }) };
    await core.store.setKv(attemptKey, JSON.stringify(receipt));
    return workspaceImage(core, athleteId, blob, receipt);
  });
  const settled = job.catch(() => {});
  locks.set(athleteId, settled);
  void settled.then(() => { if (locks!.get(athleteId) === settled) locks!.delete(athleteId); });
  return job;
}
