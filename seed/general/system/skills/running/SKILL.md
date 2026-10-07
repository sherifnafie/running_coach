---
name: running
description: "Running-specific coaching: intensity (RPE, talk test, HR, pace, VDOT with vdot.py), session types and doses, long runs, intensity distribution, sample weeks from couch-to-5K to marathon, block lengths and tapers, race pacing, in-race fueling and race-day routines. Use whenever running is one of the athlete's disciplines."
---

# Running

Running knowledge for a coach who may also be coaching other things. The general method (intake, plan design, load, injury, illness, competition timelines) lives in the general skills; this skill holds what is specific to running. Read the part you need:

| File | What's in it |
|---|---|
| `zones-and-paces.md` | Three intensity domains, RPE and talk test, heart-rate zones and their pitfalls, pace ranges, VDOT-style paces and race equivalents (`scripts/vdot.py`) and their limits, coaching without HR or a watch. |
| `plan-design.md` | Long runs, intensity distribution, session types with doses and `structure` examples, sample weeks by goal and level, block lengths, tapers, a worked half-marathon block. |
| `races.md` | Race goals anchored in evidence, pacing, in-race fueling and hydration, warm-ups, recovery durations after races, a worked race week. |

## Essentials, if you read nothing else
- **Start from what they run now**, not from the goal. Frequency first, then the long run, then intensity.
- **Most running easy** (roughly 75 to 85% of time), one or two quality sessions a week for most recreational runners, never on consecutive days.
- **Prescribe by effort first**; pace and HR as ranges ("5:35 to 6:00/km, slower is fine"). Hills, heat, wind and trails make pace meaningless; effort still works.
- **The long run** is roughly 25 to 35% of weekly volume at four or more runs a week, capped by time (~2.5 to 3 hours) as well as distance.
- **Beginners:** run/walk, three days a week, progressing toward 20 to 30 minutes continuous over 8 to 10 weeks.
- **Strength work helps runners** (economy, injury resilience): see `strength-training/support-strength.md`.

## Recording runs
`activities.sport = 'run'` (`walk`, `hike` for those). Distance in meters, `duration_s` elapsed, `moving_s` timer time, `avg_pace_s_km` with its basis in `extra.pace_basis`, cadence in steps per minute (double a one-foot value), laps and HR zones as JSON. Planned runs: `sport = 'run'`, `type` from `easy`, `recovery`, `long`, `tempo`, `intervals`, `hills`, `race`, set `target_distance_m` and/or `target_duration_s` (estimate the duration for distance-prescribed runs), and mark the long run and main quality session `key = 1`.

## Running-specific checks
- `python3 /system/skills/plan-design/scripts/plan_check.py ...` reports run km, long-run share and ramp per week alongside the all-sport picture.
- `python3 /system/skills/training-load/scripts/load.py --as-of <date> --distance-sport run` adds weekly run km and longest run.

## Common running injury patterns
See `injury-and-pain` §4 (running): knee pain around the kneecap, outer knee, shins, Achilles, plantar heel, hamstring, calf, hip or groin, foot bone stress. Bone stress injuries in runners need medical assessment; recurrent ones raise the energy-availability question (`fueling-basics`).
