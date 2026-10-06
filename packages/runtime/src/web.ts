import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ToolError, type ServerConfig, type WebPort, type WebSearchBackend } from '@opencoach/protocol';

/** Web search backends (SPEC §7). */
export function createWebSearchBackend(cfg: ServerConfig['web']['search']): WebSearchBackend | undefined {
  switch (cfg.provider) {
    case 'brave':
      if (!cfg.apiKey) return undefined;
      return {
        kind: 'brave',
        async search(query, n) {
          const url = new URL(cfg.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search');
          url.searchParams.set('q', query);
          url.searchParams.set('count', String(n));
          const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.apiKey! }, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new ToolError('INTERNAL', `Brave search failed: HTTP ${res.status}`, res.status >= 500);
          const j = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
          return (j.web?.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description ?? '') }));
        },
      };
    case 'tavily':
      if (!cfg.apiKey) return undefined;
      return {
        kind: 'tavily',
        async search(query, n) {
          const res = await fetch(cfg.baseUrl ?? 'https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: n }),
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) throw new ToolError('INTERNAL', `Tavily search failed: HTTP ${res.status}`, res.status >= 500);
          const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
          return (j.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 500) }));
        },
      };
    case 'searxng':
      if (!cfg.baseUrl) return undefined;
      return {
        kind: 'searxng',
        async search(query, n) {
          const url = new URL('/search', cfg.baseUrl);
          url.searchParams.set('q', query);
          url.searchParams.set('format', 'json');
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!res.ok) throw new ToolError('INTERNAL', `SearXNG search failed: HTTP ${res.status}`, res.status >= 500);
          const j = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
          return (j.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
        },
      };
    default:
      return undefined;
  }
}

export function createWebPort(cfg: ServerConfig['web'], backend?: WebSearchBackend): WebPort {
  return {
    async search(query, maxResults) {
      if (!backend) throw new ToolError('NOT_CONFIGURED', 'Web search is not configured on this server (web.search.provider). Ask the athlete or rely on your knowledge.');
      return backend.search(query, maxResults);
    },
    async fetch(url, _prompt) {
      if (!cfg.fetch.enabled) throw new ToolError('NOT_CONFIGURED', 'Web fetch is disabled on this server.');
      return safeFetch(url, cfg.fetch.timeoutMs, cfg.fetch.maxBytes);
    },
  };
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses (SSRF guard). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError('NOT_ALLOWED', 'Only http and https URLs can be fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new ToolError('NOT_FOUND', `Could not resolve ${host}.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new ToolError('NOT_ALLOWED', 'That address is on a private network and cannot be fetched.');
}

export async function safeFetch(raw: string, timeoutMs: number, maxBytes: number): Promise<{ url: string; title?: string; text: string }> {
  let url = new URL(raw);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'OpenCoach/0.1 (+https://github.com/sherifnafie/running_coach)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new ToolError('NOT_FOUND', `HTTP ${res.status} fetching ${url.href}`, res.status >= 500);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const type = res.headers.get('content-type') ?? '';
    if (/html/i.test(type) || /^\s*<!doctype html|<html/i.test(body)) {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
      return { url: url.href, title: title ? decodeEntities(title) : undefined, text: htmlToText(body) };
    }
    return { url: url.href, text: body };
  }
  throw new ToolError('NOT_FOUND', 'Too many redirects.');
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ''));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}
