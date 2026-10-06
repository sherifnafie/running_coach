import { z } from 'zod';
import type { JsonSchema } from './model';

/**
 * Convert a zod schema to a JSON Schema suitable for model tool definitions.
 * Strips $schema and produces an object schema (providers require type: "object" at the root).
 */
export function toToolJsonSchema(schema: z.ZodType): JsonSchema {
  const js = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== 'object') {
    return { type: 'object', properties: { value: js }, required: ['value'] };
  }
  return js;
}
