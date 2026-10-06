/**
 * A small SQLite tokenizer, used to (a) split statements without being fooled by semicolons inside
 * strings/comments/quoted identifiers and (b) scan for forbidden keywords. It only needs to be
 * exact about token boundaries; it does not parse.
 */
import { ToolError } from '@opencoach/protocol';

export type TokenKind = 'word' | 'string' | 'qident' | 'number' | 'param' | 'punct';

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  /** Unquoted content for strings and quoted identifiers; the word itself for words. */
  value: string;
  start: number;
  end: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;

export function lexSql(sql: string): Token[] {
  const toks: Token[] = [];
  const n = sql.length;
  let i = 0;
  const fail = (what: string, at: number): never => {
    throw new ToolError('INVALID_INPUT', `SQL syntax error: unterminated ${what} starting at offset ${at}`);
  };
  while (i < n) {
    const c = sql[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2; // SQLite accepts an unterminated block comment at end of input
      continue;
    }
    const start = i;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= n) fail(c === "'" ? 'string literal' : 'quoted identifier', start);
        const ch = sql[j]!;
        if (ch === c) {
          if (sql[j + 1] === c) {
            value += c;
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += ch;
        j++;
      }
      toks.push({ kind: c === "'" ? 'string' : 'qident', text: sql.slice(start, j), value, start, end: j });
      i = j;
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) fail('bracketed identifier', start);
      toks.push({ kind: 'qident', text: sql.slice(start, end + 1), value: sql.slice(i + 1, end), start, end: end + 1 });
      i = end + 1;
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && DIGIT.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) {
        if ((sql[j] === 'e' || sql[j] === 'E') && (sql[j + 1] === '+' || sql[j + 1] === '-') && !/^0[xX]/.test(sql.slice(i, j))) j++;
        j++;
      }
      toks.push({ kind: 'number', text: sql.slice(start, j), value: sql.slice(start, j), start, end: j });
      i = j;
      continue;
    }
    if (c === '?' ) {
      let j = i + 1;
      while (j < n && DIGIT.test(sql[j]!)) j++;
      toks.push({ kind: 'param', text: sql.slice(start, j), value: sql.slice(start, j), start, end: j });
      i = j;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && WORD_START.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      toks.push({ kind: 'param', text: sql.slice(start, j), value: sql.slice(start, j), start, end: j });
      i = j;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      const w = sql.slice(start, j);
      toks.push({ kind: 'word', text: w, value: w, start, end: j });
      i = j;
      continue;
    }
    toks.push({ kind: 'punct', text: c, value: c, start, end: i + 1 });
    i++;
  }
  return toks;
}

/** Split on top-level `;` tokens; empty statements (stray/trailing semicolons) are dropped. */
export function splitStatements(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  for (const t of toks) {
    if (t.kind === 'punct' && t.text === ';') {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Maximum parenthesis nesting depth of a token list. */
export function maxParenDepth(toks: Token[]): number {
  let d = 0;
  let max = 0;
  for (const t of toks) {
    if (t.kind !== 'punct') continue;
    if (t.text === '(') max = Math.max(max, ++d);
    else if (t.text === ')') d = Math.max(0, d - 1);
  }
  return max;
}
