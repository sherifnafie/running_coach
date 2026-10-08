# Project status

What works, what has been verified, and what's next. Keep this current when you finish or find something.

## State

Phase 1 (MVP) and most of Phase 2 are implemented. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e` and `pnpm eval:selftest` all pass.

| Area | State |
|---|---|
| `packages/protocol` | Contracts (zod). Browser-safe. |
| `packages/engine` | Agent loop. OpenRouter for all chat models with a vetted model catalog ([ADR 0007](adr/0007-openrouter-only-chat.md)); OpenAI-compatible endpoints (Ollama, OpenCode GO); scripted demo coach. |
| `packages/runtime`, `packages/tools` | Mind loop, epochs, situation report, messaging policy, scheduler, helpers in git worktrees, UI publish/revert, MCP, safety screen, web search/fetch. |
| `packages/store`, `workspace`, `sandbox` | SQLite store; athlete workspace (git, coach.db, history, virtual FS, blobs, export/import/delete); local namespace sandbox and Docker sandbox. |
| `packages/ui-kit` | Browser kit, bridge, Playwright preview renderer with publish gates, coach-facing docs. |
| `packages/voice` | STT/TTS, realtime calls with server sideband, cascaded calls. |
| `seed/` | Constitution and one general pack for any sport or combination ([ADR 0006](adr/0006-multi-discipline-coaching.md)): 12 skills that describe the app (coaching knowledge is the model's own, [ADR 0010](adr/0010-skills-describe-the-app.md)), helper profiles, a sport-agnostic workspace template and four starter views (Today, Calendar, Plan, Progress). |
| `apps/server` | Gateway (HTTP, WebSocket, auth, passkeys, CSRF), separate views origin, push, Telegram, CLI, Docker packaging. Per-athlete encrypted OpenRouter keys: managed (hard monthly allowance) or bring-your-own (OAuth PKCE or pasted). Admin recovery codes. |
| `ops/` | systemd user units, deploy with rollback, nightly consistent backups for a small home instance. |
| `apps/web` | React PWA: chat (streaming, micro-UI, attachments, voice notes), coach views in sandboxed iframes, settings (incl. language/theme), calls. |
| `packages/evals-sim`, `evals/` | Simulator with virtual time, personas, graders/judges, suites, CLI. See `evals/README.md`. |
| `apps/native` | Capacitor Android shell and Health Connect plugin. **Never compiled** (no Android SDK yet). |

## Verified vs. unverified

- **Verified live:** OpenCode GO with DeepSeek V4.1 Flash, using synthetic athletes. Covered: streaming tool calls, signup, delivered replies, saved intake, plan and activity, all four views showing the data, delegation to helpers, and the owner's own phone test. The server Docker image builds and runs the demo with isolated sandboxes.
- **Verified live through OpenRouter (2026-10-07):**
  - Streamed tool call with `reasoning_details` replayed within the tool loop.
  - `usage.cost` reported on every call.
  - Prompt cache hits with pinned hosts (5632 of 5643 input tokens cached).
  - A workout screenshot read correctly by all five catalog models under `data_collection: deny`.
  - The live instance runs from `~/opencoach-prod` through Tailscale Funnel, and both origins were reachable from the public internet.
- **Verified live (2026-10-07, later):**
  - Claude Haiku 5.5 through OpenRouter, the default at that time: tools, reasoning replay across tool loops, request-level 1h prompt caching, screenshot reading, and three `disciplines` eval scenarios.
  - The OpenAI key on prod: TTS and STT round trip with gpt-4o-mini-tts and gpt-4o-transcribe. The realtime, whisper and live-transcribe models are available to the key.
- **Not verified:**
  - Coaching quality: no real-model eval cohort and no human calibration.
  - Full provider conformance [MOD-2]; vision and screenshot extraction with a real model.
  - Live voice and calls, Web Push delivery, Telegram, web search backends, and MCP against real servers.
  - The native Android build and Health Connect on a device; iOS.
  - Scheduled proactive delivery over real time.
- **A known model weakness to keep an eye on:** in the VO₂max eval, DeepSeek computed the estimate correctly but invented an RPE value. The eval keeps that as a failure (see `evals/vo2max.md`). Fix this kind of problem through seed instructions, not harness code.

**Coach identity and images:** identity changes retain separate opt-in/requested turns. Image generation now reuses scoped OpenRouter keys, with an independent requested/automatic/off control and monthly image allowance. Default Flare medium at 816 square costs about $0.012 in live synthetic samples; output is safe 512 PNG with private blob and readable workspace path for gallery assets. Pricing preflight, bounded server-selected parameters, reservations, no fallback/retry and durable replay remain enforced. Direct Google/OpenAI-compatible alternatives remain. See [setup](self-hosting.md#optional-coach-name-avatar-and-generated-images), [research and expected spend](image-generation-research.md) and [ADR 0011](adr/0011-small-openrouter-images.md).

**Image integration verification (2026-10-08):** typecheck, full unit/renderer suite (794 tests), build, all 14 browser end-to-end cases, offline eval self-test and the 28-scenario reference fast subset passed. The generated medal was published through the real view gates and inspected on light/dark phone and tablet previews, with no serious/critical accessibility violations. Ten live synthetic image samples across four models cost about $0.09 total. Reference evals validate the harness; they do not establish real-model restraint or achievement quality.

**Production deployment (2026-10-08):** release 0.3.5 (`aa5f1cb`) is running in `~/opencoach-prod`, with a pre-deploy backup. DeepSeek V4.1 Flash is now the default for both chat and deep work (high effort for deep work); the production Haiku override was replaced. OpenRouter images use Flare medium. Verified the active systemd service, loaded production tier/image configuration, installed image capability skill, public app and gateway (HTTP 200), view kit (HTTP 200), and authentication boundary (unauthenticated `/v1/me` returns 401). The default-change config tests and typecheck/reference fast subset also pass.

**PWA notifications (2026-10-08):** the production account allowed push but had zero registered device subscriptions. Settings now separates that account preference from actual phone permission/enrollment, with explicit enable/reconnect and an authenticated device-specific test. Existing subscriptions re-register on open/foreground/reconnect without prompting; VAPID key changes can be repaired and disabling/signing out unregisters the device. Open desktop/background WebSockets no longer suppress phone notifications. Every received push displays a notification (required by WebKit), quiet while the local app is focused; held/call/disabled/`notify:none` exclusions still apply. Provider acceptance is not proof of display on a physical phone; the owner must enable notifications and check the test on Android/Chrome.

Notification changes pass typecheck, all 796 harness/renderer tests, 163 web unit tests (12 existing skips) and all 14 browser end-to-end cases, including the misleading account-enabled/device-disconnected state. Provider delivery with connected clients, owned/rate-limited tests, expiration cleanup, permission states, VAPID repair and actual worker event handlers have focused regression coverage.

Deployed notification fixes (`4baffbe`) to production with a pre-deploy backup. Verified the active service, newly served notification controls and service worker, and 401 responses for unauthenticated device-status/test requests. Physical Android/Chrome receipt remains pending the owner's on-device permission and test.

**Mid-turn identity requests (2026-10-08):** an owner's explicit name/avatar
request arrived during an upgrade follow-up. The coach attempted both tools;
both returned `NOT_ALLOWED` because permissions used the turn's original
`followup` class even after chat input was injected. The header correctly kept
the unsaved name. Release 0.3.6 switches the tool context to reactive at the
steering boundary and supplies a trusted context update, preserving original
trace classification and all opt-in/ownership/cost checks. Skills clarify that
no open app or extra message is needed, and a name in prose does not save it.
The owner's agreed display name was repaired to Miles through the normal
settings API with an audited, immediately revoked maintenance session. Physical
avatar generation was not retried as part of that name repair.

Validation: all 798 harness/renderer tests, typecheck, all 14 browser cases and
the 28-scenario reference fast subset pass. The new runtime regression injects
name/avatar requests during a follow-up and checks both successful completion
and continued refusal when permissions are off. The existing browser test
checks the header/avatar after `settings.changed` and reload.
Deployed 0.3.6 (`72f0ad3`) with backup; verified the active service, new system
skills/runtime code, public app/gateway/view kit and the owner's saved Miles name.

**Scannable views and Settings (0.3.7, 2026-10-08):** starter views use compact
secondary sections, light dividers and optional responsive pairs; no layout
rule is enforced on coach-authored views. Settings groups controls under three
sections, balances notifications beside model/voice/image settings, and pairs
quiet-hour inputs. Quick check-in was removed from Today, including its form,
queries and manifest grants; existing check-in records remain. Calendar details
now omit null optional children before native DOM insertion. Calendar buttons
also keep their session names accessible in compact month cells. Shared kit
URLs revalidate instead of caching a mutable major version for a year, and
updated starter URLs bypass old caches. Owner-account updates preserve the
coach's VO₂max widget and date formatting and use the normal preview/publish
and workspace history paths. Current/empty sample and owner previews pass
all gates with zero serious/critical accessibility findings.
Deployed 0.3.7 (`643d902`) after backups and published the owner's views through
the normal gates/history: Today v3, Calendar v2, Plan v3, Progress v4. Verified
those versions through the authenticated app API, preserved VO₂max markup,
removed Quick check-in, fresh kit URLs and live cache headers. All 798
harness/renderer tests, 15 browser cases, build/typecheck and deterministic
reference fast eval checks pass; visual review covered phone/tablet, both
themes and empty states.

**Supporting detail on demand (0.3.8, 2026-10-08):** optional native disclosures
and tap/keyboard help popovers are styled/documented by the kit, with a small
opt-in help control in Settings. Starter Plan folds phases, weekly breakdowns,
key sessions and rationale; Progress keeps current metrics visible with
optional distance charts, lift details and results; Calendar folds its legend.
The owner's VO₂max adaptation retains the latest value and an honest short
caveat, with its original explanation, trend and tests available on demand.
No runtime policy requires these patterns and opening them calls no model.
Session instructions, status and consequential settings warnings stay visible.
Phone/tablet, dark/light and empty-state previews pass with zero serious or
critical accessibility findings. Browser coverage exercises expanding rationale,
help inside a sandboxed view, keyboard opening, Escape/focus return, Close and
outside dismissal, plus viewport fit and unchanged settings behavior.
Deployed 0.3.8 (`7988669`) after backups and published the owner's Calendar v3,
Plan v4 and Progress v5 through normal preview/history; Today remains focused
on its existing session instructions. Authenticated production checks confirm
the release, current bundles and preserved metric method/history. All 798
harness/renderer tests, 163 web unit tests (12 existing skips), 16 browser cases,
build/typecheck and deterministic reference fast eval checks pass.

**Presentation fixes (0.3.9, 2026-10-08):** Plan opts into `rc-markdown`
`omit-title` to avoid repeating “Why this plan”; only a matching first heading
is omitted from the display, preserving the source document and subsections.
Settings places the avatar/reset beside the coach name. View updates now use
a compact personal notice with bounded summary, dismissal and a history link;
expiry pauses while hovered or keyboard-focused. Chat uses a concise linked
update entry. Full summaries and existing undo stay in screen history. Regression
coverage checks title composition/source preservation, inline avatar placement
and reset, history navigation, long summaries and focus-aware dismissal.

## Open work (roughly by value)

1. Run real-model evals (`pnpm eval --suite gates --model <provider:model>`) and improve the seed (constitution and skills) based on the failures.
2. Validate vision: configure a vision-capable route and test screenshot extraction (`evals/suites/extraction.yaml`).
3. Native shell: build `apps/native` with an Android SDK, test Health Connect on a device, then do native FCM push and a share-sheet target.
4. Validate the external services live: Web Push, voice notes and calls, and Telegram.

## Known issues and cleanup backlog

- **Leaked tool syntax (fixed 2026-10-07):** DeepSeek V4.1 Flash through OpenRouter once wrote `</text><parameter name="ui">…` inside a `send_message` text, and the athlete saw it raw. The adapter now splits such tails back into arguments (`repairLeakedParameters`), and `send_message` rejects any remaining tool markup so the model resends. Watch for other shapes of the same failure.

- **Live dictation never worked in prod (fixed 2026-10-07):** dictation sent a transcription `prompt`, which `gpt-realtime-whisper` rejects with HTTP 400. Athletes saw "The upstream provider failed (invalid_request)". Dictation no longer sends a prompt (session minting verified against the live API), and provider errors now reach athletes as plain-language messages; the provider's detail stays in the server log.
- **Coach narrating app mechanics:** after a call, DeepSeek told the athlete "voices are coming through now, that was the shimmer run", because it had seen their voice-setting changes. The constitution (§4) now says not to narrate settings, voice or model choices, connection problems or housekeeping. An eval scenario for post-call recaps is still missing.
- **Stale installed apps (fixed 2026-10-07):** an installed PWA left open in the background kept running old code after a deploy. It now checks for an update when brought to the foreground and reloads into it at a quiet moment (not during a call or while typing).

- **Coach steering redesign (2026-10-08, [ADR 0008](adr/0008-proportion-and-effort-by-stakes.md)):** instructions rewritten for proportion, athlete-first precedence and effort by stakes; deep tier defaults to DeepSeek V4.1 Flash. Still open: small models make arithmetic and consistency slips in long planning conversations (half-written weeks, overlapping dates); Haiku sometimes writes a week's plan itself instead of using the planner; no automated grading for the conversation benchmark yet; no eval scenario for "don't message after an empty call".

- **Coach-owned UI components (2026-10-08):** `ui/lib/` in the workspace is copied into each published view as `lib/` (checked by the same static gates), with starter tabs, sheet, workout timer and table; the kit source is readable at `/system/docs/ui-kit-source/` and kit elements can be overridden by defining them first. Default views deliberately don't use them; the coach decides.
- **Optional achievements (2026-10-08, [ADR 0009](adr/0009-coach-owned-achievements.md)):** a progressive skill and editable ledger/gallery example; no default tab, automatic migration, award engine or new notification behavior. Recognition needs an actual accomplishment and sources; repeated requests don't earn medals, routine sessions don't need trophies, and opt-out/challenge revisions are respected. Local artwork needs no service. Generated PNGs can now be copied into gallery assets from their returned workspace path; images have a separate permission/allowance (ADR 0011). Seven focused eval cases (three also in `fast`), structured saved-file checks and a separate uncalibrated judge rubric. Offline controls and browser publish gates pass; **real-model restraint and pressure resistance are not yet verified** (no dedicated eval key available).
- **Weather tool (2026-10-08):** `weather` (Open-Meteo, no key, town-level, cached). Not yet covered by an eval scenario.

- **Skills describe the app (2026-10-08, [ADR 0010](adr/0010-skills-describe-the-app.md)):** the nine sports-science skills were removed; their scripts live in `calculators`. Not yet measured: whether coaching quality on small models changes without them (run the conversation benchmark and the planning and safety suites).

- **Bring-your-own OpenAI key for voice** is not implemented. Voice uses the server key. The credential store already supports `openai`; the voice services need per-athlete scoping.
- **Data directory moves:** `ui_versions.dir` stores absolute paths (see self-hosting, "Small home instance"). Store them relative to the data directory.

These are smaller findings from the code review on 2026-10-07 that haven't been fixed yet:
- **Harness wording that coaches the model:** some harness strings tell the model how to behave and could move to `seed/` (the deletion test). Examples: the delegation advice in `runtime/src/capabilities.ts`, the helper LIMIT message in `helpers.ts`, and the `spawn_agent` and `set_preferences` tool descriptions.
- **Repeated research guidance:** it appears in the constitution, `skills/research`, `agents/deep-researcher.md` and `docs/tools.md`. Keep it in the skill and the profile, and leave only a pointer in the constitution.
- **Dead field:** `ModelRequest.metadata.epochId` is never set. As a result, the compatible provider's session header sends `cacheKey` (the raw athlete id) to the provider.
- **Duplicated lock:** the per-athlete lock helper exists twice (`messaging.ts` `withMessageLock` and `UiService.withLock`).
- **Server leftovers:**
  - `GET /v1/settings/calendar-url` writes state on its first call.
  - `POST /v1/ui-writes` duplicates `POST /v1/views/:id/write`.
  - The `validatePushEndpoint` and `onAthleteDeleted` gateway hooks are never wired.
- **Two `playwright-core` versions:** ui-kit pins 1.56.1, while evals-sim and web use ^1.63.
- **Eval schedule:** `evals.yml` only runs manually. Appendix E §E.7 also wants a fast subset on PRs plus nightly runs.
- **Plan view:** the race line ("N weeks to go") is only partly translated.
