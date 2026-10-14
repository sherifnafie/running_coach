# ADR 0013: Lean memory, short chat, ordered side effects, rolling plan detail

Status: accepted, 2026-10-14. Requirements: [RT-10], [CTX-1], [SK-1], [MSG-4], [UI-1], [COST-3].

## Context

A review of the owner's first production week (2026-10-08 → 10-14, DeepSeek
V4.1 Flash on every tier) found sound coaching with avoidable problems. The
review read the transcript, the workspace, the turn contexts and
`feedback-to-harness.md`. The coach's thinking time, its overall output volume
and the app work it does in its own context are acceptable. They pay for
better answers, as long as the athlete and the plan get the same care.

- **Plan drift.** All 81 sessions of a 12-week block were written on day one.
  Every change edited dozens of rows, and prose totals and claims drifted from
  the rows; the independent review caught several. The athlete was told a
  peak of 30 km that the data didn't contain (32.8 km).
- **Duplicated memory.** The same facts (weekly volumes, injury history, "keep
  it short") were copied into five pinned or briefing files, about 7.6k pinned
  tokens plus a briefing that restated them, re-read every turn and drifting
  apart.
- **Tool lessons in pinned memory**, caused by two harness gaps:
  - A step's tool calls ran under `Promise.all`. Two edits to one file raced,
    one was silently lost, and a broken view reached the athlete.
  - The coach's `skills/*.md` were never indexed (only
    `skills/<name>/SKILL.md` was), so pinning was the only way to keep seeing
    them.
- **Verbosity.** Day-one messages ran 100–215 words, often two or three in a
  row, until the athlete said "tldr man, you yap a lot".
- **Over-building and unexercised views.** The athlete asked for a simple
  field twice after getting a full screen. A log field failed three times: it
  was checked for rendering but never typed into.
- **Checks re-run on unchanged state.** Heartbeats and consolidations re-ran
  database checks and previews on days with no athlete activity. The coach
  couldn't otherwise tell that nothing had changed.
- **Effort spec/code divergence.** SPEC §5.2 listed medium/low effort; the
  code ran every class at high.

## Decision

Harness (generic, no coaching logic):
- **[RT-10]** State-changing tool calls in one step run one at a time in
  written order. Helper spawns and image generation stay concurrent.
- **[SK-1]** A single `skills/<name>.md` is indexed as a skill (front-matter
  optional, otherwise its first heading).
- **Situation report:** a `since your last turn` line lists athlete activity
  that didn't wake the coach, or `none`.
- **[COST-3]** The SPEC now matches the code: high effort for reactive,
  scheduled, follow-up and consolidation turns, low for live calls. Thinking
  before answering is the product.

Seed (constitution, addenda, docs, template):
- Session detail goes a few weeks ahead, with the rest kept as the block's
  shape and extended as the weeks pass.
- Numbers are quoted from the data at the time of quoting.
- One home per fact. Pinned files cover the athlete and their training; tool
  lessons go in skills; the briefing holds only what pinned files don't.
- Chat is short by default, one message per reply, with detail in the app.
- App requests get the smallest version that works, exercised as the athlete
  will use it. App work never replaces careful thought about the athlete and
  the plan.
- Re-check only what could have changed.

## Consequences

- Plan edits touch fewer rows, and quoted numbers come from the data.
- Fewer pinned tokens and fewer copies to drift.
- Same-step side effects lose parallelism. Reads, fetches, previews and
  helper fan-out keep it.
- Existing coaches adapt through the changelog. No plan or workspace is
  rewritten by force.
- Unmeasured with a real model. Compare the next production week against this
  baseline: 7.6k pinned tokens, 100–215-word day-one messages, 81 rows
  materialized at plan creation.
