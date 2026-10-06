import type { ContentPart } from '@opencoach/protocol';

/**
 * Key under which an adapter reports a tool input that was not valid JSON (e.g. an eagerly
 * streamed tool input that the model cut off or garbled). The agent loop answers such calls with an
 * error result instead of running the tool, so the model can re-issue the call.
 */
export const INVALID_TOOL_INPUT_KEY = '__invalid_json';

export function isInvalidToolInput(input: unknown): input is Record<typeof INVALID_TOOL_INPUT_KEY, string> {
  return typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>)[INVALID_TOOL_INPUT_KEY] === 'string';
}

/**
 * Strictly parse the accumulated JSON of a streamed tool input. An empty string is `{}` (tools with
 * no parameters stream no deltas). Anything that is not a JSON object is reported as invalid.
 */
export function parseToolInput(raw: string): { input: unknown; valid: boolean } {
  const s = raw.trim();
  if (s === '') return { input: {}, valid: true };
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return { input: v, valid: true };
  } catch {
    // fall through
  }
  return { input: { [INVALID_TOOL_INPUT_KEY]: raw }, valid: false };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function dataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/** Text parts of a content list joined by newlines (images are skipped). */
export function textOfParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function hasImages(parts: ContentPart[]): boolean {
  return parts.some((p) => p.type === 'image');
}

/** Default backoff sleep: resolves after `ms` or as soon as `signal` aborts (callers re-check the signal). */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Never-throwing JSON.stringify for tool inputs echoed back to a provider. */
export function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Split text into chunks of roughly `size` characters, preferring word boundaries. Joins back losslessly. */
export function chunkText(text: string, size = 14): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.match(/\s*\S+\s*|\s+/g) ?? []) {
    if (cur.length > 0 && cur.length + word.length > size) {
      out.push(cur);
      cur = '';
    }
    cur += word;
  }
  if (cur) out.push(cur);
  return out;
}

/** Split a string into fixed-size pieces (lossless). */
export function chunkFixed(text: string, size = 16): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
