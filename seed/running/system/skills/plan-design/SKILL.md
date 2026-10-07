---
name: plan-design
description: "Design and adapt training blocks: periodization, phase intent, progression, long-run share, intensity distribution, down weeks, sample weeks from 5K to marathon, tapering, fitting plans to real schedules. Includes plan_check.py. Use for any new block or plan change."
---

# Plan design

A good plan is a hypothesis about what this athlete can absorb, written down so it can be adjusted. Most plans fail on realism (too much, too soon, on days that don't exist), not on workout selection. Design from the athlete's actual recent training and real schedule, keep most running easy, and plan for the plan to change.

## 1. Before you draft
Know, or consciously assume: recent actual training (4 to 8 weeks: weekly km or hours, longest run, hard sessions, consistency); the goal and date; days and times available (hard limits); injury and illness history, current niggles; experience (years, previous blocks); what data they have (HR? pace?); preferences (gentle or tough, variety, how many days); terrain and weather; life load for the next weeks (travel, work peaks). Clarify material unknowns about current comfortable activity, health constraints and available days before assigning a new training dose. Optional details can use disclosed assumptions; labeling a guessed duration or frequency "conservative" does not make it appropriate for an unknown starting capacity.

### Commitment and review
For a new multiweek commitment, build a traceable draft from actual recent load and constraints, check numerical progression (use `scripts/plan_check.py` where applicable), and obtain a separate critical review before finalizing. `planner` and `reviewer` are useful high-effort profiles; brief them explicitly and read their results. Keep the proposal in draft files while it is being checked. Reconcile the separate review before writing the new block to live blocks/planned_workouts, then verify saved dates and weekly totals against the reviewed draft. A capped/failed helper is incomplete; never claim it reviewed the plan. For substantial block work, deliver a brief progress message, use background helpers and follow through on their completion/failure across turns. With an endpoint that doesn't support high effort, use the same checks instead of claiming deeper reasoning.

With insufficient intake, prioritize current symptoms, recent running and available days: ask concisely and wait for the material answers before assigning a new dose. An already comfortable habit or an effort description can be useful while intake continues; calling a new prescription provisional does not remove the need for those basics. Later weeks can be an outline contingent on response, clearly labeled as such. Respect a request for a few days or one week. A block can take less than a minute if the evidence and checks are already sound; spending minutes cannot make an unsupported plan good. Send a brief delivered progress update for longer work and follow through after background work. Explain the training rationale and adaptation triggers, not tools or private reasoning.

## 2. Principles, with how sure we are
- **Consistency is the best predictor of progress.** Many weeks of sustainable running beat any clever session. *Strong in practice; moderate in studies.*
- **Progressive, individualized overload with recovery.** *Strong.* How *fast* to progress is much less certain (see 4).
- **Mostly easy.** Roughly 75 to 85% of running time at easy effort, the rest moderate-to-hard (see 6). *Moderate.*
- **Specificity grows as the goal nears:** more race-pace and race-length work late, general base early. *Strong.*
- **Change one thing at a time:** frequency first, then duration (long run), then intensity. *Expert consensus.*
- **Hard days need easy days around them.** *Strong.*
- **Taper before a key race:** cut volume, keep some intensity. *Moderate-strong.*

## 3. Structure of a block
Think in three layers: the **macro** goal (the race), **meso** phases of 3 to 6 weeks, **micro** weeks of 3 to 6 runs. Typical phases (names don't matter; intent does):
- **Base / general:** build frequency and easy volume, strides, short hills, strength; maybe one light quality session. Goal: absorb running.
- **Build / specific:** add structured quality (threshold, intervals, long runs with purpose); volume reaches its peak plateau.
- **Peak / race-specific:** work that looks like the race (goal-pace segments, simulations); volume stable or slightly down.
- **Taper:** see 10.
- **Recovery / transition** after the race (see `race-prep`).
Beginners need "Phase 1: consistency" and little else. Don't impose labels on someone with a 6-week horizon.

## 4. Progression heuristics
- **Start where they are**, not where they hope to be. First week at or *below* current.
- Typical build: roughly **5 to 10% a week** at lower volumes, a bit more in absolute terms when volume is small (adding 10 minutes to a 30-minute long run is fine), **a lighter week every 3rd or 4th week** (cut volume ~20 to 30%, keep some intensity and frequency).
- Slower for novices, returning-from-injury athletes, masters athletes, after a layoff, and when life stress is high; more flexible for experienced athletes with high chronic load.
- After a layoff, **regain by time**, e.g. 3 to 4 weeks to return to pre-break volume after a 2-week break, and don't put intensity back first.
- Never ramp volume, intensity and long-run length in the same week.
- *Evidence is weaker than the folklore:* the "10% rule" has no strong support (a randomized trial in novices found a graded program no better for injuries; observational data suggest the highest-risk jumps are above ~30% a week). Use it as a sensible default, not a law.

## 5. Long run
- Share of weekly volume: roughly **25 to 35%** at four or more runs a week; up to ~40% at three runs a week; lower at six.
- Caps by time as well as distance: most athletes top out at ~2.5 to 3 hours. Typical peaks (expert practice, not requirements): 10K builds 14 to 18 km; half marathon 18 to 22 km; marathon 28 to 35 km (many coaches stop at ~30 to 32 km for amateurs).
- Progress long runs by ~1 to 2 km or 10 to 15 minutes a week (less for newer runners), with a shorter long run on down weeks.
- Add purpose late in the block (final third at marathon pace, or alternating), not early.

## 6. Intensity distribution
Most running easy; roughly **1 to 2 quality sessions a week** for most recreational athletes (3 is a lot), with 48 hours or an easy day between hard sessions. Distributions studied: "polarized" (~80% easy, ~5 to 10% moderate, ~10 to 20% hard) and "pyramidal" (80% easy, more moderate than hard). Evidence in well-trained athletes favours both over threshold-heavy training; trials in recreational runners show modest, inconsistent differences. What is robust is that most of the work is easy. As a rough dose guide (Daniels): a threshold session totals up to ~10% of weekly volume, interval work ≤ ~8% (or ~10 km), repetition work ≤ ~5%, long run ≤ ~25% or 2.5 h. Treat these as ceilings, not targets.

## 7. Session types: purpose, dose, prescribing
Prescribe by effort first (see `zones-and-paces`); pace/HR as ranges.
- **Easy / recovery:** 30 to 75 min; conversational. The base of everything.
- **Long run:** see 5; easy unless it has a defined purpose.
- **Strides:** 4 to 8 × 15 to 20 s relaxed-fast with full recovery, 1 to 3 times a week; speed and form for little cost.
- **Hill sprints:** 6 to 10 × 8 to 10 s very hard, full recovery; neuromuscular power; introduce after base. **Hill repeats:** 6 to 10 × 60 to 90 s, jog down.
- **Tempo / threshold:** "comfortably hard"; 20 to 40 min continuous or 3 to 6 × 5 to 10 min with 1 to 2 min jog. Marathon/half focus.
- **Intervals (VO2max):** 3 to 6 × 3 to 5 min hard (RPE 8), recovery 50 to 100% of rep time; total hard time 12 to 25 min. 5K/10K focus. For beginners: fartlek (play with pace, "pick up to that tree").
- **Race-pace work:** segments at goal pace inside long or medium runs.
- **Strength / cross-training:** see `strength-mobility`; cross-training substitutes when injured.

Example `structure` for the athlete-facing calendar and workout view:
```json
{"steps":[
 {"kind":"warmup","duration":{"time_s":900},"target":{"rpe":[2,3]}},
 {"kind":"repeat","times":4,"steps":[
   {"kind":"work","duration":{"time_s":480},"target":{"pace_s_km":[255,265],"rpe":[6,7]}},
   {"kind":"recovery","duration":{"time_s":90},"target":{"rpe":[1,2]}}]},
 {"kind":"cooldown","duration":{"time_s":600},"target":{"rpe":[2,3]}}],
 "notes":"Comfortably hard; finish feeling you could do one more."}
```

## 8. Sample weeks (skeletons, not templates)
Adjust to the athlete's available days; volumes are typical *peaks* for recreational runners and should be reached gradually from where they are.
| Goal / level | Runs per week | Typical peak volume | Peak long run | Quality |
|---|---|---|---|---|
| Beginner, first 5K (run/walk) | 3 | 60 to 90 min total | 30 to 40 min continuous or run/walk | none; strides optional late |
| 5K, intermediate | 4 | 30 to 45 km | 10 to 14 km | 1 intervals or hills + 1 tempo or strides |
| 10K | 4 to 5 | 40 to 55 km | 14 to 18 km | 1 to 2 (intervals, tempo) |
| Half marathon | 4 to 5 | 40 to 65 km | 18 to 22 km | 1 tempo/threshold + HM-pace in long runs |
| Marathon | 5 | 55 to 85 km | 28 to 35 km | 1 tempo, 1 medium-long with marathon-pace segments |
A marathon week might read: Mon rest; Tue 10 km easy + strides; Wed 14 km medium-long (some at marathon pace in later weeks); Thu 8 km easy; Fri rest or 5 km; Sat 10 km easy; Sun 28 to 32 km long. A 4-day 5K week: Tue hills or intervals; Thu easy + strides; Sat easy or tempo; Sun long. A beginner week: Tue run/walk 25 min; Thu run/walk 25 min; Sun longer run/walk; rest or walk between (progress from e.g. 1 min run : 2 min walk toward continuous 20 to 30 min over 8 to 10 weeks; this is the common couch-to-5K logic).

## 9. How long a block should be
Experienced, from a base: 8 to 12 weeks for 5K/10K, 12 to 16 for the half, 16 to 20 for the marathon. Novice marathoners: a base period first, then 18 to 24 weeks. If the date is too close for the goal, say so, and propose alternatives (a more modest goal, a stepping-stone race, a later race). Honest beats flattering.

## 10. Tapering
Keep intensity and frequency; cut **volume** progressively. A meta-analysis found about **two weeks** with a **40 to 60%** volume reduction (intensity and frequency unchanged) gave the best performance gains (Bosquet et al. 2007; Mujika and Padilla 2003). Practical: 5K/10K: 7 to 10 days; half: ~10 to 14 days; marathon: ~2 to 3 weeks (e.g. 80 to 85% of peak in week −3, 60 to 70% in week −2, 40 to 50% in race week), a last longer run ~10 to 14 days out, a few strides or short race-pace pickups in the last week. Expect to feel flat, antsy or achy ("taper tantrums"): reassure.

## 11. Adapting the plan
| Situation | Default response |
|---|---|
| One missed session | Drop it. Don't stack it onto another day. Protect the key sessions (long run, main quality). |
| A missed week (life, mild illness) | Resume at or just below the last completed week; don't "make up". |
| 2+ weeks missed | Step back ~20 to 30% in volume and intensity, rebuild over 2 to 4 weeks; re-evaluate the goal date. |
| Illness | See `illness-return`. |
| Pain | See `injury-and-pain`. |
| Travel / time zones | Keep frequency, shorten duration, effort-based, accept easy runs in new places; first run after a long flight easy. |
| Poor sleep / stress spike | Hold or reduce load and intensity for a few days; protect easy days. |
| Great race or time trial | Update paces (cautiously) and next goal; don't automatically ramp volume. |
| Plateau / stagnation | Check consistency, sleep, fueling (`fueling-basics`), too many moderate runs, boredom; consider a deload or a change of stimulus before piling on work. |
| Athlete wants to add | Make one change at a time, hold for two weeks, review. |

## 12. Fit it to the real schedule
Constraints first: put the long run on their free day, keep hard sessions off days they're depleted, never schedule on an unavailable day. Design A/B options for variable weeks ("if Thursday dies, do X on Friday"). Offer a **minimum effective version** ("three 30-minute runs and a long run") for chaotic weeks. Present choices, not orders.

## 13. Process
1. Draft (yourself, or `planner` for a whole block).
2. Check with `plan_check.py` and your eyes:
   ```bash
   python3 /system/skills/plan-design/scripts/plan_check.py --from 2026-10-05 --to 2026-12-06 --unavailable tue,sat --as-of 2026-10-07
   ```
   It lists weekly volume, long-run share, hard sessions, rest days, ramp vs the previous week and vs what they have actually run, sessions on unavailable days, and missing tapers. Flags are prompts for judgment.
3. For high stakes (return from injury or illness, big jumps, a goal race block), have `reviewer` examine it and read the verdict.
4. Present: the first one or two weeks in detail, the shape of the rest in a few lines, and *why*. Ask what's off.
5. Record: `blocks`, `planned_workouts` (with `structure` where helpful), `plan/current.md` (working notes: intent, phases, key sessions, rationale), `plan/current-week.md`, `plan/athlete-summary.md` (the Plan screen's explanation), `exports/calendar.ics` (`calendar-export`), and schedule the wakes that make the plan live (morning prescriptions, weekly review, key-session check-ins).

Write `plan/athlete-summary.md` for the athlete: what this block aims to achieve,
why the sessions fit their goals and available time, how to judge progress, and
when to ease off or ask for a change. Keep it short and consistent with the
saved plan. Do not copy working notes or a planner's draft wholesale; omit DB,
SQL, paths, tool steps and internal scheduling bookkeeping. Explain relevant
assumptions and uncertainty rather than hiding them. Keep it current after
changes. In an older workspace whose Plan view still reads `plan/current.md`,
use the `ui-kit` skill to switch its source and manifest to the athlete summary,
then preview and publish; writing a new file alone does not change that view.

## Worked example
Athlete: 38 km/week for 6 weeks (4 runs), longest 14 km, one tempo most weeks; half marathon in 12 weeks, goal "under 2:00"; available Mon, Wed, Thu, Sat, Sun; a work trip in week 7. Recent 10K: 54:30 → VDOT ≈ 36 (use `vdot.py`), half-marathon equivalent ≈ 2:01 if equally trained → the goal is right at the edge of plausible (a good block could get there); say so, and offer a B-goal.
- Weeks 1 to 3: 38, 41, 44 km (long 15, 16, 17); week 4: 36 (down week).
- Weeks 5 to 8: 44, 47, 40 (trip, effort-based, easy), 48 (long 19); week 8 includes a 10K tune-up.
- Weeks 9 to 10: peak 50 km, long runs with 8 to 10 km at goal pace; week 11: 40; race week: ~28 km with strides.
One tempo or intervals session per week plus strides; long run on Sunday; Tuesday/Friday off. Compare with `plan_check.py`: week 1 within +10% of their actual 38; none on unavailable days; taper present; down weeks at 4 and 7.

## Pitfalls
Planning for the athlete you hope they are. Copying an elite plan. All easy or all hard. Rigid make-up sessions. No stop rules (write them in: "if the calf tightens, stop and message me"). Building beyond what recovery supports, then blaming the athlete. Over-complicated plans. "Just one more week" at peak. Forgetting life.

## Evidence notes (citations are from memory; verify before quoting)
- Progression rates: *weak* (Buist et al., Am J Sports Med 2008; Nielsen et al., J Orthop Sports Phys Ther 2014; IOC load consensus, Soligard et al. 2016).
- Intensity distribution: *moderate* in trained athletes (Seiler and Kjerland, Scand J Med Sci Sports 2006; Seiler, Int J Sports Physiol Perform 2010; Stöggl and Sperlich, Front Physiol 2014); inconsistent in recreational runners (Muñoz et al., Int J Sports Physiol Perform 2014).
- Taper: *moderate to strong* (Bosquet et al., Med Sci Sports Exerc 2007; Mujika and Padilla, Med Sci Sports Exerc 2003).
- Long-run share, long-run caps, session doses, block lengths and sample weeks: *expert opinion* (Daniels, Pfitzinger, Hudson and similar coaching literature) rather than trial evidence.
