# VO₂max estimation and optional widget benchmark [EV-1, WS-8, UI-1]

This tests the owner's request: give the coach data, ask for an estimated VO₂max, optionally ask
for a widget, and optionally ask it to remember to update the estimate when suitable data arrives.
All athlete data is synthetic. Estimators and update decisions remain the model's responsibility;
the app runtime and coach seed have no new VO₂max policy.

```sh
pnpm eval --suite vo2max --model reference --out work/eval-vo2max
pnpm eval --suite vo2max-ui --model reference --out work/eval-vo2max-ui
```

The first suite has seven scenarios: maximal Cooper tests in metres and miles, insufficient
easy-run data, race-derived VDOT, inconsistent input, noisy watch reports, and chest-pressure
safety. The second suite has one seven-action journey: estimate in chat → request widget and a
remembered update rule → another test after an epoch boundary → distance correction → late
historical result → ineligible easy run → duplicate. Both suites are included in `all`/`nightly`; existing `fast`,
`gates` and `eval:selftest` selections keep their previous scope.

The widget journey observes an immutable **published** view in a 390×844 Chromium iframe.
It uses the production PWA `BridgeHost`, production runtime manifest-scoped queries, UI kit,
CSP and the PWA's stream-change predicate. The same iframe stays open across later messages;
reloading or republishing instead of refreshing data fails continuity. The observer records
accessible text, query results, active subscriptions, mount/version, errors and screenshots at
each relevant action. This component client does not repeat gateway authentication, offline
queue or full-shell acceptance coverage. A publication screenshot alone never proves updates.

In this benchmark the athlete explicitly requests the portable seed `metrics` table,
`athlete/vo2max.md`, and the `vo2max` view id so that deterministic state checks can find evidence.
That is an output contract for these fixtures, not a general requirement for every coach-designed
widget. The standing instruction is kept in `briefing.md`, which is available across epochs.
The model revises data during a triggered turn; the widget subscribes to saved changes. Neither
requires or implies continuous model thinking or automatic watch/device synchronization.

The arithmetic fixtures request the commonly used Cooper conversion:

```text
estimated relative VO₂max = (12-minute distance in metres − 504.9) / 44.73
2400 m → 42.3675 ml/kg/min
1.5 miles = 2414.016 m → 42.6809 ml/kg/min
2700 m → 49.0744; corrected 2600 m → 46.8388
```

The foundation is Cooper's 12-minute field test ([JAMA, 1968](https://doi.org/10.1001/jama.1968.03140030033008));
the [commonly published distance conversion](https://www.brianmac.co.uk/gentest.htm) is used here
as an explicit arithmetic oracle. Its output is a population-based estimate conditional on the
test protocol. The tolerance of ±0.15 checks calculation/rounding; it **does not** assert that the
athlete's true VO₂max is known within that error. No simulated gas-analysis measurement exists.
Daniels/Gilbert VDOT from a 20:00 5K is about 49.8; it is a running-performance index, not a
measurement of physiological VO₂max. Easy-run HR/pace and overnight watch changes cannot
establish an exact individual value or a real fitness gain.

Generic DB assertions filter rows by date/name, check numeric bounds and exact counts, and verify
units. Optional activity writes must leave unreported RPE and heart rates null: "maximal" is not
a supplied numeric RPE. File checks use the athlete's filesystem jail. Delivered replies count; private assistant
notes do not. Wrong dates, units, numeric strings, fabricated estimates, duplicate records,
missing method notes and frozen/unsubscribed widgets have negative controls. These controls
exercise the real runtime and browser, without any model API call or access to hidden assertions.

For a real model, name a supported provider and an explicit judge:

```sh
pnpm eval --suite vo2max --model openai:YOUR_COACH_MODEL --judge anthropic:YOUR_JUDGE_MODEL --out work/eval-vo2max-live
pnpm eval --suite vo2max-ui --model openai:YOUR_COACH_MODEL --judge anthropic:YOUR_VISION_JUDGE_MODEL --out work/eval-vo2max-ui-live
```

Provider credentials belong in the trusted environment. The eval CLI currently supports OpenAI,
Anthropic and **direct** DeepSeek; it does not read the server's OpenCode GO configuration.
Use `runScenario` with an explicitly constructed compatible provider for GO, and never send a
GO key to the direct DeepSeek endpoint. API callers should supply
`rendererFactory: clock => createPlaywrightRenderer({ clock })` and `observeViews: true` for
widget evidence; the CLI enables both automatically for `view` assertions. Publication previews
and observations share the runner's advancing `VirtualClock`. The runner disposes factory-created
renderers; callers still own a directly supplied `renderer`. Real-model tools
require an isolated sandbox. Chromium is required for the optional UI suite.

The versioned `vo2max` judge rubric assesses scientific honesty, assumptions, attribution,
precision, useful clarification, safety and continuity. The `ui` rubric assesses actual supplied
images. They are reported separately as non-blocking semantic assessments, matching the existing
focused UI/adaptation suites. With no judge they remain `not_run`, even when deterministic gates
pass. They have not been calibrated with human coaches. Offline controls validate the benchmark
mechanics; they do not certify a model's coaching quality, biological prediction accuracy or
multi-athlete isolation. Screenshot/file extraction and richer open-ended estimates remain
additional coverage to add rather than implied by these text-data fixtures.

Observed results, including a real-model failure retained in the benchmark, are in the
[verification record](../docs/verification/vo2max-eval.md).
