import { ToolError } from '@opencoach/protocol';

export const imageObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export const imageList = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Bounded JSON decoding shared by image contracts; never expose provider diagnostics. */
export async function imageJson(response: Response, maxBytes = 12 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolError('NOT_CONFIGURED', `Image provider rejected the request (HTTP ${response.status}). Do not retry automatically.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ToolError('INVALID_INPUT', 'Image provider returned no response body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new ToolError('ETOOBIG', 'Image provider response is too large.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ToolError) throw error;
    throw new ToolError('TIMEOUT', 'Image response was interrupted. Do not retry automatically.');
  }
  try { return imageObject(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new ToolError('INVALID_INPUT', 'Image provider returned invalid JSON.'); }
}

export function decodeImage(encoded: unknown, mime: unknown): { data: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp' } {
  if (typeof encoded !== 'string' || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ToolError('INVALID_INPUT', 'No generated image returned. The provider may have filtered the request.');
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mime))) throw new ToolError('INVALID_INPUT', 'Only PNG, JPEG or WebP image output is supported.');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > 8 * 1024 * 1024) throw new ToolError('ETOOBIG', 'Generated image is empty or too large.');
  return { data, mime: mime as 'image/png' | 'image/jpeg' | 'image/webp' };
}

export function imageEndpoint(baseUrl: string): URL {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error('Image endpoint must use HTTPS (HTTP is allowed only for loopback), without credentials, query or fragment.');
  }
  return base;
}
