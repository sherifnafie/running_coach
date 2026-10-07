import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { labelLanguage, languageDirection, setLabelPack, translate, type Logger, type ModelRequest } from '@opencoach/protocol';
import { createModelRouter, createScriptedProvider } from '@opencoach/engine';
import { LabelPacks, labelSources } from '../src/label-packs';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

function packs(handler: (sources: string[]) => Record<string, string>) {
  const requests: ModelRequest[] = [];
  const scripted = createScriptedProvider({ id: 'scripted', handler: (req) => {
    requests.push(req);
    const part = req.items[0]?.kind === 'user' ? req.items[0].parts[0] : undefined;
    const sources = JSON.parse(part?.type === 'text' ? part.text : '[]') as string[];
    return { text: `Here you go:\n${JSON.stringify(handler(sources))}` };
  } });
  const router = createModelRouter({ tiers: { coach: { provider: 'scripted', model: 'm' } }, fallbacks: {}, pricing: {} }, { scripted });
  return { requests, make: async () => { const dir = await mkdtemp(join(tmpdir(), 'oc-i18n-')); dirs.push(dir); return { dir, packs: new LabelPacks({ dataDir: dir, router, logger }) }; } };
}

describe('interface labels in any language', () => {
  it('maps locales to pack keys and directions', () => {
    expect(labelLanguage('de-AT')).toBe('de');
    expect(labelLanguage('zh-TW')).toBe('zh-hant');
    expect(labelLanguage('zh-CN')).toBe('zh-hans');
    expect(labelLanguage('no')).toBe('nb');
    expect(labelLanguage('not a tag')).toBe('en');
    expect(languageDirection('he')).toBe('rtl');
    expect(languageDirection('fa-IR')).toBe('rtl');
    expect(languageDirection('ur')).toBe('rtl');
    expect(languageDirection('de')).toBe('ltr');
  });

  it('uses installed packs for any language and falls back to English per string', () => {
    setLabelPack('de', { 'Nothing planned': 'Nichts geplant' });
    expect(translate('Nothing planned', 'de-CH')).toBe('Nichts geplant');
    expect(translate('Move here', 'de')).toBe('Move here');
    expect(translate('Nothing planned', 'nl')).toBe('Niets gepland');
  });

  it('generates a pack once per language in the background, caches it, and never generates for curated languages', async () => {
    const t = packs((sources) => Object.fromEntries(sources.map((s) => [s, `DE:${s}`])));
    const { dir, packs: p } = await t.make();
    expect(await p.get('nl')).toEqual({ language: 'nl', ready: true, labels: {} });
    expect(await p.get('de', { generate: false })).toMatchObject({ ready: false, labels: {} });
    expect(t.requests).toHaveLength(0);
    expect(await p.get('de')).toMatchObject({ language: 'de', ready: false });
    await p.settled();
    const ready = await p.get('de-AT');
    expect(ready.ready).toBe(true);
    expect(Object.keys(ready.labels)).toHaveLength(labelSources().length);
    expect(ready.labels['Nothing planned']).toBe('DE:Nothing planned');
    const calls = t.requests.length;
    await p.get('de');
    await p.settled();
    expect(t.requests.length).toBe(calls);
    expect(JSON.parse(await readFile(join(dir, 'i18n', 'de.json'), 'utf8')).labels['Move here']).toBe('DE:Move here');
  });

  it('keeps what it got when a batch fails and fills only the gaps later', async () => {
    let fail = true;
    const t = packs((sources) => (fail && sources.includes('Nothing planned') ? {} : Object.fromEntries(sources.map((s) => [s, `FR:${s}`]))));
    const { packs: p } = await t.make();
    await p.get('fr');
    await p.settled();
    const partial = await p.get('fr', { generate: false });
    expect(partial.ready).toBe(true);
    expect(partial.labels['Nothing planned']).toBeUndefined();
    fail = false;
    const before = t.requests.length;
    await p.get('fr');
    await p.settled();
    expect(t.requests.length - before).toBe(1);
    expect((await p.get('fr')).labels['Nothing planned']).toBe('FR:Nothing planned');
  });
});
