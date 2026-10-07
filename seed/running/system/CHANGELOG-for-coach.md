# Changelog, written for you (the coach)

Each release adds a section here. When the harness is upgraded you get a `harness.upgraded` event: read the sections newer than the last version you recorded, adapt your workspace where it helps, and note what you did in the journal. Don't message the athlete about the upgrade unless something they'll notice has changed.

## v0.1.0: initial release

**What exists now**
- **Tools:** `read`, `write`, `edit`, `glob`, `grep`, `bash`; `send_message`, `no_reply`; `schedule`, `list_schedules`, `cancel_schedule`, `set_heartbeat`; `spawn_agent`, `task_status`, `cancel_task`; `preview_ui`, `publish_ui`, `rollback_ui`; `web_search`, `web_fetch`; `search_history`. Practical guide: `/system/docs/tools.md`.
- **Mounts:** `/workspace` (yours, git-committed each turn), `/raw` (uploads, immutable), `/history` (day-by-day transcripts), `/system` (this; read-only).
- **Docs:** `opencoach.md` (product, ownership and capability map), `tools.md`, `workspace.md`, `data-import.md`, `voice.md`, and the UI kit documentation (`ui-kit.md`, `bridge.md`, `views.md`).
- **Skills** (`/system/skills`): `intake`, `screenshot-extraction`, `file-import`, `zones-and-paces`, `training-load`, `plan-design`, `injury-and-pain`, `illness-return`, `race-prep`, `environment`, `strength-mobility`, `fueling-basics`, `calendar-export`, `data-hygiene`, `ui-kit`, `research`. They carry evidence notes; treat them as suggestions. Several ship runnable scripts (VDOT and paces, training load, ICS export, FIT/GPX/TCX/Samsung parsers, database and plan checks), each with `--help`.
- **Starter workspace:** `AGENTS.md`, persona, profile template, health and preference notes, a starter database (`activities`, `planned_workouts`, `blocks`, `checkins`, `metrics`, `races`, `gear`, `activity_gear`), seven helper profiles (`extractor`, `analyst`, `planner`, `reviewer`, `researcher`, `deep-researcher`, `ui-builder`), an empty `exports/calendar.ics`, four seed views (Today, Calendar, Plan, Progress) built with UI kit v1.
- **Policies the harness enforces** (you'll see them as tool errors and in the situation report): quiet hours (default 22:00 to 07:00; sends held, wakes still fire), proactive message budget (default 3 a day, 12 a week), a minimum gap between proactive messages (default 2 h), pause mode, per-athlete cost budgets (warning at 80%), turn limits (steps and wall time). The athlete can change the quiet hours, budgets and pause in settings; the situation report always shows the current values.
- **Turn types:** reactive (athlete wrote or tapped; a reply or `no_reply` is required), scheduled (wake-ups and the daily heartbeat; silence is fine), follow-up (task done, call ended, view error, upgrade, workspace edited from outside), consolidation (nightly; you cannot message).
- **Nightly consolidation** writes `briefing.md`. Pinned files and the briefing are what your next epoch starts with.
- **Safety screen:** the harness checks athlete messages and voice-note transcripts for red-flag signals and may add a safety notice to your situation report and show the athlete an emergency banner. See the constitution's §11.

**Configuration and verification limits:** calls, voice notes, Telegram, push and MCP require their relevant services to be configured; their external-service behavior has not been fully verified. Multiple athlete accounts are supported with isolated workspaces and administrator invitations. The native Health Connect bridge has mocked coverage; native SDK/device integration and iOS HealthKit remain unfinished. Automatic Strava/Garmin/Samsung Health cloud sync, watch workout export (the `structure` field is designed for it) and app-store distribution are not available. Don't promise them. The situation/environment report identifies configured web search/fetch, renderer and model/vision routes; tool results remain authoritative.

**Conventions worth knowing**
- Units in the database are SI: meters, seconds, s/km. Timestamps carry the athlete's UTC offset; local dates are `YYYY-MM-DD`.
- Take the date and time from the `<situation>` block; the sandbox clock isn't authoritative.
- UI views pin a kit major version (`"kit": "1"`); old majors stay served for at least two releases.

**Context audit update:** OpenCoach is introduced explicitly in the constitution and product map. Research has a quick and deep profile, durable cited reports and a skill. Helpers receive time and configuration facts. Research profiles have a write tool as well as an allowed scope. In an existing workspace preserve customized profiles: add a `write` tool to a research profile only if it should save notes, and create `deep-researcher` from the `research` skill if absent. New seed files do not overwrite coach-owned files. The constitution and skill index refresh at the next epoch; current turns also receive pointers to the new guide/skill in their situation report.

**Presentation and planning:** `set_preferences` persists language, theme and accent across devices. The built-in shell and starter-view labels support English, Dutch and Arabic; custom content may need translation and publication. Follow the current locale for your replies. `spawn_agent` can request effort; the situation reports provider support. Plan commitments should match the available evidence: clarify starting capacity and health, honor the requested horizon, calculate loads and review consequential blocks before saving. New planner/reviewer profiles include `write`; preserve existing customized profiles and explicitly grant the required tools/scope when saving helper output.

**Suggested migrations:** adopt useful view and profile improvements without overwriting customizations. Keep athlete-facing explanations separate from working notes. No database migration.
**Deprecations:** none.
