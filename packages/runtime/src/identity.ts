import { ToolError, ZERO_USAGE, type BlobRef, type TriggerClass } from '@opencoach/protocol';
import { prepareCoachAvatar } from '@opencoach/workspace';
import { createHash } from 'node:crypto';
import type { Core } from './core';
import { localDayStartIso, localMonthStartIso } from './time';

const imageLocks = new WeakMap<Core, Map<string, Promise<unknown>>>();

export async function requireIdentityPermission(core: Core, athleteId: string, cls: TriggerClass): Promise<void> {
  const settings = await core.settings(athleteId);
  if (!settings.coachIdentity.allowChanges) throw new ToolError('NOT_ALLOWED', 'The athlete has not enabled coach name/avatar changes in Settings → Profile. Ask only if they requested personalization; never enable it yourself.');
  if (cls !== 'reactive') throw new ToolError('NOT_ALLOWED', 'Coach identity and image tools are for athlete-requested chat turns, not automatic check-ins or consolidation.');
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
export async function generateImage(core: Core, athleteId: string, turnId: string, callId: string, cls: TriggerClass, prompt: string, signal: AbortSignal): Promise<BlobRef> {
  let locks = imageLocks.get(core);
  if (!locks) { locks = new Map(); imageLocks.set(core, locks); }
  const previous = locks.get(athleteId) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    await requireIdentityPermission(core, athleteId, cls);
    const provider = core.deps.imageProvider;
    const config = core.config.imageGeneration;
    if (!provider || !config) throw new ToolError('NOT_CONFIGURED', 'Image generation has no configured provider. This is separate from chat model vision; naming still works.');
    const attemptKey = `image-attempt:${athleteId}:${turnId}:${callId}`;
    const prior = await core.store.getKv(attemptKey);
    if (prior) {
      const state = JSON.parse(prior) as { blob?: BlobRef };
      if (state.blob) return state.blob;
      throw new ToolError('LIMIT', 'This image attempt already started; its billing/result is uncertain. Do not repeat it automatically.');
    }
    const settings = await core.settings(athleteId);
    const now = core.clock.now();
    const day = (await core.store.sumUsage(athleteId, localDayStartIso(now, settings.profile.tz))).costUsd;
    const month = (await core.store.sumUsage(athleteId, localMonthStartIso(now, settings.profile.tz))).costUsd;
    const cost = config.costPerImageUsd;
    if (day >= settings.budgets.dailyUsd || month >= settings.budgets.monthlyUsd || day + cost > settings.budgets.dailyUsd || month + cost > settings.budgets.monthlyUsd) {
      throw new ToolError('LIMIT', 'Image generation would exceed the athlete’s daily or monthly AI budget.');
    }
    await core.store.setKv(attemptKey, JSON.stringify({ startedAt: now.toISOString() }));
    // Reserve a conservative attempt cost before dispatch. Never hide uncertain charges on abort/failure.
    await core.store.recordUsage({ athleteId, turnId, at: now.toISOString(), provider: provider.id, model: provider.model, kind: 'image', usage: { ...ZERO_USAGE }, costUsd: cost });
    const result = await provider.generate(prompt, signal);
    signal.throwIfAborted();
    await requireIdentityPermission(core, athleteId, cls); // permission may have been revoked during the request
    let image: Uint8Array;
    try { image = await prepareCoachAvatar(result.data); }
    catch { throw new ToolError('INVALID_INPUT', 'Provider returned an invalid raster image; no avatar changed.'); }
    const stored = await core.deps.blobs.put(athleteId, image, { mime: 'image/png', name: 'generated-image.png', origin: 'coach', extra: { provider: provider.id, model: provider.model, generatedAt: core.clock.now().toISOString() } });
    const blob = { sha256: stored.sha256, mime: stored.mime, bytes: stored.bytes, name: stored.name };
    await core.store.setKv(attemptKey, JSON.stringify({ blob }));
    return blob;
  });
  const settled = job.catch(() => {});
  locks.set(athleteId, settled);
  void settled.then(() => { if (locks!.get(athleteId) === settled) locks!.delete(athleteId); });
  return job;
}
