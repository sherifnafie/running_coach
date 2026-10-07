/** Colour helpers for the coach-provided accent (SPEC §9.5): pick readable text for it. */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White or near-black, whichever reads better on `accent`. */
export function contrastText(accent: string): '#ffffff' | '#111214' {
  return contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#111214') ? '#ffffff' : '#111214';
}

/** Keep accent-colored text readable, including very pale/dark custom colors. */
export function accentText(accent: string, surface: string): string {
  if (contrastRatio(accent, surface) >= 4.5) return accent;
  const target = relativeLuminance(surface) > .4 ? '#111214' : '#ffffff';
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const from = rgb(accent), to = rgb(target);
  for (let step = 1; step <= 20; step++) {
    const hex = '#' + from.map((value, i) => Math.round(value + (to[i]! - value) * step / 20).toString(16).padStart(2, '0')).join('');
    if (contrastRatio(hex, surface) >= 4.5) return hex;
  }
  return target;
}
