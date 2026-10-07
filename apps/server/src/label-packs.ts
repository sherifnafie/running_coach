import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCuratedLabels, kitLabelSources, labelLanguage, type Logger, type ModelRouter } from '@opencoach/protocol';
import { shellLabels } from '@opencoach/protocol/presentation-shell';

/**
 * Interface labels for any language (SPEC §16 i18n). English is the source; Dutch and Arabic are curated. For any
 * other language the fast tier translates the label list once, the result is cached in `<dataDir>/i18n/<lang>.json`
 * and served to the PWA and, through the view env, to the kit. Only these built-in strings are ever translated
 * here; athlete and coach content is not. Until a pack exists the interface stays English.
 */
export interface LabelPack {
  language: string;
  ready: boolean;
  labels: Record<string, string>;
}

const BATCH = 80;

export function labelSources(): string[] {
  return [...new Set([...kitLabelSources, ...Object.keys(shellLabels)])];
}

export class LabelPacks {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly sources = labelSources();
  private readonly sourceHash = createHash('sha256').update(this.sources.join('\u0000')).digest('hex').slice(0, 16);

  constructor(private readonly deps: { dataDir: string; router?: ModelRouter; logger: Logger }) {}

  private file(language: string): string {
    return join(this.deps.dataDir, 'i18n', `${language}.json`);
  }

  private async read(language: string): Promise<{ sourceHash: string; labels: Record<string, string> } | undefined> {
    try {
      return JSON.parse(await readFile(this.file(language), 'utf8')) as { sourceHash: string; labels: Record<string, string> };
    } catch {
      return undefined;
    }
  }

  /**
   * The pack for a locale. With `generate` (signed-in callers) a missing or outdated pack is generated in the
   * background; anonymous callers (the sign-in screen) only get packs that already exist.
   */
  async get(locale: string, opts: { generate?: boolean } = { generate: true }): Promise<LabelPack> {
    const language = labelLanguage(locale);
    if (hasCuratedLabels(language)) return { language, ready: true, labels: {} };
    const stored = await this.read(language);
    if (stored?.sourceHash === this.sourceHash) return { language, ready: true, labels: stored.labels };
    if (opts.generate !== false) this.generate(language, stored?.labels ?? {});
    // A stale pack is still far better than English while the missing strings are filled in.
    return { language, ready: !!stored, labels: stored?.labels ?? {} };
  }

  private generate(language: string, existing: Record<string, string>): void {
    if (this.inflight.has(language) || !this.deps.router) return;
    const run = this.translateMissing(language, existing)
      .catch((error) => this.deps.logger.warn('label pack generation failed', { language, error: (error as Error).message }))
      .finally(() => this.inflight.delete(language));
    this.inflight.set(language, run);
  }

  /** Test hook: wait for any running generation. */
  async settled(): Promise<void> {
    await Promise.all(this.inflight.values());
  }

  private async translateMissing(language: string, existing: Record<string, string>): Promise<void> {
    const missing = this.sources.filter((s) => !existing[s]);
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
    const results = await Promise.all(batches.map((batch) => this.translateBatch(language, batch).catch(() => ({}))));
    const labels: Record<string, string> = {};
    for (const source of this.sources) {
      const value = existing[source] ?? results.reduce<string | undefined>((found, r) => found ?? (r as Record<string, string>)[source], undefined);
      if (value) labels[source] = value;
    }
    const complete = this.sources.every((s) => labels[s]);
    await mkdir(join(this.deps.dataDir, 'i18n'), { recursive: true, mode: 0o700 });
    const tmp = `${this.file(language)}.tmp`;
    // An incomplete pack is saved with an empty hash, so the next request retries only the gaps.
    await writeFile(tmp, JSON.stringify({ sourceHash: complete ? this.sourceHash : '', labels }), { mode: 0o600 });
    await rename(tmp, this.file(language));
    this.deps.logger.info('label pack ready', { language, translated: Object.keys(labels).length, of: this.sources.length });
  }

  private async translateBatch(language: string, batch: string[]): Promise<Record<string, string>> {
    const route = this.deps.router!.route('fast')[0];
    if (!route) throw new Error('no model for label translation');
    let name = language;
    try {
      name = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language;
    } catch {
      /* keep the code */
    }
    let out = '';
    for await (const ev of route.provider.stream({
      model: route.model,
      system: [
        {
          text:
            `Translate user-interface labels of OpenCoach, a phone app where an AI coach coaches people in sports and fitness, into ${name} (${language}). ` +
            'Use natural, short, friendly wording a native speaker would expect in a mobile app; use the informal form of address where the language has one. ' +
            'Keep emoji, numbers, punctuation such as "…" and the meaning of medical or safety sentences exactly. Some labels are sentence fragments that get joined with other text; translate them as fragments. ' +
            'Reply with ONLY a JSON object mapping each English label, unchanged, to its translation.',
          cache: true,
        },
      ],
      items: [{ kind: 'user', parts: [{ type: 'text', text: JSON.stringify(batch) }] }],
      tools: [],
      effort: 'low',
      maxOutputTokens: 16_000,
    })) {
      if (ev.type === 'text_delta') out += ev.text;
    }
    const m = /\{[\s\S]*\}/.exec(out);
    if (!m) throw new Error('no JSON in translation');
    const parsed = JSON.parse(m[0]) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const source of batch) {
      const value = parsed[source];
      if (typeof value === 'string' && value.trim() && value.length <= source.length * 4 + 40) result[source] = value.trim();
    }
    return result;
  }
}
