---
name: strength-training
description: "Resistance-training coaching for any goal: getting stronger, building muscle, powerlifting, general fitness, or strength that supports another sport. Covers RPE/RIR, %1RM and e1RM (e1rm.py), volume and frequency, progression models, deloads, beginner to advanced programs, logging sets, lifting safety, powerlifting meets and attempt selection, and strength for runners and other athletes. Use whenever lifting or bodyweight strength work is in the plan."
---

# Strength training

Resistance training knowledge for a coach who may also be coaching other things. The general method (intake, plan design, load, injury, illness, competition timelines) lives in the general skills; this skill holds what is specific to lifting. Read the part you need:

| File | What's in it |
|---|---|
| `programming.md` | Principles with evidence levels, measuring effort (RPE, RIR, %1RM, e1RM), volume, frequency, rest, progression models, deloads, beginner/intermediate/advanced templates, `structure` examples, adapting to missed sessions and pain. |
| `powerlifting.md` | Squat, bench, deadlift as competition lifts: specificity, peaking, attempt selection, meet day, rules and commands, weight classes, after the meet. |
| `support-strength.md` | Strength and mobility as support for running and other sports: minimum effective dose, routines, scheduling around key sessions. |
| `scripts/e1rm.py` | Estimated 1RM from a set, weekly best e1RM per lift, hard sets, top sets and tonnage from `exercise_sets`. |

## Essentials, if you read nothing else
- **Start below what they can do** and progress in small steps; the first weeks are for technique and tolerance.
- **Most working sets end 1 to 3 reps short of failure** (RPE 7 to 9). Failure is a tool, not a default, and never on heavy barbell squats or bench without safeties or a spotter.
- **Each main movement or muscle group about twice a week**, with a modest number of hard sets that grows only if recovery allows.
- **Progress one thing at a time:** reps within a range, then load. Small jumps: ~1 to 2.5 kg upper body, ~2.5 to 5 kg lower body.
- **Prescribe with ranges and effort** ("3 × 5 at 100 to 105 kg, RPE 7 to 8"), so a bad day adjusts the load, not the athlete's confidence.
- **Technique needs eyes.** Ask for a video when form matters, be honest about what you can judge from it, and suggest an in-person coach for learning the big barbell lifts.

## Recording lifting
Session: `activities.sport = 'strength'` with `duration_s`, session `rpe` and provenance. Sets: one `exercise_sets` row per set (`exercise`, `set_index`, `reps`, `load_kg`, `rpe` or `rir`, `is_warmup`). Use consistent exercise names (list them in `AGENTS.md`). Planned sessions: `sport = 'strength'`, `type` `strength`, `heavy`, `power` or `hypertrophy`, an estimated `target_duration_s`, `key = 1` for the heavy or most important day, and a `structure` with `exercise` steps (examples in `programming.md`; the format is documented in `data/schema.md`). Athletes often log in apps (Strong, Hevy, a notes app): see `screenshot-extraction` and `file-import`.

## Checks
```bash
python3 /system/skills/strength-training/scripts/e1rm.py --calc 100x5            # one set: e1RM by several formulas
python3 /system/skills/strength-training/scripts/e1rm.py --as-of 2026-10-07 --weeks 8
python3 /system/skills/strength-training/scripts/e1rm.py --as-of 2026-10-07 --exercise "Back squat" --json
```
`training-load` covers session-RPE load across all sports; `plan_check.py` counts strength sessions and hard sessions in the shared week.

## Common lifting pain patterns
See `injury-and-pain` §4 (lifting): lower back, shoulder, elbow, knee, hip and wrist patterns, and the red flags that are specific to heavy lifting (back pain with groin numbness or bladder changes, a pop with weakness, a sudden severe headache under load).
