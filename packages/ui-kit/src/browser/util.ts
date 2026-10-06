/**
 * Small DOM + parsing helpers shared by the kit. Rule: never assign untrusted strings to
 * innerHTML. `h()` / `s()` build nodes with textContent only.
 */

export type Row = Record<string, unknown>;

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(el: Element, attrs?: Attrs): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.setAttribute('class', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(typeof c === 'number' ? String(c) : c);
  }
}

/** Create an HTML element. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

/** Create an SVG element. */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

/** Parse a JSON attribute/column leniently: objects pass through, strings are parsed, junk gives the fallback. */
export function parseJson<T = unknown>(v: unknown, fallback: T | undefined = undefined): T | undefined {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bool(v: string | null | undefined): boolean {
  return v != null && v !== 'false' && v !== '0';
}

let uidCounter = 0;
export function uid(prefix = 'rc'): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** "left_achilles" -> "Left achilles" */
export function humanize(id: string): string {
  const t = id.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...a);
    }, ms);
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return d;
}

/** Extract the tables a SQL string reads from (FROM / JOIN) as "db:<table>" targets. */
export function sqlTargets(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const t = m[1];
    if (t && !/^(select|lateral|values)$/i.test(t)) out.add(`db:${t}`);
  }
  return [...out];
}

export function isRecord(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Does `target` ("db:x" / "file:plan/x.md") match a subscription pattern ("db:*", "db:x", "file:plan/*")? */
export function targetMatches(pattern: string, target: string): boolean {
  if (pattern === '*' || pattern === target) return true;
  if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('file:') && target.startsWith('file:')) {
    const re = new RegExp(
      '^' +
        pattern
          .slice(5)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\u0000/g, '.*') +
        '$',
    );
    return re.test(target.slice(5));
  }
  return false;
}
