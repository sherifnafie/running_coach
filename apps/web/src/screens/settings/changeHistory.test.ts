import { describe, expect, it } from 'vitest';
import { translate, type ChangeEntry } from '@opencoach/protocol';
import { shellLabels } from '../../lib/labels';
import { changePresentation } from './changeHistory';

const entry = (patch: Partial<ChangeEntry>): ChangeEntry => ({ commit: 'abc123', at: '2026-10-07T08:00:00Z', kind: 'turn', summary: 'Updated plan/current.md', files: ['plan/current.md'], ...patch });

describe('readable workspace history [WS-4]', () => {
  it('labels drafts and screen source without claiming they were published or adopted', () => {
    const change = entry({ summary: 'Updated plan/drafts/block.md, ui/views/today/index.html', files: ['plan/drafts/block.md', 'ui/views/today/index.html', 'ui/app.json', 'plan/current.md'] });
    const display = changePresentation(change, (label) => label);
    expect(display.title).not.toMatch(/published|restored|training plan updated/i);
    expect(display.areas).toEqual(['Plan files', 'Screen files', 'Coach notes']);
    expect(change.summary).toContain('plan/drafts/block.md'); // original evidence remains available
  });

  it('keeps the coach-authored publication explanation', () => {
    const display = changePresentation(entry({ kind: 'publish', summary: 'publish: Bigger pace numbers for running outdoors', files: ['ui/views/today/index.html'] }), (label) => label);
    expect(display.title).toBe('Bigger pace numbers for running outdoors');
  });

  it.each(['nl', 'ar'])('translates generated headings and categories in %s', (locale) => {
    const t = (label: string) => translate(label, locale, shellLabels);
    const display = changePresentation(entry({ files: ['data/schema.md', 'research/heat.md', 'exports/calendar.ics'] }), t);
    expect(display.title).not.toBe('Coach saved changes');
    expect(display.areas).toEqual(['Training data', 'Research', 'Calendar export'].map(t));
    expect(display.areas.every((label) => !['Training data', 'Research', 'Calendar export'].includes(label))).toBe(true);
  });
});
