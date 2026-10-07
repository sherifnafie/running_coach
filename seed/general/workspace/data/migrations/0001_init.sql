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
