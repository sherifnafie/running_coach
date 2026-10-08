---
name: plan-design
description: "Design and adapt training blocks in any sport or combination of sports: what to know first, commitment and review, periodization, progression, intensity, down weeks, peaking and tapering, adapting to missed sessions and life, fitting plans to real schedules and equipment, and recording the plan. Includes plan_check.py. Use for any new block or plan change; read the discipline skill (running, strength-training, or a workspace skill) for sport-specific numbers."
---

# Plan design

A good plan is a hypothesis about what this athlete can absorb, written down so it can be adjusted. Most plans fail on realism (too much, too soon, on days that don't exist, with equipment they don't have), not on exercise or workout selection. Design from the athlete's actual recent training and real schedule, keep most work sustainable, and plan for the plan to change.

This skill is the method. Sport-specific numbers (session types, doses, sample weeks, block lengths, tapers) are in the discipline skills: `running/plan-design.md`, `strength-training/programming.md` and `powerlifting.md`, or the workspace skill you wrote for another sport. When more than one discipline shares the week, read `disciplines` §3 too.

## 1. Before you draft
Know, or consciously assume: which disciplines and their priority; recent actual training in each (4 to 8 weeks: sessions, time, key numbers such as weekly km and longest run, or lifting days, top sets and hard sets, and consistency); the goals and dates; days and times available (hard limits); equipment and facilities; fixed sessions you don't control (club runs, team practice, classes); injury and illness history, current niggles; experience; what data they have (HR? pace? a training log?); preferences (gentle or tough, variety, how many days); terrain and weather; life load for the next weeks (travel, work peaks). Ask about what you can't sensibly assume and what would change the plan; for the rest, assume and say so.

### Effort, checking and review
Match the effort to the commitment. Adjusting a week after feedback or moving a session is quick work you do in the turn. A new plan the athlete will follow for a week or more deserves careful work:
- Ask first what would really change the design (current training, available days, a goal date), and assume and state the rest. Don't hold the design for questions they've answered or declined.
- Tell them it's coming and roughly when, and give them what they need until then (today's or tomorrow's session).
- Draft from everything available: recent actual training in every discipline, the relevant discipline skills, research where it changes the answer. For anything beyond a week, `planner` (deep tier) is built for this; brief it with all the facts, priorities, constraints and uncertainties, since it can't see the conversation.
- Check the numbers: weekly load per discipline against what they've actually done (`scripts/plan_check.py` and the discipline's own checks), every session on an available day with equipment they have, hard days spread across all disciplines.
- For high stakes (a return from injury or illness, a big change in load, an A-goal block), get one independent review from `reviewer`, then reconcile its concerns yourself.
- Keep it bounded: one design, at most one review, reconcile, deliver. Deliver as soon as it's ready, usually within the hour. If a helper fails or stops early, finish the work yourself rather than starting another round, and never claim a review that didn't happen.

Respect the requested horizon: a week when they ask for a week, a block when they ask for a block. Explain the training rationale and what would make you change course, not your tools or private reasoning.

## 2. Principles, with how sure we are
- **Consistency is the best predictor of progress.** Many weeks of sustainable training beat any clever session. *Strong in practice; moderate in studies.*
- **Progressive, individualized overload with recovery.** *Strong.* How *fast* to progress is much less certain (see 4).
- **Most work sustainable.** Most endurance time easy; most lifting sets short of failure; hard work purposeful and limited. *Moderate.*
- **Specificity grows as the goal nears:** general base early, work that looks like the event late. *Strong.*
- **Change one thing at a time:** frequency first, then duration or volume, then intensity or load. *Expert consensus.*
- **Hard days need easy days around them**, across all disciplines. *Strong.*
- **Peak and taper before a key event:** cut volume, keep intensity. *Moderate-strong* (endurance), *weak/moderate* (strength).

## 3. Structure of a block
Think in three layers: the **macro** goal (the event, or a season), **meso** phases of 3 to 6 weeks, **micro** weeks. Typical phases (names don't matter; intent does):
- **Base / general / accumulation:** build frequency, tolerance and volume at sustainable effort; technique; general strength. Goal: absorb training.
- **Build / specific / intensification:** structured hard work that targets the goal; volume reaches its plateau.
- **Peak:** work that looks like the event; volume stable or down.
- **Taper:** see 6.
- **Recovery / transition** after the event (`competition-prep`).
Beginners need "Phase 1: consistency" and little else. Don't impose labels on someone with a 6-week horizon. For several disciplines, phases can differ per discipline (a running build while lifting holds at maintenance); write that down in `blocks.focus`.

## 4. Progression heuristics
- **Start where they are**, not where they hope to be. First week at or *below* current, in every discipline.
- Endurance volume: roughly **5 to 10% a week** at lower volumes (a bit more in absolute terms when volume is small). Lifting: small load jumps or added reps within a range, sets added slowly. Details in the discipline skills.
- **A lighter week every 3rd to 6th week** (cut volume ~20 to 50%, keep some intensity and frequency); align down weeks across disciplines when you can.
- Slower for novices, returning-from-injury athletes, masters athletes, after a layoff, when adding a new discipline, and when life stress is high; more flexible for experienced athletes with high chronic load.
- After a layoff, **regain by time**, e.g. 3 to 4 weeks to return to pre-break volume after a 2-week break, and don't put intensity back first.
- Never ramp volume, intensity and the longest or heaviest session in the same week.
- *Evidence is weaker than the folklore:* the "10% rule" has no strong support; observational running data suggest the highest-risk jumps are above ~30% a week. Use sensible defaults, not laws.

## 5. Intensity and session selection
Each discipline has its own intensity language: pace, HR and talk test for endurance (`running/zones-and-paces.md`); RPE, RIR and %1RM for lifting (`strength-training/programming.md`); power, stroke rate, grades, game minutes elsewhere. Prescribe by effort first, numbers as ranges. Across disciplines, count hard sessions together: for most recreational athletes, **two to three genuinely hard sessions a week in total**, with an easier day or 24 to 48 hours between them, is plenty.

## 6. Peaking and tapering
Keep intensity and frequency; cut **volume** progressively. For endurance events, a meta-analysis found about **two weeks** with a **40 to 60%** volume reduction gave the best gains (Bosquet et al. 2007; Mujika and Padilla 2003); for strength sports, about a week of reduced volume with heavy singles maintained is common practice. Lengths per event are in the discipline skills. In a multi-discipline week, taper the supporting disciplines too: they shouldn't add fatigue in the final days. Expect the athlete to feel flat, antsy or achy: reassure.

## 7. Adapting the plan
| Situation | Default response |
|---|---|
| One missed session | Drop it. Don't stack it onto another day. Protect the key sessions (`key = 1`). |
| A missed week (life, mild illness) | Resume at or just below the last completed week; don't "make up". |
| 2+ weeks missed | Step back ~20 to 30% in volume and intensity or load, rebuild over 2 to 4 weeks; re-evaluate the goal date. |
| Illness | See `illness-return`. |
| Pain | See `injury-and-pain`. |
| Travel / time zones | Keep frequency, shorten duration, effort-based; bodyweight or hotel-gym strength; first session after a long flight easy. |
| Poor sleep / stress spike | Hold or reduce load and intensity for a few days; protect easy days. |
| Great result or test | Update targets (cautiously) and the next goal; don't automatically ramp volume. |
| Plateau / stagnation | Check consistency, sleep, fueling (`fueling-basics`), too much moderate work, load from other disciplines, boredom; consider a deload or a change of stimulus before piling on work. |
| Athlete wants to add (a session, a discipline) | Make one change at a time, hold for two weeks, review; a new discipline is new load (`disciplines`). |

## 8. Fit it to the real schedule
Constraints first: fixed sessions and unavailable days, then the key sessions on the days that suit them (long run on the free day, heavy lifting when they're fresh and have the gym), then everything else. Never schedule on an unavailable day or with equipment they don't have. Design A/B options for variable weeks ("if Thursday dies, do X on Friday"). Offer a **minimum effective version** ("two 30-minute runs, one long run and one short full-body session") for chaotic weeks. Present choices, not orders.

## 9. Process
1. Draft (yourself, or `planner` for a whole block).
2. Check with `plan_check.py` and your eyes:
   ```bash
   python3 /system/skills/plan-design/scripts/plan_check.py --from 2026-10-05 --to 2026-12-06 --unavailable tue,sat --as-of 2026-10-07
   ```
   Per Monday-to-Sunday week it lists planned time and sessions by sport, hard and key sessions, rest days, ramp in planned time vs the previous week and vs what they have actually done, sessions on unavailable days, hard sessions on consecutive days, run km and long-run share when running is planned, and missing tapers before A goal events. Flags are prompts for judgment. Add the discipline's own checks (e.g. `strength-training/scripts/e1rm.py` for recent lifting numbers).
3. For high stakes, one independent review from `reviewer` (see above).
4. Present: the first one or two weeks in detail, the shape of the rest in a few lines, and *why*. Ask what's off.
5. Record: `blocks`, `planned_workouts` (with `sport`, `type`, `target_duration_s` for every non-rest session, `key` for the week's most important sessions, and `structure` where helpful: steps for endurance, exercises for lifting), `plan/current.md` (working notes: intent, phases, key sessions, rationale), `plan/current-week.md`, `plan/athlete-summary.md` (the Plan screen's explanation), `goal_events` for dated goals, `exports/calendar.ics` (`calendar-export`), and schedule the wakes that make the plan live (morning prescriptions, weekly review, key-session check-ins).

Write `plan/athlete-summary.md` for the athlete: what this block aims to achieve in each discipline and how they fit together, why the sessions fit their goals and available time, how to judge progress, and when to ease off or ask for a change. Keep it short and consistent with the saved plan. Do not copy working notes or a planner's draft wholesale; omit DB, SQL, paths, tool steps and internal scheduling bookkeeping. Explain relevant assumptions and uncertainty rather than hiding them. Keep it current after changes. In an older workspace whose Plan view still reads `plan/current.md`, use the `ui-kit` skill to switch its source and manifest to the athlete summary, then preview and publish; writing a new file alone does not change that view.

## Worked example (hybrid)
Athlete: runs 4 × a week (~35 km, longest 13 km) and lifts twice (full body, squat 5 × 90 kg at RPE 8); goals: half marathon in 12 weeks (A), "keep my strength" (B); available every day but Friday; gym on weekdays only. Plan: running follows `running/plan-design.md` (build to ~45 km, long run to 18 km, one quality session); lifting holds at two sessions of ~45 minutes, 2 to 3 hard sets per main lift at RPE 7 to 8 (a maintenance dose, `disciplines` §3). Week: Mon lift A (lower-body heavy) after a short easy run; Tue intervals; Wed easy run; Thu lift B (upper-heavy, light legs); Sat easy run; Sun long run; Fri off. Heavy legs on Monday sit two days before the quality session and six before the long run. Down weeks every fourth week in both. Taper: running per the half-marathon taper; one short lifting session in race week, nothing heavy in the final five days. `plan_check.py` shows planned time rising ~6% a week, hard sessions (intervals, heavy lifting day) never on consecutive days, Friday empty.

## Pitfalls
Planning for the athlete you hope they are. Copying an elite program. All easy or all hard. Rigid make-up sessions. No stop rules (write them in: "if the calf tightens, stop and message me"; "if the knee hurts above 3/10, skip squats"). Building beyond what recovery supports, then blaming the athlete. Planning each discipline as if the others didn't exist. Over-complicated plans. "Just one more week" at peak. Forgetting life.

## Evidence notes (citations are from memory; verify before quoting)
- Progression rates: *weak* (Buist et al., Am J Sports Med 2008; Nielsen et al., J Orthop Sports Phys Ther 2014; IOC load consensus, Soligard et al. 2016).
- Taper: *moderate to strong* for endurance (Bosquet et al., Med Sci Sports Exerc 2007; Mujika and Padilla, Med Sci Sports Exerc 2003); *weak/moderate* for strength sports (Pritchard et al. 2015; Travis et al. 2020).
- Periodization in strength training: *moderate* (Williams et al., Sports Med 2017).
- Concurrent training and scheduling: see `disciplines`.
- Phase structures, down-week frequency and session limits: *expert opinion* rather than trial evidence.
