# Implementation guide (for everyone building the harness)

Read with `SPEC.md` and `AGENTS.md`. This file maps the spec onto code.

## Packages and dependency direction

```
@opencoach/protocol   ← shared contracts (zod schemas + interfaces). Browser-safe. No node: imports.
   ▲
   ├── @opencoach/store      SqliteStore (node:sqlite, WAL, FTS5)                       implements Store
   ├── @opencoach/sandbox    LocalSandboxProvider (namespaces) / DockerSandboxProvider   implements SandboxProvider
   ├── @opencoach/workspace  seed init, git, coach.db, history, VirtualFS, blobs, views data, export
   ├── @opencoach/engine     AgentLoop + providers (anthropic, openai, compatible, scripted) + router/pricing
   ├── @opencoach/tools      model-facing ToolDefs over ToolContext ports
   ├── @opencoach/ui-kit     browser kit (web components, bridge client) + Playwright preview renderer
   ├── @opencoach/voice      STT/TTS, OpenAI realtime + sideband, call service, cascaded calls
   ├── @opencoach/runtime    the mind loop (depends on workspace, tools, store)            implements CoachRuntimeAPI
   ├── @opencoach/evals-sim  athlete simulator + time machine + graders
   ├── apps/server           composition root + gateway (HTTP/WS, auth, push, views origin)
   └── apps/web              PWA client (React + Vite)
```

Rules:
- Packages depend on `@opencoach/protocol` interfaces. Only the composition root (`apps/server/src/compose.ts`) and test harnesses wire concrete implementations together.
- Each package's `src/index.ts` signatures are **final contracts**. Implementations may add exports but must not change existing signatures without updating every caller.
- `protocol` must stay browser-safe (the web app imports it): no `node:*` imports there.

## Data directory layout (`config.dataDir`)

```
system.db                         SqliteStore
secrets/                          vapid.json, session-secret, view-token-secret (0600)
system/<harnessVersion>/          read-only /system mount (built by buildSystemDir from seed/)
  constitution.md  docs/  skills/  CHANGELOG-for-coach.md
athletes/<athleteId>/             see athletePaths() in protocol/src/config.ts
  workspace/  raw/  blobs/  history/  snapshots/  published/  exports/  tmp/  calls/
```

## Seed layout (`seed/`)

```
seed/core/constitution.md              harness-generic constitution with {{pack_coaching}} and {{pack_safety}} slots
seed/core/addenda/*.md                 helper, voice, consolidation, upgrade, safety-notice preambles
seed/running/pack.json                 { "id": "running", "version": "0.1.0", "name": "Running" }
seed/running/constitution/coaching.md  fills {{pack_coaching}}
seed/running/constitution/safety.md    fills {{pack_safety}} (running red flags)
seed/running/system/                   → /system: docs/*.md, skills/<name>/SKILL.md (+ refs, scripts), CHANGELOG-for-coach.md
seed/running/workspace/                → copied into each new athlete workspace (Appendix D), incl. ui/ seed views
```

Placeholders rendered at workspace init: `{{athlete_name}}`, `{{coach_name}}`, `{{voice_id}}`, `{{created_date}}`.
Placeholders rendered per epoch in the constitution: `{{coach_name}}`, `{{athlete_name}}`, `{{harness_version}}`, `{{pack_version}}`.

The runtime loads the constitution and running addenda, a skill index (not all skill bodies), `AGENTS.md` plus its pinned files, and `briefing.md` into a frozen epoch system prompt. Detailed product guidance lives at `/system/docs/opencoach.md`; research procedures live in the `research` skill. New workspaces include quick/deep research profiles; old coach-owned profiles are not overwritten. The skill explains how to add the deep profile when missing.

The starter Plan view reads `plan/athlete-summary.md` for its athlete-facing explanation. `plan/current.md` remains working memory and is absent from that view's read manifest. The constitution and UI/plan skills require reviewed display copy instead of raw working notes, briefings or helper output. This is a presentation convention, not a confidential storage boundary: exports still include the athlete's notes, and coach-authored views can evolve their manifests. Existing views need an explicit preview/publication repair after upgrading; see [self-hosting](self-hosting.md#updating-an-existing-coachs-plan-view).

`capabilities.ts` renders granted core tools, configured web search/fetch and renderer state, and primary model/vision routes into each coach situation report and helper environment. Helpers also receive the Clock-derived time, their role, inputs and write scope, without the main conversation. Configuration facts are not live service certification. Constitution/skill-index edits take effect at the next epoch; current turns receive guide/skill pointers through the fresh report. Never put provider credentials or deployment headers into model context. Runtime context tests execute research helpers and inspect the actual requests and persisted outputs.

## Views at runtime

The eval-only published-view observer reuses the PWA's `BridgeHost` and stream-change predicate
directly from their source modules. It serves immutable published bundles in an opaque-origin
Chromium iframe and calls the runtime's manifest-scoped read API. It records accessible text,
queries, subscriptions, publication reports, mount/version and screenshots across actions.
The CLI uses a runner-owned renderer factory so previews share the advancing runtime Clock.
This component client is separate from full gateway/PWA authentication and offline acceptance.
The VO₂max fixtures use general saved-data/file/UI-scope assertions; their arithmetic controls
are confined to `packages/evals-sim`, not the production coach policy.

- Views origin (separate port/host, [SEC-3]) serves:
  - `/kit/1/kit.js`, `/kit/1/kit.css` (+ assets): the built UI kit
  - `/v/<viewToken>/<viewId>@<version>/<path>`: immutable published view files
- View HTML loads the kit with absolute paths: `<link rel="stylesheet" href="/kit/1/kit.css"><script type="module" src="/kit/1/kit.js"></script>`.
- The shell embeds views in `<iframe sandbox="allow-scripts">` (never allow-same-origin) and runs the bridge host. The bridge is JSON-RPC 2.0 over postMessage (`BridgeRequest` in protocol/views.ts). The host validates `event.source === iframe.contentWindow`.
- Data access always goes through the gateway (`POST /v1/views/:id/query|file|write|act`), which enforces the manifest server-side.

## Conventions

- **Time:** use the injected `Clock`. Never `Date.now()` / `new Date()` for "now" outside clock adapters (`new Date(isoString)` for parsing is fine).
- **IDs:** `newId(prefix, clock)` from protocol.
- **Naming:** model-facing tool inputs and coach-authored files use snake_case; events, HTTP JSON and TS use camelCase; SQL columns use snake_case (ADR 0002).
- **Errors:** tools return `ToolOutcome` with `ToolErrorCode`s. Packages throw `ToolError` / `ProviderError` where the contracts say so.
- **Logging:** take a `Logger` (protocol) and use `.child({...})`. Use `silentLogger` in tests.
- **Tests:** vitest, colocated `src/**/*.test.ts` or `test/**/*.test.ts`. No network and no live model calls in unit tests (use the scripted provider or cassettes). Tests that need Chromium use `PLAYWRIGHT_BROWSERS_PATH` (set in this environment) and must skip cleanly if it's absent.
- **Run:** `pnpm test` (all), `npx vitest run packages/<name>`, `pnpm typecheck` (root tsc + web).
- **TypeScript:** 5.9, strict, `moduleResolution: Bundler`, ESM, extensionless relative imports. Packages are consumed as TS source (no build step), except `apps/web` (Vite) and the browser kit bundle (esbuild).

## Context rendering (runtime → model)

Each turn appends one **user item** that renders the trigger events (oldest first, separated by a blank line). Every event starts with a header line matching

```
^\[(?<local>[^·\]]+) · (?<type>[a-z_.]+)(?: · (?<id>[A-Za-z0-9_]+))?\]$
```

where `local` is the athlete-local time, e.g. `2026-10-07 06:58 Tue`. Examples:

```
[2026-10-07 06:58 Tue · user.message · evt_01JABC...]
Athlete: Tempo done, brutal 😅
Attachments: /raw/3f2a…e1.png (image/png)

[2026-10-07 07:01 Tue · user.ui_action · evt_01JABD...]
Athlete tapped quick reply "8" on message evt_01JABB...

[2026-10-07 20:30 Tue · schedule.fired · sch_01JAB0...]
Wake-up you scheduled on 2026-10-05: Check whether today's tempo was logged; if not, check in gently.

[2026-10-08 07:30 Wed · system.heartbeat]
Daily heartbeat. Work through HEARTBEAT.md.
```

Images the athlete sent are attached as image parts after the text, when the coach model has vision. The **situation report** follows as a separate harness item whose text starts with `<situation>` and ends with `</situation>`. It includes a `trigger: <class> (<event types>)` line and a `reply required: yes|no` line.
