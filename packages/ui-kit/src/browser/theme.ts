/**
 * Theme helpers: WCAG contrast math and accent derivation. The CSS carries static defaults for
 * both themes; this module only runs when the host supplies a custom accent (app.json theme.accent).
 */

export const SURFACES = {
  light: { bg: '#f9f9f7', surface: '#ffffff' },
  dark: { bg: '#111110', surface: '#1b1b1a' },
} as const;

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return a;
  return rgbToHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t]);
}

export interface AccentTokens {
  accent: string;
  onAccent: string;
  accentText: string;
  accentSoft: string;
}

/** Derive accessible accent tokens for a theme from a brand colour. */
export function deriveAccent(accent: string, theme: 'light' | 'dark'): AccentTokens | null {
  if (!hexToRgb(accent)) return null;
  const { bg, surface } = SURFACES[theme];
  const white = '#ffffff';
  const ink = '#0b0b0b';
  const onAccent = contrast(white, accent) >= 4.5 || contrast(white, accent) >= contrast(ink, accent) ? white : ink;
  // Text-safe variant: move toward black (light) or white (dark) until it reads on the page background.
  const target = theme === 'light' ? '#000000' : '#ffffff';
  let text = accent;
  for (let i = 1; i <= 20 && contrast(text, bg) < 4.5; i++) text = mix(accent, target, i / 20);
  return { accent, onAccent, accentText: text, accentSoft: mix(accent, surface, theme === 'light' ? 0.88 : 0.78) };
}

export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? `#${(m[1] as string).toLowerCase()}` : null;
}

export function applyAccent(root: HTMLElement, accent: unknown, theme: 'light' | 'dark'): void {
  const hex = normalizeHex(accent);
  const names = ['--rc-accent', '--rc-on-accent', '--rc-accent-text', '--rc-accent-soft'];
  if (!hex) {
    for (const n of names) root.style.removeProperty(n);
    return;
  }
  const t = deriveAccent(hex, theme);
  if (!t) return;
  root.style.setProperty('--rc-accent', t.accent);
  root.style.setProperty('--rc-on-accent', t.onAccent);
  root.style.setProperty('--rc-accent-text', t.accentText);
  root.style.setProperty('--rc-accent-soft', t.accentSoft);
}
