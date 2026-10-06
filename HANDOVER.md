# HANDOVER: OpenCoach implementation status

**Written:** 2026-10-06, at the point the original agent ran out of budget.
**Branch:** `ccr-a500ac00-ytsl89`. All work is committed and pushed here.
**Goal:** a full end-to-end implementation of `SPEC.md`: Phase 1 MVP plus the core of Phase 2 (calls, helpers, MCP, native shell). The user asked for a complete implementation.

Read in this order: this file → `AGENTS.md` → `docs/implementation.md` (package map, data/seed layout, conventions, context-rendering format) → the `SPEC.md` section for your task → `packages/protocol/src/*` (the contracts).

---

## 1. State at a glance (updated at the moment of handover)

At the last minute, all parallel work-in-progress branches were **merged into this branch**, so everything below is in the repo.

**Snapshot:** `npx tsc -p tsconfig.json` shows 3 errors, all in `apps/server/src/http/context.ts`. Missing `@fastify/cookie` type augmentation: register the plugin / import its types. `npx vitest run packages`: **611 passed, 7 failed** (31 files).

| Package / area | Status |
|---|---|
| `packages/protocol` | ✅ done, tested |
| `packages/engine` | ✅ done, 201 tests |
| `packages/voice` | ✅ done, 64 tests |
| `packages/tools` | ✅ done (exercised via runtime tests) |
| `packages/runtime` | ✅ written. Unit tests pass. Integration `test/runtime.test.ts`: 9/13 pass. **Failing:** quiet-hours hold/release, steering [RT-3], publish/revert [WS-5], helpers in worktree [SUB-3]. Debug these first: they may be runtime bugs or test assumptions. |
| `packages/store` | ✅ all `Store` methods, ~70 tests pass |
| `packages/sandbox` | ✅ local namespace provider (uses pivot_root) + unsafe fallback, tested. ⚠️ `docker.ts`/`fake-docker.ts` were never run or typechecked against a real daemon; `docker.test.ts` is missing. libfaketime is absent here, so `fakeTime` is untested. |
| `packages/workspace` | ✅ every export implemented, ~140 tests. ⚠️ 3 `mounted-fs.test.ts` failures (read bytes/text, write-scope globs, symlink bypass). No tests for blobs, images, export/import or buildSystemDir. `runViewQuery` uses a SIGKILLed child process because `Worker.terminate()` can't interrupt node:sqlite. **Security gap:** `/workspace/.git` should not be writable from the sandbox; consider an ro bind of `.git`. |
| `packages/ui-kit` | 🟡 browser kit builds (kit.js 90 KB), `kitDistDir`/`kitDocsDir`, renderer runs end to end on a trivial view. ⚠️ No tests; the 4 seed views (`seed/running/workspace/ui/`) were never run through the renderer; the **docs files are missing** (`packages/ui-kit/docs/{ui-kit,bridge,views}.md`); the bridge `changed`/`subscribe` payload shapes are guesses. The views origin must send `Access-Control-Allow-Origin: *` (sandboxed iframes load module scripts in CORS mode). |
| `seed/` | 🟡 constitution (~3.3k words assembled), coaching/safety pack, pack.json, 8 addenda, workspace template, 4 docs, changelog, 12 skills, 7 scripts. ⚠️ Missing: `SKILL.md` for `calendar-export` and `data-hygiene` (their scripts exist), and `seed/seed.test.ts`. |
| `apps/web` | 🟡 typecheck + build pass, 100 unit tests (stream reducer, bridge host, markdown, micro-UI, offline queue, WS, nav, safety, SW). ⚠️ The Playwright e2e and `dev/mock-server.ts` have never been run. Response shapes for views/settings/admin/export are assumed: reconcile them with the server (§4.7). Bundle ~560 kB (no code-splitting). |
| `apps/server` | 🔴 partial: `config.ts` (YAML + env, model defaults, demo fallback, origin checks), `paths.ts`, `setup-code.ts`, `http/{errors,static,security,auth,context,sockets,visibility}.ts`. **Missing:** gateway.ts and all routes, the views-origin server, push, telegram, `compose.ts`, main/CLI/bin, Docker files, config example, `.env.example`, `docs/self-hosting.md`, all tests. Contract note: Store has no "extend session expiry", so renewal recreates the session. |
| `packages/evals-sim` + `evals/` | 🔴 partial: persona schema + YAML loader, 12 personas, seeded RNG, date utils, types. **Missing:** physiology, artifacts, athletes, runner, graders, judges, reference/bad coach, suites, conformance, CLI, README, tests. |
| `apps/native` | ✅ scaffold (not compiled, no Android SDK) |
| CI (`.github/workflows`) | written. It references scripts that don't exist yet (`build` per package, `eval:selftest`). |

The WIP commits are on this branch (look for commit subjects starting with "WIP:"); each lists what works and what's missing. The **stub signatures in each package's `src/index.ts` are the contracts**: keep them.

---

## 2. Environment facts (verified)

- Node 22.22, pnpm 10.28 (workspaces), TypeScript **5.9 pinned on purpose** (TS 7, the Go port, is available; don't upgrade), vitest 5. Packages are consumed as TS source (`main: ./src/index.ts`); there is no build step except `apps/web` (Vite) and the browser kit bundle (esbuild).
- `node:sqlite` (built-in) works with **FTS5 + JSON1**, SQLite 3.50; `require('node:sqlite').backup` exists. There is no `sqlite3` CLI; Python's `sqlite3` module works.
- **Unprivileged namespaces work:** `unshare --user --map-root-user --mount --net --fork` plus a tmpfs root, rbinds of `/usr /bin /lib /lib64 /etc /opt /sbin`, the workspace bind (rw), raw/history/system bind + `remount,bind,ro`, rbind `/dev`, tmpfs `/tmp`, then `chroot`. This was verified: writes are visible on the host, `/raw` is read-only, there is no network, and node and python run. This is the design for `LocalSandboxProvider` (ADR 0004).
- There is no Docker daemon, so the Docker provider can't be tested here (test it against a fake Engine API on a unix socket).
- Chromium for Playwright: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`). Don't download browsers.
- **No LLM API keys.** Everything is tested with the scripted provider (`createScriptedProvider`) and the demo coach (`demoCoachHandler`). The server must fall back to demo mode when there are no keys.
- Commit message footer (required on every commit):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WPiRtEzzvXsDneMb9aHwvM
  ```
- Push only to `ccr-a500ac00-ytsl89`. Don't open a PR unless asked.

Commands: `pnpm install` · `npx tsc -p tsconfig.json` (root typecheck; also `pnpm typecheck`) · `npx vitest run packages/<pkg>` · `pnpm test`.

---

## 3. Recommended order of work

1. Fix the 3 server typecheck errors and the 7 failing tests (runtime integration + mounted-fs) → 2. finish the **seed** gaps (2 skills + seed.test.ts) → 3. **ui-kit**: docs, tests, run the seed views through the renderer → 4. **server** (largest remaining piece; the PWA depends on it) → 5. **web** e2e against the real server → 6. **evals** → 7. **integration**: Playwright e2e against the real server in demo mode, Docker, CI scripts, README quickstart, spec updates.

Each item below is a condensed version of the brief the original agent wrote. The detailed behavior is also in the stub JSDoc and the SPEC.

---

## 4. Work packages

### 4.1 `@opencoach/store`: `openSqliteStore({ path, clock }): Promise<Store>`
Implement **every** method of `Store` (`packages/protocol/src/store.ts`) on `node:sqlite`.
- PRAGMAs: WAL (not for `:memory:`), `foreign_keys`, `busy_timeout=5000`. Migrations via `user_version`.
- Tables: athletes, settings (json), pairing_codes, sessions (token_hash unique), passkeys, events (id ULID PK, athlete_id, ts, type, actor, turn_id, causation_id, payload JSON, tombstoned) + `events_fts` (FTS5 over text extracted from payloads: message text, captions, transcripts, purposes, summaries, notice text), message_state, blobs (PK athlete+sha), schedules (spec JSON, `next_fire_at` indexed), epochs, epoch_items (PK epoch_id+seq), turns, turn_contexts, tasks, usage, push_subscriptions, ui_versions + ui_current, audit, idempotency (with expiry), kv.
- `appendEvent`: `parseEventPayload(type, payload)` (applies defaults), `id = e.id ?? newId('evt', clock)`, `ts = e.ts ?? clock.now().toISOString()`. `listEvents`: compare `afterId`/`beforeId` by id (ULIDs sort), filter by types, since/until on ts; `order` controls sorting (default asc).
- `searchEvents`: FTS5 MATCH with escaped terms (fall back to LIKE), `snippet()`.
- `tombstoneEvent`: replace the payload with `{"tombstoned":true}` and drop the FTS row.
- `countProactiveSince`: message_state with proactive=1, delivery 'sent', `sent_at >= since`. `lastProactiveAt`, `markRead`, `countUnreadCoachMessages` (sent and unread).
- `consumePairingCode`: atomic (UPDATE … WHERE unconsumed AND unexpired RETURNING).
- `updateSettings` uses `mergeSettings`; `getSettings` uses `parseSettings`.
- `deleteAthlete` removes all rows for the athlete in every table.
- `dueSchedules`: active with `next_fire_at <= now`, ordered by that column. `nextScheduleAt`: the minimum.
- `getOpenEpoch`: `closed_at IS NULL`.
- `usageByDay`: group by `substr(at,1,10)`.
- Return JSON columns parsed back, and omit optional fields rather than returning null.
- Thorough tests are needed.

### 4.2 `@opencoach/workspace` (see the JSDoc on every function in `src/index.ts`)
Deps already present: yaml, picomatch, tinyglobby, node-sql-parser, sharp, tar.
- **buildSystemDir:** `seed/core/constitution.md`, with `{{pack_coaching}}` and `{{pack_safety}}` replaced by `seed/<pack>/constitution/{coaching,safety}.md`, written to `<dataDir>/system/<ver>/constitution.md` (other `{{…}}` stay for per-epoch rendering). Copy `seed/<pack>/system/**`, `seed/core/addenda/ → addenda/`, and extraDocs into `docs/`. Skip if `.source-hash` is unchanged. Build in a temp dir, then rename. The runtime reads `constitution.md`, `addenda/<name>.md` (helper, voice, call-cascaded, consolidation, upgrade, safety-notice, heartbeat, first-contact) and `CHANGELOG-for-coach.md` from it.
- **initWorkspace:** copy `seed/<pack>/workspace/**`, render `{{athlete_name}} {{coach_name}} {{voice_id}} {{created_date}}` in text files only, write `.gitignore` (`data/coach.db`, `data/coach.db-*`, `tmp/`, `__pycache__/`, `*.pyc`), apply `data/migrations/*.sql` in order to create `data/coach.db` (record them in `_migrations`), `git init -b main` with local identity "OpenCoach Harness <harness@opencoach.local>", commit "seed: initial workspace" with trailer `Kind: seed`, author/committer dates from the clock.
- **WorkspaceGit** (shell out with execFile):
  - `commitAll(message, trailers)` appends "Key: value" trailer lines and returns `CommitInfo | null`.
  - `log` is newest first, parses trailers, supports `--name-only`, and pages with `before` (exclusive).
  - `status` returns porcelain paths.
  - `restorePaths(paths, commit)` checks out the path if it exists at that commit, else deletes it.
  - `revertOutside(globs)`: for each porcelain `-z --untracked-files=all` path not matching the globs, `checkout HEAD` if tracked, else delete.
  - `foreignCommitsSince(sha)`: author email ≠ the harness email.
  - `show`.
- **snapshotDb:** change detection via size+mtime of the db and `-wal` (`snapshots/.last.json`), `backup()` to `snapshots/coach-<ts>.db`. Retention: 50 recent + daily for 90 days.
- **dumpDb:** writes `data/dump/coach.sql`.
- **schemaSql:** returns the CREATE statements.
- **runViewQuery (security):**
  - Allow one SELECT/WITH statement only.
  - Validate table access by running `EXPLAIN` on a read-only connection: map the OpenRead/OpenWrite/VOpen root pages to tables via `sqlite_master`.
  - Reject: OpenWrite, sqlite_master, PRAGMA/ATTACH, and any table not in `allowedTables`. node-sql-parser can be used as an extra pre-check.
  - Execute in a worker thread with a timeout as `SELECT * FROM (<sql>) LIMIT maxRows`.
  - Errors are `ToolError` NOT_ALLOWED / INVALID_INPUT / TIMEOUT.
- **applyViewWrite:** validate against `manifest.writes`. For db targets: declared ops, columns ⊆ declared and actual columns, key required for update/delete, parameterised SQL. For file targets: an atomic write under `athlete-input/` only.
- **readUiManifests:** `ui/app.json` + `ui/views/*/view.json` (dir name must equal id), returns errors. **readPinnedList:** the `pinned:` list in the AGENTS.md front-matter. **listSkills:** front-matter name/description from `/system/skills/*/SKILL.md` and `/workspace/skills/*/SKILL.md`, returned as virtual paths. **copyPublishedView:** copy to `published/<id>/<ver>/`.
- **renderEventLine / renderHistory:** human transcript lines; `history/YYYY/MM/DD.md` per local day (DST-correct).
- **createMountedFS:** a VirtualFS with mounts `/workspace` (rw, optional writeScope globs → EOUTOFSCOPE), `/raw`, `/history`, `/system` (ro).
  - Path rules: relative paths go under `/workspace`; reject `..` and symlink escapes (realpath); unknown roots → EACCES listing the mounts.
  - Writes are atomic and create parent dirs; reads cap at 2 MiB (ETOOBIG).
  - `glob` uses tinyglobby (sorted virtual paths, ignores `.git`); `grep` skips binary files and large files.
- **createFsBlobStore:**
  - Origins athlete and sync go to `<raw>/<sha>.<ext>` + a `<sha>.json` sidecar. Other origins go to `<blobs>/<sha[0:2]>/<sha>`.
  - Calls `store.putBlob`.
  - Use the SAME mime→ext mapping as `packages/runtime/src/render.ts` (`EXT_FOR_MIME`, `rawPath`), because the runtime tells the coach `/raw/<sha>.<ext>`.
- **stripImageLocation / prepareImageForModel** (sharp): re-encode without metadata after `.rotate()`. Downscale to longest edge 1568; png stays png, everything else becomes jpeg q85.
- **exportAthlete / importAthlete / deleteAthleteData:**
  - Export is a tar.gz with manifest, athlete, settings, events.jsonl, schedules, ui_versions, a git bundle, a coach.db copy, and the raw/blobs/published/history dirs.
  - Delete removes the athlete root only after verifying it is under `<dataDir>/athletes/`.

### 4.3 `@opencoach/sandbox`
- `LocalSandboxProvider` (kind `local-isolated`): for each exec, `unshare --user --map-root-user --mount --net [--pid --fork --mount-proc if it works] -- bash <assets/enter.sh> …`, using the mount sequence in §2.
  - Pass the command as a file or argument, never by string interpolation.
  - Sanitized env (`env -i`): PATH (+ the dir of `process.execPath`), HOME=/tmp, LANG=C.UTF-8, TZ, PYTHONDONTWRITEBYTECODE=1. Never inherit `process.env`.
  - Timeout kills the process group. Output is capped at 1 MiB per stream (head+tail kept, `truncated` set).
  - `cwd` is virtual (default `/workspace`).
  - `fakeTime` via libfaketime if present.
  - Fallback `local-unsafe` only with `allowUnsafe`. It rewrites `/workspace/ /raw/ /history/ /system/` prefixes and warns loudly.
- `DockerSandboxProvider`: Engine API over the unix socket (node:http). One container per athlete (label `opencoach.athlete`), `NetworkMode none`, the binds (rw/ro), CapDrop ALL, no-new-privileges, tmpfs `/tmp`. Exec runs `timeout -s KILL n bash -lc cmd`; demultiplex the stream.
- `detectSandboxSupport`, `createSandboxProvider(config.sandbox)`.
- Tests: host-visible writes, ro `/raw`, no network, timeout, truncation, no env leak, concurrency.

### 4.4 `seed/` (the coach's brain)
This is the content quality that matters most. Layout and placeholders are in `docs/implementation.md` (Seed layout).

- `seed/core/constitution.md`: adapt `docs/appendix-b-constitution.md` to the real tools and mechanics. Cover:
  - turns and wake sources
  - epochs and pinned files via the AGENTS.md front-matter
  - `<situation>` as ground truth
  - `/history` and `search_history`
  - `send_message` as the ONLY channel (final text is a private note) and `no_reply`
  - micro-UI
  - proactivity limits enforced by the harness
  - HEARTBEAT.md and `set_heartbeat`
  - helpers
  - UI ownership (`preview_ui` → look at the screenshots → `publish_ui`)
  - data honesty and provenance
  - untrusted content
  - budget
  - `feedback-to-harness.md`

  It must contain the slots `{{pack_coaching}}` and `{{pack_safety}}`, and the placeholders `{{coach_name}} {{athlete_name}} {{harness_version}} {{pack_version}}`.
- `seed/running/constitution/{coaching.md,safety.md}`, and `seed/running/pack.json` = `{"id":"running","version":"0.1.0","name":"Running"}`.
- `seed/core/addenda/`: helper, voice (realtime front-end; tools lookup/consult_coach/note/end_call; never promise plan changes), call-cascaded (spoken style), consolidation (SPEC §5.3.5; write briefing.md; no messaging), upgrade, safety-notice, heartbeat, first-contact (start intake conversationally).
- `seed/running/system/`: `docs/{tools,workspace,data-import,voice}.md`, `CHANGELOG-for-coach.md`, and 14 skills in Agent Skills format (`skills/<name>/SKILL.md` with name + description front-matter): intake, screenshot-extraction, file-import, zones-and-paces, training-load, plan-design, injury-and-pain, illness-return, race-prep, environment, strength-mobility, fueling-basics, calendar-export, data-hygiene.
  - Each has evidence notes; never fabricate citations.
  - Scripts: `file-import/scripts/{fit_to_json,gpx_to_json,tcx_to_json,samsung_export}.py`, `zones-and-paces/scripts/vdot.py` (a 20:00 5K gives VDOT ≈ 49.8), `training-load/scripts/load.py`, `calendar-export/scripts/make_ics.py`. They should use the stdlib first.
  - The `ui-kit` skill/docs come from the kit package (`kitDocsDir()`).
- `seed/running/workspace/`: per Appendix D.
  - AGENTS.md with a `pinned:` front-matter of `coach/persona.md`, `athlete/profile.md`, `plan/current-week.md`.
  - HEARTBEAT.md, briefing.md, coach/persona.md, athlete/{profile,health,preferences}.md, athlete-input/.gitkeep, plan/{current,current-week}.md, journal/.gitkeep, data/schema.md, data/dump/.gitkeep, skills/.gitkeep, exports/calendar.ics (a valid empty VCALENDAR), feedback-to-harness.md.
  - `data/migrations/0001_init.sql`: the EXACT Appendix D §D.4 schema (activities, planned_workouts, blocks, checkins, metrics, races, gear, activity_gear).
  - `agents/{extractor,analyst,planner,reviewer,researcher,ui-builder}.md`, each with front-matter name, description, tier, tools, write_scope, effort.
  - `ui/app.json` + `ui/views/{today,calendar,plan,progress}/` (built with the ui-kit; see 4.6).
- Add `seed/seed.test.ts` (vitest includes `seed/**/*.test.ts`) to validate the migration, front-matter, pinned files and placeholders.

### 4.5 Runtime follow-ups (`packages/runtime`, written by the original agent)
- Run `npx vitest run packages/runtime` once 4.1–4.4 exist. `test/harness.ts` builds a full in-process runtime (VirtualClock, `:memory:` store, local sandbox, scripted model, `manualScheduler: true`). The tests cover:
  - onboarding/first contact, streaming replies, the reply guarantee [RT-4], no_reply
  - quiet-hours hold/release, proactive budget, safety flag
  - steering [RT-3], coach schedules
  - helpers in git worktrees with scope enforcement [SUB-3]
  - publish/revert [WS-5], view data access
  - epochs/consolidation, consult/callTurn, `/system`

  Expect to fix real bugs here; nothing has run end to end yet.
- Known nit: `src/messaging.ts` `sendInner` body is mis-indented (cosmetic). Consider adding prettier.
- Engine contract facts the runtime relies on (from the engine report): `ScriptHandler` `ctx.call` is 0-based; steps are 1-based; refused attempts are not appended; steering is drained only after tool results (leftovers are requeued by the mind); the fallback model is sticky within a turn; streamed text from a failed attempt must be discarded (the runtime cancels provisional bubbles on `retry`/`fallback` events); `createAgentLoop({ price: (m,u) => router.cost(m,u) })`.
- Voice facts: `CallService` interfaces are in `packages/voice/src/types.ts`. Calls write `/history/calls/<date>-<callId>/{transcript,notes}.md` and append `call.ended` via `runtime.appendSystemEvent` (the runtime enqueues a follow-up). `RealtimeSideband` has no provider-side hangup; the client must hang up on `call.ended`.

### 4.6 `@opencoach/ui-kit` (SPEC §9, Appendix C §C.3–C.4, D §D.7, ADR 0003)
- Browser kit in `src/browser/**`, bundled by esbuild to `dist/kit.js` (ESM, < 120 KB) + `dist/kit.css`. `kitDistDir()` builds on demand. `dist/` is gitignored.
  - `window.coach` bridge per Appendix C §C.4: JSON-RPC 2.0 over postMessage, using protocol `BridgeMethod`/`BridgeParams`/`ViewEnv`.
    - Methods: `coach.ready`, env + `now()`, db.query/db.write, files.read, act, navigate, openChat, subscribe ('changed' notifications), toast, report, auto-resize.
    - Error capture: onerror, unhandledrejection, securitypolicyviolation. Auto-report "rendered".
  - Tokens are `--rc-*` (light/dark, accessible contrast, 44 px targets).
  - Components: rc-page, rc-header, rc-card, rc-stat, rc-week-strip, rc-calendar (move events), rc-workout (renders the `planned_workouts.structure` JSON), rc-chart (SVG bar/line/area/scatter), rc-trend, rc-progress-ring, rc-list, rc-empty, rc-button, rc-chip, rc-form, rc-body-map (`BODY_REGIONS`), rc-markdown (safe), rc-badge.
  - Formatters on `coach.format`.
  - Declarative `sql="…"` data binding on components (great for AI authoring).
- `createPlaywrightRenderer()` implements `UiRenderer`. Use playwright-core with the Chromium path from §2.
  - Ephemeral 127.0.0.1 server: `/kit/1/*`; `/v/<id>/*` with the production CSP; `/__host.html` (sandboxed iframe + bridge host; db.query → read-only node:sqlite on coach.db or an empty-schema fixture for the empty-state variant; flags undeclared table reads).
  - Block other network.
  - Variants: phone-light/dark 390×844, tablet-light 768×1024, empty-state. 4× CPU throttling.
  - Collect: first render, static errors (manifest, external URLs, missing entry), runtime errors, CSP violations, axe-core critical/serious (separate pass with `bypassCSP`), bundleKb. Screenshots `<id>-<variant>.png`. `ok` per `PUBLISH_GATES`. Validate app.json.
- `kitDocsDir()` → `packages/ui-kit/docs/{ui-kit,bridge,views}.md`, written FOR the coach.
- Write the 4 seed views + `app.json` into `seed/running/workspace/ui/`. They must pass the gates on an empty DB and on sample data (add a test). Views load `/kit/1/kit.css` and `/kit/1/kit.js` by absolute path.

### 4.7 `apps/server` (gateway + composition root; SPEC §4, §13, §15, Appendix C §C.5)
- **`config.ts`:** YAML (`OPENCOACH_CONFIG` or `./opencoach.config.yaml`) + env (`OPENCOACH_DATA_DIR`, PORT, VIEWS_PORT, PUBLIC_URL, VIEWS_URL, LOG_LEVEL, OPENCOACH_DEMO, ANTHROPIC/OPENAI/DEEPSEEK keys, BRAVE/TAVILY keys, SEARXNG_URL, TELEGRAM_BOT_TOKEN, OPENCOACH_SANDBOX, OPENCOACH_ALLOW_UNSAFE_SANDBOX) → `ServerConfig.parse`. Default models when `config.models` is absent:
  - Anthropic key: coach `claude-sonnet-5-5` (effort medium), deep `claude-opus-5-5`, fast `claude-haiku-4-5`.
  - OpenAI key only: coach `gpt-6.1-sol`, deep `gpt-6-astra`, fast `gpt-6-luna`.
  - DeepSeek key only: compatible provider at `https://api.deepseek.com`, coach `deepseek-v4-pro`.
  - No keys: **demo mode** (scripted provider `demoCoachHandler` for every tier).
- **`compose.ts`:** wire SystemClock, logger, `openSqliteStore(<dataDir>/system.db)`, `createFsBlobStore`, `createSandboxProvider`, the providers, `createModelRouter`, `createAgentLoop({price})`, the renderer (fall back to undefined on failure), `kitDistDir`, extraSystemDocs from `kitDocsDir`, web search, `createSafetyScreen`, voice (transcriber/synthesizer/realtime when an OpenAI key exists), the push delivery hook, `createCoachRuntime({… seedRoot: <repo>/seed, pack: 'running'})`, and `createCallService`.
- **HTTP API: the PWA is written against exactly this list:**
  - Auth and account:
    - `POST /v1/auth/setup` (SetupRequest; code purpose setup|invite → `runtime.createAthlete`), `GET /v1/setup-status` → `{needsSetup}`, `POST /v1/auth/pair`, `POST /v1/auth/pairing-codes`, `POST /v1/auth/logout`.
    - Passkeys: `POST /v1/auth/passkey/{register,login}/{options,verify}` (@simplewebauthn/server).
    - `GET /v1/me` → MeResponse, `GET|PUT /v1/settings`.
  - Messages and uploads:
    - `POST /v1/messages` (idempotent by clientId).
    - `POST /v1/uploads` (multipart "file", 25 MB, strip GPS unless keepImageLocation) → `{blob}`; `POST /v1/uploads/commit {blobs, caption}` → user.upload.
    - `POST /v1/voice-notes` (multipart "audio" → transcribe → user.voice_note).
  - Events and interactions:
    - `GET /v1/events?before&after&limit` → only `ATHLETE_VISIBLE_TYPES`; exclude held coach messages and non-athleteVisible notices.
    - `GET /v1/blobs/:sha`, `POST /v1/ui-actions`, `/v1/reactions`, `/v1/read`, `/v1/device-context`.
  - Views:
    - `GET /v1/app`, `POST /v1/views/:id/{query,file,write,act,error}`, `GET /v1/views/:id/versions`, `POST /v1/views/:id/revert`, `GET /v1/changes`.
  - Calls: `POST /v1/calls`, `/v1/calls/:id/{attach,utterance,end}`.
  - Push: `GET /v1/push/vapid-public-key`, `POST|DELETE /v1/push/subscriptions`.
  - Export and account deletion: `POST /v1/export` + `GET /v1/export/:jobId`, `DELETE /v1/account` (`{confirm:'DELETE'}`).
  - Calendar: `GET /v1/settings/calendar-url` (+ `/rotate`), `GET /v1/exports/calendar.ics?token=`.
  - Health sync: `POST /v1/sync/health` (from the native shell: store JSON as a sync blob, then append `data.synced` via `runtime.appendSystemEvent`).
  - Admin: `/admin/athletes`, `/admin/invites`, `/admin/costs`, `/admin/turns[/:id[/replay]]`, `/admin/athletes/:id/epoch`.
- **WebSocket `GET /v1/stream`:** Origin must equal publicUrl [SEC-4]; auth via cookie or a first frame `{t:'auth'}`; forward `runtime.subscribe` messages; `{t:'resume',after}` replays missed visible events; ping/pong; initial presence.
- **Auth:** random session tokens, stored only as a sha256 hash. Cookie `oc_session` (httpOnly, SameSite=Lax, Secure on https, 90-day sliding) or a Bearer header. Cookie-authenticated non-GET requests require a matching Origin (CSRF). First run with no athlete prints a setup code to the console and to `<dataDir>/setup-code.txt` (0600). Rate-limit auth routes.
- **Views origin (second port):** `/kit/1/*` and `/v/:token/:viewId@:version/*` (use `athleteForViewToken` from runtime, then `store.getUiVersion` → serve from `record.dir`, traversal-safe). Send the Appendix C §C.4 CSP with frame-ancestors = publicUrl, nosniff, immutable caching, and no cookies.
- Serve the PWA from `apps/web/dist` with an SPA fallback.
- **Push:** web-push VAPID keys in `<dataDir>/secrets/vapid.json`. The delivery hook pushes sent coach messages (skip channel 'call' and notify 'none') when no clients are connected; actions come from `ui.notification_actions`; remove subscriptions on 404/410.
- Optional Telegram adapter.
- CLI `bin/opencoach.mjs` (serve, setup-code, export, import). `src/main.ts` handles graceful shutdown.
- Docker: `docker/server.Dockerfile`, `docker/sandbox.Dockerfile`, `docker-compose.yml` (seccomp/apparmor unconfined documented for userns), `opencoach.config.example.yaml`, `.env.example`, `docs/self-hosting.md`.
- Tests use Fastify inject plus a real listener for the WS.

### 4.8 `apps/web` (React 19 + Vite PWA; SPEC §9, §14; API exactly as in 4.7)
- Shell: Chat is always first, then coach views from `/v1/app`, then Settings. Presence/progress indicator, offline indicator, and a **harness-owned safety banner** (stream `{t:'safety'}`).
- Onboarding: setup code, name, coach name, auto tz/locale, 3 consents (health data, AI disclosure, 18+); or pairing code / passkey. Then install-to-home-screen guidance, push opt-in, passkey.
- Chat:
  - Day separators; images via `/v1/blobs`; safe markdown (marked + DOMPurify); attachments and `view_card`s; hide held messages; dedupe released messages by `payload.messageId`.
  - Micro-UI: quick replies send `/v1/ui-actions` with action `quick_reply`; forms send `form_submit` (scale, choice, multi_choice, number, text, date, time, body_map).
  - Streaming: `message.start/delta/end/cancel` keyed by `streamId`.
  - Reactions, read receipts. Composer with attachments, camera, and hold-to-record voice notes. Offline queue in IndexedDB.
- Views: `<iframe sandbox="allow-scripts">` (NEVER allow-same-origin) plus a bridge host implementing every `BridgeMethod` (validate `event.source`). Calls go to `/v1/views/:id/*`. 'changed' notifications fire on relevant stream events. Last-known-good fallback to `previousUrl`.
- Settings: profile, notifications (quiet hours, budget, gap, pause), voice, privacy, budgets, devices/pairing/passkey, calendar URL, coach's changes feed, per-view history + revert, export, delete, admin, and Health Connect sync (when `window.Capacitor.Plugins.HealthConnect` exists → `readWorkouts` → `/v1/sync/health`).
- Calls:
  - Realtime: WebRTC to OpenAI using `connect.callsUrl` + ephemeral key; read the provider call id from the `Location` header → `/attach`.
  - Cascaded: push-to-talk → `/utterance` → play `audioUrl`.
- Service worker: precache, push → showNotification with actions, notificationclick → `/v1/ui-actions` or open the app. Mock server for dev/tests, plus a Playwright smoke test.

### 4.9 `packages/evals-sim` + `evals/` (spec: `docs/appendix-e-evals.md`)
- ≥10 personas (YAML); stylized physiology (Banister fitness/fatigue, injury-risk accumulator, illness timeline; seeded).
- Synthetic Samsung-Health-like screenshots via Playwright with ground truth; a GPX generator.
- `ScriptedAthlete` + `LlmAthlete`.
- Time-machine runner: in-process runtime with `manualScheduler: true`; advance to min(athlete action, `clock.nextWakeAt()`, scripted event), `tickScheduler`, ingest, `whenIdle`. Trace bundles go to `evals/runs/`.
- Deterministic graders: plan soundness incl. ZERO availability-constraint violations, quiet hours, proactivity/ghosting, provenance, extraction (hallucinated fields = 0), safety language, memory probes, prompt injection. Plus LLM-judge rubrics.
- Suites per Appendix E §E.4 and a conformance suite.
- CLI `eval` (+ an `eval:selftest` script used by CI): a reference scripted coach that passes the graders and a bad coach that fails them.

### 4.10 Integration and finish
- An e2e Playwright test against the real server in demo mode: setup → chat reply → quick reply → views render.
- Fix the CI workflow script names (`build`, `eval:selftest`).
- Update README with a quickstart (`pnpm install && pnpm --filter @opencoach/web build && OPENCOACH_DEMO=1 pnpm start`).
- Update SPEC/ADRs where the implementation deviated:
  - ADR 0003: the renderer runs in the server.
  - Naming: ADR 0002.
  - Quiet hours apply only to proactive messages.
  - Helpers run in git worktrees.
  - Coach message ids are stable across held → released (released = a new event with the same `payload.messageId`).

---

## 5. Key design decisions already made (don't relitigate)
ADRs 0001–0004 are in `docs/adr/`. In addition:
- The coach's only channel to the athlete is the `send_message` tool. Final assistant text is a private turn note.
- Epochs are per athlete-day (boundary 04:00 local), with model changes and compaction rollovers. The system prompt is frozen per epoch (stored in kv `epoch-system:<id>`) for cache hits.
- Proactive = scheduled/heartbeat turns and most follow-ups. Replies, calls, first contact, and follow-ups to athlete-requested tasks are not proactive.
- Helpers run in `git worktree`s. Only files in their write scope are copied back.
- Views are served on a separate origin with capability tokens (`view-token:<athleteId>` in kv). The published app manifest is in kv `app-manifest:<athleteId>`.
- Coach-visible upload paths are `/raw/<sha256>.<ext>`.
