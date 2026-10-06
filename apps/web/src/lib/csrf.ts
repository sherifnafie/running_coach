/** The session proof is intentionally readable; the session itself remains HttpOnly. */
export function csrfTokenFromCookie(cookie: string): string | undefined {
  for (const part of cookie.split(';')) {
    const equal = part.indexOf('=');
    if (equal < 0 || part.slice(0, equal).trim() !== 'oc_csrf') continue;
    const token = part.slice(equal + 1).trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  }
  return undefined;
}

/** Read at dispatch, including offline queue replay after the athlete signs into a new session. */
export function browserCsrfHeaders(method: string): Record<string, string> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) || typeof document === 'undefined') return {};
  const token = csrfTokenFromCookie(document.cookie);
  return token ? { 'X-CSRF-Token': token } : {};
}
