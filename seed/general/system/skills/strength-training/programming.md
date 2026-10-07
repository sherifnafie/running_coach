# Strength training: programming

Part of the `strength-training` skill. The general drafting process, commitment and review, and adapting to life are in `plan-design`; this file holds the lifting-specific principles and numbers. If the athlete also runs or plays a sport, fit these sessions into the shared week (`disciplines`).

## 1. Principles, with how sure we are
- **Progressive overload with recovery.** Strength and muscle grow when the demand rises gradually and recovery keeps up. *Strong.*
- **Specificity.** You get better at what you train: heavy, low-rep work for maximal strength in those lifts; a wide range of loads for muscle size; fast, lighter work for power. *Strong.*
- **Effort matters more than load for muscle growth.** Sets taken reasonably close to failure build similar muscle across roughly 6 to 30 reps; heavier loads build more maximal strength. *Moderate to strong* (Schoenfeld et al. 2017; Lopez et al. 2021).
- **Volume has a dose-response, with diminishing returns.** More weekly hard sets tend to give more muscle, up to a point that differs between people; strength needs less volume than size. *Moderate* (Schoenfeld et al. 2017; Pelland et al. 2024).
- **Frequency is mostly a way to distribute volume.** Training a muscle or lift about twice a week is a good default; beyond that, total volume matters more than frequency. *Moderate* (Schoenfeld et al. 2016, 2019).
- **Consistency beats the perfect program.** Adherence predicts results better than program design. *Strong in practice.*

## 2. Measuring and prescribing effort
- **RPE (1 to 10) and RIR (reps in reserve)** for lifting: RPE 10 = no more reps possible (0 RIR), RPE 9 = one more rep (1 RIR), RPE 8 = two more, RPE 7 = three more; below ~RPE 6 it's a warm-up or speed set. Athletes underestimate RIR when new and at high reps; it improves with practice and is most accurate close to failure (Zourdos et al. 2016; Helms et al. 2016). Teach the anchors, then ask for RPE or RIR on top sets.
- **%1RM** works when a recent true or estimated max exists. Reps possible at a given percentage vary a lot between people and lifts (more at a given % on deadlift and with more training age); combine percentages with an RPE cap ("3 × 5 at 75 to 80%, stop the set at RPE 9").
- **Estimated 1RM (e1RM)** from a submaximal set: Epley `load × (1 + reps/30)`, Brzycki `load × 36 / (37 − reps)`, or RPE-adjusted tables. Reasonable for sets of ≤ ~6 reps taken close to failure, increasingly wrong above ~10 reps or when the set was far from failure (`scripts/e1rm.py`). Say "estimated". Trend over weeks is more useful than one number.
- **True 1RM tests** are rarely necessary outside powerlifting. If done: experienced lifters only, a proper warm-up ramp, safeties or spotters, stop at a clean single near RPE 9 to 9.5 rather than a grinder.
- **Session RPE** (whole-session effort × minutes) still works for lifting and puts it on the same load scale as other sports (`training-load`).

## 3. Volume, frequency, rest
| Goal | Load / reps | Proximity to failure | Hard sets per muscle or lift per week | Rest between sets |
|---|---|---|---|---|
| General health and fitness | 6 to 15 reps | 2 to 4 RIR | 4 to 10 | 1 to 2 min |
| Muscle size | 6 to 20+ reps (mostly 6 to 12) | 0 to 3 RIR | ~10 to 20 (start lower) | 1.5 to 3 min |
| Maximal strength | 1 to 6 reps at ~75 to 92% plus some lighter volume | 1 to 3 RIR | ~4 to 10 heavy per main lift | 2 to 5 min |
| Power | Light to moderate loads, moved fast; jumps, throws | far from failure (speed drops = stop) | low | full recovery |
| Strength as support for another sport | 3 to 8 heavy or 8 to 12 moderate | 1 to 3 RIR | 2 to 6 per pattern | 1 to 3 min |
These are starting ranges, not prescriptions; individual response varies widely. Count a set as "hard" when it ends at roughly RIR 0 to 4. Longer rests (2 to 3 minutes or more) on compound lifts support more total work and similar or better gains (Schoenfeld et al. 2016). Supersetting unrelated muscles saves time.

## 4. Movements
Cover the patterns, adapted to equipment and goals: **squat** (back/front/goblet squat, leg press), **hinge** (deadlift variants, RDL, hip thrust), **horizontal push** (bench, push-up), **vertical push** (overhead press), **horizontal pull** (rows), **vertical pull** (pull-up, pulldown), **single-leg** (split squat, step-up, lunge), **carry and trunk** (carries, planks, anti-rotation). Home or no equipment: bodyweight progressions (harder variations, slower tempo, single-limb, pauses, more reps closer to failure), bands, a backpack, adjustable dumbbells. Choose variations the athlete can do well and that don't provoke pain; there is no mandatory exercise.

## 5. Progression models
- **Linear (beginners):** same sets and reps, add a small load every session or week while every set is completed at the target effort. Works for months for many beginners. Stall twice: reduce ~10% and build again, or move on.
- **Double progression:** a rep range (e.g. 3 × 8 to 12); when all sets reach the top of the range at the target RIR, add load and drop back to the bottom. Simple and robust for accessories and general training.
- **RPE-based autoregulation:** prescribe reps and a target RPE ("top set of 5 at RPE 8, then 3 × 5 at 90% of that load"); load floats with daily readiness. Good for intermediates and for athletes with variable lives or other sports. Similar or slightly better results than fixed percentages (*moderate*; Helms et al. 2018).
- **Periodized (intermediate and advanced):** vary emphasis over weeks: undulating (different rep ranges within a week) or block (accumulation with more volume, then intensification with heavier loads, then a peak). Periodized programs beat non-periodized ones modestly for strength; no model is clearly best (*moderate*; Williams et al. 2017; Grgic et al. 2017).
Change one thing at a time. If several lifts stall together, look at sleep, food, stress, total load from other sports and adherence before changing the program.

## 6. Deloads
A lighter week every ~4 to 8 weeks, or when performance drops, aches accumulate or RPE creeps up for the same loads: keep frequency and movement, cut sets by ~30 to 50% and/or loads by ~10 to 20%, nothing near failure. Evidence for set schedules is *weak*; it is common expert practice (Bell et al. 2023). Down weeks in another discipline are a good time to deload lifting too.

## 7. Templates (skeletons, not prescriptions)
**Beginner, full body, 2 to 3 days a week** (~45 to 60 min): A: squat pattern 3 × 5 to 8, push 3 × 6 to 10, pull 3 × 8 to 12, hinge 2 × 6 to 8, carry or plank. B: hinge 3 × 5 to 8, overhead or incline push 3 × 6 to 10, vertical pull 3 × 6 to 10, single-leg 2 × 8 to 10 per side, trunk. Alternate A/B; linear progression; technique first two to four weeks.
**Intermediate, upper/lower 4 days:** two lower days (one heavier squat focus, one heavier hinge focus) and two upper days (one heavier press, one volume), 10 to 16 hard sets per session, RPE-based top sets plus back-offs, deload every 5 to 7 weeks.
**Time-crunched (2 × 30 to 40 min):** full body, four to five movements, 2 to 3 hard sets each, supersets. Far better than nothing; maintenance and slow progress are realistic.
**Older or returning athletes:** same principles, slower progression, more emphasis on power (moving moderate loads quickly) and balance, joint-friendly variations; clinician clearance where §11 says so.

## 8. Writing sessions (`planned_workouts.structure`)
```json
{"steps":[
  {"kind":"warmup","duration":{"time_s":600},"note":"Easy bike or brisk walk, then 2 to 3 lighter sets of the first lift."},
  {"kind":"exercise","name":"Back squat","sets":[{"reps":5,"load":{"kg":110},"target":{"rpe":8}},{"reps":5,"load":{"kg":100},"times":3}],"rest_s":180},
  {"kind":"exercise","name":"Bench press","sets":4,"reps":6,"load":{"pct_1rm":[72,77]},"target":{"rir":2},"rest_s":150},
  {"kind":"repeat","times":3,"steps":[
    {"kind":"exercise","name":"Chest-supported row","sets":1,"reps":[8,12],"target":{"rir":[1,2]}},
    {"kind":"exercise","name":"Plank","sets":1,"duration":{"time_s":45}}]}
 ],
 "notes":"Leave the last squat set if bar speed drops a lot. Pain above 3/10: stop that lift and message me."}
```
Set `sport: "strength"`, `type` (`strength`, `heavy`, `power`, `hypertrophy`), an estimated `target_duration_s`, and `key = 1` on the session that matters most this week. Keep the athlete-facing `description` short ("Heavy squat + bench, about 60 min").

## 9. Adapting
| Situation | Default response |
|---|---|
| Missed session | Do the next one as written; don't double up. Missed a whole week: repeat the last completed week. |
| 2+ weeks off | Restart at ~80 to 90% of previous loads with fewer sets, rebuild over 2 to 3 weeks; strength returns fast. |
| Bad day (sleep, stress) | Keep the movement and the top set at a lower RPE, cut back-off sets. Autoregulation exists for this. |
| Pain during a lift | Stop that lift, swap to a pain-free variation (range, grip, stance, tempo, load), apply `injury-and-pain`. Red flags per §11. |
| Plateau | Check sleep, food, stress, other-sport load, adherence and technique; then change one variable (rep range, variation, volume) for a block. |
| Travel / no gym | Bodyweight and band sessions or hotel-gym full body; keep frequency, accept lower loads. |
| Other sport's key session nearby | Move or lighten lower-body work to protect it (`disciplines`). |

## 10. Safety
- Barbell squats and bench to failure only with safeties, spotter arms or a spotter; use collars. Deadlifts are dropped, not caught.
- Breath-holding (Valsalva) under heavy load raises blood pressure sharply: athletes with hypertension, heart, eye (retinal) or other relevant conditions, or pregnancy need clinician guidance before heavy lifting (§11).
- Warm up: a few minutes of general movement, then ramping sets of the first lift.
- Technique deteriorates with fatigue: end sets when form breaks, not at an arbitrary number.
- Hernia symptoms (a bulge, groin pain with straining), a pop with weakness, or back pain with leg numbness: stop and get assessed (§11).

## Evidence notes (citations from memory; verify before quoting)
- Load range for hypertrophy vs strength: *moderate to strong* (Schoenfeld et al., J Strength Cond Res 2017; Lopez et al., Med Sci Sports Exerc 2021).
- Volume dose-response: *moderate* (Schoenfeld, Ogborn and Krieger, J Sports Sci 2017; Pelland et al. 2024 meta-regressions).
- Frequency: *moderate* (Schoenfeld et al., Sports Med 2016; J Sports Sci 2019).
- RIR-based RPE: *moderate* (Zourdos et al., J Strength Cond Res 2016; Helms et al., Strength Cond J 2016); RPE vs percentage autoregulation: *moderate* (Helms et al., Front Physiol 2018).
- Rest intervals: *moderate* (Schoenfeld et al., J Strength Cond Res 2016).
- Periodization: *moderate* (Williams et al., Sports Med 2017; Grgic et al., PeerJ 2017).
- e1RM formulas: *moderate* accuracy at low reps, poor at high reps (LeSuer et al., J Strength Cond Res 1997).
- Deloads: *weak/expert practice* (Bell et al., Sports Med Open 2023).
