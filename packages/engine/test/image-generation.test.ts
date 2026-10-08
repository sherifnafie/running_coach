import { describe, expect, it, vi } from 'vitest';
import { ImageGenerationConfig } from '@opencoach/protocol';
import { createImageProvider } from '../src/image-generation';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgWBUKQhAKABqeA/24RcKwAAAAAElFTkSuQmCC';
const config = (provider: 'google' | 'openai-compatible') => ImageGenerationConfig.parse({ provider, model: 'test-image', apiKeyEnv: 'IMAGE_TEST_KEY', costPerImageUsd: .2 });
const signal = () => new AbortController().signal;
const env = { IMAGE_TEST_KEY: 'private-test-key' };

describe('[MOD-1] [SEC-1] image provider contracts', () => {
  it.each(['google', 'openai-compatible'] as const)('sends a single square image request through %s and decodes bytes', async provider => {
    const reply = provider === 'google' ? { candidates: [{ content: { parts: [{ text: 'ignored' }, { thought: true, inlineData: { data: 'ignored' } }, { inlineData: { mimeType: 'image/png', data: png } }] } }] } : { data: [{ b64_json: png }] };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(reply)));
    const adapter = createImageProvider(config(provider), { env, fetch: request })!;
    const result = await adapter.generate('A green running mascot', signal());
    expect(Buffer.from(result.data).toString('base64')).toBe(png);
    expect(result.mime).toBe('image/png');
    const [url, options] = request.mock.calls[0]!;
    expect(url).toContain(provider === 'google' ? '/models/test-image:generateContent' : '/v1/images/generations');
    expect(String(url)).not.toContain(env.IMAGE_TEST_KEY);
    expect(options!.redirect).toBe('error');
    const body = JSON.parse(String(options!.body));
    if (provider === 'google') {
      expect(options!.headers).toMatchObject({ 'x-goog-api-key': env.IMAGE_TEST_KEY });
      expect(body.contents[0].parts[0].text).toContain('pixel-art');
      expect(body.contents[0].parts[0].text).toContain('Subject: A green running mascot');
      expect(body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } });
    } else {
      expect(options!.headers).toMatchObject({ Authorization: `Bearer ${env.IMAGE_TEST_KEY}` });
      expect(body).toMatchObject({ model: 'test-image', n: 1, size: '1024x1024', output_format: 'png', quality: 'low' });
    }
  });

  it('remains optional, rejects missing keys and unsafe credential endpoints', () => {
    expect(createImageProvider(undefined)).toBeUndefined();
    expect(() => createImageProvider(config('google'), { env: {} })).toThrow('IMAGE_TEST_KEY');
    for (const baseUrl of ['http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=x']) {
      expect(() => createImageProvider({ ...config('google'), baseUrl }, { env })).toThrow('HTTPS');
    }
  });

  it('sanitizes provider errors, propagates cancellation and never retries', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(env.IMAGE_TEST_KEY + ' private prompt', { status: 401 }));
    const adapter = createImageProvider(config('google'), { env, fetch: request })!;
    await expect(adapter.generate('A mascot', signal())).rejects.toThrow('HTTP 401');
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValue(new Error(env.IMAGE_TEST_KEY));
    const aborted = new AbortController(); aborted.abort();
    await expect(adapter.generate('A mascot', aborted.signal)).rejects.toMatchObject({ code: 'LIMIT' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([{ data: [{ url: 'https://untrusted.example/image.png' }] }, { data: [{ b64_json: '<script>' }] }, { data: [] }])('rejects malformed/filtered outputs and never follows an image URL', async response => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(createImageProvider(config('openai-compatible'), { env, fetch: request })!.generate('A mascot', signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds provider response size before JSON decoding', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(12 * 1024 * 1024 + 1)));
    await expect(createImageProvider(config('google'), { env, fetch: request })!.generate('A mascot', signal())).rejects.toMatchObject({ code: 'ETOOBIG' });
  });
});
