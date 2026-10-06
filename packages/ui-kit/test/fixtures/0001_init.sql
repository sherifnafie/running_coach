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
