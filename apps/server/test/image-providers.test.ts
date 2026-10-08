import { describe, expect, it, vi } from 'vitest';
import { ImageGenerationConfig } from '@opencoach/protocol';
import { scopedImageProviders } from '../src/image-providers';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgWBUKQhAKABqeA/24RcKwAAAAAElFTkSuQmCC';
describe('[SEC-1] [MOD-1] per-athlete image credentials', () => {
  it('uses each athlete’s existing key, tracks rotation, and falls back only for accounts without a scoped key', async () => {
    const model = 'recraft/recraft-v4.1-flash';
    const config = ImageGenerationConfig.parse({ provider: 'openrouter', model });
    if (config.provider !== 'openrouter') throw new Error('Fixture config');
    const keys: Record<string, string> = { a: 'athlete-a', b: 'athlete-b' };
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, input) => new Response(JSON.stringify(input?.method === 'GET'
      ? { id: model, endpoints: [{ provider_tag: 'recraft', supported_parameters: { aspect_ratio: { values: ['1:1'] } }, pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .007 }] }] }
      : { data: [{ b64_json: png, media_type: 'image/png' }] })));
    const forAthlete = scopedImageProviders(config, { keyFor: id => keys[id], fallbackKey: 'deployment-key', fetch: request });
    const a = forAthlete('a')!;
    expect(forAthlete('a')).toBe(a);
    for (const id of ['a', 'b', 'unassigned']) await forAthlete(id)!.generate('A mascot', new AbortController().signal);
    const authorizations = request.mock.calls.filter(([, input]) => input?.method === 'POST').map(([, input]) => (input?.headers as Record<string, string>).Authorization);
    expect(authorizations).toEqual(['Bearer athlete-a', 'Bearer athlete-b', 'Bearer deployment-key']);
    keys.a = 'rotated';
    expect(forAthlete('a')).not.toBe(a);
    delete keys.a;
    expect(forAthlete('a')).not.toBe(a);
    expect(scopedImageProviders(config, { keyFor: () => undefined })('none')).toBeUndefined();
  });
});
