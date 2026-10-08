---
name: disciplines
description: "Take on a sport or training goal (running, lifting, cycling, swimming, climbing, a team sport, general fitness, anything) or several at once in this app: recording disciplines and priorities, writing your own workspace skill for a sport, fitting its data into the database and views, and logging several sports so they can be combined. Use at intake, when the athlete adds or drops a discipline, or when a new sport's data needs a home."
---

# Disciplines

You coach whatever the athlete trains for, from what you know and what you research. This skill is about the app side: where disciplines are recorded, how a sport's knowledge and data find a home in your workspace, and the conventions that let several sports share one plan, one database and one set of views.

## Record what they do and what matters most
Ranked disciplines (what matters most, what supports it, what's for fun), and for each: experience, current typical week, recent results or tests, equipment and facilities, any club or coach whose sessions you plan around, goals with dates. Put them in `athlete/profile.md` (Disciplines) and the `## Disciplines` section of `AGENTS.md`, with the `sport` word you'll use for each in the database.

## Your own skill for a sport
When a sport matters for this athlete, write down how you coach it at `/workspace/skills/<sport>/SKILL.md` (front-matter `name`, and a `description` that says what it covers and when to use it, because your skills index only shows that). What belongs there is yours to decide: how you prescribe and progress it, the session types and words you use in `planned_workouts.type`, how you read the athlete's data for it, what needs in-person instruction, warning signs, open questions, sources. Research what you don't know well first (`research` skill), with dates and evidence strength. Update the skill as you learn; it's how a future model, or tomorrow's you, starts from your work instead of from scratch.

## Where its data goes
Most sports fit the existing tables (`data/schema.md`): `activities` (sport, duration, RPE, HR, distance), `exercise_sets` for any resistance work, `goal_events` for competitions and tests, `metrics` for numbers like FTP or critical swim speed, `extra` JSON for occasional details. Add a column or table (with a migration and a note in `data/schema.md`) only for data you'll query or chart, such as climbing grades per route or rowing splits. Views show any sport by time and sessions already; add a discipline-specific card or view (`ui-kit` skill) when there's data worth showing.

## Several sports in one plan
- Every session gets its `sport`, so views and scripts can separate and combine them.
- Set `target_duration_s` on every planned session: weekly time is the measure that works across sports (`calculators` skill: `load.py`, `plan_check.py`).
- Mark the week's most important sessions with `key = 1`, across all disciplines.
- One plan and one weekly message, not one per discipline.

## When the mix changes
Adding, pausing or dropping a discipline changes the profile, `AGENTS.md` (Disciplines), `plan/current.md`, `plan/athlete-summary.md`, `planned_workouts` and possibly the views; keep them agreeing, and record the last known performances of a paused discipline so you can restart sensibly.
