# Coach prompt and capability-context audit

Observed **6 October 2026 UTC / 7 October Europe/Amsterdam** on branch `ccr-a500ac00-ytsl89`, starting at `bfa0f40`. This is a review of the actual context pipeline and a bounded live capability/delegation probe, not a coaching-quality or deep-web-research certification.

## What the coach actually receives

`packages/runtime/src/context.ts` assembles and persists the epoch system prompt from the core constitution plus running coaching/safety addenda, the available skill index, workspace `AGENTS.md`, its pinned persona/profile/current-week files, and `briefing.md`. The conversation grows during the epoch. Full skill bodies, helper profiles, database schema and product/UI documentation are read on demand. `packages/tools` supplies real tool descriptions and JSON schemas; these are not just names mentioned in prose.

Each turn adds trigger events and a harness situation report containing Clock-derived time, why it woke, reply discipline, budgets, quiet hours, tasks, published views, context size and limits. Helpers receive their role/profile, task and explicit inputs, a private worktree, read-only raw/history/system mounts and scoped tools/writes; the main conversation is not automatically copied to them. Files, SQLite records, history, Git and schedules persist independently of a particular model's context window.

The existing constitution was substantial: identity and time, memory, messaging, proactivity, helpers, editable views, evidence, privacy, untrusted content, running coaching, safety, resources and self-improvement. The audit found gaps in product orientation and accurate capability/research instructions, not an absence of an agent system prompt.

## Repairs

- Introduce OpenCoach explicitly and add `/system/docs/opencoach.md`: the product, shell/view ownership, database vs chat, persistence, tools, helpers, UI publication and actual deployment limits.
- Add a `research` skill and `deep-researcher` profile (deep tier, high effort, scoped cited reports). Keep the fast `researcher` for narrow facts. Fix its missing `write` grant; a declared write scope alone did not allow it to save the notes its prompt requested.
- Render current granted core tools, wired search backend, fetch setting, renderer configuration and primary model/vision routes into each coach situation and helper environment. State that these are configuration facts, not live service health checks. Give helpers Clock-derived time and product/skill pointers.
- Make UI ownership explicit: coach views can change; Chat, Settings, authentication and the server remain shell-owned. Never claim visual inspection without image input. Remove inaccurate automatic PDF/image-extraction claims from tool documentation.
- Explain requested scope, research depth, source verification, privacy, uncertainty, background completion and preserving cited findings. Refresh the stale coach changelog that described already implemented account/call/MCP mechanisms as absent.

No training algorithm was added to harness code. Runtime additions report configuration facts; coaching/research procedures remain model instructions and skills.

## Verification

Four new production-runtime integration tests inspect actual model requests and persisted turn contexts, check rendered memory and skill discovery, compare exposed tool schemas, verify missing search/fetch/vision/renderer reports without leaking a test credential, and execute both research profiles against a clearly labeled offline source fixture. The fixture search result is not live evidence. Both helpers write a report in their allowed scope, return it to the coach, receive correct time/capability context, and do not receive the private athlete request. The deep helper selects high effort and the deep route; quick research remains fast/low.

Aggregate typecheck passes. All **739 core tests** pass. Offline self-test passes **10 reference cases** and rejects **6 bad controls**; full offline gates pass **120 scenarios / 173 assertions**, with no failures or missing evidence. All three Chromium renderer gates have passing results. One sample-data render initially exceeded the 1500 ms budget while the evaluation jobs ran concurrently (Progress: 2564 ms with 4× CPU throttling); the targeted recheck after those jobs finished passed both matching render cases, with the already-passing third case skipped. No threshold or view implementation changed. Thus the first aggregate command exited nonzero on that performance check, while the subsequent isolated check resolved it. Offline reference controls verify harness/grader behavior, not real model behavior.

After the final skill clarifications, the seed/context integration checks passed **11/11** and the required offline fast subset passed **25 scenarios / 32 assertions**, with no failures or missing evidence. These are a subset of the gate dimensions, not 25 additional distinct live-model trials.

## Bounded live DeepSeek probe

Provider/model: **OpenCode GO / `deepseek-v4.1-flash`**, official compatible endpoint, reasoning replay enabled, vision disabled and the same model on all tiers. The trusted composed server used a real **`local-isolated`** sandbox, manual scheduler, a synthetic account, reactive limits of 14 steps/180 seconds and helper limits of 10 steps/120 seconds. Temporary credentials remained outside athlete mounts and model context and were removed. No genuine health records were sent.

The athlete first asked which app the coach lives in, what it can change, how memory persists and whether helpers/deep research are available. Delivered messages accurately identified OpenCoach, persistent files/SQLite/Git/briefings, editable Today/Calendar/Plan/Progress views and the shell boundary. It identified all tiers as the same model, search as unconfigured, fetching supplied public URLs as a separate capability, and vision as unavailable across all tiers. These were inspected as delivered `coach.message` events, not private final text. The coach also cancelled the test account's first-contact wake to avoid a duplicate hello; this is an observed exception to the request for no schedule changes, not evidence of perfect scope adherence.

A second request asked for an independent deep review using only the local research skill and product map. The coach delegated to a background `deep-researcher` with web tools withheld and scope `research/**`. The first helper reached its 120-second wall limit after five steps and produced no merged report. Its task was marked done without outputs; the coach checked for the missing file, retried the work within the same bounded probe, and verified the second helper's saved `/workspace/research/context-audit.md`. The successful helper ended normally in four steps on the deep tier with high effort. Its report cites the two local sources, describes source/configuration limits and explicitly disclaims fresh web search. The coach read the report and delivered the result. All attempts are retained; the incomplete first attempt is not counted as a successful independent trial.

The three coach turns ended normally in **6 / 6 / 10 steps**; the two helper turns were **limit / ok** in **5 / 4 steps**. Reported usage: **61,232 uncached input / 593,792 cached input / 43,087 output tokens**, peak-rate estimate **$0.073636752**. This is local reported-token accounting, not a provider invoice; a cancelled in-flight request can have unreported usage. Private source traces remain under ignored `work/context-live/`; no credential markers were present in them.

The live review suggested putting untrusted-content and visual-evidence warnings directly in the research skill. These protections were already present in higher-level constitution/helper instructions and the product map; their absence from the skill alone was not proof of an unprotected agent. The final skill repeats them at the point of use. The live probe preceded those two local clarifications; the final skill is covered by the subsequent offline context/evaluation checks.

## Practical limits

This establishes that the app supplies broad context and that the live model can describe it, delegate a deeper task, save a scoped report and verify its delivery. It does not establish full research quality, source-verification reliability, complete prompt adherence or long-horizon coaching quality. The wall-limit attempt and first-contact cancellation show why capability awareness is not a general behavior guarantee. Partial/limited helper status could be made clearer in a future runtime change.

Fresh web search needs a wired Brave, Tavily or SearXNG backend. Public-page fetch is independent. The GO example currently has neither search configuration nor a vision-capable model; prompts cannot supply either. Live literature retrieval, visual review/publication by this model, external voice/push/Telegram/MCP behavior, native SDK/device integration, and full model conformance/safety/human-calibrated coaching evaluation remain unverified.

New workspaces receive the updated seed profiles. Existing coach-owned files are preserved: the `research` skill explains adding a missing deep profile, and the coach changelog describes fixing an older research profile's write grant when desired. Constitution and skill-index snapshots refresh at the next epoch; per-turn reports point existing contexts to the current product guide and research skill immediately. Keep the same data directory when restarting.
