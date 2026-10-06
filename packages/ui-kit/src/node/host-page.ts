/**
 * The preview host page: embeds a view in <iframe sandbox="allow-scripts"> at the variant's
 * viewport size and implements the host side of the bridge (SPEC §9.6, ADR 0003). It is trusted
 * code served by the preview server; the view itself runs in an opaque-origin sandbox.
 *
 * Every bridge call except ready/env.get is forwarded to the preview server (/__api/call), which
 * validates it against the view manifest and records problems.
 */
export const HOST_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCoach preview host</title>
<style>html,body{margin:0;padding:0;background:#8a8a8a}iframe{display:block;border:0;background:#fff}</style>
</head><body><script src="/__host.js"></script></body></html>`;

export const HOST_JS = `(() => {
  const cfg = JSON.parse(new URLSearchParams(location.search).get('cfg') || '{}');
  const P = (window.__preview = { done: false, renderedAt: null, fallbackAt: null, loadAt: null, readySeen: false, height: 0, calls: 0 });
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.title = 'view';
  iframe.style.width = cfg.w + 'px';
  iframe.style.height = cfg.h + 'px';
  window.__setFrameHeight = (h) => { iframe.style.height = h + 'px'; };

  const finish = (t) => { if (!P.done) { P.renderedAt = t; P.done = true; } };
  iframe.addEventListener('load', () => {
    P.loadAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const t = performance.now();
      // The kit reports "rendered" itself; if no kit ever said ready, fall back to load + 2 frames.
      setTimeout(() => { if (!P.readySeen && !P.done) { P.fallbackAt = t; finish(t); } }, 250);
    }));
  });

  const env = () => ({
    theme: cfg.theme, locale: cfg.locale, units: cfg.units, tz: cfg.tz, nowMs: cfg.nowMs,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, viewport: { w: cfg.w, h: cfg.h }, online: true,
    viewId: cfg.view, params: {}, mode: 'preview', ...(cfg.accent ? { accent: cfg.accent } : {}),
  });

  async function call(method, params) {
    const r = await fetch('/__api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-preview-token': cfg.token },
      body: JSON.stringify({ view: cfg.view, variant: cfg.variant, empty: cfg.empty, method, params }),
    });
    return r.json();
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
    P.calls++;
    const reply = (msg) => { try { ev.source.postMessage(Object.assign({ jsonrpc: '2.0', id: m.id }, msg), '*'); } catch (e) {} };
    if (m.method === 'ready' || m.method === 'env.get') {
      if (m.method === 'ready') P.readySeen = true;
      return reply({ result: env() });
    }
    if (m.method === 'resize' && m.params && Number.isFinite(m.params.height)) P.height = m.params.height;
    if (m.method === 'report' && m.params && m.params.level === 'info' && m.params.message === 'rendered') finish(performance.now());
    try {
      const j = await call(m.method, m.params);
      reply(j.error ? { error: j.error } : { result: j.result === undefined ? null : j.result });
    } catch (e) {
      reply({ error: { code: -32603, message: String(e) } });
    }
  });

  iframe.src = '/v/' + encodeURIComponent(cfg.view) + '/' + cfg.entry.split('/').map(encodeURIComponent).join('/');
  document.body.appendChild(iframe);
})();`;
