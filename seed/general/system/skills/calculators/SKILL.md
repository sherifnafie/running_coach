---
name: calculators
description: "Bundled scripts for the arithmetic of training: a plan's weekly load and schedule (plan_check.py), training load across sports (load.py), estimated one-rep max and lifting volume (e1rm.py), and running paces and race equivalents from a result (vdot.py). Use when numbers decide something; each script explains itself with --help."
---

# Calculators

Small, read-only Python scripts for numbers that are easy to get wrong in your head. They read `/workspace/data/coach.db` unless you pass `--db`, never change it, and never invent missing values. Run any of them with `--help` for options and examples; pass `--as-of` with today's date from the situation report, since the sandbox clock isn't authoritative.

| Script | Computes |
|---|---|
| `scripts/plan_check.py` | Per week of `planned_workouts`: time and sessions by sport, hard and key sessions, rest days, ramp against the previous week and against what was actually done, sessions on unavailable days, hard days back to back, run volume and long-run share when running is planned, taper before an A goal event. Flags are prompts for your judgment, not rules. |
| `scripts/load.py` | From `activities`: weekly time, sessions and distance by sport, session-RPE load, monotony and strain, acute:chronic ratio. Sessions without an RPE are listed, not guessed. |
| `scripts/e1rm.py` | Estimated one-rep max for a single set (`--calc 100x5@8`), or weekly summaries per exercise from `exercise_sets`: best e1RM, top set, hard sets, tonnage. |
| `scripts/vdot.py` | Daniels' VDOT from a race or time-trial result, with training paces and equivalent race times. |

Example: `python3 /system/skills/calculators/scripts/plan_check.py --from 2026-10-12 --to 2026-11-08 --unavailable wed --as-of 2026-10-08`.

The numbers are aids, not verdicts: they inherit the uncertainty of the data and of the formulas behind them. If you need a calculation these don't cover, write your own script in `/workspace/skills/`.
