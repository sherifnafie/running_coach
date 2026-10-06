import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Safe markdown subset for coach messages (SPEC §9.1, §5.4). marked renders, DOMPurify sanitizes with a
 * strict allow-list: no scripts, no event handlers, no images (coach images arrive as attachments), no
 * forms/iframes/styles. Links open in a new tab with rel=noopener noreferrer, http(s)/mailto/tel only.
 */
const marked = new Marked({ gfm: true, breaks: true, async: false });

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote', 'hr',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
];
const ALLOWED_ATTR = ['href', 'title', 'colspan', 'rowspan', 'align'];
const SAFE_URL = /^(?:https?:|mailto:|tel:)/i;

type Purifier = ReturnType<typeof DOMPurify>;
let purifier: Purifier | null = null;

function getPurifier(): Purifier {
  if (purifier) return purifier;
  // `DOMPurify` is already bound to the global window in browsers/jsdom; calling it with a window re-binds.
  const p: Purifier = typeof (DOMPurify as unknown as Purifier).sanitize === 'function' ? (DOMPurify as unknown as Purifier) : DOMPurify(globalThis.window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (!href || !SAFE_URL.test(href.trim())) {
        node.removeAttribute('href');
      } else {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
  purifier = p;
  return p;
}

/** Render untrusted markdown to sanitized HTML. */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text ?? '', { async: false }) as string;
  return getPurifier().sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'img', 'svg', 'math', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload', 'srcdoc'],
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as unknown as string;
}

/** Plain-text preview (notifications, aria labels). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
