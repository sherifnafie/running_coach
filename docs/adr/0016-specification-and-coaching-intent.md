# ADR 0016: Keep the specification faithful to accepted coaching intent

Status: accepted, 2026-10-15. Requirements: [SAFE-3], [CTX-2], [CTX-4], [SK-1], [UI-1],
[WS-5], [SEC-6], [COST-1], [EV-1]. Documentation corrections; no new runtime/seed deployment.

## Context

A full review of SPEC §§0–23 against its founding revision and accepted ADRs found a mismatch
between the high-level principles and several surviving details. The founding thesis remains:
the model is the coach, the workspace holds its knowledge, and the harness supplies general
capabilities and enforceable guarantees. However, details could be read as fixed coaching
workflows or could direct future engineers to restore behavior already rejected.

Most seriously, [SAFE-3] still placed skills and workspace notes above athlete requests, contrary
to ADR 0008 and the shipped constitution. Other stale statements described a universal call recap,
nightly file-update sequence, an old compaction threshold, a pending SDK spike, a Docker-only
deployment and fallback on every view error. Some were factual drift; others were examples
that could accidentally become universal acceptance criteria.

The review also found unmet implementation obligations. These must not be erased merely to
make the specification describe current code. In particular, managed spending is checked on
turn admission without a shared in-flight allowance reservation, and backup retention by count
does not enforce the promised 30-day erasure deadline.

## Decision

- Restore the accepted precedence: safety, honesty and enforced guarantees first; athlete
  wishes above skills, workspace notes and coach assumptions. Filesystem ownership enforces
  permissions, not semantic instruction precedence.
- State the substantive coaching standard accepted in ADR 0015 in the product contract:
  coach-owned judgment, an evidence-to-training-to-goal case, and timely reassessment of actual
  progress. Address insufficient as well as excessive work without prescribing training methods.
- Mark journeys as illustrative outcomes. Remove universal intake, illness-timetable, nightly
  maintenance and post-call-recap implications; retain the safety floor and no-message
  consolidation guarantee. Distinguish observed measurements from explicitly derived estimates.
- Correct factual documentation to ADRs 0001/0003/0004/0007/0010/0014 and current contracts:
  own engine/provider adapters, local namespace or Docker isolation, trusted preview service,
  isolated preview writes, startup-only fallback, model-aware total-prompt compaction and
  administrator authority over managed accounts.
- Make latency targets concern acknowledgement/progress, not premature substantive completion.
  Distinguish requirements and proposed milestones from completed validation.
- Keep hard spending, erasure, export, undo and isolation requirements. Record implementation gaps
  in status rather than silently weakening guarantees. Generic view-write receipts, voice lookup
  over coach-owned schemas and full athlete-facing undo remain implementation work.

## Remaining decisions and verification

Cost/quality fallback policy, calibration of nominal step limits, experimental self-host model
selection versus validated defaults, and the remaining maintenance prompting need explicit follow-up.
Athlete enthusiasm does not waive spending/privacy controls or imply a guaranteed performance outcome.

The review did not run evals, alter training, delete archives or change the deployed runtime.
Behavioral validation and human calibration remain open, as stated in status. Detailed personal
evidence is retained locally outside Git; no athlete conversation is quoted here.
