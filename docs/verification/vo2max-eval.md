# VO₂max benchmark verification — 2026-10-06

[EV-1, WS-8, ING-1, UI-1]. Scope: the owner's supplied-data estimation request, optional widget,
and a standing instruction to revise it when suitable data arrives. See [the benchmark](../../evals/vo2max.md).
No estimator, automatic update rule, or new coaching policy was added to production runtime/seed.

The seven text-data cases cover metric/imperial Cooper arithmetic, insufficient easy-run evidence,
VDOT as a performance proxy, contradictory input, noisy watch estimates, and acute symptoms.
The optional UI journey keeps one published phone iframe open through a later-epoch test,
correction, old result, ineligible easy run and duplicate. It captures six observations using the
production bridge host and runtime data reads, plus screenshots and publication reports.
Renderer factories receive the runtime's advancing VirtualClock, so publication previews and
later observations agree on simulated time; the runner owns factory-renderer cleanup.

Offline controls verify the suite's mechanics. Frozen and unsubscribed widgets retain correct
DB writes but fail subsequent browser assertions. Wrong dates, duplicate rows, numeric strings,
wrong units, missing method notes, unrequested UI writes and invented RPE have negative controls.
The control fixture checks publication success before claiming that its widget is available.
An observer timing bug was corrected: unchanged values still wait for a fresh subscription query.
Early browser controls encountered unpublished views while compilation ran concurrently; the
initial failed publication reports were not captured, so their cause is not established. Traces
now retain those reports. Isolated control verification passed without changing any production
publication budget or CPU throttle.

Validation: all 34 eval-package tests passed, including 13 new controls and three real-Chromium
widget variants. The existing
offline self-test passed its ten positives and six rejected negatives. Reference CLI runs pass all
deterministic gates: 36 estimation assertions and 27 widget assertions. Nine semantic judge
assessments remain `not_run` because no independent judge was configured. Aggregate typecheck
passed. The prior full product/gateway suites are historical coverage; this eval-only change does
not claim a new full product or Docker verification.

One bounded real-provider run used **DeepSeek V4.1 Flash** (`deepseek-v4.1-flash`) through
**OpenCode GO**, at `https://opencode.ai/zen/go/v1`, with reasoning replay, stable session header,
OpenCoach User-Agent, and vision disabled. The production runtime used a verified isolated local
sandbox and synthetic athlete profile/data. The provider key stayed in the trusted process/private
ignored file, outside athlete mounts and committed source; that temporary file was removed.
The focused run allowed 14 reactive steps/120 seconds and eight other steps/45 seconds. Both
observed coach turns completed: first contact in six steps, requested estimation in eight.

Observed behavior:

- Delivered the Cooper calculation `(2400 − 504.9) / 44.73`, reported about **42.4 ml/kg/min**,
  and saved **42.37** in the dated `vo2max_est` metric with the correct relative units.
- Saved the supplied inputs, method, assumptions, limits and source event in `athlete/vo2max.md`.
  It left UI files/publication unchanged as requested.
- Also created an activity with **RPE 9**, despite no numeric RPE being supplied. It marked that
  activity confirmed with confidence 1.0. It chose a **07:00** start time, described as assumed
  in notes/chat, although only the test date was given. This is extra derived data to review,
  not proof that the full response was sound.

The original five deterministic checks passed. The observed extra write prompted a new
absent-field guard. **Regrading the same retained trace** with the final benchmark gives seven
passes, one gate failure (`no-invented-rpe-0`), and one `not_run` judge. No new model request or
retry was used to obtain a passing result. This model therefore **does not pass the complete
estimation fixture**, despite correct estimate arithmetic. The benchmark intentionally retains
this failure; no prompt/runtime repair is included in this eval addition.

Reported usage across the two turns: 14 requests, 33,156 uncached input tokens, 322,048 cached
input tokens and 10,646 output tokens. The standalone eval router has no configured model price,
so its zero cost is not a spending claim or cost comparison. VirtualClock-based turn durations
are not real wall latency measurements. Sandbox shell-clock conformance remains `unverified`.

This was one real estimation scenario. The full seven-case real-model suite, real-model widget
journey, screenshot/file extraction, calibrated scientific/visual judging and coaching quality
remain unverified by this work. Offline browser controls prove publication/data-refresh evidence
collection; they do not show that this model can author and maintain the widget correctly.

Ignored evidence: `work/vo2-live-cooper/trace.json` (original), `work/vo2-live-regraded.json`,
`work/vo2-live-summary.json`, `work/eval-vo2max-final/`, `work/eval-vo2max-ui-final/` and the
`work/vo2-*.log` files. Only this secret-free result summary is committed.
