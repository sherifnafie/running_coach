# Changelog, written for you (the coach)

Each release adds a section here. When the harness is upgraded you get a `harness.upgraded` event: read the sections newer than the last version you recorded, adapt your workspace where it helps, and note what you did in the journal. Don't message the athlete about the upgrade unless something they'll notice has changed.

## v0.1.0: initial release

**What exists now**
- **Tools:** `read`, `write`, `edit`, `glob`, `grep`, `bash`; `send_message`, `no_reply`; `schedule`, `list_schedules`, `cancel_schedule`, `set_heartbeat`; `spawn_agent`, `task_status`, `cancel_task`; `preview_ui`, `publish_ui`, `rollback_ui`; `web_search`, `web_fetch`; `search_history`. Practical guide: `/system/docs/tools.md`.
- **Mounts:** `/workspace` (yours, git-committed each turn), `/raw` (uploads, immutable), `/history` (day-by-day transcripts), `/system` (this; read-only).
- **Docs:** `tools.md`, `workspace.md`, `data-import.md`, `voice.md`, and the UI kit documentation (`ui-kit.md`).
- **Skills** (`/system/skills`): `intake`, `screenshot-extraction`, `file-import`, `zones-and-paces`, `training-load`, `plan-design`, `injury-and-pain`, `illness-return`, `race-prep`, `environment`, `strength-mobility`, `fueling-basics`, `calendar-export`, `data-hygiene`, `ui-kit`. They carry evidence notes; treat them as suggestions. Several ship runnable scripts (VDOT and paces, training load, ICS export, FIT/GPX/TCX/Samsung parsers, database and plan checks), each with `--help`.
- **Starter workspace:** `AGENTS.md`, persona, profile template, health and preference notes, a starter database (`activities`, `planned_workouts`, `blocks`, `checkins`, `metrics`, `races`, `gear`, `activity_gear`), six helper profiles (`extractor`, `analyst`, `planner`, `reviewer`, `researcher`, `ui-builder`), an empty `exports/calendar.ics`, four seed views (Today, Calendar, Plan, Progress) built with UI kit v1.
- **Policies the harness enforces** (you'll see them as tool errors and in the situation report): quiet hours (default 22:00 to 07:00; sends held, wakes still fire), proactive message budget (default 3 a day, 12 a week), a minimum gap between proactive messages (default 2 h), pause mode, per-athlete cost budgets (warning at 80%), turn limits (steps and wall time). The athlete can change the quiet hours, budgets and pause in settings; the situation report always shows the current values.
- **Turn types:** reactive (athlete wrote or tapped; a reply or `no_reply` is required), scheduled (wake-ups and the daily heartbeat; silence is fine), follow-up (task done, call ended, view error, upgrade, workspace edited from outside), consolidation (nightly; you cannot message).
- **Nightly consolidation** writes `briefing.md`. Pinned files and the briefing are what your next epoch starts with.
- **Safety screen:** the harness checks athlete messages and voice-note transcripts for red-flag signals and may add a safety notice to your situation report and show the athlete an emergency banner. See the constitution's §11.

**Not available yet** (don't promise these): live calls (planned for the next phase), Health Connect / HealthKit sync, third-party fitness-account integrations (Strava, Garmin Connect), MCP tools, watch workout export (the `structure` field in `planned_workouts` is designed for it), multiple athletes per instance.

**Conventions worth knowing**
- Units in the database are SI: meters, seconds, s/km. Timestamps carry the athlete's UTC offset; local dates are `YYYY-MM-DD`.
- Take the date and time from the `<situation>` block; the sandbox clock isn't authoritative.
- UI views pin a kit major version (`"kit": "1"`); old majors stay served for at least two releases.

**Suggested migrations:** none (this is the first release).
**Deprecations:** none.
