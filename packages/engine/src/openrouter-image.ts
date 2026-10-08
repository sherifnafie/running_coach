import { ToolError, type ImageGenerationConfig, type ImageProvider, type ImageQuote } from '@opencoach/protocol';
import { decodeImage, imageEndpoint, imageJson, imageList, imageObject } from './image-response';

type Config = Extract<ImageGenerationConfig, { provider: 'openrouter' }>;

// API profiles, not tool options. Verified 2.5/816 output: 171 tokens low, 384
// medium. Reserve 256/512 plus a one-token-per-UTF8-byte prompt upper bound.
// This is a conservative reservation, not an upstream invoice guarantee.
const tokenProfiles: Record<string, { size: string; outputReservation: Record<'low' | 'medium', number> }> = {
  'openai/gpt-image-2.5-flare': { size: '816x816', outputReservation: { low: 256, medium: 512 } },
  'openai/gpt-image-2.5-flare-2026-09-08': { size: '816x816', outputReservation: { low: 256, medium: 512 } },
  'openai/gpt-image-1-mini': { size: '1024x1024', outputReservation: { low: 272, medium: 1056 } },
};
type Recipe = { prompt?: string; size: string; quality?: 'low' | 'medium'; background?: 'transparent' };

/** Bounded square icon generation; model/count/quality cannot be selected by a coach. */
export function createOpenRouterImageProvider(config: Config, apiKey: string, request: typeof fetch = fetch): ImageProvider {
  const base = imageEndpoint(config.baseUrl ?? 'https://openrouter.ai/api/v1').href.replace(/\/$/, '');
  const issued = new WeakMap<ImageQuote, Recipe>();
  let priceOverrun = false;
  const visualPrompt = (prompt: string) => config.stylePrompt ? `${config.stylePrompt}\n\nSubject: ${prompt}` : prompt;
  const call = async (url: string, signal: AbortSignal, body?: Record<string, unknown>) => {
    try {
      return await request(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
        ...(body ? { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ToolError(signal.aborted ? 'LIMIT' : 'TIMEOUT', 'Image request did not complete. Do not retry automatically.');
    }
  };
  const quote = async (signal: AbortSignal, prompt = ''): Promise<ImageQuote> => {
    signal.throwIfAborted();
    if (priceOverrun) throw new ToolError('LIMIT', 'This image client is paused because billing exceeded its reservation. Review configuration before another generation.');
    const path = config.model.split('/').map(encodeURIComponent).join('/');
    const json = await imageJson(await call(`${base}/images/models/${path}/endpoints`, signal), 512 * 1024);
    if (json.id !== config.model) throw new ToolError('INVALID_INPUT', 'Image pricing metadata does not match the configured model.');
    const options = imageList(json.endpoints).flatMap(value => {
      const endpoint = imageObject(value);
      const parameters = imageObject(endpoint.supported_parameters);
      const ratios = imageList(imageObject(parameters.aspect_ratio).values);
      const prices = imageList(endpoint.pricing).map(imageObject);
      const output = prices.filter(price => price.billable === 'output_image');
      // No arbitrary token/megapixel/quality-tier assumptions or unpinnable endpoints.
      if (!ratios.includes('1:1') || typeof endpoint.provider_tag !== 'string' || !endpoint.provider_tag || output.length !== 1) return [];
      const price = output[0]!;
      if (price.variant !== undefined || typeof price.cost_usd !== 'number' || !Number.isFinite(price.cost_usd) || price.cost_usd < 0) return [];
      // Explicit resolution tiers must have a small option. Fixed-size icon models
      // (such as Recraft Flash) expose none and receive only the square aspect ratio.
      const resolutions = imageList(imageObject(parameters.resolution).values);
      if (resolutions.length && !resolutions.some(size => ['512', '768', '1K'].includes(String(size)))) return [];
      const profile = tokenProfiles[config.model];
      if (price.unit === 'token' && profile) {
        const input = prices.filter(line => line.billable === 'input_text');
        const inputRate = input[0]?.cost_usd;
        if (input.length !== 1 || typeof inputRate !== 'number' || !Number.isFinite(inputRate) || inputRate < 0) return [];
        if (prices.some(line => !['output_image', 'input_text', 'input_image'].includes(String(line.billable)))) return [];
        if (!imageList(imageObject(parameters.quality).values).includes(config.quality) || !imageList(imageObject(parameters.background).values).includes('transparent')) return [];
        const costUsd = profile.outputReservation[config.quality] * price.cost_usd + Buffer.byteLength(visualPrompt(prompt), 'utf8') * inputRate;
        if (costUsd > config.costPerImageUsd) return [];
        return [{ costUsd, provider: endpoint.provider_tag, recipe: { prompt, size: profile.size, quality: config.quality, background: 'transparent' as const } }];
      }
      if (price.unit !== 'image' || price.cost_usd > config.costPerImageUsd) return [];
      if (prices.some(line => line.billable !== 'output_image' && !(line.billable === 'input_image' && line.cost_usd === 0))) return [];
      const small = ['512', '768', '1K'].find(size => resolutions.includes(size));
      const size = small === '512' ? '512x512' : small === '768' ? '768x768' : '1024x1024';
      return [{ costUsd: price.cost_usd, provider: endpoint.provider_tag, recipe: { size } }];
    }).sort((a, b) => a.costUsd - b.costUsd);
    const selected = options[0];
    if (!selected) throw new ToolError('LIMIT', 'No pinned image endpoint fits the configured request reservation. Use a short subject prompt; unknown pricing profiles are refused. No generation was dispatched.');
    const value = { costUsd: selected.costUsd, provider: selected.provider };
    issued.set(value, selected.recipe);
    return value;
  };
  return { id: 'openrouter', model: config.model, quote,
    async generate(prompt, signal, preparedQuote) {
      if (!prompt.trim() || prompt.length > 2000) throw new ToolError('INVALID_INPUT', 'Image prompt must contain 1–2000 characters.');
      const selected = preparedQuote && issued.has(preparedQuote) ? preparedQuote : await quote(signal, prompt);
      const recipe = issued.get(selected)!;
      if (recipe.prompt !== undefined && recipe.prompt !== prompt) throw new ToolError('INVALID_INPUT', 'The image prompt changed after its cost reservation.');
      issued.delete(selected); // A quote authorizes one dispatch, never a retry.
      signal.throwIfAborted();
      const json = await imageJson(await call(`${base}/images`, signal, {
        model: config.model, prompt: visualPrompt(prompt), n: 1,
        aspect_ratio: '1:1', size: recipe.size, output_format: 'png',
        ...(recipe.quality ? { quality: recipe.quality, background: recipe.background } : {}),
        provider: { only: [selected.provider], allow_fallbacks: false, data_collection: 'deny' },
      }));
      const data = imageList(json.data);
      if (data.length !== 1) throw new ToolError('INVALID_INPUT', 'Image provider must return exactly one image.');
      const output = imageObject(data[0]);
      const image = decodeImage(output.b64_json, output.media_type ?? 'image/png');
      const cost = imageObject(json.usage).cost;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > selected.costUsd + 1e-9) priceOverrun = true;
      return { ...image, ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) };
    },
  };
}
