import type { ServerConfig } from '@opencoach/protocol';

/** http→ws / https→wss for the same host (explicit, because 'self' does not cover ws: in every browser). */
function wsOrigin(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
}

/**
 * CSP for the app shell (gateway origin). Views are framed from the views origin; WebRTC SDP exchange for
 * realtime calls goes to the OpenAI API directly from the browser (SPEC §11.2).
 */
export function appCsp(config: ServerConfig): string {
  const publicOrigin = new URL(config.publicUrl).origin;
  const viewsOrigin = new URL(config.viewsUrl).origin;
  const connect = new Set<string>(["'self'", wsOrigin(publicOrigin), 'https://api.openai.com']);
  const openaiBase = config.providers.openai?.baseUrl;
  if (openaiBase) {
    try {
      connect.add(new URL(openaiBase).origin);
    } catch {
      /* ignore invalid custom base url */
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    `frame-src ${viewsOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Headers for every gateway response. */
export function appSecurityHeaders(config: ServerConfig): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': appCsp(config),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
  };
  if (new URL(config.publicUrl).protocol === 'https:') h['Strict-Transport-Security'] = 'max-age=15552000';
  return h;
}

/**
 * CSP for coach-authored views on the isolated views origin (Appendix C §C.4, [SEC-3]):
 * scripts and styles only from the view bundle and the kit (both served from this origin), no network.
 */
export function viewsCsp(config: ServerConfig): string {
  const publicOrigin = new URL(config.publicUrl).origin;
  const viewsOrigin = new URL(config.viewsUrl).origin;
  return [
    "default-src 'none'",
    `script-src 'self' ${viewsOrigin}`,
    `style-src 'self' 'unsafe-inline' ${viewsOrigin}`,
    `img-src 'self' data: blob: ${viewsOrigin}`,
    `font-src 'self' ${viewsOrigin}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${publicOrigin}`,
  ].join('; ');
}

/**
 * Headers for the views origin. The iframe is sandboxed without allow-same-origin, so its document has an opaque
 * origin: module scripts, fonts and imports are fetched in CORS mode and need `Access-Control-Allow-Origin: *`.
 * The content is a capability URL (random token in the path), never cookie-authenticated, so `*` is safe.
 */
export function viewsSecurityHeaders(config: ServerConfig): Record<string, string> {
  return {
    'Content-Security-Policy': viewsCsp(config),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}
