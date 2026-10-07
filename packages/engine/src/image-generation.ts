import { ToolError, type ImageGenerationConfig, type ImageProvider } from '@opencoach/protocol';

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Direct vendor REST contracts; credentials stay in this trusted adapter [SEC-1]. */
export function createImageProvider(config: ImageGenerationConfig | undefined, deps: {
  env?: Record<string, string | undefined>; fetch?: typeof fetch;
} = {}): ImageProvider | undefined {
  if (!config) return undefined;
  const apiKey = (deps.env ?? process.env)[config.apiKeyEnv];
  if (!apiKey) throw new Error(`Image generation requires the environment variable ${config.apiKeyEnv}.`);
  const base = new URL(config.baseUrl ?? (config.provider === 'google' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1'));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error('Image endpoint must use HTTPS (HTTP is allowed only for a loopback service), without credentials, query or fragment.');
  }
  const request = deps.fetch ?? fetch;
  return {
    id: config.provider, model: config.model,
    async generate(prompt, signal) {
      if (!prompt.trim() || prompt.length > 2000) throw new ToolError('INVALID_INPUT', 'Image prompt must contain 1–2000 characters.');
      const google = config.provider === 'google';
      const url = `${base.href.replace(/\/$/, '')}/${google ? `models/${encodeURIComponent(config.model)}:generateContent` : 'images/generations'}`;
      let response: Response;
      try {
        response = await request(url, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
          headers: { 'Content-Type': 'application/json', ...(google ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }) },
          body: JSON.stringify(google ? {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } },
          } : { model: config.model, prompt, n: 1, size: '1024x1024', output_format: 'png', quality: 'low' }),
        });
      } catch {
        // Provider diagnostics may echo prompts, credentials or URLs. Never return them to the model.
        throw new ToolError(signal.aborted ? 'LIMIT' : 'TIMEOUT', 'Image request did not complete. Do not retry automatically; a provider charge may have occurred.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ToolError('NOT_CONFIGURED', `Image provider rejected the request (HTTP ${response.status}). Check server configuration; do not retry automatically.`);
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
          if (length > MAX_RESPONSE_BYTES) throw new ToolError('ETOOBIG', 'Image provider response is too large.');
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof ToolError) throw error;
        throw new ToolError('TIMEOUT', 'Image response was interrupted. Do not retry automatically.');
      }
      let json: Record<string, unknown>;
      try { json = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { throw new ToolError('INVALID_INPUT', 'Image provider returned invalid JSON.'); }
      let encoded: unknown;
      let mime: unknown = 'image/png';
      if (google) {
        const parts = list(object(object(list(json.candidates)[0]).content).parts);
        const part = parts.map(object).find(p => !p.thought && object(p.inlineData).data);
        const inline = object(part?.inlineData);
        encoded = inline.data; mime = inline.mimeType;
      } else encoded = object(list(json.data)[0]).b64_json;
      if (typeof encoded !== 'string' || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new ToolError('INVALID_INPUT', 'No generated image returned. The provider may have filtered the request; no avatar changed.');
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mime))) throw new ToolError('INVALID_INPUT', 'Only PNG, JPEG or WebP image output is supported.');
      const data = Buffer.from(encoded, 'base64');
      if (!data.length || data.length > MAX_IMAGE_BYTES) throw new ToolError('ETOOBIG', 'Generated image is empty or too large.');
      return { data, mime: mime as 'image/png' | 'image/jpeg' | 'image/webp' };
    },
  };
}
