import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/browser/markdown';

describe('optional repeated Markdown title [UI-1]', () => {
  it('preserves titles by default', () => {
    expect(parseMarkdown('# Why this plan\n\nExplanation.')[0]?.t).toBe('h');
  });
  it('omits a matching first title and preserves the body and subsections', () => {
    const blocks = parseMarkdown('# **Why this plan**\n\nExplanation.\n\n## Assumptions\n\nImportant detail.', { omitTitle: ' why THIS plan ' });
    expect(blocks.map(b => b.t)).toEqual(['p', 'h', 'p']);
  });
  it('keeps a different title or a matching heading later in the document', () => {
    expect(parseMarkdown('# My training\n\nExplanation.', { omitTitle: 'Why this plan' })[0]?.t).toBe('h');
    expect(parseMarkdown('Introduction.\n\n## Why this plan', { omitTitle: 'Why this plan' }).map(b => b.t)).toEqual(['p', 'h']);
  });
});
