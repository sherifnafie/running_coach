# Project status

What works, what has been verified, and what's next. Keep this current when you finish or find something.

## State

Phase 1 (MVP) and most of Phase 2 are implemented. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e` and `pnpm eval:selftest` all pass.

| Area | State |
|---|---|
| `packages/protocol` | Contracts (zod). Browser-safe. |
| `packages/engine` | Agent loop. Anthropic, OpenAI and OpenAI-compatible providers (incl. OpenCode GO), scripted demo coach. |
| `packages/runtime`, `packages/tools` | Mind loop, epochs, situation report, messaging policy, scheduler, helpers in git worktrees, UI publish/revert, MCP, safety screen, web search/fetch. |
| `packages/store`, `workspace`, `sandbox` | SQLite store; athlete workspace (git, coach.db, history, virtual FS, blobs, export/import/delete); local namespace sandbox and Docker sandbox. |
| `packages/ui-kit` | Browser kit, bridge, Playwright preview renderer with publish gates, coach-facing docs. |
| `packages/voice` | STT/TTS, realtime calls with server sideband, cascaded calls. |
| `seed/` | Constitution, running pack, 16 skills, helper profiles, the workspace template and four starter views (Today, Calendar, Plan, Progress). |
| `apps/server` | Gateway (HTTP, WebSocket, auth, passkeys, CSRF), separate views origin, push, Telegram, CLI, Docker packaging. |
| `apps/web` | React PWA: chat (streaming, micro-UI, attachments, voice notes), coach views in sandboxed iframes, settings (incl. language/theme), calls. |
| `packages/evals-sim`, `evals/` | Simulator with virtual time, personas, graders/judges, suites, CLI. See `evals/README.md`. |
| `apps/native` | Capacitor Android shell and Health Connect plugin. **Never compiled** (no Android SDK yet). |

## Verified vs. unverified

- **Verified live:** OpenCode GO with DeepSeek V4.1 Flash, using synthetic athletes. Covered: streaming tool calls, signup, delivered replies, saved intake, plan and activity, all four views showing the data, delegation to helpers, and the owner's own phone test. The server Docker image builds and runs the demo with isolated sandboxes.
- **Not verified:**
  - Coaching quality: no real-model eval cohort and no human calibration.
  - Full provider conformance [MOD-2]; vision and screenshot extraction with a real model.
  - Live voice and calls, Web Push delivery, Telegram, web search backends, and MCP against real servers.
  - The native Android build and Health Connect on a device; iOS.
  - Scheduled proactive delivery over real time.
- **A known model weakness to keep an eye on:** in the VO₂max eval, DeepSeek computed the estimate correctly but invented an RPE value. The eval keeps that as a failure (see `evals/vo2max.md`). Fix this kind of problem through seed instructions, not harness code.

## Open work (roughly by value)

1. Run real-model evals (`pnpm eval --suite gates --model <provider:model>`) and improve the seed (constitution and skills) based on the failures.
2. Validate vision: configure a vision-capable route and test screenshot extraction (`evals/suites/extraction.yaml`).
3. Native shell: build `apps/native` with an Android SDK, test Health Connect on a device, then do native FCM push and a share-sheet target.
4. Validate the external services live: Web Push, voice notes and calls, and Telegram.

## Known issues and cleanup backlog

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
