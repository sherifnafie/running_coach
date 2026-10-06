/**
 * Files of the mock "Today" view served from the mock views origin (a second port), plus a trivial kit that speaks the
 * bridge protocol (JSON-RPC 2.0 over postMessage) so the shell's bridge host can be exercised end to end.
 */
export const KIT_JS = `(() => {
  'use strict';
  const pending = new Map();
  const subs = new Map();
  let seq = 1;
  let subSeq = 1;
  const envListeners = new Set();
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  window.addEventListener('message', (ev) => {
    if (ev.source !== parent) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      else p.resolve(m.result);
      return;
    }
    if (m.method === 'changed') for (const cb of subs.values()) cb();
    if (m.method === 'env.changed') {
      coach.env = m.params;
      for (const cb of envListeners) cb(m.params);
    }
  });
  const coach = {
    env: null,
    ready: async () => {
      coach.env = await call('ready');
      return coach.env;
    },
    onEnv: (cb) => { envListeners.add(cb); return () => envListeners.delete(cb); },
    db: {
      query: (sql, params) => call('db.query', { sql, params }),
      write: (target, op, row, key) => call('db.write', { target, op, row, key }),
    },
    files: { read: (path) => call('files.read', { path }) },
    act: (name, payload, opts) => call('act', { name, payload, wake: opts && opts.wake }),
    navigate: (viewId, params) => call('navigate', { viewId, params }),
    openChat: (opts) => call('openChat', opts || {}),
    subscribe: (targets, cb) => {
      const key = subSeq++;
      subs.set(key, cb);
      call('subscribe', { targets });
      return () => subs.delete(key);
    },
    toast: (text) => call('toast', { text }),
    report: (level, message, detail) => call('report', { level, message, detail }),
    resize: (height) => call('resize', { height }),
  };
  window.coach = coach;
  window.addEventListener('error', (e) => { coach.report('error', String(e.message), { stack: e.error && e.error.stack }); });
  window.addEventListener('unhandledrejection', (e) => { coach.report('error', String(e.reason && e.reason.message || e.reason)); });
})();
`;

export const KIT_CSS = `:root { --rc-bg:#f6f5f2; --rc-surface:#fff; --rc-text:#1b1c1e; --rc-muted:#5f6269; --rc-border:#d9d7d0; --rc-accent:#c8431c; }
html[data-theme='dark'] { --rc-bg:#101113; --rc-surface:#1a1b1e; --rc-text:#ececea; --rc-muted:#a2a5ad; --rc-border:#34363b; --rc-accent:#ef6a3f; }
html, body { margin:0; background: var(--rc-bg); color: var(--rc-text); font: 16px/1.4 system-ui, sans-serif; }
main { padding: 16px; max-width: 640px; margin: 0 auto; }
h1 { margin: 0 0 12px; font-size: 1.4rem; }
ul { list-style: none; padding: 0; margin: 0 0 16px; }
li { background: var(--rc-surface); border: 1px solid var(--rc-border); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; gap: 8px; }
button { min-height: 44px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--rc-border); background: var(--rc-surface); color: var(--rc-text); font: inherit; margin-right: 8px; }
button.primary { background: var(--rc-accent); color: #fff; border-color: var(--rc-accent); }
small { color: var(--rc-muted); }
`;

export function indexHtml(viewId: string, version: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${viewId}</title>
<link rel="stylesheet" href="/kit/1/kit.css"><script src="/kit/1/kit.js"></script>
</head><body><main>
<h1 id="title">Today</h1>
<p><small id="env">loading…</small></p>
<ul id="list" aria-label="Planned workouts"></ul>
<button class="primary" id="done">Mark easy run done</button>
<button id="ask">Ask coach</button>
<button id="toast">Toast</button>
<p><small id="marker">version ${version}</small></p>
</main><script src="app.js"></script></body></html>`;
}

export function appJs(broken: boolean): string {
  if (broken) return `throw new Error('mock view is broken on purpose');\n`;
  return `(async () => {
  const env = await coach.ready();
  const apply = (e) => { document.documentElement.dataset.theme = e.theme; document.getElementById('env').textContent = 'theme ' + e.theme + ' · ' + e.tz + ' · ' + e.units + (e.online ? '' : ' · offline'); };
  apply(env);
  coach.onEnv(apply);
  const list = document.getElementById('list');
  async function load() {
    const rows = await coach.db.query('select * from planned_workouts order by date');
    list.innerHTML = '';
    for (const r of rows) {
      const li = document.createElement('li');
      li.textContent = r.title + ' ';
      const s = document.createElement('small');
      s.textContent = r.status;
      li.appendChild(s);
      list.appendChild(li);
    }
  }
  await load();
  coach.subscribe(['db:planned_workouts', 'db:checkins'], load);
  document.getElementById('done').addEventListener('click', async () => {
    await coach.db.write('checkins', 'insert', { note: 'easy run done' });
    await coach.act('ask_coach', { topic: 'easy run' }, { wake: false });
    coach.toast('Saved');
  });
  document.getElementById('ask').addEventListener('click', () => coach.openChat({ prefill: 'About today: ' }));
  document.getElementById('toast').addEventListener('click', () => coach.toast('Hello from the view'));
})().catch((e) => coach.report('error', String(e && e.message || e), { stack: e && e.stack }));
`;
}

export function cardHtml(viewId: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${viewId} card</title>
<link rel="stylesheet" href="/kit/1/kit.css"><script src="/kit/1/kit.js"></script>
</head><body><main><strong id="card">Easy 8 km today</strong><br><small>Keep it conversational.</small></main>
<script src="card.js"></script>
</body></html>`;
}

export const CARD_JS = `coach.ready().then((e) => { document.documentElement.dataset.theme = e.theme; coach.resize(96); });\n`;
