# Strength training: powerlifting

Part of the `strength-training` skill. Powerlifting tests a one-rep max in the squat, bench press and deadlift, three attempts each, judged against rules. Read `programming.md` for general principles and `competition-prep` for the event timeline, goals and debrief.

## 1. Know the athlete's competition context
Ask, and record in the profile and `goal_events` (`kind: meet`, `sport: strength`, `goal.text` like "500 kg total, 8/9"): federation (IPF and its affiliates, USAPL, USPA, and many others: rules differ), division (classic/raw or equipped; age class), weight class, meet date, weigh-in timing (2-hour or 24-hour changes eating on the day), recent best lifts in competition and in the gym, competition history, and who handles them on the day. **Research the federation's current rulebook** (`researcher`) rather than relying on memory: depth, bench pause and commands, allowed equipment (belts, sleeves, wraps, singlet), and attempt-change rules.

Weight class: they compete where they naturally sit. No cutting plans, dehydration or rapid restriction (constitution §11). If a class change matters to them, suggest a sports dietitian and plan training as if weight were stable.

## 2. Training for the platform
- **Specificity:** the competition lifts (or close variations) are the core, typically squat and bench 2 to 3 times a week and deadlift 1 to 2 times, with variations (pause squat, close-grip bench, deficit or block pulls) chosen for a reason (a weak position, an irritated joint, technique practice) and accessories for muscle mass and weak points.
- **Intensity:** most working sets at ~70 to 87% (RPE 6 to 8), heavier singles and doubles (RPE 8 to 9) more often as the meet nears. Grinders to failure on the competition lifts are rarely useful.
- **Volume:** higher in accumulation blocks (muscle and work capacity), lower as intensity rises. Bench tolerates more frequency and volume than squat; deadlift fatigue is high per set.
- **Practice the rules in training:** squat depth, pause and commands on bench ("start", "press", "rack" in IPF-style rules), lock-out and waiting for "down" on deadlift. A missed pause or soft depth on the day costs a lift.
- **Technique:** video from the side for squat and deadlift, from the front and side for bench. You can comment on what's visible (depth, bar path, pause), but encourage an experienced in-person coach for technique learning.

## 3. Block structure (one common pattern; adapt)
| Phase | Weeks | Emphasis |
|---|---|---|
| Accumulation / hypertrophy | 4 to 6 | More sets, 6 to 10 reps, variations, accessories; RPE 6 to 8. |
| Strength / intensification | 3 to 5 | Fewer sets, 3 to 6 reps, competition lifts; RPE 7 to 9. |
| Peak | 2 to 4 | Heavy singles and doubles at ~88 to 95% (RPE 8 to 9), volume down, accessories trimmed. |
| Taper | ~1 week (up to 2) | Volume cut ~30 to 70%, some lighter singles at opener weight early in the week, last heavy work ~7 to 10 days out for deadlift and ~5 to 7 for squat and bench, rest or very light the final 2 days. |
Tapers of about a week with reduced volume and maintained intensity are what most powerlifting coaches use and what the limited evidence supports (*weak/moderate*; Pritchard et al. 2015; Travis et al. 2020). Don't test true maxes in the final two weeks.

For a hybrid athlete, hold running (or other endurance) volume steady or reduce it during the peak, keep it easy, and keep it away from heavy squat and deadlift days (`disciplines`).

## 4. Attempt selection (guidance, adjusted to the athlete and the day)
- **Opener:** a weight they could do for about a triple on a good day, or a single at RPE ~7 on a bad day: often ~88 to 93% of their current best estimate. Its job is to get on the board and settle nerves.
- **Second:** a confident heavy single, often ~95 to 98%, around a current best.
- **Third:** a PR attempt if the second moved well (~100 to 103%), smaller if it was slow or the meet goal is a total or 9/9.
- **Decide the plan before the day, adjust on the day:** bar speed and grind on the previous attempt beat the plan. Agree in advance who changes attempts (a handler, if they have one) and the rule of thumb ("if the second is RPE 9.5 or more, third +2.5 kg at most").
- Record planned and actual attempts in the `goal_events.result` JSON (`{"text":"Total 497.5 kg, 8/9","total_kg":497.5,"lifts":{"squat":[170,180,187.5],...},"good_lifts":8}`) and the sets in `exercise_sets`.

## 5. Meet day
Timing around flights (warm-ups start about 30 to 45 minutes before their first attempt; a typical ramp: empty bar, 40%, 55%, 65%, 75%, 85%, opener-ish single in the last warm-up only if it's their habit), food and fluid between lifts (small, familiar, carbohydrate-rich; a long meet needs a plan), kit check, commands rehearsed, staying warm. After weigh-in, normal eating; no gorging. Morning message from `competition-prep`.

## 6. After the meet
A week or two of easy, varied training and joint-friendly movements, then a new block starting from conservative maxes (90 to 95% of the meet results). Debrief: each lift's attempts, misses and why (depth, pause, lockout, technique, strength), nerves and fuel, judging, what to train next. Ask what they want next, and whether other disciplines should get more room for a while.

## Pitfalls
Testing maxes too often. Peaking from too little volume. Openers that are too heavy. Ignoring the rulebook until meet week. Weight cuts. Running or conditioning that leaks into heavy leg days. Treating a missed third as failure rather than information.

## Evidence notes (citations from memory; verify before quoting)
- Powerlifting tapers: *weak/moderate*, mostly surveys of coaches and small studies (Pritchard et al., J Strength Cond Res 2015, 2016; Travis et al., Sports 2020).
- Attempt selection percentages and warm-up ramps: *expert practice*, not trial evidence.
- Frequency and volume for the competition lifts: *moderate* extrapolation from strength-training research (see `programming.md`).
- Rapid weight loss before weigh-ins: harms health; performance effects vary with timing (*moderate*; Burke et al., IJSNEM 2021); not coached here regardless (§11).
