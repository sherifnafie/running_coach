import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ImageProvider, type TriggerClass } from '@opencoach/protocol';
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
    expect((await e.execute(call('disabled', 'set_preferences', { coach_name: 'Kip' }), signal())).isError).toBe(true);
    expect((await e.execute(call('self-grant', 'set_preferences', { allowChanges: true, coach_name: 'Kip' }), signal())).isError).toBe(true);
    expect((await e.execute(call('disabled-img', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true } });
    expect((await executor(id, 'helper').execute(call('helper', 'set_preferences', { coach_name: 'Kip' }), signal())).isError).toBe(true);
    expect((await executor(id, 'helper').execute(call('helper-img', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect((await executor(id, 'coach', 'scheduled').execute(call('scheduled', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    expect(generate).not.toHaveBeenCalled();
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
    await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: true } });
    generate.mockResolvedValueOnce({ data: Buffer.from('<svg/>'), mime: 'image/png' });
    const e = executor(id);
    expect((await e.execute(call('malformed', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
    generate.mockImplementationOnce(async () => {
      await h.runtime.updateSettings(id, { coachIdentity: { allowChanges: false } });
      return { data: png, mime: 'image/png' };
    });
    expect((await e.execute(call('in-flight', 'generate_image', { prompt: 'A mascot' }), signal())).isError).toBe(true);
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
