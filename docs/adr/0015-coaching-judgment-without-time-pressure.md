# ADR 0015: Coaching judgment without time pressure

Status: accepted, 2026-10-15. Requirements: [RT-5], [CTX-1], [SUB-3], [SK-1], [EV-1].

## Context

A production review found a substantive plan revision that checked session arithmetic and
calendar consistency but did not establish a fresh case that the changed training served the
goal. The earlier plan had received a real design and independent review; that work did not
automatically validate the subsequent change. An assurance about cross-discipline load also
exceeded what the available evidence established. Athlete pressure for greater initiative was
interpreted primarily as permission to increase training and make decisions quickly.

There was also a direct harness contribution: halfway through every turn the engine injected
"Finish now", despite half the configured allowance remaining. The reviewed turn received
this instruction and delivered shortly afterward. This establishes conflicting guidance, not
proof that elapsed time alone caused the reasoning failure. The default reactive cutoff was
ten minutes; SPEC [RT-5] still said five. Background helpers were similarly hurried halfway
through their own allowance. A minimum thinking duration would be just as arbitrary.

The previous review correctly removed a compulsory planning pipeline (ADR 0014). However,
the planning judge still required a separate review for every consequential block, and helper
profiles emphasized tolerability and arithmetic more than goal adequacy. Stored helper turns
had only metadata and a final note, making actual research/review work hard to inspect.

## Decision

- Remove time-based completion instructions entirely. Do not narrate wall-time allowances in
  main-coach or helper context. Set all normal main/helper wall cutoffs to six hours, solely as
  distant runaway backstops. Live-call coach turns inherit that backstop too; their conversational
  style still fits the call. Provider-stream stall detection, cancellation, step limits, cost and
  security controls remain separate mechanisms. Operators must review shorter existing overrides.
- Replace the constitution's planning paragraph with an outcome standard: a defensible connection
  between evidence, training and goal; consideration of both insufficient and excessive stimulus;
  honest confidence; reconsideration when challenged; and early observations that can change the
  plan or goal. Correct totals, more training, citations and completed sessions alone are insufficient.
- Keep duration, helper use, review count, training methods and assessment choices with the coach.
  Do not encode sport-specific thresholds, a minimum research duration or a plan approval engine.
- Version cached system prompts by harness and pack release. Replace the epoch when either
  changes (or a legacy snapshot lacks versions), retaining recent athlete messages verbatim.
  Otherwise a release's new constitution could remain absent until the next day or compaction.
- Make planner/reviewer profiles consider goal adequacy and early detection of failure, alongside
  feasibility and safety. Grant web tools when the deployment provides them. Existing profiles are
  coach-owned: the changelog points to updated references rather than overwriting them.
- Store each helper's scoped request and returned transcript, including tool calls/results, on its
  turn context. Record both successful and stopped/error returns; omit duplicated image bytes but
  retain their references. These records follow existing athlete ownership/deletion. This is audit
  evidence, not a guarantee of complete traces after a process crash.
- Add synthetic `planning-quality` cases: goal reconsideration, pressure during a return to training,
  worsening effort with stalled strength performance across epochs, and missing training feedback.
  A substantive judge is a required gate, with one case in `fast` and all four in `gates`; replies
  and nonempty files cannot make these suites pass without assessment. Include supplied initial
  files and helper contexts as judge evidence.
  Fix the older planning rubric to require separate review only when explicitly requested.

## Consequences and validation

The harness supplies truthful capabilities, durable evidence and runaway protection; the seed
describes good judgment. A stronger model remains free to choose a better approach. Neither these
instructions nor scripted tests certify that a plan will achieve an athletic outcome.

Code regressions cover absence of time prompts, continued work until the actual backstop, helper
trace retention on success/error, capability-change continuity and required quality assessment.
The unfinished SearXNG documentation/testing from the preceding release is completed alongside
this change, including first-upgrade detection when no tool ledger existed.

The owner explicitly requested **no eval runs for this change**. This is an exception to the
usual Appendix E §E.7 gate, not evidence of passing it. The new quality scenarios and changed
prompts remain behaviorally unverified. Future validation should compare fixed-seed baseline
and candidate traces, retain every failure, use a different-family judge where possible, and
obtain human-coach calibration. Examine whether the coach establishes an adequate training case
and reacts to evidence early, rather than rewarding time spent, verbosity or helper count.
