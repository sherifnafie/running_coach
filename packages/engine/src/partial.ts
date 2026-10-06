import { Allow, parse } from 'partial-json';

/**
 * Extract the `text` field from a (possibly incomplete) JSON string of `send_message` input, so the
 * gateway can stream the message to the athlete while the model is still writing it.
 * Returns undefined when `text` is not (yet) present as a string. Never throws.
 */
export function partialSendMessageText(partialJson: string): string | undefined {
  if (typeof partialJson !== 'string' || partialJson.trim() === '') return undefined;
  try {
    const v: unknown = parse(partialJson, Allow.ALL);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const text = (v as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  } catch {
    // incomplete in a way the tolerant parser cannot recover from
  }
  return undefined;
}
