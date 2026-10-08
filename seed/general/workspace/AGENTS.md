---
pinned:            # loaded into every epoch, in this order, up to the harness cap (~12k tokens)
  - coach/persona.md
  - athlete/profile.md
  - plan/current-week.md
---

# Workspace manual

This is my persistent workspace as {{athlete_name}}'s coach inside OpenCoach. Any model that takes over from me should read this first, then `briefing.md`, then whatever the task needs. Created {{created_date}}. The product and capability map is `/system/docs/opencoach.md`; research guidance is the `research` skill.

## Map
- `athlete/`: who they are. `profile.md` is the one-page essentials (pinned). `health.md`: injuries, conditions, clearances, safety follow-ups (sensitive). `preferences.md`: how and when they like to be coached.
- `plan/`: `current.md` is my working account of the current block (intent, phases, key sessions, rationale and bookkeeping); do not render it in a view. `athlete-summary.md` is the plain-language explanation displayed under "Why this plan" in Plan. `current-week.md` is the next 7 days in prose (pinned). Session-level detail lives in `data/coach.db` → `planned_workouts`. Helper drafts and reviews go in `plan/drafts/` and `plan/reviews/`.
- `journal/YYYY/MM/DD.md`: my daily notes: observations, decisions and why.
- `briefing.md`: what I wrote for tomorrow-me during consolidation. Replaced every night.
- `data/`: `coach.db` (SQLite) is the source of truth for activities (any sport), lifting sets, planned workouts, check-ins, metrics, goal events (races, meets, tests) and gear. Schema docs: `data/schema.md`. Migrations: `data/migrations/`. Nightly SQL dumps in `data/dump/` are written by the harness.
- `ui/`: the athlete's app. `app.json` = nav and theme. Views in `ui/views/<id>/`; shared components I own in `ui/lib/` (copied into every view on publish). Guide: `/system/docs/ui-kit.md`.
- `skills/`: procedures I've written for myself (first-party skills are read-only in `/system/skills`). `agents/`: helper profiles.
- `research/`: source-backed findings and evidence reviews, with dates, URLs, caveats and unanswered questions. Quick lookups use `researcher`; deeper reviews use `deep-researcher` or a profile I create.
- `exports/calendar.ics`: subscribed by the athlete's calendar. Regenerate after any plan change (`calendar-export` skill).
- `athlete-input/`: files the athlete's views may write directly.
- `feedback-to-harness.md`: notes for the developers.
- Read-only: `/raw` (original uploads), `/history` (rendered transcripts by day), `/system` (constitution, docs, skills, changelog for me).

## Conventions
- Dates are ISO 8601 with the athlete's UTC offset; local dates are `YYYY-MM-DD`. Distances in meters, durations in seconds, loads in kg, paces in s/km in the DB. Convert for display only.
- Sports in use (keep `activities.sport`, `planned_workouts.sport` and `goal_events.sport` consistent): none yet.
- Exercise names in use (`exercise_sets.exercise`): none yet.
- Every activity records `source`, `source_refs` (raw blob hashes), `extracted_by`, `confidence` and `confirmed`.
- Schema changes go in `data/migrations/NNNN_name.sql`, are applied, and are documented in `data/schema.md` (with a line in its migration log).
- Pinned files stay short. Detail goes in unpinned files with a pointer.
- After a plan change: `plan/current-week.md`, `plan/athlete-summary.md`, `planned_workouts`, `exports/calendar.ics` and my scheduled wakes must agree.
- Athlete-facing text explains training, reasons and uncertainty. Working notes, briefings and helper drafts need review and rewriting before display; no implementation bookkeeping in ordinary coaching screens.

## Disciplines
What I coach for this athlete, which skills I lean on for each, and any workspace skills I wrote for a discipline without a first-party skill. Details and priorities live in `athlete/profile.md`.
- (none yet; ask during intake)

## Open threads
- (none yet; onboarding not started)
