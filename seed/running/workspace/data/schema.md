# Database schema (`data/coach.db`)

SQLite. This file documents every table and column, in the style I should keep up when I change things. The numbered files in `migrations/` are the ledger of structural changes; the "Migration log" at the bottom records when each was applied. The seed views read these tables, so after any change I re-run `preview_ui` for the views that read what changed.

## Conventions
- **IDs** are text. Use a ULID (time-sortable) for new rows, or a stable slug for small reference rows.
- **Timestamps** (`started_at`, `created_at`, `updated_at`, `checkins.at`) are ISO 8601 *with the athlete's UTC offset*, e.g. `2026-10-07T06:58:12+02:00`. Never store a bare local time without an offset.
- **Local dates** (`planned_workouts.date`, `metrics.date`, `blocks.*_date`, `races.date`) are `YYYY-MM-DD` in the athlete's timezone on that day.
- **Units** are SI in the DB: distance in **meters**, durations in **seconds**, pace in **seconds per kilometer** (`s_km`), elevation in meters, heart rate in beats per minute, cadence in steps per minute. Convert to km, min:sec, miles etc. only for display.
- **Unknown is NULL.** Never write 0 for "not recorded". A run with no HR has `avg_hr` NULL.
- **JSON columns** hold JSON text. Query with `json_extract`, `json_each`.
- **Provenance:** a derived row says where it came from (`source`, `source_refs`, `extracted_by`, `confidence`, `confirmed`). Raw files in `/raw` are never edited; if a value is corrected, correct the row and say why in `extra` or the journal.

## `activities`: what the athlete actually did
One row per recorded session (run, walk, bike, strength...).
| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | ULID. |
| `started_at` | text | Start time, ISO 8601 with offset. Used with distance and duration to detect duplicates. |
| `sport` | text | `run` (default), `walk`, `hike`, `bike`, `swim`, `strength`, `cross`, `other`. |
| `title` | text | Short title, e.g. the app's title or my own ("Morning easy run"). |
| `distance_m` | real | Distance in meters. NULL if not recorded (strength, treadmill without calibration, etc.). |
| `duration_s` | real | **Elapsed** time in seconds, start to stop. |
| `moving_s` | real | Moving (timer) time in seconds, if the source distinguishes it. |
| `elev_gain_m` | real | Total ascent in meters, as the source reports it. Sources differ (GPS vs barometer); don't compare across sources. |
| `avg_hr`, `max_hr` | real | bpm. NULL without a sensor. |
| `avg_cadence_spm` | real | Steps per minute (both feet). Some sources report one foot's strides: if a value looks like ~85 for running, double it and note it in `extra`. |
| `avg_pace_s_km` | real | Seconds per km, computed as `duration_s / (distance_m/1000)` unless the source gives a moving pace; say which in `extra.pace_basis`. |
| `rpe` | real | The athlete's session RPE, 1 to 10 (CR-10 style: 1 very easy, 10 maximal). NULL until they tell me; never guessed. |
| `feel` | text | The athlete's words about the session. |
| `laps` | JSON | `[{"index":1,"distance_m":1000,"duration_s":362,"avg_hr":148,"avg_pace_s_km":362}, ...]`. Add keys as needed; document them here. |
| `hr_zones` | JSON | Time in zone if visible, e.g. `{"z1_s":300,"z2_s":1800,...}`. The zone definitions used by the source go in `extra.hr_zone_defs`. |
| `planned_id` | text FK | The `planned_workouts` row this fulfilled, if clear. |
| `source` | text | `screenshot`, `file`, `manual`, `voice`, `sync`. |
| `source_refs` | JSON | List of raw blob sha256 hashes (from `/raw`) this row was derived from. `[]` for manual entries. |
| `extracted_by` | text | Model id that extracted it, or `athlete` if they typed it. |
| `confidence` | real | 0 to 1, overall confidence in the extraction. |
| `confirmed` | integer | 1 once the athlete confirmed the uncertain fields; 0 otherwise. |
| `extra` | JSON | Anything else: `fields_confidence`, `not_visible`, `app`, `locale`, `weather`, `shoe`, `notes`. |
| `created_at`, `updated_at` | text | ISO 8601 with offset. |

## `planned_workouts`: what I prescribed
One row per planned session. Rest days may be rows of type `rest` if useful for the calendar view.
| Column | Meaning |
|---|---|
| `id` | ULID. Stable: the calendar export derives UIDs from it. |
| `date` | Local date. |
| `slot` | `am`, `pm` or `any`. |
| `type` | `easy`, `long`, `tempo`, `intervals`, `hills`, `race`, `strength`, `rest`, `cross`, `other`. |
| `title` | Athlete-facing title, e.g. "Easy 8 km". |
| `description` | Athlete-facing, short. Appears in the calendar and views. |
| `structure` | JSON step list (see below). Optional for simple runs. |
| `target_distance_m`, `target_duration_s` | Meters / seconds, whichever the session is prescribed by. |
| `status` | `planned`, `done`, `partial`, `skipped`, `moved`. When I move a session I change its `date` and leave it `planned`; `moved` is for sessions I deliberately keep as a record of a move. |
| `block_id` | The block this belongs to. |
| `coach_notes` | **Private** rationale. Never exported or shown. |
| `updated_at` | ISO 8601 with offset. |

**`structure`** is a compact, device-agnostic step list: `{"steps":[...], "notes":"..."}`. A step is `{"kind": "warmup|work|recovery|cooldown|rest", "duration": {"time_s": 900} or {"distance_m": 1000}, "target": {...}}`, or a repeat: `{"kind": "repeat", "times": 5, "steps": [...]}`. Targets may be ranges (`[low, high]`) of `pace_s_km`, `hr_bpm`, `hr_zone`, `rpe`, or `talk_test` (text). Example: warm up 15 min at RPE 2 to 3, 5 x (1000 m at 235 to 245 s/km with 2 min recovery), cool down 10 min.

## `blocks`: training blocks
`id`, `name` (e.g. "Base 1"), `start_date`, `end_date` (local dates, inclusive), `focus` (one line), `notes`.

## `checkins`: subjective data
One row per thing the athlete tells me or logs.
| Column | Meaning |
|---|---|
| `id` | ULID. |
| `at` | When it was reported or applies (ISO 8601 with offset). |
| `kind` | `sleep`, `soreness`, `pain`, `illness`, `mood`, `stress`, `energy`, `cycle`, `note`. |
| `value` | JSON; the shape depends on `kind` (suggested shapes below). |
| `source` | `chat`, `form`, `view`, `voice`, `call`. |
| `ref_event` | Event id it came from (so I can find the conversation). |

Suggested `value` shapes: `sleep` `{"hours":6.5,"quality":3}` (quality 1 to 5); `soreness` `{"score":3,"region":"left_calf"}` (score 1 to 5); `pain` `{"region":"left_achilles","severity":3,"behavior":"warms up, worse next morning"}` (region ids as in the body map, severity 0 to 10); `illness` `{"symptoms":["sore throat"],"fever":false}`; `mood`, `energy` `{"score":4}` (1 to 5, 5 = best); `stress` `{"score":4}` (1 to 5, 5 = most stress); `cycle` (opt-in only) `{"note":"..."}`; `note` `{"text":"..."}`.

## `metrics`: dated numbers that aren't sessions
Primary key `(date, name, source)`. `date` is a local date. `name` e.g. `resting_hr` (bpm), `hrv` (ms; say in `unit` which measure, e.g. `ms_rmssd`), `vo2max_est` (ml/kg/min, a watch's estimate: treat as noisy), `sleep_h` (hours). `value` real, `unit` text, `source` (`screenshot`, `file`, `manual`, ...), `source_refs` JSON list of blob hashes. Body weight is not tracked by default; track it only if the athlete asks and there are no eating-related concerns.

## `races`
`id`, `date` (local), `name`, `distance_m`, `priority` (`A`, `B`, `C`), `goal` JSON (e.g. `{"time_s":6000,"note":"A-goal"}`; add `b_goal_s` etc. as useful), `result` JSON (e.g. `{"time_s":6145,"place":212,"source":"athlete"}`), `notes`. Past races with known results also belong here: they anchor paces (see `zones-and-paces`).

## `gear`, `activity_gear`
`gear`: `id`, `name`, `kind` (default `shoe`; also `watch`, `other`), `started_at`, `retired_at`, `distance_offset_m` (meters already on it before tracking), `notes`. `activity_gear` (`activity_id`, `gear_id`; primary key on both) links activities to gear (many to many). Shoe mileage = `distance_offset_m` + sum of linked activities' `distance_m`.

## Migration log
| # | File | Applied | Notes |
|---|---|---|---|
| 0001 | `migrations/0001_init.sql` | {{created_date}} | Starter schema (created with the workspace). |

How to add one: write `migrations/NNNN_short_name.sql` (use `ALTER TABLE ... ADD COLUMN`, or create-copy-rename for anything bigger, and make it safe to read as documentation), apply it once with Python's `sqlite3` module (`executescript`), update the relevant section of this file, add a log line, then re-run `preview_ui`.
