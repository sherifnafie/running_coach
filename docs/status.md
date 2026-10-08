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
| `seed/` | Constitution and one general pack for any sport or combination ([ADR 0006](adr/0006-multi-discipline-coaching.md)): 11 skills that describe the app (coaching knowledge is the model's own, [ADR 0010](adr/0010-skills-describe-the-app.md)), helper profiles, a sport-agnostic workspace template and four starter views (Today, Calendar, Plan, Progress). |
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
  - Claude Haiku 5.5 through OpenRouter, now the default: tools, reasoning replay across tool loops, request-level 1h prompt caching, screenshot reading, and three `disciplines` eval scenarios.
  - The OpenAI key on prod: TTS and STT round trip with gpt-4o-mini-tts and gpt-4o-transcribe. The realtime, whisper and live-transcribe models are available to the key.
- **Not verified:**
  - Coaching quality: no real-model eval cohort and no human calibration.
  - Full provider conformance [MOD-2]; vision and screenshot extraction with a real model.
  - Live voice and calls, Web Push delivery, Telegram, web search backends, and MCP against real servers.
  - The native Android build and Health Connect on a device; iOS.
  - Scheduled proactive delivery over real time.
- **A known model weakness to keep an eye on:** in the VO₂max eval, DeepSeek computed the estimate correctly but invented an RPE value. The eval keeps that as a failure (see `evals/vo2max.md`). Fix this kind of problem through seed instructions, not harness code.

**Optional coach identity:** athlete-controlled name/avatar changes and an independent square-image service are implemented. Off by default; head coach and requested chat turns only. Providers: Google Gemini image generation and OpenAI-compatible Images, with private owned blobs, preview/application separation, conservative budget accounting and durable replay guards. A progressive skill keeps personalization peripheral. Mock provider contracts and the real-gateway browser journey passed; no live image-provider availability or quality is certified. See [setup](self-hosting.md#optional-coach-name-avatar-and-generated-images) and [ADR 0005](adr/0005-optional-coach-identity.md).

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
- **Optional achievements (2026-10-08, [ADR 0009](adr/0009-coach-owned-achievements.md)):** a progressive skill and editable ledger/gallery example; no default tab, automatic migration, award engine or new notification behavior. Recognition needs an actual accomplishment and sources; repeated requests don't earn medals, routine sessions don't need trophies, and opt-out/challenge revisions are respected. Local artwork needs no service. Requested generated images can be attached in chat but their private blobs are not mounted as gallery assets; image permissions remain unchanged. Seven focused eval cases (three also in `fast`), structured saved-file checks and a separate uncalibrated judge rubric. Offline controls and browser publish gates pass; **real-model restraint and pressure resistance are not yet verified** (no dedicated eval key available).
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
