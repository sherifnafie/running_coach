/**
 * Safe, minimal Markdown. Parsing produces a plain AST; rendering builds DOM nodes with
 * textContent only (no innerHTML of raw input, ever). Raw HTML in the source is shown as text.
 *
 * Supported: headings, paragraphs, bold, italic, strikethrough, inline code, fenced code, links
 * (http/https/mailto/tel only), bullet/numbered/task lists (nested by indentation), blockquotes,
 * horizontal rules, pipe tables. Images are rendered as their alt text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul' | 'ol'; items: ListItem[]; start?: number }
  | { t: 'quote'; c: Block[] }
  | { t: 'code'; v: string; lang?: string }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'center' | 'right' | null> };

export interface ListItem {
  task?: boolean;
  checked?: boolean;
  c: Inline[];
  children: Block[];
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Returns a safe href or null (relative links and javascript:/data: URLs are dropped). */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const url = raw.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url);
  if (!m) return null;
  if (!SAFE_PROTOCOLS.has((m[1] ?? '').toLowerCase())) return null;
  return url;
}

// ----------------------------------------------------------------------------- inline

const ESCAPABLE = '\\`*_{}[]()#+-.!|~>';

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1] as string)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: 'code', v: (m[2] as string).replace(/^ (.*) $/, '$1') });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        buf += m[1] ?? '';
        i += m[0].length;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[2] ?? '');
        const inner = parseInline(m[1] ?? '');
        if (href) out.push({ t: 'link', href, c: inner });
        else out.push(...inner);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const isDouble = src[i + 1] === ch;
      const marker = isDouble ? ch + ch : ch;
      const kind: 'strong' | 'em' | 'del' | null = ch === '~' ? (isDouble ? 'del' : null) : isDouble ? 'strong' : 'em';
      if (kind) {
        const prev = i > 0 ? (src[i - 1] as string) : ' ';
        const intraword = ch === '_' && /[A-Za-z0-9]/.test(prev);
        const close = intraword ? -1 : findClose(src, marker, i + marker.length);
        if (close > i + marker.length) {
          flush();
          out.push({ t: kind, c: parseInline(src.slice(i + marker.length, close)) });
          i = close + marker.length;
          continue;
        }
      }
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }
    if (ch === ' ' && src[i + 1] === ' ' && src[i + 2] === '\n') {
      i += 2;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function findClose(src: string, marker: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const j = src.indexOf(marker, i);
    if (j < 0) return -1;
    const before = src[j - 1] as string | undefined;
    const after = src[j + marker.length] as string | undefined;
    // Closing marker must not be preceded by whitespace and (for single markers) not be part of a longer run.
    if (before && !/\s/.test(before) && (marker.length === 2 || after !== marker[0]) && src[j - 1] !== '\\') return j;
    i = j + 1;
  }
  return -1;
}

// ----------------------------------------------------------------------------- blocks

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableDelim(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && (line.includes('|') || /^\s*:?-+:?\s*$/.test(line));
}

function indentOf(line: string): number {
  const ws = /^[ \t]*/.exec(line)?.[0] ?? '';
  return ws.replace(/\t/g, '    ').length;
}

export interface MarkdownOptions { omitTitle?: string }

export function parseMarkdown(src: string, options: MarkdownOptions = {}): Block[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = parseBlocks(lines);
  const first = blocks[0];
  const plain = (parts: Inline[]): string => parts.map(p => p.t === 'br' ? ' ' : 'v' in p ? p.v : plain(p.c)).join('');
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (options.omitTitle && first?.t === 'h' && normalized(plain(first.c)) === normalized(options.omitTitle)) return blocks.slice(1);
  return blocks;
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const isBlank = (l: string | undefined) => l == null || /^\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    // fenced code
    const fence = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
    if (fence) {
      const mark = (fence[1] as string).slice(0, 3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(mark)) body.push(lines[i++] as string);
      i++;
      blocks.push({ t: 'code', v: body.join('\n'), lang: fence[2] || undefined });
      continue;
    }
    // heading
    const hm = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hm) {
      const level = Math.min(4, (hm[1] as string).length) as 1 | 2 | 3 | 4;
      blocks.push({ t: 'h', level, c: parseInline(hm[2] as string) });
      i++;
      continue;
    }
    // hr
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && isTableDelim(lines[i + 1] as string)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] as string).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]) && (lines[i] as string).includes('|')) {
        rows.push(splitRow(lines[i++] as string).map(parseInline));
      }
      blocks.push({ t: 'table', head: head.map(parseInline), rows, align });
      continue;
    }
    // blockquote
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] as string)) body.push((lines[i++] as string).replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ t: 'quote', c: parseBlocks(body) });
      continue;
    }
    // list
    if (BULLET.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }
    // paragraph
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (isBlank(l) || /^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(l) || BULLET.test(l) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) break;
      para.push(l.trim());
      i++;
    }
    if (para.length === 0) {
      para.push((lines[i++] as string).trim());
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start] as string) as RegExpExecArray;
  const baseIndent = indentOf(lines[start] as string);
  const ordered = /\d/.test(first[2] as string);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^\s*$/.test(line)) {
      // a blank line ends the list unless the next non-blank line continues it
      let j = i + 1;
      while (j < lines.length && /^\s*$/.test(lines[j] as string)) j++;
      if (j < lines.length && BULLET.test(lines[j] as string) && indentOf(lines[j] as string) >= baseIndent) {
        i = j;
        continue;
      }
      break;
    }
    const m = BULLET.exec(line);
    const ind = indentOf(line);
    if (m && ind === baseIndent) {
      if (/\d/.test(m[2] as string) !== ordered) break;
      let text = m[3] as string;
      let task: boolean | undefined;
      let checked: boolean | undefined;
      const tm = /^\[( |x|X)\]\s+(.*)$/.exec(text);
      if (tm) {
        task = true;
        checked = tm[1] !== ' ';
        text = tm[2] as string;
      }
      const item: ListItem = { task, checked, c: [], children: [] };
      i++;
      const textLines = [text];
      const nested: string[] = [];
      while (i < lines.length) {
        const nl = lines[i] as string;
        if (/^\s*$/.test(nl)) break;
        const nInd = indentOf(nl);
        if (nInd <= baseIndent && BULLET.test(nl)) break;
        if (nInd > baseIndent && BULLET.test(nl)) {
          nested.push(nl);
          i++;
          continue;
        }
        if (nested.length === 0 && nInd > baseIndent) {
          textLines.push(nl.trim());
          i++;
          continue;
        }
        if (nested.length > 0 && nInd > baseIndent) {
          nested.push(nl);
          i++;
          continue;
        }
        break;
      }
      item.c = parseInline(textLines.join('\n'));
      if (nested.length) item.children = parseBlocks(nested.map((l) => l.slice(Math.min(indentOf(l), baseIndent + 1))));
      items.push(item);
      continue;
    }
    break;
  }
  const startNum = ordered ? Number.parseInt(first[2] as string, 10) : undefined;
  return { block: { t: ordered ? 'ol' : 'ul', items, start: startNum }, next: i };
}

// ----------------------------------------------------------------------------- DOM rendering

function inlineToDom(nodes: Inline[], doc: Document): Node[] {
  return nodes.map((n): Node => {
    switch (n.t) {
      case 'text':
        return doc.createTextNode(n.v);
      case 'br':
        return doc.createElement('br');
      case 'code': {
        const el = doc.createElement('code');
        el.textContent = n.v;
        return el;
      }
      case 'link': {
        const a = doc.createElement('a');
        a.setAttribute('href', n.href);
        a.setAttribute('rel', 'noopener noreferrer nofollow');
        a.setAttribute('target', '_blank');
        a.append(...inlineToDom(n.c, doc));
        return a;
      }
      default: {
        const el = doc.createElement(n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 's');
        el.append(...inlineToDom(n.c, doc));
        return el;
      }
    }
  });
}

function blockToDom(b: Block, doc: Document): Node {
  switch (b.t) {
    case 'h': {
      const el = doc.createElement(`h${Math.min(6, b.level + 1)}`);
      el.append(...inlineToDom(b.c, doc));
      return el;
    }
    case 'p': {
      const el = doc.createElement('p');
      el.append(...inlineToDom(b.c, doc));
      return el;
    }
    case 'hr':
      return doc.createElement('hr');
    case 'code': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.v;
      pre.append(code);
      return pre;
    }
    case 'quote': {
      const el = doc.createElement('blockquote');
      el.append(...b.c.map((x) => blockToDom(x, doc)));
      return el;
    }
    case 'ul':
    case 'ol': {
      const el = doc.createElement(b.t);
      if (b.t === 'ol' && b.start && b.start !== 1) el.setAttribute('start', String(b.start));
      for (const it of b.items) {
        const li = doc.createElement('li');
        if (it.task) {
          li.className = 'rc-md-task';
          const box = doc.createElement('span');
          box.setAttribute('aria-hidden', 'true');
          box.className = 'rc-md-box';
          box.textContent = it.checked ? '☑' : '☐';
          const sr = doc.createElement('span');
          sr.className = 'rc-sr';
          sr.textContent = it.checked ? 'Done: ' : 'To do: ';
          li.append(box, sr);
        }
        li.append(...inlineToDom(it.c, doc));
        if (it.children.length) li.append(...it.children.map((x) => blockToDom(x, doc)));
        el.append(li);
      }
      return el;
    }
    case 'table': {
      const wrap = doc.createElement('div');
      wrap.className = 'rc-md-table';
      const table = doc.createElement('table');
      const thead = doc.createElement('thead');
      const hr = doc.createElement('tr');
      b.head.forEach((c, idx) => {
        const th = doc.createElement('th');
        th.setAttribute('scope', 'col');
        const al = b.align[idx];
        if (al) th.style.textAlign = al;
        th.append(...inlineToDom(c, doc));
        hr.append(th);
      });
      thead.append(hr);
      const tbody = doc.createElement('tbody');
      for (const r of b.rows) {
        const tr = doc.createElement('tr');
        r.forEach((c, idx) => {
          const td = doc.createElement('td');
          const al = b.align[idx];
          if (al) td.style.textAlign = al;
          td.append(...inlineToDom(c, doc));
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }
  }
}

/** Render markdown into a DocumentFragment. Heading levels are shifted down one (# -> h2) so the page keeps a single h1. */
export function renderMarkdown(src: string, doc: Document = document, options: MarkdownOptions = {}): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const b of parseMarkdown(src, options)) frag.append(blockToDom(b, doc));
  return frag;
}
