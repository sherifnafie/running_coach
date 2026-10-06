/** Safe-area insets (px) for `ViewEnv.safeArea`, measured with a probe element using CSS `env(safe-area-inset-*)`. */
let probe: HTMLDivElement | null = null;

export function readSafeArea(): { top: number; right: number; bottom: number; left: number } {
  try {
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    const n = (v: string) => Math.max(0, Math.round(parseFloat(v) || 0));
    return { top: n(cs.paddingTop), right: n(cs.paddingRight), bottom: n(cs.paddingBottom), left: n(cs.paddingLeft) };
  } catch {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
}
