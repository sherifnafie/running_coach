# ADR 0014: A truthful environment over more instructions

Status: accepted, 2026-10-15. Requirements: [CTX-1], [CTX-2], [UI-1], [SUB-1], [RT-4], [COST-1].

## Context

Two independent reviews (Claude and Codex, each without seeing the other's)
read the owner's production conversations from 2026-10-08 to 10-15 end to end:
turn contexts, tool calls, helpers, the workspace and its git history, and the
coach's `feedback-to-harness.md`. The question was where the harness gives the
coach too little, misleading or conflicting context, too much instruction, or
boxes it in. The reviews agreed on the main pattern: the coach's diligence was
fine, but several things the harness told it were false or incomplete, and it
turned what it then learned into rigid rules carried from context to context.

- **Preview lied about writes.** `preview_ui` checked a view's writes against
  its manifest and then returned success without running them, and showed only
  error-level reports. The coach shipped a broken save path three times in one
  evening, then built a probe that reported success as an error to see it, and
  learned from the stub that "an update matching no row succeeds" (the live
  gateway rejects it). That false lesson reached its skills and our backlog.
- **`ui.error` claimed a fallback** on every report. The app only swaps
  versions when a view fails to start, so the coach wrote defensive rules into
  every view.
- **Compaction every few minutes.** A fixed 80k-token trigger (system prompt
  and tools use about 25k) compacted eight times in one evening on a model with
  a 1M window. Each time a short summary of a summary replaced the athlete's
  own words; a model switch dropped the day's conversation entirely.
- **Nudges.** "N turns since you last updated your pinned files" fired on every
  turn once eight passed without a pinned write, pushing facts into pinned files.
- **Conflicting reports.** Tools the server can't run were offered and listed as
  granted next to "NOT CONFIGURED"; helper and tool descriptions carried
  workflow advice that the constitution also gave, sometimes differently
  ("one message per reply" vs "call it several times").
- **A fixed planning pipeline** in the constitution (deep-tier design, at most
  one review, within the hour), and a helper brief that passed the coach's
  conclusions as the athlete's constraints.
- **Lost helper work.** A helper that hit a stalled stream lost everything it
  had written, because only limit stops kept partial files.

## Decision

Fix what the harness says about the world and what the coach can do; don't add
instructions to compensate.

- Preview runs bridge writes with the live rules (`applyViewWrite`) on a
  per-variant throwaway copy of the data and reports each write's outcome and
  the view's `warn`/`info` reports as non-failing notes.
- `ui.error` states the actual rule: start failures fall back, later errors don't.
- Compaction triggers at `min(limits.compactionTriggerTokens, 60% of the model's
  context window)`, default cap 160k. Any context opened mid-day (compaction or
  model switch) carries the latest chat messages verbatim; the compaction prompt
  asks for what the athlete asked, corrected or disputed, with event ids.
- The harness no longer nudges memory writes (SPEC §5.3.3 amended).
- Tools without a backing service are not offered; the situation report names
  them once. Capability lines state facts, not advice.
- Helpers stopped by a model error keep their in-scope files, like limit stops.
- Constitution §6/§12 keep the standard for a multi-week plan and leave the
  process (helpers, reviews, how many) to the coach; helper briefs separate the
  athlete's constraints from the coach's assumptions. The safety pack keeps every
  weight and calorie limit but says a passing mention of weight is not a request
  to decline.

## Consequences

- A stronger model gets more of the day verbatim and fewer false facts to work
  around; a weaker one loses the crutch of reminders, which the reviews found
  did more harm than good.
- Longer contexts cost more per step. On DeepSeek V4.1 Flash this is negligible;
  on a premium model (GPT-6.1 Sol) cached context dominates a turn's cost, and
  operators can lower `limits.compactionTriggerTokens`.
- Existing workspaces keep the workarounds the coach wrote; the 0.3.13 changelog
  for the coach names them so it can drop them.
- Real-model effect is unmeasured; compare the next production week against
  this review (repeat questions, corrections that survive a context change,
  view saves that work first time).
