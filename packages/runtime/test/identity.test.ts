import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZERO_USAGE, type ImageProvider, type TriggerClass } from '@opencoach/protocol';
import { createExecutor } from '../src/executor';
import { generateImage } from '../src/identity';
import { makeHarness, type Harness } from './harness';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgWBUKQhAKABqeA/24RcKwAAAAAElFTkSuQmCC', 'base64');
const athlete = { displayName: 'Sam', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false };
const config = { imageGeneration: { provider: 'google', model: 'test-image', apiKeyEnv: 'IMAGE_KEY', costPerImageUsd: .2 } };
let h: Harness;
afterEach(async () => { await h?.close(); });
function executor(id: string, kind: 'coach' | 'helper' = 'coach', cls: TriggerClass = 'reactive') {
  return createExecutor(h.runtime.core, { athleteId: id, turnId: 'identity-test', triggerClass: cls,
    agent: { kind, depth: kind === 'coach' ? 0 : 1 }, tools: ['set_preferences', 'generate_image'],
    fs: h.runtime.core.fsFor(id), sandbox: { exec: async () => { throw new Error('No shell'); } }, vision: false });
}
const call = (id: string, name: string, input: unknown) => ({ id, name, input, type: 'tool_call' as const });
const signal = () => new AbortController().signal;

describe('[UI-1] [SEC-1] [COST-1] optional coach identity', () => {
  it('requires athlete opt-in, refuses self-grants and blocks helpers/automatic turns', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockResolvedValue({ data: png, mime: 'image/png' });
    h = await makeHarness({ config, imageProvider: { id: 'google', model: 'test-image', generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    const e = executor(id);
    await h.runtime.updateSettings(id, { images: { mode: 'off' } });
    expect((await e.execute(call('disabled', 'set_preferences', { coach_name: 'Kip' }), signal())).isError).toBe(true);
    expect((await e.execute(call('self-grant', 'set_preferences', { allowChanges: true, coach_name: 'Kip' }), signal())).isError).toBe(true);
    expect((await e.execute(call('disabled-img', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true }, images: { mode: 'requested' } });
    expect((await executor(id, 'helper').execute(call('helper', 'set_preferences', { coach_name: 'Kip' }), signal())).isError).toBe(true);
    expect((await executor(id, 'helper').execute(call('helper-img', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect((await executor(id, 'coach', 'scheduled').execute(call('scheduled', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it('separates image permission from identity, enables allowed automatic images and persists a readable private asset', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockResolvedValue({ data: png, mime: 'image/png' });
    h = await makeHarness({ config, imageProvider: { id: 'google', model: 'test-image', generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    const other = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { images: { mode: 'automatic', monthlyUsd: 1 } });
    const automatic = executor(id, 'coach', 'scheduled');
    expect((await automatic.execute(call('automatic', 'generate_image', { prompt: 'A tiny medal' }), signal())).isError).toBe(false);
    const blob = (await h.runtime.core.store.listBlobs(id))[0]!;
    const path = `/workspace/exports/images/${blob.sha256}.png`;
    expect(Buffer.from(await h.runtime.core.fsFor(id).readFile(path))).toEqual(Buffer.from(await h.runtime.core.deps.blobs.read(id, blob.sha256)));
    expect(await h.runtime.core.fsFor(other.id).stat(path)).toBeNull();
    expect((await h.runtime.core.settings(id)).coachIdentity).toMatchObject({ allowChanges: false, avatarSha256: null });
    expect((await automatic.execute(call('self-grant-images', 'set_preferences', { images: { mode: 'automatic', monthlyUsd: 10 } }), signal())).isError).toBe(true);
    expect((await executor(id, 'coach', 'consolidation').execute(call('overnight', 'generate_image', { prompt: 'A medal' }), signal())).isError).toBe(true);
    await h.runtime.updateSettings(id, { notifications: { pauseUntil: '2027-01-01T00:00:00Z' } });
    expect((await automatic.execute(call('paused', 'generate_image', { prompt: 'A medal' }), signal())).isError).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('uses the image-only monthly allowance without charging ordinary model usage to it', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockResolvedValue({ data: png, mime: 'image/png' });
    const quote = vi.fn<NonNullable<ImageProvider['quote']>>().mockResolvedValue({ costUsd: .007, provider: 'recraft' });
    h = await makeHarness({ config: { imageGeneration: { provider: 'openrouter' } }, imageProvider: { id: 'openrouter', model: 'fixture', quote, generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { images: { monthlyUsd: .01 } });
    await h.runtime.core.store.recordUsage({ athleteId: id, at: h.runtime.core.clock.now().toISOString(), provider: 'fixture', model: 'fixture', kind: 'turn', costUsd: .15, usage: { ...ZERO_USAGE } });
    const e = executor(id);
    expect((await e.execute(call('cheap', 'generate_image', { prompt: 'A small medal' }), signal())).isError).toBe(false);
    expect((await e.execute(call('too-many', 'generate_image', { prompt: 'Another medal' }), signal())).isError).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await h.runtime.core.store.sumUsage(id, '2026-10-01T00:00:00Z', 'image')).costUsd).toBe(.007);
  });

  it('honors a budget reduction during price preflight before reserving or generating', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockResolvedValue({ data: png, mime: 'image/png' });
    h = await makeHarness({ config: { imageGeneration: { provider: 'openrouter' } }, imageProvider: { id: 'openrouter', model: 'fixture', generate,
      quote: async () => { await h.runtime.updateSettings(id, { images: { monthlyUsd: .001 } }); return { costUsd: .007, provider: 'fixture' }; },
    } });
    const { id } = await h.runtime.createAthlete(athlete);
    expect((await executor(id).execute(call('reduced', 'generate_image', { prompt: 'A medal' }), signal())).isError).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect((await h.runtime.core.store.sumUsage(id, '2026-10-01T00:00:00Z', 'image')).costUsd).toBe(0);
  });

  it('can rename with no image provider, refreshes settings, and respects later revocation', async () => {
    h = await makeHarness();
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true } });
    const e = executor(id);
    const rename = await e.execute(call('name', 'set_preferences', { coach_name: 'Kip' }), signal());
    expect(rename.isError).toBe(false);
    expect((await h.runtime.core.settings(id)).profile.coachName).toBe('Kip');
    expect(h.stream.some(m => m.t === 'settings.changed')).toBe(true);
    const missing = await e.execute(call('missing', 'generate_image', { prompt: 'A mascot' }), signal());
    expect(JSON.stringify(missing)).toContain('NOT_CONFIGURED');
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: false } });
    expect((await e.execute(call('revoked', 'set_preferences', { coach_name: 'Other' }), signal())).isError).toBe(true);
    expect((await h.runtime.core.settings(id)).profile.coachName).toBe('Kip');
  });

  it('generates a private preview, applies separately, preserves ownership and replays once [RT-6]', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockResolvedValue({ data: png, mime: 'image/png' });
    h = await makeHarness({ config, imageProvider: { id: 'google', model: 'test-image', generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    const other = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true } });
    const e = executor(id);
    const request = call('image', 'generate_image', { prompt: 'A friendly running mascot' });
    const [image, replay] = await Promise.all([e.execute(request, signal()), e.execute(request, signal())]);
    expect(image.isError).toBe(false); expect(replay).toEqual(image);
    expect(generate).toHaveBeenCalledTimes(1);
    const blobs = await h.runtime.core.store.listBlobs(id);
    const sha = blobs[0]!.sha256;
    expect(blobs[0]!.mime).toBe('image/png');
    expect((await h.runtime.core.settings(id)).coachIdentity.avatarSha256).toBeNull();
    expect(await h.runtime.core.store.getBlob(other.id, sha)).toBeUndefined();
    expect((await h.runtime.core.store.sumUsage(id, '2026-10-01T00:00:00Z')).costUsd).toBe(.2);
    expect((await e.execute(call('apply', 'set_preferences', { coach_name: 'Kip', coach_avatar_sha256: sha }), signal())).isError).toBe(false);
    expect((await h.runtime.core.settings(id)).coachIdentity.avatarSha256).toBe(sha);
    await expect(h.runtime.updateSettings(other.id, { coachIdentity: { avatarSha256: sha } })).rejects.toThrow('owned');
    expect((await e.execute(call('reset', 'set_preferences', { coach_avatar_sha256: null }), signal())).isError).toBe(false);
    expect((await h.runtime.core.settings(id)).coachIdentity.avatarSha256).toBeNull();
  });

  it('reserves image attempt costs, enforces budgets and does not repeat uncertain attempts', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockRejectedValue(new Error('fixture failed'));
    h = await makeHarness({ config, imageProvider: { id: 'google', model: 'test-image', generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true }, budgets: { dailyUsd: .3 } });
    const e = executor(id);
    // Simulate an interrupted executor before it could save a final replay result.
    await expect(generateImage(h.runtime.core, id, 'identity-test', 'failed', 'reactive', 'A mascot', signal())).rejects.toThrow('fixture failed');
    expect((await executor(id).execute(call('failed', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect((await e.execute(call('over-budget', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await h.runtime.core.store.sumUsage(id, '2026-10-01T00:00:00Z')).costUsd).toBe(.2);
  });

  it('does not apply malformed output or a revoked in-flight generation', async () => {
    const generate = vi.fn<ImageProvider['generate']>();
    h = await makeHarness({ config, imageProvider: { id: 'google', model: 'test-image', generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true }, images: { monthlyUsd: 1 } });
    generate.mockResolvedValueOnce({ data: Buffer.from('<svg/>'), mime: 'image/png' });
    const e = executor(id);
    expect((await e.execute(call('malformed', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    generate.mockImplementationOnce(async () => {
      await h.runtime.updateSettings(id, { images: { mode: 'off' } });
      return { data: png, mime: 'image/png' };
    });
    expect((await e.execute(call('in-flight', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(await h.runtime.core.store.listBlobs(id)).toEqual([]);
    expect((await h.runtime.core.settings(id)).coachIdentity.avatarSha256).toBeNull();
  });

  it('serializes different image calls against the remaining budget', async () => {
    const generate = vi.fn<ImageProvider['generate']>().mockResolvedValue({ data: png, mime: 'image/png' });
    h = await makeHarness({ config, imageProvider: { id: 'google', model: 'test-image', generate } });
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true }, budgets: { dailyUsd: .3 } });
    const e = executor(id);
    const results = await Promise.all(['one', 'two'].map(key => e.execute(call(key, 'generate_image', { prompt: 'A mascot' }), signal())));
    expect(results.filter(r => !r.isError)).toHaveLength(1);
    expect(results.filter(r => r.isError)).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await h.runtime.core.store.sumUsage(id, '2026-10-01T00:00:00Z')).costUsd).toBe(.2);
  });
});
