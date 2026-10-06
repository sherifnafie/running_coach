# Appendix D: Seed workspace (day zero)

The seed is the coach's starting point. **Everything in `/workspace` belongs to the coach from the first turn.** The seed is a scaffold and a set of worked examples, not a framework. It ships in `seed/running/` and is copied into a new athlete's workspace at account creation. `/system` content (constitution, first-party skills, docs) is mounted read-only and updated with releases.

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
│   ├── current.md                  # "No plan yet — complete intake first."
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
- `plan/`: `current.md` is the current block (intent, phases, key sessions, rationale).
  `current-week.md` is the next 7 days in prose (pinned). Session-level detail lives in
  `data/coach.db` → `planned_workouts`.
- `journal/YYYY/MM/DD.md`: my daily notes: observations, decisions and why.
- `briefing.md`: what I wrote for tomorrow-me during consolidation.
- `data/`: `coach.db` (SQLite) is the source of truth for activities, planned workouts,
  check-ins, metrics, races and gear. Schema docs: `data/schema.md`.
- `ui/`: the athlete's app. `app.json` = nav. Views in `ui/views/<id>/`.
- `skills/`: procedures I've written for myself. `agents/`: helper profiles.
- `exports/calendar.ics`: subscribed by the athlete's calendar. Regenerate it after plan changes.

## Conventions
- Dates are ISO 8601 with the athlete's UTC offset. Distances in meters, durations in
  seconds, paces in s/km in the DB. Convert for display only.
- Every activity records `source`, `source_refs` (raw blob hashes), `extracted_by`,
  `confidence` and `confirmed`.
- Schema changes go in `data/migrations/NNNN_name.sql` and are documented in `schema.md`.

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
Philosophy: consistency beats heroics; mostly easy running; individualize everything;
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

The coach may evolve this schema freely (SPEC `[WS-1]`). The seed views depend on it, so the coach must update them if it changes.

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE activities (
  id              TEXT PRIMARY KEY,                -- ulid
  started_at      TEXT NOT NULL,                   -- ISO 8601 with offset
  sport           TEXT NOT NULL DEFAULT 'run',     -- run | walk | hike | bike | swim | strength | cross | other
  title           TEXT,
  distance_m      REAL,
  duration_s      REAL,                            -- elapsed
  moving_s        REAL,
  elev_gain_m     REAL,
  avg_hr          REAL,
  max_hr          REAL,
  avg_cadence_spm REAL,
  avg_pace_s_km   REAL,
  rpe             REAL,                            -- athlete-reported session RPE (1–10)
  feel            TEXT,                            -- athlete's words
  laps            JSON,                            -- [{distance_m, duration_s, avg_hr, ...}]
  hr_zones        JSON,                            -- {"z1_s":..., ...} if visible; zone definitions in extra
  planned_id      TEXT REFERENCES planned_workouts(id),
  source          TEXT NOT NULL,                   -- screenshot | file | manual | voice | sync
  source_refs     JSON NOT NULL DEFAULT '[]',      -- raw blob sha256 list
  extracted_by    TEXT,                            -- model id or 'athlete'
  confidence      REAL,                            -- 0–1 overall
  confirmed       INTEGER NOT NULL DEFAULT 0,      -- athlete confirmed uncertain fields
  extra           JSON,                            -- anything else
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX activities_started ON activities(started_at);

CREATE TABLE planned_workouts (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,                     -- local date YYYY-MM-DD
  slot          TEXT,                              -- am | pm | any
  type          TEXT NOT NULL,                     -- easy | long | tempo | intervals | hills | race | strength | rest | cross | other
  title         TEXT NOT NULL,
  description   TEXT,                              -- athlete-facing, short
  structure     JSON,                              -- see "Workout structure" below
  target_distance_m REAL,
  target_duration_s REAL,
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

CREATE TABLE races (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL, distance_m REAL,
  priority TEXT,               -- A | B | C
  goal JSON, result JSON, notes TEXT
);

CREATE TABLE gear (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'shoe',
  started_at TEXT, retired_at TEXT, distance_offset_m REAL DEFAULT 0, notes TEXT
);
CREATE TABLE activity_gear (activity_id TEXT REFERENCES activities(id), gear_id TEXT REFERENCES gear(id),
  PRIMARY KEY (activity_id, gear_id));
```

**Workout structure (`planned_workouts.structure`)** is a compact, device-agnostic step list. It's chosen so the coach can later write FIT workout files for watch export (Phase 3) without a harness change:

```json
{
  "steps": [
    { "kind": "warmup",   "duration": { "time_s": 900 },  "target": { "rpe": [2, 3] } },
    { "kind": "repeat", "times": 5, "steps": [
        { "kind": "work",     "duration": { "distance_m": 1000 }, "target": { "pace_s_km": [235, 245] } },
        { "kind": "recovery", "duration": { "time_s": 120 },      "target": { "rpe": [1, 2] } }
    ]},
    { "kind": "cooldown", "duration": { "time_s": 600 },  "target": { "rpe": [2, 3] } }
  ],
  "notes": "Even effort; stop the reps if the calf tightens."
}
```

Targets may be `pace_s_km`, `hr_bpm`, `hr_zone`, `rpe` or `talk_test` ranges. The coach chooses based on the data the athlete has.

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
You extract data for a running coach. For each input:
1. Identify the source app and screen type (summary, splits, HR graph, map…).
2. Report only values that are visibly present, with units exactly as shown and
   normalized values (meters, seconds, s/km). Mark any value read from a graph as approximate.
3. Give a per-field confidence (0–1) and an overall one. List fields that are not visible.
4. Note the date and time shown and whether a timezone is visible.
5. If several images belong to the same workout, merge them and say so.
Return JSON matching the `activities` table columns plus `fields_confidence` and `not_visible`.
```

Others (front-matter plus a 5–15 line brief each):

| Profile | Tier | Tools | Write scope | Brief |
|---|---|---|---|---|
| `analyst` | coach | read, glob, grep, bash | `journal/**`, `exports/**`, `/tmp` | Answer data questions with code; produce charts as PNG; show method and caveats |
| `planner` | deep | read, glob, grep, bash | `plan/drafts/**` | Draft a block from given constraints and history; state assumptions, the weekly load table, the key-session rationale, and risks |
| `reviewer` | coach (prefer a different provider than the coach) | read, glob, grep, bash | `plan/reviews/**` | Independently check a proposed plan change for safety and sanity: ramp rate, long-run share, intensity distribution, recovery, constraints, athlete-specific risks. Verdict: approve, concerns or reject, with reasons |
| `researcher` | fast | read, web_search, web_fetch | `research/**` | Course profiles, race logistics, weather, literature; cite sources; flag the evidence level |
| `ui-builder` | coach | read, write, edit, glob, grep, bash, preview_ui | `ui/**` | Build or modify views using the kit; iterate until preview passes and the screenshots look right; never publish (the coach publishes) |

---

## D.6 First-party skills (`/system/skills`, read-only)

All skills follow the Agent Skills format. Each is **knowledge plus suggested procedure, with evidence notes**, and invites adaptation. Contents outlines:

| Skill | Description (front-matter) | Body outline |
|---|---|---|
| `intake` | Conducting a coaching intake conversationally | Topics checklist (goals, dates, history, volume, injuries, health screening questions that trigger clearance advice, schedule, devices, preferences, motivation); pacing across sessions; what goes in which file; example openers |
| `screenshot-extraction` | Reading workout screenshots from common apps | Per-app layout notes (Samsung Health, Garmin Connect, Apple Fitness, Strava, Coros, Polar, NRC), unit and locale pitfalls, multi-screen merging, graph reading, duplicates, confirmation strategy |
| `file-import` | Parsing FIT/GPX/TCX/CSV/ZIP exports | Library snippets (fitdecode, gpxpy, pandas), Samsung Health export structure and timezone offsets, dedupe across sources, storing raw-to-derived links |
| `zones-and-paces` | Setting and using intensity guidance | HR (max, reserve, LTHR-based) vs. pace vs. RPE vs. talk test; race-equivalence tables (VDOT-style) and their limits; heat and terrain adjustments; coaching without HR |
| `training-load` | Quantifying and reasoning about load | Session RPE × duration, TRIMP variants, weekly volume and time; ACWR **with the critique** (use as a conversation prompt, not a rule); monotony and strain; what to track |
| `plan-design` | Designing training blocks | Periodization models, phase intents, progression heuristics (and their evidence quality), long-run share, intensity distribution (polarized, pyramidal), down weeks, sample week skeletons 5K → marathon, taper ranges, adapting to schedules |
| `injury-and-pain` | Handling pain and injury | Red flags (mirrors constitution §11), pain-monitoring model, common running injuries at an *awareness* level (no diagnosis), load modification, cross-training substitutes, return-to-run progressions, referral triggers |
| `illness-return` | Training around illness | "Neck check" heuristic, fever rule, post-viral caution, return progression |
| `race-prep` | Race-specific preparation | Race-week structure, taper, pacing strategies, fueling and hydration plan, logistics checklist, race-morning message, post-race recovery and debrief |
| `environment` | Heat, cold, altitude, air quality | Adjustments, acclimatization, warning signs, when to move indoors |
| `strength-mobility` | Strength and mobility for runners | Rationale, minimal effective routines, scheduling around key sessions, progression |
| `fueling-basics` | Everyday and long-run fueling | Carbohydrate ranges for long sessions, hydration; **explicit RED-S and ED cautions**; when to refer to a dietitian |
| `ui-kit` | Building views for the athlete's app | Kit components and tokens, bridge API, design rules (outdoor readability, one primary action per view, empty states, dark mode), patterns (calendar, trends, workout detail), performance budget, publish workflow |
| `calendar-export` | Maintaining `exports/calendar.ics` | ICS structure, timezone handling, stable UIDs, descriptions with workout structure |
| `data-hygiene` | Keeping the data trustworthy | Units, timezones, duplicates, provenance, corrections, re-derivation |

**Evidence policy for skill authors:** every non-trivial recommendation carries an evidence note (`strong`, `moderate`, `weak/expert opinion`) and, where possible, a citation. Skills are reviewed by the human coach advisory (SPEC §22 item 9) before release.

---

## D.7 Seed views and UI kit v1

**UI kit v1 components** (lightweight web components plus CSS tokens, served from the kit origin):
`<rc-page>`, `<rc-header>`, `<rc-card>`, `<rc-stat>`, `<rc-week-strip>`, `<rc-calendar>` (month and week, drag to move with a write hook), `<rc-workout>` (renders a `structure`), `<rc-chart>` (bar, line, area, scatter; thin wrapper over a vetted charting lib), `<rc-trend>`, `<rc-progress-ring>`, `<rc-list>`, `<rc-empty>`, `<rc-button>`, `<rc-chip>`, `<rc-form>` (fields as in micro-UI), `<rc-body-map>`, `<rc-markdown>` (render workspace markdown safely), `<rc-map>` (Phase 2, via the tile proxy). Design tokens: color (light, dark, accent), type scale, spacing, radii, motion (reduced-motion aware). Formatters: distance, duration, pace, date (locale and units aware).

**Seed views** (each about 100–250 lines; deliberately readable as examples):

| View | Shows | Interactions |
|---|---|---|
| `today` (home) | Today's session (structure, targets, coach note), readiness check-in shortcut, last activity summary, next key session | Mark done or skipped (direct write plus `act` with wake), "Ask coach about this", quick check-in form |
| `calendar` | Week strip and month grid, planned vs. done, colour by type, race markers | Drag to move (direct write plus `act('workout_moved', …, {wake: true})`), tap for detail |
| `plan` | Current block: phases timeline, weekly volume table (planned), key sessions, goal race | Read-only; "Discuss this plan" opens chat with a reference |
| `progress` | Weekly volume bars (8–16 wks), long-run trend, easy-run pace-at-HR trend if HR exists, consistency streak *without* gamification pressure, race results | Range toggle |

---

## D.8 Sandbox image

Debian slim plus: `python3` (pandas, numpy, scipy, matplotlib, plotly, fitdecode, fitparse, gpxpy, tcxreader, duckdb, pillow, pyarrow, python-dateutil, icalendar), `sqlite3`, `node` (LTS) plus `playwright` with Chromium (for `preview_ui`), `git`, `ffmpeg`, `jq`, `ripgrep`, `libfaketime` (eval time machine). No credentials. Default no egress. Image version pinned per harness release.
