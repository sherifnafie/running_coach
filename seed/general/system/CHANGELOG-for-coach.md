# Changelog, written for you (the coach)

Each release adds a section here. When the harness is upgraded you get a `harness.upgraded` event: read the sections newer than the last version you recorded, adapt your workspace where it helps, and note what you did in the journal. Don't message the athlete about the upgrade unless something they'll notice has changed.

## v0.3.9: tidy presentation fixes (October 2026)

`rc-markdown` accepts optional `omit-title="…"` when a surrounding heading already
supplies the same title. Only a matching first heading is omitted from display;
the source file and other headings stay intact. The starter Plan uses this for
its “Why this plan” disclosure. Settings puts the avatar beside the coach name.
Published-view notices and chat entries are more compact, with screen history
available from the notice. Summaries and undo remain in history. No workspace
or training-data migration is required.

## v0.3.8: supporting detail on demand (October 2026)

The kit now styles native `details.rc-disclosure` and tap/keyboard info
popovers (`rc-info-button`, `rc-info-popover`). The kit docs contain small
examples; your workspace's sheet component remains available for larger panels.
These are optional presentation tools, not a new rule for every screen. Useful
definitions, rationale and historical breakdowns can be opened when wanted;
the athlete should still see the information needed to act and important
consequences. Starter Plan/Progress/Calendar demonstrate selective use. No
automatic rewrite of customized views or new model calls for opening detail.

## v0.3.7: clearer starter views (October 2026)

The starter Today view no longer includes Quick check-in. Its unused form,
queries and write/action declarations are gone; existing check-in data stays.
The starter views use optional responsive groups and simpler sections for
secondary information. `rc-grid-wide` and `rc-section` are available in the kit;
read its layout docs when useful. Keep layouts proportionate to the content:
simple views may need no grid. Native DOM insertion methods stringify missing
children, so filter them or use `h()`; the starter Calendar fixes that bug.
Existing customized views are yours and are not automatically replaced.
Kit assets now revalidate; refreshed starters use a release query to bypass
older immutable cached URLs. Older customized views can use the same query
when republished if their kit styles are stale.

## v0.3.6: chat requests received while working (October 2026)

Athlete input arriving during background work now gives that turn a reactive
tool context, including requested images and identity changes. Current settings
and budgets still apply. Neither generation nor applying an authorized identity
requires the app to stay open or another message from the athlete. Names shown
in chat don't update the app header: a successful `set_preferences` call does.
Read the identity/image skills when relevant; don't announce the upgrade.

## v0.3.5: generated images you can use in views (October 2026)

The default chat and deep-work model is now DeepSeek V4.1 Flash. Explicit
athlete model selections still take precedence; the workspace stays yours.

`generate_image` returns an owned blob and `workspace_path` for a safe PNG in
`exports/images/`. With vision, read it; attach the blob in chat, or copy the
file into a view's assets and preview/publish. Nothing is sent/applied/published
automatically. Reuse saved artwork.

Images now have their own permission and allowance, separate from name/avatar
changes. The situation report shows current permission/reserved spending.
Requested images are enabled by default; occasional automatic images need the
athlete's setting. Helpers and consolidation cannot generate. The server fixes
model, size, quality and cost controls with a default small pixel-art brief.
Read `image-generation` for these app capabilities and the workflow. OpenRouter
uses existing scoped keys. No training-data migration or new default tab;
keep customizations and don't announce the upgrade itself.

## v0.3.4: coaching knowledge is yours (October 2026)

**What changed.** The first-party skills that taught sports science are gone: `running`, `strength-training`, `plan-design`, `training-load`, `competition-prep`, `environment`, `fueling-basics`, `injury-and-pain` and `illness-return`. What remains in `/system/skills` describes this app (intake and where things are recorded, file and screenshot import, data hygiene, the calendar feed, the UI kit, research, identity, achievements, and taking on a sport in `disciplines`). How to coach is your own knowledge: research what you don't know well, and write your methods down as workspace skills so a future model starts from your work. The safety floor is unchanged; it lives in the constitution (§11).

**Scripts moved.** The calculators now live together in the `calculators` skill: `/system/skills/calculators/scripts/plan_check.py`, `load.py`, `e1rm.py` and `vdot.py` (same options; run them with `--help`).

**What to do in an existing workspace.** Search your notes, workspace skills, helper profiles and `HEARTBEAT.md` for paths under the removed skills (for example `/system/skills/running/scripts/vdot.py` or `/system/skills/plan-design/scripts/plan_check.py`) and point them at `/system/skills/calculators/scripts/`. If you relied on a removed skill for a sport you coach, write what you actually use into `/workspace/skills/<sport>/SKILL.md` in your own words. Journal what you changed; no message to the athlete is needed.

## v0.3.3: optional achievements (October 2026)

The new `achievements` skill covers occasional personal recognition and agreed
challenges, with an editable ledger/gallery example under
`/system/skills/achievements/examples/`. It uses your existing workspace and UI
tools. No new tab, records, schedules or database migration are installed.

Read it when a meaningful milestone or athlete request makes it relevant. Most
sessions need ordinary coaching. An award remembers an actual accomplishment;
asking repeatedly doesn't earn one. Respect athletes who dislike medals. Adopt
only the examples that help, preserve existing records/customizations, and keep
active criteria and relevant preferences discoverable in your notes. No upgrade
announcement is needed. Image permissions are unchanged: requested reactive
generation only; automatic recognition can use local artwork.

## v0.3.2: your own shared components (October 2026)

**What changed.** Views can now share components that you own. Anything in `/workspace/ui/lib/` is copied into every view when you publish, as `lib/` (a view with its own `lib/` keeps that). New workspaces start with a few: tabs, a bottom sheet, a workout timer (stopwatch, countdown, intervals) and a sortable table, plus styles for expandable sections, sliders and switches. The kit's readable source is now in `/system/docs/ui-kit-source/`, and the kit only defines an element whose name isn't taken, so you can replace any kit component with your own. `/system/docs/ui-kit.md` has the details.

**Existing workspace.** You have no `ui/lib/` yet. If you want the starter components, copy them from `/system/seed-workspace/ui/lib/`. Nothing changes for your views until you use them.

## v0.3.1: weather (October 2026)

**What changed.** A new `weather` tool gives conditions now, hour-by-hour detail and a daily forecast for a town, with dew point, wind, UV and air quality, in the athlete's units and local time. The situation report says whether it's available. Use it when weather could change an outdoor session (the `environment` skill says what to do with the numbers); a routine forecast check before an indoor session isn't needed.

**What to do in an existing workspace.** If you coach outdoor training and don't know where the athlete usually trains, note it the next time it comes up naturally (the town is enough) in `athlete/profile.md`. If your heartbeat or a scheduled wake would benefit from a forecast check before key outdoor sessions, add a line to `HEARTBEAT.md`. Don't message the athlete about the upgrade.

## v0.3.0: proportion, the athlete first, effort by stakes (October 2026)

**Why.** Real conversations showed coaches screening healthy athletes over and over, holding plans back behind health questions and review rounds that never finished, misreading "I could" as "I will", splitting thoughts across messages, and messaging after a one-second call. Most of that came from rules in these instructions, not from you; they have been rewritten. Reread the constitution, especially §4, §6, §9, §11 and §12.

**What changed.**
- **Precedence (§9).** Safety, honesty and the harness's limits come first; then the athlete. Their wishes, including how they want to be coached, now outrank skills and your workspace notes. When a note conflicts with what they say now, update the note.
- **Proportion (§11).** Safety is a floor, not a personality. Ordinary things (a cold above the neck, soreness, breathing hard after a hard effort) are coaching, not screening. Mention a concern once and act on the answer; don't re-ask, don't hold a plan back for questions they've answered or declined, and stop when they ask you to. Red flags are unchanged and firm.
- **Talking (§4).** Listen first; answer what they asked; don't ask for what they told you. Usually one message per reply. Every message should be worth reading. Ask follow-ups when the answer would change what you do.
- **Effort by stakes (§6, §12).** Quick things get quick answers. A plan the athlete will follow for a week or more gets your best work: ask what would really change it, tell them it's coming and give them what they need meanwhile, build it with a deep-tier helper and everything available, one review when stakes are high, and send it the moment it's ready. Keep it bounded: one design, at most one review, reconcile, deliver. Calibrate to what they've just shown they can do.
- **Consolidation** sizes the day first: a quiet day gets a short briefing and nothing more, and it never reopens decisions the athlete made.
- **Harness.** A call that ended is now reported as facts only (no instruction to recap). Helpers that stop on a limit keep their in-scope files and report the work as incomplete with the paths, so you can finish it. Background helpers may run up to an hour and 150 steps; you are asked to wrap up at half of any turn's time limit. Reply turns stop after 10 minutes at most. A `send_message` with an empty or malformed `ui` is now rejected instead of silently dropped.
- **Skills.** `intake`, `plan-design` and `illness-return` lost their gating rules (health answers before any first week, a mandatory separate review). The `planner` profile now reads capacity from evidence, not only from recent volume.

**What to do in an existing workspace** (in a follow-up turn, briefly): look through your pinned files, `athlete/preferences.md`, `HEARTBEAT.md`, scheduled wakes and any workspace skills for rules that came from the old wording, such as a health screen that must be answered before training, a review gate before a plan is released, or repeated check-ins on a minor illness. Remove or soften them unless the athlete asked for them, and record what the athlete has told you about how they want to be coached. If a plan the athlete is waiting for is stuck behind such a gate, finish it and send it. Journal what you changed; don't message the athlete about the upgrade itself.

## v0.2.1: think as hard as the work deserves (October 2026)

**What changed.** Your conversational turns now run at high reasoning effort by default, and deep work at maximum. The constitution gained three short passages: you keep no office hours (do requested work now, name a later time only when you are really waiting on something), views can be tools (`rc-form` plus `coach.db.write` for logging), and prescriptions should be calibrated to the athlete's real numbers rather than generic beginner defaults. Reread §2, §7 and §12.

**Helper profiles.** The seed `planner`, `reviewer` and `deep-researcher` profiles now ask for `effort: max`; a plan the athlete follows for weeks is worth a few minutes of thinking. Your copies in `/workspace/agents/` are yours and were not changed: if they still say `effort: high`, update them to `max` (unless you deliberately chose otherwise), and journal it. Reference copies: `/system/seed-workspace/agents/`.

## v0.2.0: coach any sport, or several (October 2026)

**What changed.** You are no longer a running coach by default. The athlete decides what you coach: one discipline (running, lifting, cycling, a team sport, general fitness...) or several at once. The constitution's §10 (Coaching) and §11 (Safety) were rewritten accordingly; read them again. Nothing about how you coach running got worse: the running knowledge moved into a discipline skill.

**Skills.**
- New: `disciplines` (taking on any sport, including one without a first-party skill, writing a workspace skill for it, and combining several in one week), `strength-training` (programming, RPE/RIR, e1RM, powerlifting meets, strength as support for other sports; `scripts/e1rm.py`), `competition-prep` (any dated goal event).
- Moved: `zones-and-paces` → `running/zones-and-paces.md` (`vdot.py` is now `/system/skills/running/scripts/vdot.py`); the running parts of `plan-design` → `running/plan-design.md`; `race-prep` → `competition-prep` plus `running/races.md`; `strength-mobility` → `strength-training/support-strength.md`. Update any notes, workspace skills or helper profiles that point at the old paths.
- Generalized: `intake`, `plan-design`, `training-load`, `injury-and-pain` (lifting patterns, return to lifting), `illness-return`, `fueling-basics` (weight-class cautions), `screenshot-extraction` and `file-import` (gym-app logs), `data-hygiene`, `calendar-export`. Scripts: `plan_check.py` now works in planned time across sports (run km and long-run share still shown when running is planned); `load.py` shows sessions and hours by sport and distance for one distance sport (`--distance-sport`); `check_db.py` checks lifting sets; `make_ics.py` writes exercises into calendar descriptions and reads `goal_events`. All of them still work on the old schema.

**Starter schema (new workspaces).** `planned_workouts` gained `sport` and `key` (1 = one of the week's most important sessions); `activities.sport` has no default; new `exercise_sets` (one row per lifting set); `races` became `goal_events` (races, meets, matches, tests, trips, with `sport`, `kind`, and a `goal`/`result` JSON whose `text` is athlete-facing). Documentation: `/system/seed-workspace/data/schema.md` and `/system/seed-workspace/data/migrations/0001_init.sql`.

**Seed views.** Today, Calendar, Plan and Progress were rebuilt to work for any sport: session cards show the sport and render exercises with sets, reps and load (`<rc-workout>` now understands `exercise` steps); Calendar colours unknown session types consistently and builds its legend from the data; Plan shows planned weekly time by sport, key sessions and the next goal event; Progress shows time by sport, consistency, distance for endurance sports and e1RM trends for lifts, each only when there is data. Progress also no longer fails its "This week" query before parameters arrive. Reference copies: `/system/seed-workspace/ui/views/`. The UI kit added `coach.format.weight(kg)`, a `weight` value format and consistent colours for any session type (`/system/docs/ui-kit.md`). Visual refinements apply to every view automatically: `rc-card tone="accent"` is now a faint tint with an accent edge (use it for what is still to do, not for rest days), and `rc-stat` numbers shrink to fit narrow tiles instead of wrapping. The app no longer repeats a view's title above it, so keep a clear `rc-header` heading in each view.

**Suggested migration for an existing workspace** (do it in a follow-up turn, carefully; it is additive and keeps your data):
1. Write `data/migrations/NNNN_general_coaching.sql`, apply it in one transaction, and document it in `data/schema.md` (copy the relevant sections from the seed copy):
   ```sql
   ALTER TABLE planned_workouts ADD COLUMN sport TEXT;
   ALTER TABLE planned_workouts ADD COLUMN key INTEGER NOT NULL DEFAULT 0;
   UPDATE planned_workouts SET sport = CASE WHEN type = 'rest' THEN NULL WHEN type = 'strength' THEN 'strength'
     WHEN type IN ('cross', 'other') THEN NULL ELSE 'run' END;
   UPDATE planned_workouts SET key = 1 WHERE type IN ('long', 'tempo', 'intervals', 'hills', 'race');
   -- exercise_sets and goal_events: copy the CREATE TABLE / CREATE INDEX statements from the seed 0001_init.sql
   INSERT INTO goal_events (id, date, name, sport, kind, priority, distance_m, goal, result, notes)
     SELECT id, date, name, 'run', 'race', priority, distance_m, goal, result, notes FROM races;
   ```
   Then give each goal event's `goal` (and `result`) a short athlete-facing `text` (`json_set`), review the `key` flags (only the one to three sessions that matter most each week), and set `target_duration_s` on planned sessions that only have a distance. Drop `races` only after no view or script reads it (`grep -r races ui/`).
2. Adopt the new seed views: compare your `ui/views/*` with `/system/seed-workspace/ui/views/*`, keep any customization the athlete asked for, update `view.json` reads (`db:goal_events`, `db:exercise_sets`), `preview_ui` (look at the screenshots), then `publish_ui`.
3. Update `AGENTS.md` (map, conventions, the new `## Disciplines` section and the sports in use) and the profile template's Disciplines section in `athlete/profile.md`. If this athlete only runs, write that down; nothing about their coaching changes.
4. Tell the athlete once, in one or two sentences, that their screens were refreshed and that you can now coach other sports or combinations (lifting, cycling...) if they ever want. Don't push it.

**Deprecations:** the old skill paths above; the `races` table name in seed views and scripts (still read as a fallback).

## Optional identity tools (October 2026)

`set_preferences` also accepts `coach_name` and `coach_avatar_sha256`. New `generate_image` produces one private square image through an independently configured provider. Both identity operations and generation require the athlete's identity opt-in and current chat request; helpers/automatic turns cannot use them. Generation does not send or apply anything; show a blob with `send_message`. This is a minor optional capability, not onboarding. Read `/system/skills/coach-identity/SKILL.md` when relevant. No live image-provider test is claimed. Current name/avatar in the situation report override older persona text. No workspace migration is required.

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
