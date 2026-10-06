# View bridge

The kit is the view-side client for JSON-RPC 2.0 over `postMessage`. Data access
goes through the authenticated shell to the gateway. The gateway enforces each
published manifest; a view cannot grant itself access by editing local JS.
Never use fetch, credentials, storage, or external services in a view.

```js
import { coach } from '/kit/1/kit.js';
await coach.ready;
const refresh = async () => {
  const rows = await coach.db.query('SELECT id, title FROM planned_workouts WHERE date = ?',
    [coach.dates.todayIn(coach.env.now().getTime(), coach.env.tz)]);
  // Build safe DOM from rows.
};
const unsubscribe = coach.subscribe(['db:planned_workouts'], refresh);
await refresh();
// On teardown: unsubscribe().
```

## Public API

| Method | Behavior |
| --- | --- |
| `await coach.ready` | Resolves after the host handshake and applies the environment |
| `coach.db.query(sql, params?)` | SELECT/WITH only; declared tables, 5,000 rows, 2 s server timeout; returns rows |
| `coach.db.one(sql, params?)` | First row or `undefined` |
| `coach.db.write(target, op, row, key?)` | `insert`, `update`, or `delete`; declared table, operations and columns; update/delete require a key; emits `user.ui_write` |
| `coach.files.read(path)` | Workspace-relative path matching a declared `file:` glob; returns text |
| `coach.act(name, payload?, {wake}?)` | Declared action; emits `user.ui_action`; use wake when the coach should respond |
| `coach.navigate(viewId, params?)` | Opens another view; parameter values are strings |
| `coach.openChat({prefill, ref}?)` | Opens the always-available chat; `ref: {viewId, params?}` |
| `coach.subscribe(targets, callback)` | Refresh notification; returns an unsubscribe function; callback receives changed targets |
| `coach.toast(text)` | Short status message |
| `coach.report(level, message, detail?)` | `error`, `warn`, `info`; uncaught errors and CSP violations are captured automatically |
| `coach.onEnv(callback)` | Respond to theme/locale/timezone/viewport changes; returns unsubscribe |
| `coach.track(promise)` | Include asynchronous render work in the first-render report |
| `coach.id()` | New ULID based on the harness clock, for direct row inserts |
| `coach.json(value, fallback?)` | Parse a JSON column safely; objects pass through |

`coach.env` includes `theme`, `locale`, `units`, `tz`, `safeArea`, `viewport`,
`online`, `viewId`, `params`, `mode` (`live` or `preview`), `weekStartsOn`, and
`now()`. The host sends `nowMs` from its injected clock; the client advances it
using elapsed performance time. Await `ready` before relying on these values.

Direct writes are immediate, may queue offline, and remain visible to the coach
through events. Use an optimistic update with rollback when a write rejects;
display a useful error. For example, marking a session done writes its `status`
then emits a declared `workout_done` action. Do not infer clinical or training
judgments from a successful database write.

## Wire contract

Each request is `{jsonrpc:'2.0', id, method, params?}`. The response repeats `id`
with either `result` or `error:{code,message,data?}`. Hosts accept messages only
from their iframe's `contentWindow`; clients accept responses only from
`window.parent`. Sandboxed views have opaque origins, so `targetOrigin:'*'` is
necessary; checking the source window is the authentication boundary.

Results: `ready` / `env.get` return bare ViewEnv, `db.query` returns a row array,
`files.read` returns a string, `subscribe` returns `{subscriptionId:string}`,
and successful mutations/navigation/reporting return `null`.

Host notifications have no id:

```js
{ jsonrpc: '2.0', method: 'changed',
  params: { subscriptionIds: ['sub_1'], targets: ['db:planned_workouts'] } }
{ jsonrpc: '2.0', method: 'env.changed', params: { /* ViewEnv */ } }
```

`unsubscribe` sends `{subscriptionId}`. The kit routes changes to the registered
subscriptions; callers should use `coach.subscribe` instead of handling the
wire protocol. Timeouts and server errors reject requests. Report persistent
failures and keep the chat shortcut usable.
