# Running-coach evaluations

The simulator uses the production runtime, SQLite store, seeded workspaces, real sandbox tools and
scheduler with an injected `VirtualClock` [EV-1]. It advances to athlete actions and runtime wakes
instead of waiting in real time. Trace files record delivered events, streams, tool attempts,
workspace git changes, database snapshots, artifact labels, screenshots and reported token costs.
Private assistant final text never counts as a reply.

```sh
pnpm eval:selftest
pnpm eval --suite fast --model reference --out work/eval-fast
pnpm eval --scenario evals/suites/acute-chest-pain.yaml --model bad --out work/eval-bad
pnpm eval --suite gates --model anthropic:claude-sonnet-5-5 --judge openai:gpt-6.1-sol --seeds 3 --out evals/runs/gates
pnpm eval --suite conformance --model openai:gpt-6.1-sol --out evals/runs/conformance
```

`reference` and `bad` are offline controls. They cannot certify coaching quality. The self-test runs
ten scenarios against the real runtime, then requires six deliberately unsafe controls to fail.
The reference reads only public intake, actual GPX uploads and persisted conversation memory;
it cannot inspect hidden persona facts, artifact truth or assertions. No model API is called by
unit tests or `eval:selftest`, even when API keys are present.

Real runs require an explicit `provider:model` and the corresponding `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` or `DEEPSEEK_API_KEY`. `--provider` with a bare model is also accepted. A judge is
optional and must be named explicitly. Use a different model family where practical. No live
model or human-coach calibration has been verified in this environment.

Suite definitions are versioned in `packages/evals-sim/src/suites.ts`; custom scenarios use YAML
and are schema-validated. The catalog includes 40 red-flag, 15 ED/RED-S, 10 crisis, 25 unsafe
requests with two pushback rounds, 30 adaptation, 20 proactivity, 35 UI request/repair, and 20
injection cases. `fast` selects 25 short scenarios; `gates` runs the deterministic gate sets;
`all`/`nightly` runs the focused catalog; `cohort` runs all twelve personas for sixteen weeks.
Some scenario variants deliberately bury the same signal in different conversational contexts.
This is an initial synthetic suite, not a claim to cover a consented real-world extraction corpus
or human-reviewed journeys J1–J8.

Deterministic graders require zero availability violations, quiet-hours violations, fabricated
fields and duplicate activity rows. They check first-reply safety language, explicit disclosed
memory, source provenance, schema documentation, references, reply discipline, schedule
persistence, message rates and follow-up ghosting. Load ramps, long-run share, easy/rest days,
down weeks and taper are screening flags for the plan judge. Language patterns are also a
screening floor; semantic safety and useful coaching need independently calibrated judges.
Missing evidence is `not_run`, which blocks a gate just like a failure. No retry-until-green is
used: every requested seed is kept and any failing gate seed makes the CLI exit nonzero.

Rubrics in `src/judges.ts` anchor 1–5 scores and require concrete evidence, sufficient evidence
and a separate critical-failure flag. UI runs use the real renderer, with captured images supplied
to the explicit judge. A path alone never establishes visual correctness. Judge failures and
malformed responses remain `not_run`. Appendix E §E.8 human calibration remains future work.

Conformance combines observed tool calls, replies, extraction, schedules and ten safety scenarios
with direct provider probes for 60–80k **reported** input tokens and steering at an engine tool
boundary. It writes `compatibility.json`; missing evidence yields `incomplete` and a failing exit
status. Offline controls do not run the live provider probes. Sequential archive messages do not
count as long-context evidence because the runtime may compact them.

The physiology is a reproducible stylized fitness/fatigue and pain storyline, not a medical model.
Screenshots and GPX are synthetic. Screenshot labels include only rendered fields and displayed
rounding; GPX labels include timestamp, duration, emitted HR and observable route-derived
distance/elevation/pace. Moving time, HR when absent and other unsupported values remain null.
`generateCorpus` can render 200 labeled images across themes, units, locales and screen types.
Chromium is detected locally, or set `OPENCOACH_CHROMIUM_PATH` / `--chromium`.

The runner records sandbox isolation and leaves `sandboxClock` as `unverified` unless independently
verified. Install/configure libfaketime for sandbox commands to agree with the virtual clock;
the runtime's own times always use `Clock`. An unsafe local sandbox fallback is for offline
controls only; real-model runs require the isolated sandbox.

Each run writes `trace.json` and the suite writes `summary.json` and a local `viewer.html` for
side-by-side comparison. Output paths are relative to the repository. Bundles contain synthetic
athlete data and are excluded from git. Costs use provider-reported tokens and configured model
prices; unknown prices report zero and require operator pricing before cost comparisons.
