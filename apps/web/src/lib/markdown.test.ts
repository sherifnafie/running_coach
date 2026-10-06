import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripMarkdown } from './markdown';

const parse = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('renderMarkdown (safe subset)', () => {
  it('renders the supported subset', () => {
    const d = parse(renderMarkdown('**bold** and _em_ and `code`\n\n- a\n- b\n\n1. x\n2. y\n\n> quote\n\n## Head'));
    expect(d.querySelector('strong')?.textContent).toBe('bold');
    expect(d.querySelector('em')?.textContent).toBe('em');
    expect(d.querySelector('code')?.textContent).toBe('code');
    expect(d.querySelectorAll('ul li')).toHaveLength(2);
    expect(d.querySelectorAll('ol li')).toHaveLength(2);
    expect(d.querySelector('blockquote')).not.toBeNull();
    expect(d.querySelector('h2')?.textContent).toBe('Head');
  });

  it('removes script tags and inline event handlers', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <img src=x onerror="alert(2)"> <b onclick="alert(3)">b</b>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/alert\(/);
    expect(html).toContain('hello');
  });

  it('strips dangerous elements: iframe, object, embed, svg, style, form, img', () => {
    const html = renderMarkdown(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x"><svg onload="alert(1)"><circle/></svg><style>*{display:none}</style><form action="/x"><input></form>![alt](https://t.example/p.png)',
    );
    expect(html).not.toMatch(/<(iframe|object|embed|svg|style|form|input|img)\b/i);
  });

  it('opens links in a new tab with rel=noopener noreferrer', () => {
    const a = parse(renderMarkdown('[docs](https://example.com/page)')).querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/page');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('drops javascript:, data: and other non-web link schemes', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', 'file:///etc/passwd']) {
      const html = renderMarkdown(`[x](${bad})`);
      const a = parse(html).querySelector('a');
      expect(a?.getAttribute('href') ?? null).toBeNull();
      expect(html).not.toMatch(/javascript:/i);
    }
  });

  it('allows mailto: and tel: links', () => {
    expect(parse(renderMarkdown('[mail](mailto:a@b.co)')).querySelector('a')?.getAttribute('href')).toBe('mailto:a@b.co');
    expect(parse(renderMarkdown('[call](tel:+31123)')).querySelector('a')?.getAttribute('href')).toBe('tel:+31123');
  });

  it('removes style attributes and data attributes', () => {
    const html = renderMarkdown('<p style="position:fixed;inset:0" data-x="1" class="evil">hi</p>');
    expect(html).not.toMatch(/style=/);
    expect(html).not.toMatch(/data-x/);
  });

  it('handles empty and plain text', () => {
    expect(renderMarkdown('')).toBe('');
    expect(parse(renderMarkdown('just text')).textContent?.trim()).toBe('just text');
  });

  it('turns single newlines into <br> (chat style)', () => {
    expect(renderMarkdown('a\nb')).toContain('<br');
  });

  it('stripMarkdown gives a plain preview', () => {
    expect(stripMarkdown('**Hi** [there](https://x.y) `code`')).toBe('Hi there code');
  });
});
