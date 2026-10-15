# Project status

What works, what is verified, what's open. Keep this page current: change the facts when they change, and put the
history in commits, ADRs and the coach changelog, not here.

## State

Phase 1 (MVP) and most of Phase 2 are implemented. Production is on **0.3.14** (harness and `general` pack).
It removes time pressure from coach context, adds goal-adequacy and
early-assessment guidance, retains helper traces and refreshes cached prompts on release changes
([ADR 0015](adr/0015-coaching-judgment-without-time-pressure.md)). `pnpm typecheck`, `pnpm test`, `pnpm build`,
web tests and 18 browser end-to-end checks pass. Eval runs were explicitly skipped at the owner's request,
so coaching behavior remains unverified.

| Area | State |
|---|---|
| `packages/protocol` | Contracts (zod). Browser-safe. |
| `packages/engine` | Agent loop. OpenRouter for all chat models with a vetted catalog ([ADR 0007](adr/0007-openrouter-only-chat.md)); OpenAI-compatible endpoints (Ollama, OpenCode GO); scripted demo coach. |
| `packages/runtime`, `packages/tools` | Mind loop, epochs and compaction, situation report, messaging policy and durable inbox, scheduler, helpers in git worktrees, UI publish/revert, MCP, safety screen, web search/fetch, weather. |
| `packages/store`, `workspace`, `sandbox` | SQLite store; athlete workspace (git, coach.db, history, virtual FS, blobs, export/import/delete); local namespace sandbox and Docker sandbox. |
| `packages/ui-kit` | Browser kit, bridge, Playwright preview renderer with publish gates (writes run on a throwaway copy of the data), coach-facing docs. |
| `packages/voice` | STT/TTS, realtime calls with server sideband, cascaded calls, dictation. |
| `seed/` | Constitution and one general pack for any sport ([ADR 0006](adr/0006-multi-discipline-coaching.md)): skills that describe the app ([ADR 0010](adr/0010-skills-describe-the-app.md)), helper profiles, a sport-agnostic workspace template and four starter views. |
| `apps/server` | Gateway (HTTP, WebSocket, auth, passkeys, CSRF), separate views origin, push, Telegram, CLI, Docker packaging. Per-athlete encrypted OpenRouter keys: managed (administrator's allowance and model) or bring-your-own. |
| `ops/` | systemd user units, deploy with health check and rollback, nightly and pre-deploy backups as separate series. |
| `apps/web` | React PWA: chat (streaming, micro-UI, attachments, voice notes, dictation), coach views in sandboxed iframes, settings, calls. |
| `packages/evals-sim`, `evals/` | Simulator with virtual time, personas, graders/judges, suites, CLI. See `evals/README.md`. |
| `apps/native` | Capacitor Android shell and Health Connect plugin. **Never compiled** (no Android SDK yet). |

## Production

The owner's instance runs from `~/opencoach-prod` on a home server (`ops/`, [self-hosting](self-hosting.md#small-home-instance)),
reachable through Tailscale Funnel, with three athletes. Chat goes through one deployment OpenRouter key; the owner
chooses their own model (currently DeepSeek V4.1 Flash; also tried GPT-6.1 Sol on 2026-10-15). That key has a
lifetime spending limit set in the OpenRouter dashboard: when it runs out every turn fails with a 403 and athletes see
"the provider refused the key". Check it with `GET https://openrouter.ai/api/v1/key` before suspecting the harness.
SearXNG now runs on localhost and is connected to production; general and scholarly searches have returned results
through the installed backend. A real coach turn using the newly enabled search has not yet been observed.

Production reviews of the owner's conversations are the main feedback loop for the harness and seed:
[ADR 0013](adr/0013-lean-memory-and-ordered-side-effects.md) (first week) and
[ADR 0014](adr/0014-truthful-environment-over-instructions.md) (second week, two independent reviewers). Each
records what to compare in the following week.
The follow-up in [ADR 0015](adr/0015-coaching-judgment-without-time-pressure.md) addresses substantive planning
judgment, early assessment and the engine's former halfway instruction to finish.
Its live upgrade turn loaded the new constitution, adapted the coach-owned helper/heartbeat guidance,
added a plan-adequacy section and merged duplicate weekly reviews. This verifies adoption, not coaching quality.

## Verified vs. unverified

- **Verified live (OpenRouter, 2026-10-07/08):** streamed tool calls with reasoning replay, `usage.cost` on every
  call, prompt-cache hits with pinned hosts, screenshot reading by all catalog models under `data_collection: deny`,
  Claude Haiku 5.5 and DeepSeek V4.1 Flash as coach, OpenAI TTS/STT round trip, OpenRouter image generation
  (about $0.012 per image), PWA push enrollment, the Docker image with isolated sandboxes.
- **Verified in production use:** a week of daily coaching by DeepSeek V4.1 Flash: intake, a 12-week plan, view
  building and publishing, helpers, heartbeats, consolidation, held outreach and input recovery across restarts.
- **Not verified:**
  - Coaching quality: no real-model eval cohort and no human calibration.
  - Full provider conformance [MOD-2].
  - Live calls end to end, Telegram, a real coach's use of newly enabled search, MCP against real servers.
  - Physical receipt of Web Push on Android/Chrome (provider acceptance only).
  - The native Android build and Health Connect; iOS.
- **A model weakness to watch:** in the VO₂max eval, DeepSeek computed the estimate correctly but invented an RPE
  value (kept as a failure, `evals/vo2max.md`). Fix this kind of problem in the seed, not in harness code.

## Open work (roughly by value)

1. Run real-model evals (`pnpm eval --suite gates --model <provider:model>`) and improve the seed from the failures.
   The new `planning-quality` suite also needs a substantive judge and human calibration: goal adequacy, pressure,
   stalled strength progress and absent feedback, including later epochs. It has not been run.
   Missing scenarios: post-call recaps and "don't message after an empty call", the weather tool, small-model
   arithmetic and consistency slips in long planning conversations.
2. Compare the next production week against ADR 0014: repeated questions, corrections that survive a context
   change, view saves that work the first time, helper briefs that carry the athlete's own request.
3. Calls: `call.ended` can't tell a call that never connected from a hang-up (two of six owner calls were empty);
   the call front-end has `lookup`, `consult_coach` and `note` but no weather or web.
4. Native shell: build `apps/native`, test Health Connect on a device, then native push and a share target.
5. Validate external services live: Web Push receipt, voice notes and calls, Telegram.

## Known issues

- **Intermittent browser-test database contention:** one full browser run recorded `database is locked` and three
  later assertions failed; a clean repeat passed. Not isolated.
- **Voice spend is not metered:** realtime and cascaded calls, voice-note transcription and TTS use the server's
  OpenAI key and record no usage, so they don't count toward an athlete's budget (dictation does). A call no longer
  starts once the budget is used up, but its own cost is capped only by its maximum duration.
- **Bring-your-own OpenAI key for voice** is not implemented; the credential store already supports `openai`.
- **Historical helper transcripts are missing:** 0.3.14 retains scoped request and returned tool transcripts;
  earlier helpers cannot be reconstructed, and process crashes can still leave only the initial context.
- **Data directory moves:** `ui_versions.dir` stores absolute paths (see self-hosting). Store them relative.
- **Provider session header:** the OpenAI-compatible adapter sends the raw athlete id as its session id
  (`ModelRequest.metadata.epochId` is never set).
- **Harness wording that still coaches the model:** the helper LIMIT message in `runtime/src/helpers.ts`. Research
  guidance is repeated across the constitution, `skills/research`, `agents/deep-researcher.md` and `docs/tools.md`.
- **Two `playwright-core` versions:** ui-kit pins 1.56.1; evals-sim and web use ^1.63.
- **Eval schedule:** `evals.yml` runs only manually; Appendix E §E.7 also wants a fast subset on PRs and nightly runs.
- **Plan view:** the race line ("N weeks to go") is only partly translated.
- **Leaked tool syntax** (fixed 2026-10-07 for one shape): DeepSeek once wrote parameter markup inside a
  `send_message` text. The adapter repairs that shape and `send_message` rejects remaining markup; watch for others.
