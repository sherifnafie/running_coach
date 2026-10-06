import { parse as parseYaml } from 'yaml';

/** Split `---\n<yaml>\n---\n<body>` front-matter. Returns data = {} when absent or unparsable. */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string; error?: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  try {
    const parsed: unknown = parseYaml(m[1]!);
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { data, body: text.slice(m[0].length) };
  } catch (e) {
    return { data: {}, body: text.slice(m[0].length), error: (e as Error).message };
  }
}
