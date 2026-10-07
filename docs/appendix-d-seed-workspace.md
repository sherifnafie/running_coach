# Appendix D: Seed workspace (day zero)

The seed is the coach's starting point. **Everything in `/workspace` belongs to the coach from the first turn.** The seed is a scaffold and a set of worked examples, not a framework. It ships in `seed/general/` (one general pack for any sport or combination of sports; see [ADR 0006](adr/0006-multi-discipline-coaching.md)) and is copied into a new athlete's workspace at account creation. A reference copy is also mounted at `/system/seed-workspace/` so a coach in an older workspace can adopt newer seed files. **The files in `seed/general/` are authoritative; this appendix summarizes them and may lag.** `/system` content (constitution, first-party skills, docs) is mounted read-only and updated with releases.

Design rule for the seed: **small, legible and exemplary.** Each file should teach the coach (and any future model) a convention by example. There should be no empty boilerplate.

---

## D.1 File tree

```
/workspace
├── AGENTS.md                       # map + conventions + pinned list (D.2)
├── HEARTBEAT.md                    # daily checklist (D.3)
├── briefing.md                     # empty until first consolidation
├── coach/
│   └── persona.md                  # D.3
├── athlete/
│   ├── profile.md                  # D.3 template (pinned)
│   ├── health.md                   # "No information yet."
│   └── preferences.md              # "No information yet."
├── athlete-input/                  # files views may write directly (e.g. free-form logs)
├── plan/
│   ├── current.md                  # coach working notes; not Plan view copy
│   ├── athlete-summary.md          # plain-language "Why this plan" explanation
│   └── current-week.md             # pinned; coach keeps the next 7 days here in prose
├── journal/                        # YYYY/MM/DD.md
├── data/
│   ├── coach.db                    # created from D.4
│   ├── schema.md                   # D.4 documentation
│   ├── migrations/0001_init.sql
│   └── dump/                       # nightly SQL text dumps (harness-written)
├── ui/
│   ├── app.json
│   ├── views/{today,calendar,plan,progress}/   # D.7
│   └── components/                 # empty; coach's own reusable components
├── skills/                         # empty; coach-authored skills
├── agents/                         # D.5 helper profiles
├── exports/
│   └── calendar.ics                # empty calendar until a plan exists
└── feedback-to-harness.md          # "Notes for the developers."
```

---

## D.2 `AGENTS.md` (starter)

```markdown
---
pinned:            # loaded into every context, in this order, up to the harness cap (12k tokens)
  - coach/persona.md
  - athlete/profile.md
  - plan/current-week.md
---

# Workspace manual

This is my workspace as {{athlete_name}}'s coach. Any model that takes over from me
should read this first.

## Map
- `athlete/`: who they are. `profile.md` is the one-page essentials (pinned).
  `health.md`: injuries, conditions, clearances. `preferences.md`: how and when they
  like to be coached.
- `plan/`: `current.md` is working memory for the current block (intent, phases, key sessions, rationale).
  `athlete-summary.md` is the reviewed explanation displayed in Plan; no implementation bookkeeping.
  `current-week.md` is the next 7 days in prose (pinned). Session-level detail lives in
  `data/coach.db` → `planned_workouts`.
- `journal/YYYY/MM/DD.md`: my daily notes: observations, decisions and why.
- `briefing.md`: what I wrote for tomorrow-me during consolidation.
- `data/`: `coach.db` (SQLite) is the source of truth for activities, planned workouts,
  check-ins, lifting sets, metrics, goal events and gear. Schema docs: `data/schema.md`.
- `ui/`: the athlete's app. `app.json` = nav. Views in `ui/views/<id>/`.
- `skills/`: procedures I've written for myself. `agents/`: helper profiles.
- `exports/calendar.ics`: subscribed by the athlete's calendar. Regenerate it after plan changes.

## Conventions
- Dates are ISO 8601 with the athlete's UTC offset. Distances in meters, durations in
  seconds, loads in kg, paces in s/km in the DB. Convert for display only.
- Sports and exercise names in use: listed here and kept consistent across tables.
- Every activity records `source`, `source_refs` (raw blob hashes), `extracted_by`,
  `confidence` and `confirmed`.
- Schema changes go in `data/migrations/NNNN_name.sql` and are documented in `schema.md`.

## Disciplines
- (none yet; ask during intake) What I coach, which skills I lean on, workspace skills I wrote.

## Open threads
- (none yet — onboarding not started)
```

---

## D.3 Other starter files

**`coach/persona.md`**
```markdown
# Persona
Name: {{coach_name}} (the athlete may rename me)
Voice: warm, direct, encouraging without hype; plain language; light humor when it fits.
Philosophy: consistency beats heroics; most training sustainable, hard work purposeful; individualize everything;
health first; the athlete decides.
Spoken voice: {{voice_id}} (for calls and voice notes)
Adjust this file as I learn how this athlete likes to be coached.
```

**`athlete/profile.md`** (template the coach fills during intake)
```markdown
# {{athlete_name}}: profile (keep under ~1,500 words)
## Essentials
- Age range / sex (if shared):
- Running background:
- Current typical week (volume, frequency, longest run):
- Devices & data available (watch, HR strap, app):
## Goals (ranked, with dates)
## Constraints (days/times available, terrain, travel, family, work)
## Health snapshot (details in health.md)
## Coaching preferences (tone, message frequency, detail level)
## Current phase & focus
## Things to remember (short, dated bullets)
```

**`HEARTBEAT.md`**
```markdown
# Daily heartbeat checklist (I can edit this)
- Is today's session clear to the athlete? If they haven't heard from me and there's a
  session today, consider a short prescription message.
- Anything from yesterday unresolved (missing log, pain mention, unanswered question)?
- Do my scheduled wakes cover the next few days sensibly?
- Is `plan/current-week.md` accurate?
If nothing needs saying, say nothing.
```

**`plan/current-week.md`**: `"No plan yet."` · **`briefing.md`**: empty · **`feedback-to-harness.md`**: one-line explanation.

---

## D.4 Starter database schema (`data/migrations/0001_init.sql`)

The coach may evolve this schema freely (SPEC `[WS-1]`). The seed views depend on it, so the coach must update them if it changes. The schema is sport-agnostic: one `activities` table for every session of every sport (endurance-only columns stay NULL elsewhere), set-by-set lifting in `exercise_sets`, dated goals of any kind (races, meets, matches, tests, trips) in `goal_events`, and `sport` plus `key` on planned sessions. Weekly time (`target_duration_s`, `duration_s`) is the cross-sport volume measure.

```sql
-- 0001_init: starter schema for coach.db (Appendix D §D.4).
-- The coach owns this schema and may evolve it freely, in new numbered migrations, documenting each
-- change in data/schema.md. The seed views depend on these tables: re-check them after any change.
--
-- The schema is sport-agnostic. `sport` is free text (run, strength, bike, swim, climb, row, yoga, ...);
-- endurance-only columns (distance, pace, cadence, laps, HR zones) stay NULL for other sports, and
-- resistance work is logged set by set in `exercise_sets`.
--
-- Session structure (planned_workouts.structure) is a compact, device-agnostic list of steps. Endurance
-- steps have a duration and a target; strength work uses "exercise" steps with sets, reps and load.
-- Both can appear in one session. Example (a run with strides, then two lifts):
--
-- {
--   "steps": [
--     { "kind": "warmup",   "duration": { "time_s": 600 },  "target": { "rpe": [2, 3] } },
--     { "kind": "repeat", "times": 4, "steps": [
--         { "kind": "work",     "duration": { "time_s": 20 },  "target": { "rpe": [7, 8] } },
--         { "kind": "recovery", "duration": { "time_s": 60 },  "target": { "rpe": [1, 2] } }
--     ]},
--     { "kind": "exercise", "name": "Back squat", "sets": 3, "reps": 5, "load": { "kg": 100 }, "target": { "rpe": [7, 8] }, "rest_s": 180 },
--     { "kind": "exercise", "name": "Romanian deadlift", "sets": [ { "reps": 8, "load": { "kg": 70 } }, { "reps": 8, "load": { "kg": 70 }, "times": 2 } ] }
--   ],
--   "notes": "Even effort on the strides; stop the squats if the knee complains."
-- }
--
-- Targets may be pace_s_km, hr_bpm, hr_zone, rpe, rir, pct_1rm or talk_test ranges. Choose based on the
-- data the athlete has and the sport.

PRAGMA journal_mode = WAL;

CREATE TABLE activities (
  id              TEXT PRIMARY KEY,                -- ulid
  started_at      TEXT NOT NULL,                   -- ISO 8601 with offset
  sport           TEXT NOT NULL,                   -- run | strength | bike | swim | walk | hike | climb | row | yoga | ... (free text)
  title           TEXT,
  duration_s      REAL,                            -- elapsed
  moving_s        REAL,
  distance_m      REAL,                            -- endurance sports; NULL otherwise
  elev_gain_m     REAL,
  avg_hr          REAL,
  max_hr          REAL,
  avg_cadence_spm REAL,                            -- running steps per minute; NULL otherwise
  avg_pace_s_km   REAL,                            -- running/walking pace; NULL otherwise
  rpe             REAL,                            -- athlete-reported session RPE (1–10)
  feel            TEXT,                            -- athlete's words
  laps            JSON,                            -- [{distance_m, duration_s, avg_hr, ...}]
  hr_zones        JSON,                            -- {"z1_s":..., ...} if visible; zone definitions in extra
  planned_id      TEXT REFERENCES planned_workouts(id),
  source          TEXT NOT NULL,                   -- screenshot | file | manual | voice | sync | view
  source_refs     JSON NOT NULL DEFAULT '[]',      -- raw blob sha256 list
  extracted_by    TEXT,                            -- model id or 'athlete'
  confidence      REAL,                            -- 0–1 overall
  confirmed       INTEGER NOT NULL DEFAULT 0,      -- athlete confirmed uncertain fields
  extra           JSON,                            -- anything else
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX activities_started ON activities(started_at);

CREATE TABLE exercise_sets (
  id            TEXT PRIMARY KEY,                  -- ulid
  activity_id   TEXT NOT NULL REFERENCES activities(id),
  performed_at  TEXT NOT NULL,                     -- ISO 8601 with offset (the session start is fine)
  exercise      TEXT NOT NULL,                     -- consistent display name, e.g. 'Back squat'
  set_index     INTEGER NOT NULL,                  -- order within the session, from 1
  reps          REAL,                              -- NULL for timed/distance sets
  load_kg       REAL,                              -- external load in kg (bar + plates, dumbbell each side noted in extra)
  rpe           REAL,                              -- set RPE (1–10), athlete-reported
  rir           REAL,                              -- reps in reserve, athlete-reported
  duration_s    REAL,                              -- timed sets (plank, carry)
  distance_m    REAL,                              -- carries, sled pushes
  is_warmup     INTEGER NOT NULL DEFAULT 0,
  extra         JSON                               -- bodyweight, assistance, per-side, tempo, notes
);
CREATE INDEX exercise_sets_exercise ON exercise_sets(exercise, performed_at);
CREATE INDEX exercise_sets_activity ON exercise_sets(activity_id);

CREATE TABLE planned_workouts (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,                     -- local date YYYY-MM-DD
  slot          TEXT,                              -- am | pm | any
  sport         TEXT,                              -- as activities.sport; NULL for rest days
  type          TEXT NOT NULL,                     -- session intent, see data/schema.md
  title         TEXT NOT NULL,
  description   TEXT,                              -- athlete-facing, short
  structure     JSON,                              -- see "Session structure" above
  target_distance_m REAL,
  target_duration_s REAL,                          -- set for every non-rest session (an estimate is fine)
  key           INTEGER NOT NULL DEFAULT 0,        -- 1 = one of the week's most important sessions
  status        TEXT NOT NULL DEFAULT 'planned',   -- planned | done | partial | skipped | moved
  block_id      TEXT REFERENCES blocks(id),
  coach_notes   TEXT,                              -- private rationale
  updated_at    TEXT NOT NULL
);
CREATE INDEX planned_date ON planned_workouts(date);

CREATE TABLE blocks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  focus TEXT, notes TEXT
);

CREATE TABLE checkins (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,          -- sleep | soreness | pain | illness | mood | stress | energy | cycle | note
  value JSON NOT NULL,         -- e.g. {"score":3} or {"region":"left_achilles","severity":3,"behavior":"warms up"}
  source TEXT NOT NULL,        -- chat | form | view | voice | call
  ref_event TEXT               -- event id it came from
);

CREATE TABLE metrics (
  date TEXT NOT NULL, name TEXT NOT NULL,      -- resting_hr | hrv | vo2max_est | ...
  value REAL NOT NULL, unit TEXT, source TEXT NOT NULL, source_refs JSON DEFAULT '[]',
  PRIMARY KEY (date, name, source)
);

CREATE TABLE goal_events (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL,
  sport TEXT,                  -- as activities.sport
  kind TEXT,                   -- race | meet | match | test | trip | other
  priority TEXT,               -- A | B | C
  distance_m REAL,             -- races; NULL otherwise
  goal JSON,                   -- {"text": "Sub 1:45", "time_s": 6300} or {"text": "500 kg total", "total_kg": 500}
  result JSON,                 -- {"text": "1:46:12, 212th", "time_s": 6372, "place": 212}
  notes TEXT
);

CREATE TABLE gear (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT,  -- shoe | bike | belt | watch | other
  started_at TEXT, retired_at TEXT, distance_offset_m REAL DEFAULT 0, notes TEXT
);
CREATE TABLE activity_gear (activity_id TEXT REFERENCES activities(id), gear_id TEXT REFERENCES gear(id),
  PRIMARY KEY (activity_id, gear_id));
```

Session `structure` mixes endurance steps (`warmup|work|recovery|cooldown|steady|rest` with a `duration` and `target`), `repeat` groups, and `exercise` steps (`name`, `sets` as a count or an array of set groups, `reps` as a number, range or `"AMRAP"`, `load` as `{kg}`, `{pct_1rm}` or `{bodyweight}`, `target`, `rest_s`, `tempo`). Targets may be `pace_s_km`, `hr_bpm`, `hr_zone`, `rpe`, `rir`, `pct_1rm` or `talk_test`. The coach chooses based on the sport and the data the athlete has.

`data/schema.md` documents every table and column in prose, including units and semantics. It's written in the same style the coach is expected to keep up.

---

## D.5 Helper profiles (`agents/*.md`)

Example in full:

```markdown
---
name: extractor
description: Extract structured workout data from screenshots or exported files, with per-field confidence. Never guesses invisible values.
tier: fast
tools: [read, glob, grep, bash]
write_scope: []
effort: low
---
You extract training data for a coach (any sport, including gym logs). For each input:
1. Identify the source app and screen type (summary, splits, HR graph, map…).
2. Report only values that are visibly present, with units exactly as shown and
   normalized values (meters, seconds, kg, s/km). Mark any value read from a graph as approximate.
3. Give a per-field confidence (0–1) and an overall one. List fields that are not visible.
4. Note the date and time shown and whether a timezone is visible.
5. If several images belong to the same workout, merge them and say so.
Return JSON matching the `activities` table columns (plus `sets` matching `exercise_sets` for lifting) and `fields_confidence` and `not_visible`.
```

Others (front-matter plus a 5–15 line brief each):

| Profile | Tier | Tools | Write scope | Brief |
|---|---|---|---|---|
| `analyst` | coach | read, glob, grep, bash | `journal/**`, `exports/**`, `/tmp` | Answer data questions with code; produce charts as PNG; show method and caveats |
| `planner` | deep | read, glob, grep, bash | `plan/drafts/**` | Draft a block (one or several disciplines) from given constraints and history; state assumptions, the weekly load table per discipline, the key-session rationale, and risks |
| `reviewer` | coach (prefer a different provider than the coach) | read, glob, grep, bash | `plan/reviews/**` | Independently check a proposed plan change for safety and sanity: ramp rate per discipline, discipline-specific checks (long-run share, proximity to failure), hard sessions across sports, recovery, constraints and equipment, athlete-specific risks. Verdict: approve, concerns or reject, with reasons |
| `researcher` | fast | read, write, web_search, web_fetch | `research/**` | Focused lookups for courses, logistics, weather and literature; save cited findings; flag the evidence level |
| `deep-researcher` | deep, high effort | read, write, glob, grep, web_search, web_fetch | `research/**` | Complex questions and requested deep evidence reviews; compare primary sources and disagreements; preserve a cited report with uncertainty |
| `ui-builder` | coach | read, write, edit, glob, grep, bash, preview_ui | `ui/**` | Build or modify views using the kit; iterate until preview passes and the screenshots look right; never publish (the coach publishes) |

---

## D.6 First-party skills (`/system/skills`, read-only)

`/system/skills/coach-identity/SKILL.md` is indexed with the other skills and read only for a relevant athlete request. It explains name/avatar permission, private generated blobs, preview versus application, text-only limitations, budgets and failure handling. It must not become an intake or scheduled-contact workflow. See SPEC §9.5.1 and the self-hosting image configuration. Existing workspace persona files and views are preserved; the current settings identity is reported every turn.

All skills follow the Agent Skills format. Each is **knowledge plus suggested procedure, with evidence notes**, and invites adaptation. Contents outlines:

The implementation also ships a `research` skill: depth selection, source retrieval and verification, privacy, uncertainty, bounded delegation and persistent cited reports. `/system/docs/opencoach.md` explains the actual product and ownership boundaries. Runtime reports state configured services and model/vision routes; mentioning a feature in these documents is not proof that it is available in a deployment.

| Skill | Description (front-matter) | Body outline |
|---|---|---|
| `intake` | Conducting a coaching intake conversationally | What they want coaching in (one sport or several), goals, history per discipline, equipment, health screening that triggers clearance advice, schedule, devices, preferences; pacing across sessions; what goes in which file; example openers |
| `disciplines` | Taking on any sport and combining several | Finding disciplines and priorities; researching a sport without a first-party skill and writing a workspace skill; extending schema and views; concurrent training (interference, scheduling, maintenance doses, templates) |
| `running` | Running-specific coaching | `zones-and-paces.md` (RPE, talk test, HR, pace, VDOT via `vdot.py`), `plan-design.md` (long runs, intensity distribution, session doses, sample weeks 5K to marathon, tapers), `races.md` (pacing, in-race fueling, warm-ups, recovery) |
| `strength-training` | Resistance training for any goal | `programming.md` (RPE/RIR, %1RM, e1RM, volume, frequency, progression, deloads, templates), `powerlifting.md` (peaking, attempts, meet day, weight classes), `support-strength.md` (strength for runners and other sports), `e1rm.py` |
| `screenshot-extraction` | Reading workout screenshots from common apps | Watch and run apps, gym-log apps and handwritten logs; unit and locale pitfalls (km/mi, kg/lb), multi-screen merging, graph reading, duplicates, confirmation strategy |
| `file-import` | Parsing FIT/GPX/TCX/CSV/ZIP exports | Bundled parsers, Samsung Health export structure and timezone offsets, gym-app CSVs, dedupe across sources, raw-to-derived links |
| `training-load` | Quantifying and reasoning about load | Session RPE × duration as the cross-sport currency, weekly time and discipline measures; ACWR **with the critique**; monotony and strain; `load.py` |
| `plan-design` | Designing training blocks, any sport | Commitment and review, periodization and phase intents, progression heuristics (and their evidence quality), peaking and tapering, adapting to life, fitting to schedules and equipment, recording; `plan_check.py` |
| `injury-and-pain` | Handling pain and injury | Red flags (mirrors constitution §11), pain monitoring, running and lifting patterns at an *awareness* level (no diagnosis), load modification, return-to-run and return-to-lifting progressions, referral triggers |
| `illness-return` | Training around illness | "Neck check" heuristic, fever rule, post-viral caution, return progression for endurance and lifting |
| `competition-prep` | Preparing for any dated goal event | Timeline, A/B/C goals, weight classes (no cuts), rehearsal, logistics, morning message, debrief, recording results |
| `environment` | Heat, cold, altitude, air quality | Adjustments, acclimatization, warning signs, when to move indoors |
| `fueling-basics` | Everyday and in-session fueling | Eating enough, protein and carbohydrate in plain terms, in-session carbohydrate, hydration, supplements; **explicit RED-S, ED and weight-cutting cautions**; when to refer to a dietitian |
| `ui-kit` | Building views for the athlete's app | Kit components and tokens, bridge API, design rules, patterns, performance budget, publish workflow |
| `calendar-export` | Maintaining `exports/calendar.ics` | ICS structure, timezone handling, stable UIDs, descriptions with session structure and exercises |
| `data-hygiene` | Keeping the data trustworthy | Units, timezones, duplicates, provenance, lifting-set checks, corrections, re-derivation; `check_db.py` |

**Evidence policy for skill authors:** every non-trivial recommendation carries an evidence note (`strong`, `moderate`, `weak/expert opinion`) and, where possible, a citation. Skills are reviewed by the human coach advisory (SPEC §22 item 9) before release.

---

## D.7 Seed views and UI kit v1

**UI kit v1 components** (lightweight web components plus CSS tokens, served from the kit origin):
`<rc-page>`, `<rc-header>`, `<rc-card>`, `<rc-stat>`, `<rc-week-strip>`, `<rc-calendar>` (month and week, drag to move with a write hook), `<rc-workout>` (renders a `structure`: endurance steps and exercises), `<rc-chart>` (bar, line, area, scatter; thin wrapper over a vetted charting lib), `<rc-trend>`, `<rc-progress-ring>`, `<rc-list>`, `<rc-empty>`, `<rc-button>`, `<rc-chip>`, `<rc-form>` (fields as in micro-UI), `<rc-body-map>`, `<rc-markdown>` (render workspace markdown safely), `<rc-map>` (Phase 2, via the tile proxy). Design tokens: color (light, dark, accent), type scale, spacing, radii, motion (reduced-motion aware). Formatters: distance, duration, pace, weight, date (locale and units aware). Session types are free text: known words have fixed colours and letters, any other word gets a stable hashed colour and its initial (`types` helpers).

**Seed views** (each about 100–250 lines; deliberately readable as examples):

| View | Shows | Interactions |
|---|---|---|
| `today` (home) | Today's sessions in any sport (sport and type, structure with exercises, key-session badge), readiness check-in shortcut, last activity with numbers that fit the sport, next key session | Mark done or skipped (direct write plus `act` with wake), "Ask coach", quick check-in form |
| `calendar` | Month and week grid, planned vs. done, colour and letter by type (any word), goal events, legend built from the types in use, detail card per sport (sets for lifting) | Drag to move (direct write plus `act('workout_moved', …, {wake: true})`), tap for detail |
| `plan` | Current block: phases timeline, planned weekly time stacked by sport (distance fallback), weekly table, key sessions, next goal event, "Why this plan" | Read-only; "Discuss this plan" opens chat with a reference |
| `progress` | Weekly training time by sport, planned sessions done, weekly distance (if any distance sports), e1RM trends and top lifts (if any lifting), consistency *without* gamification pressure, results | Range toggle |

---

## D.8 Sandbox image

Debian slim plus: `python3` (pandas, numpy, scipy, matplotlib, plotly, fitdecode, fitparse, gpxpy, tcxreader, duckdb, pillow, pyarrow, python-dateutil, icalendar), `sqlite3`, `node` (LTS) plus `playwright` with Chromium (for `preview_ui`), `git`, `ffmpeg`, `jq`, `ripgrep`, `libfaketime` (eval time machine). No credentials. Default no egress. Image version pinned per harness release.
