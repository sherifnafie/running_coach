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
seed/general/pack.json                 { "id": "general", "version": "0.3.11", "name": "General coaching" }
seed/general/constitution/coaching.md  fills {{pack_coaching}} (any sport, chosen by the athlete; ADR 0006)
seed/general/constitution/safety.md    fills {{pack_safety}} (red flags for all sports, weight-cut and high-risk rules)
seed/general/system/                   → /system: docs/*.md, skills/<name>/SKILL.md (+ refs, scripts), CHANGELOG-for-coach.md
seed/general/workspace/                → copied into each new athlete workspace (Appendix D), incl. ui/ seed views;
                                         also mounted read-only as /system/seed-workspace/ for upgraded coaches
```

Placeholders rendered at workspace init: `{{athlete_name}}`, `{{coach_name}}`, `{{voice_id}}`, `{{created_date}}`.
Placeholders rendered per epoch in the constitution: `{{coach_name}}`, `{{athlete_name}}`, `{{harness_version}}`, `{{pack_version}}`.

The runtime builds a frozen per-epoch system prompt from the constitution (with the pack's addenda), a skill index (not the skill bodies), `AGENTS.md` with its pinned files, and `briefing.md`. Product guidance for the coach lives at `/system/docs/opencoach.md`. `capabilities.ts` adds configuration facts to each turn's situation report and to helper environments: granted tools, search/fetch, renderer, and model/vision routes. Credentials and deployment headers never enter model context.

Optional achievement examples live under `system/skills/achievements/examples/`,
outside the copied starter workspace. The coach can adopt the empty JSON ledger
and hidden gallery when useful; no harness migration or award logic reads them
([ADR 0009](adr/0009-coach-owned-achievements.md)). Generated-image blobs are
private attachments with readable PNG copies in `exports/images/`; galleries
copy those into local assets. OpenRouter images reuse scoped account keys,
with separate image permissions/allowances and fixed rendering parameters
([ADR 0011](adr/0011-small-openrouter-images.md)).

## Views at runtime

- Views origin (separate port/host, [SEC-3]) serves:
  - `/kit/1/kit.js`, `/kit/1/kit.css` (+ assets): the built UI kit
  - `/v/<viewToken>/<viewId>@<version>/<path>`: immutable published view files
- View HTML loads the kit with absolute paths: `<link rel="stylesheet" href="/kit/1/kit.css"><script type="module" src="/kit/1/kit.js"></script>`.
- Kit major-version paths revalidate because compatible releases can change them. Updated starters use a release query to bypass previously immutable cached kit URLs; published view bundles keep their commit fingerprints and immutable cache policy.
- The shell embeds views in `<iframe sandbox="allow-scripts">` (never allow-same-origin) and runs the bridge host. The bridge is JSON-RPC 2.0 over postMessage (`BridgeRequest` in protocol/views.ts). The host validates `event.source === iframe.contentWindow`.
- Publish comparison includes the shared `ui/lib/` copied into each bundle, unless a view supplies its own `lib/`. Unchanged selections create no version or alert. Chat folds adjacent screen publications from one turn (legacy events: matching commit/summary) into one compact disclosure; full per-screen history/revert stays available. Conversation and athlete-action boundaries keep separate changes separate.
- Data access always goes through the gateway (`POST /v1/views/:id/query|file|write|act`), which enforces the manifest server-side.

## Conventions

- **Time:** use the injected `Clock`. Never `Date.now()` / `new Date()` for "now" outside clock adapters (`new Date(isoString)` for parsing is fine).
- **IDs:** `newId(prefix, clock)` from protocol.
- **Naming:** model-facing tool inputs and coach-authored files use snake_case; events, HTTP JSON and TS use camelCase; SQL columns use snake_case (ADR 0002).
- **Errors:** tools return `ToolOutcome` with `ToolErrorCode`s. Packages throw `ToolError` / `ProviderError` where the contracts say so.
- **Logging:** take a `Logger` (protocol) and use `.child({...})`. Use `silentLogger` in tests.
- **Tests:** vitest, colocated `src/**/*.test.ts` or `test/**/*.test.ts`. No network and no live model calls in unit tests (use the scripted provider or cassettes). Tests that need Chromium find it via `chromiumExecutable()` (ui-kit) and must skip cleanly if it's absent.
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

## Environment

- Node ≥ 22.13 and pnpm 10.28. TypeScript is **pinned to 5.9** on purpose. Packages are consumed as TS source; only `apps/web` and the UI kit bundle are built.
- `node:sqlite` with FTS5 and JSON1 is required (Node 22 has it).
- The local sandbox needs unprivileged user namespaces (ADR 0004). On Ubuntu 24.04 CI this needs `kernel.apparmor_restrict_unprivileged_userns=0`.
- Chromium is needed for the preview renderer, e2e tests and UI evals. It is found automatically, or set `OPENCOACH_CHROMIUM_PATH`.
- Unit tests never call a model. Live checks need keys in the trusted server environment. Never put keys in files under the repo or in athlete sandboxes.
- Commands: `pnpm install`, `pnpm typecheck`, `pnpm test`, `npx vitest run packages/<name>`, `pnpm build`, `pnpm test:e2e`, `pnpm eval:selftest`.

## Settled design decisions

ADRs 0001–0004 are in `docs/adr/`. In addition:
- The coach reaches the athlete only through the `send_message` tool. Final assistant text is a private turn note. [RT-4] guarantees a reply to athlete messages.
- Epochs are per athlete-day (boundary 04:00 local), and also roll over on model change and compaction. The system prompt is frozen per epoch (kv `epoch-system:<id>`) for prompt-cache hits.
- Proactive messages are scheduled, heartbeat and most follow-up turns. Only those are subject to quiet hours, budgets and the minimum gap. A held message is released as a new event with the same `payload.messageId`. New reply-requiring input atomically cancels held outreach, and release checks newer context by event append order. Terminal delivery states cannot return to held. SQLite migration 4 adds internal `cancelled` delivery state and `pending_coach_inputs`; original held events remain immutable (ADR 0012).
- Messages, uploads, voice notes and waking UI actions stay in the durable coach inbox until a reply commits with acknowledgement of consumed IDs, or `no_reply` explicitly acknowledges them. Restart recovery screens/requeues original pending events before background follow-ups. Harness reply retries reuse those original inputs as reactive turns and do nothing once answered.
- Helpers run in `git worktree`s. Only files in their write scope are merged back. Grants intersect along the helper chain.
- Coach views are served on a separate origin with capability tokens and run in `sandbox="allow-scripts"` iframes. Data access goes through the gateway, which enforces the view manifest.
- Coach-visible upload paths are `/raw/<sha256>.<ext>`.
- Language, theme and accent are account settings. The coach can change them through a presentation-only tool.
