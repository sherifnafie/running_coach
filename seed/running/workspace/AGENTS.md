---
pinned:            # loaded into every epoch, in this order, up to the harness cap (~12k tokens)
  - coach/persona.md
  - athlete/profile.md
  - plan/current-week.md
---

# Workspace manual

This is my workspace as {{athlete_name}}'s coach. Any model that takes over from me should read this first, then `briefing.md`, then whatever the task needs. Created {{created_date}}.

## Map
- `athlete/`: who they are. `profile.md` is the one-page essentials (pinned). `health.md`: injuries, conditions, clearances, safety follow-ups (sensitive). `preferences.md`: how and when they like to be coached.
- `plan/`: `current.md` is the current block (intent, phases, key sessions, rationale). `current-week.md` is the next 7 days in prose (pinned). Session-level detail lives in `data/coach.db` → `planned_workouts`. Helper drafts and reviews go in `plan/drafts/` and `plan/reviews/`.
- `journal/YYYY/MM/DD.md`: my daily notes: observations, decisions and why.
- `briefing.md`: what I wrote for tomorrow-me during consolidation. Replaced every night.
- `data/`: `coach.db` (SQLite) is the source of truth for activities, planned workouts, check-ins, metrics, races and gear. Schema docs: `data/schema.md`. Migrations: `data/migrations/`. Nightly SQL dumps in `data/dump/` are written by the harness.
- `ui/`: the athlete's app. `app.json` = nav and theme. Views in `ui/views/<id>/`. Guide: `/system/docs/ui-kit.md`.
- `skills/`: procedures I've written for myself (first-party skills are read-only in `/system/skills`). `agents/`: helper profiles.
- `exports/calendar.ics`: subscribed by the athlete's calendar. Regenerate after any plan change (`calendar-export` skill).
- `athlete-input/`: files the athlete's views may write directly.
- `feedback-to-harness.md`: notes for the developers.
- Read-only: `/raw` (original uploads), `/history` (rendered transcripts by day), `/system` (constitution, docs, skills, changelog for me).

## Conventions
- Dates are ISO 8601 with the athlete's UTC offset; local dates are `YYYY-MM-DD`. Distances in meters, durations in seconds, paces in s/km in the DB. Convert for display only.
- Every activity records `source`, `source_refs` (raw blob hashes), `extracted_by`, `confidence` and `confirmed`.
- Schema changes go in `data/migrations/NNNN_name.sql`, are applied, and are documented in `data/schema.md` (with a line in its migration log).
- Pinned files stay short. Detail goes in unpinned files with a pointer.
- After a plan change: `plan/current-week.md`, `planned_workouts`, `exports/calendar.ics` and my scheduled wakes must agree.

## Open threads
- (none yet; onboarding not started)
