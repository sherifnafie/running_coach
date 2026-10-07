# VO₂max estimation and widget benchmark [EV-1, WS-8, UI-1]

This benchmark checks a scenario the owner asked for:
1. Give the coach data and ask for an estimated VO₂max.
2. Optionally ask for a widget that shows it.
3. Optionally ask the coach to update the estimate when suitable new data arrives.

All data is synthetic. Choosing an estimator and deciding when to update stay with the model; there is no VO₂max logic in the harness or seed.

```sh
pnpm eval --suite vo2max    --model reference      # 7 estimation cases
pnpm eval --suite vo2max-ui --model reference      # 1 widget journey (Chromium)
pnpm eval --suite vo2max --model openai:MODEL --judge anthropic:JUDGE   # real model
```

## Estimation cases (`vo2max`)

The seven cases are:
- maximal Cooper tests in metres and in miles;
- insufficient easy-run data;
- a race-derived VDOT;
- inconsistent input;
- noisy watch reports;
- a chest-pressure safety case.

The arithmetic cases use the common Cooper conversion `(12-min distance in m − 504.9) / 44.73`, so 2400 m gives 42.37. The tolerance is ±0.15. That checks the calculation, not physiological accuracy. The deterministic checks look at:
- saved `metrics` rows (date, value, units, exact counts);
- the method notes in `athlete/vo2max.md`;
- that the coach invents no values. For example, unreported RPE and heart rate must stay null.

## Widget journey (`vo2max-ui`)

The journey has seven actions:
1. An estimate in chat.
2. Asking for a `vo2max` view and a standing "update when new tests arrive" rule.
3. A new test after an epoch boundary.
4. A distance correction.
5. A late historical result.
6. An ineligible easy run.
7. A duplicate.

The observer keeps one published view open in a phone-sized Chromium iframe. It uses the production `BridgeHost`, the manifest-scoped queries and the CSP. After each action it records visible text, query results, subscriptions and screenshots. A widget that only refreshes on reload, or that never subscribes to changes, fails.

## Results so far

The offline controls pass, and the negative controls are rejected: wrong dates or units, fabricated estimates, duplicates, missing notes, and frozen or unsubscribed widgets. One real DeepSeek V4.1 Flash run computed the correct 42.37 estimate and recorded the method, but invented an activity RPE of 9. That fails the benchmark, and the failure is deliberately kept. The judge rubrics (`vo2max`, `ui`) have not been run against real models or calibrated with humans.
