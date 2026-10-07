# Running: plan design

Part of the `running` skill. The general method (what to know before drafting, commitment and review, progression heuristics, adapting the plan, fitting it to the schedule, the drafting process) is in `plan-design`; this file holds the running-specific numbers. If the athlete trains other disciplines too, fit these sessions into the shared week (`disciplines`).

## 1. Long run
- Share of weekly volume: roughly **25 to 35%** at four or more runs a week; up to ~40% at three runs a week; lower at six.
- Caps by time as well as distance: most athletes top out at ~2.5 to 3 hours. Typical peaks (expert practice, not requirements): 10K builds 14 to 18 km; half marathon 18 to 22 km; marathon 28 to 35 km (many coaches stop at ~30 to 32 km for amateurs).
- Progress long runs by ~1 to 2 km or 10 to 15 minutes a week (less for newer runners), with a shorter long run on down weeks.
- Add purpose late in the block (final third at marathon pace, or alternating), not early.

## 2. Intensity distribution
Most running easy; roughly **1 to 2 quality sessions a week** for most recreational athletes (3 is a lot), with 48 hours or an easy day between hard sessions. Distributions studied: "polarized" (~80% easy, ~5 to 10% moderate, ~10 to 20% hard) and "pyramidal" (80% easy, more moderate than hard). Evidence in well-trained athletes favours both over threshold-heavy training; trials in recreational runners show modest, inconsistent differences. What is robust is that most of the work is easy. As a rough dose guide (Daniels): a threshold session totals up to ~10% of weekly volume, interval work ≤ ~8% (or ~10 km), repetition work ≤ ~5%, long run ≤ ~25% or 2.5 h. Treat these as ceilings, not targets.

## 3. Session types: purpose, dose, prescribing
Prescribe by effort first (see `zones-and-paces.md`); pace/HR as ranges.
- **Easy / recovery:** 30 to 75 min; conversational. The base of everything.
- **Long run:** see 5; easy unless it has a defined purpose.
- **Strides:** 4 to 8 × 15 to 20 s relaxed-fast with full recovery, 1 to 3 times a week; speed and form for little cost.
- **Hill sprints:** 6 to 10 × 8 to 10 s very hard, full recovery; neuromuscular power; introduce after base. **Hill repeats:** 6 to 10 × 60 to 90 s, jog down.
- **Tempo / threshold:** "comfortably hard"; 20 to 40 min continuous or 3 to 6 × 5 to 10 min with 1 to 2 min jog. Marathon/half focus.
- **Intervals (VO2max):** 3 to 6 × 3 to 5 min hard (RPE 8), recovery 50 to 100% of rep time; total hard time 12 to 25 min. 5K/10K focus. For beginners: fartlek (play with pace, "pick up to that tree").
- **Race-pace work:** segments at goal pace inside long or medium runs.
- **Strength / cross-training:** see `strength-training/support-strength.md`; cross-training substitutes when injured.

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

## 4. Sample weeks (skeletons, not templates)
Adjust to the athlete's available days; volumes are typical *peaks* for recreational runners and should be reached gradually from where they are.
| Goal / level | Runs per week | Typical peak volume | Peak long run | Quality |
|---|---|---|---|---|
| Beginner, first 5K (run/walk) | 3 | 60 to 90 min total | 30 to 40 min continuous or run/walk | none; strides optional late |
| 5K, intermediate | 4 | 30 to 45 km | 10 to 14 km | 1 intervals or hills + 1 tempo or strides |
| 10K | 4 to 5 | 40 to 55 km | 14 to 18 km | 1 to 2 (intervals, tempo) |
| Half marathon | 4 to 5 | 40 to 65 km | 18 to 22 km | 1 tempo/threshold + HM-pace in long runs |
| Marathon | 5 | 55 to 85 km | 28 to 35 km | 1 tempo, 1 medium-long with marathon-pace segments |
A marathon week might read: Mon rest; Tue 10 km easy + strides; Wed 14 km medium-long (some at marathon pace in later weeks); Thu 8 km easy; Fri rest or 5 km; Sat 10 km easy; Sun 28 to 32 km long. A 4-day 5K week: Tue hills or intervals; Thu easy + strides; Sat easy or tempo; Sun long. A beginner week: Tue run/walk 25 min; Thu run/walk 25 min; Sun longer run/walk; rest or walk between (progress from e.g. 1 min run : 2 min walk toward continuous 20 to 30 min over 8 to 10 weeks; this is the common couch-to-5K logic).

## 5. How long a block should be
Experienced, from a base: 8 to 12 weeks for 5K/10K, 12 to 16 for the half, 16 to 20 for the marathon. Novice marathoners: a base period first, then 18 to 24 weeks. If the date is too close for the goal, say so, and propose alternatives (a more modest goal, a stepping-stone race, a later race). Honest beats flattering.

## 6. Tapering
Keep intensity and frequency; cut **volume** progressively. A meta-analysis found about **two weeks** with a **40 to 60%** volume reduction (intensity and frequency unchanged) gave the best performance gains (Bosquet et al. 2007; Mujika and Padilla 2003). Practical: 5K/10K: 7 to 10 days; half: ~10 to 14 days; marathon: ~2 to 3 weeks (e.g. 80 to 85% of peak in week −3, 60 to 70% in week −2, 40 to 50% in race week), a last longer run ~10 to 14 days out, a few strides or short race-pace pickups in the last week. Expect to feel flat, antsy or achy ("taper tantrums"): reassure.

## Worked example
Athlete: 38 km/week for 6 weeks (4 runs), longest 14 km, one tempo most weeks; half marathon in 12 weeks, goal "under 2:00"; available Mon, Wed, Thu, Sat, Sun; a work trip in week 7. Recent 10K: 54:30 → VDOT ≈ 36 (use `scripts/vdot.py`), half-marathon equivalent ≈ 2:01 if equally trained → the goal is right at the edge of plausible (a good block could get there); say so, and offer a B-goal.
- Weeks 1 to 3: 38, 41, 44 km (long 15, 16, 17); week 4: 36 (down week).
- Weeks 5 to 8: 44, 47, 40 (trip, effort-based, easy), 48 (long 19); week 8 includes a 10K tune-up.
- Weeks 9 to 10: peak 50 km, long runs with 8 to 10 km at goal pace; week 11: 40; race week: ~28 km with strides.
One tempo or intervals session per week plus strides; long run on Sunday; Tuesday/Friday off. Compare with `plan_check.py`: week 1 within +10% of their actual 38; none on unavailable days; taper present; down weeks at 4 and 7.

## Pitfalls
Copying an elite plan. All easy or all hard. Rigid make-up sessions. Long runs that grow faster than the rest of the week. Racing the easy runs. "Just one more week" at peak. Forgetting that lifting, other sports and life share the same recovery.

## Evidence notes (citations are from memory; verify before quoting)
- Progression rates: *weak* (Buist et al., Am J Sports Med 2008; Nielsen et al., J Orthop Sports Phys Ther 2014; IOC load consensus, Soligard et al. 2016).
- Intensity distribution: *moderate* in trained athletes (Seiler and Kjerland, Scand J Med Sci Sports 2006; Seiler, Int J Sports Physiol Perform 2010; Stöggl and Sperlich, Front Physiol 2014); inconsistent in recreational runners (Muñoz et al., Int J Sports Physiol Perform 2014).
- Taper: *moderate to strong* (Bosquet et al., Med Sci Sports Exerc 2007; Mujika and Padilla, Med Sci Sports Exerc 2003).
- Long-run share, long-run caps, session doses, block lengths and sample weeks: *expert opinion* (Daniels, Pfitzinger, Hudson and similar coaching literature) rather than trial evidence.
