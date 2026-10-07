# Database schema (`data/coach.db`)

SQLite. This file documents every table and column, in the style I should keep up when I change things. The numbered files in `migrations/` are the ledger of structural changes; the "Migration log" at the bottom records when each was applied. The seed views read these tables, so after any change I re-run `preview_ui` for the views that read what changed.

The schema is sport-agnostic: one `activities` table for every session of every sport, set-by-set detail for resistance work in `exercise_sets`, and dated goals of any kind in `goal_events`. When a discipline needs data these tables don't hold (rowing splits, climbing grades, swim strokes), add it: a JSON key in `extra` for occasional data, a column or a new table for data I will query or chart.

## Conventions
- **IDs** are text. Use a ULID (time-sortable) for new rows, or a stable slug for small reference rows.
- **Timestamps** (`started_at`, `performed_at`, `created_at`, `updated_at`, `checkins.at`) are ISO 8601 *with the athlete's UTC offset*, e.g. `2026-10-07T06:58:12+02:00`. Never store a bare local time without an offset.
- **Local dates** (`planned_workouts.date`, `metrics.date`, `blocks.*_date`, `goal_events.date`) are `YYYY-MM-DD` in the athlete's timezone on that day.
- **Units** are SI in the DB: distance in **meters**, durations in **seconds**, load in **kilograms**, pace in **seconds per kilometer** (`s_km`), elevation in meters, heart rate in beats per minute, cadence in steps per minute. Convert to km, mi, lb, min:sec etc. only for display (1 lb = 0.45359237 kg).
- **Sports** are short lowercase words: `run`, `walk`, `hike`, `bike`, `swim`, `row`, `strength`, `climb`, `yoga`, `mobility`, `cross`, `other`, or another word that fits (`football`, `bjj`). Pick one per discipline and use it consistently in `activities.sport`, `planned_workouts.sport` and `goal_events.sport`; record the list in use in `AGENTS.md`. Use `strength` for resistance training of any style (powerlifting, general gym, bodyweight) and put the style in the title or `extra` if it matters.
- **Unknown is NULL.** Never write 0 for "not recorded". A run with no HR has `avg_hr` NULL; a lifting session has `distance_m` NULL.
- **JSON columns** hold JSON text. Query with `json_extract`, `json_each`.
- **Provenance:** a derived row says where it came from (`source`, `source_refs`, `extracted_by`, `confidence`, `confirmed`). Raw files in `/raw` are never edited; if a value is corrected, correct the row and say why in `extra` or the journal.

## `activities`: what the athlete actually did
One row per recorded session, any sport. Columns marked *endurance* stay NULL for sports where they don't apply.
| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | ULID. |
| `started_at` | text | Start time, ISO 8601 with offset. Used with sport and duration to detect duplicates. |
| `sport` | text | See conventions. |
| `title` | text | Short title, e.g. the app's title or my own ("Morning easy run", "Squat day"). |
| `duration_s` | real | **Elapsed** time in seconds, start to stop. Set it for every sport when known: it drives time-based load and the Progress view. |
| `moving_s` | real | Moving (timer) time in seconds, if the source distinguishes it. |
| `distance_m` | real | *Endurance.* Distance in meters. NULL if not recorded or not applicable. |
| `elev_gain_m` | real | *Endurance.* Total ascent in meters, as the source reports it. Sources differ (GPS vs barometer); don't compare across sources. |
| `avg_hr`, `max_hr` | real | bpm. NULL without a sensor. |
| `avg_cadence_spm` | real | *Running.* Steps per minute (both feet). Some sources report one foot's strides: if a value looks like ~85 for running, double it and note it in `extra`. Cycling cadence (rpm) goes in `extra.cadence_rpm`. |
| `avg_pace_s_km` | real | *Running/walking.* Seconds per km, computed as `duration_s / (distance_m/1000)` unless the source gives a moving pace; say which in `extra.pace_basis`. Swim pace per 100 m goes in `extra.pace_s_100m`. |
| `rpe` | real | The athlete's session RPE, 1 to 10 (CR-10 style: 1 very easy, 10 maximal). NULL until they tell me; never guessed. |
| `feel` | text | The athlete's words about the session. |
| `laps` | JSON | *Endurance.* `[{"index":1,"distance_m":1000,"duration_s":362,"avg_hr":148,"avg_pace_s_km":362}, ...]`. Add keys as needed; document them here. |
| `hr_zones` | JSON | Time in zone if visible, e.g. `{"z1_s":300,"z2_s":1800,...}`. The zone definitions used by the source go in `extra.hr_zone_defs`. |
| `planned_id` | text FK | The `planned_workouts` row this fulfilled, if clear. |
| `source` | text | `screenshot`, `file`, `manual`, `voice`, `sync`, `view`. |
| `source_refs` | JSON | List of raw blob sha256 hashes (from `/raw`) this row was derived from. `[]` for manual entries. |
| `extracted_by` | text | Model id that extracted it, or `athlete` if they typed it. |
| `confidence` | real | 0 to 1, overall confidence in the extraction. |
| `confirmed` | integer | 1 once the athlete confirmed the uncertain fields; 0 otherwise. |
| `extra` | JSON | Anything else: `fields_confidence`, `not_visible`, `app`, `locale`, `weather`, `shoe`, `notes`, sport-specific values. |
| `created_at`, `updated_at` | text | ISO 8601 with offset. |

## `exercise_sets`: resistance work, set by set
One row per set the athlete performed (logged, not planned). The parent `activities` row (sport `strength`, or any session that included lifting) holds duration, session RPE and provenance; this table holds the detail that strength progress depends on.
| Column | Meaning |
|---|---|
| `id` | ULID. |
| `activity_id` | The session this set belongs to (required). |
| `performed_at` | ISO 8601 with offset; the session start is fine when set times aren't known. |
| `exercise` | Consistent, athlete-readable name: `Back squat`, `Bench press`, `Deadlift`, `Pull-up`. Keep one spelling per movement (list them in `AGENTS.md` once there are many); variations get their own name (`Pause squat`, `Close-grip bench`). Progress views group by this column. |
| `set_index` | Order within the session, from 1. |
| `reps` | Reps completed. NULL for timed or distance sets. A failed rep is not counted; note it in `extra`. |
| `load_kg` | External load in kg. Barbell = bar plus plates. Dumbbells: one dumbbell's weight with `extra.per_side: true`. Bodyweight movements: NULL, or added load only with `extra.bodyweight: true`; assisted: `extra.assist_kg`. |
| `rpe`, `rir` | Effort for the set as the athlete reported it (RPE 1 to 10, or reps in reserve). One is enough; never guess either. |
| `duration_s`, `distance_m` | For timed sets (plank 45 s) and carries or sled work. |
| `is_warmup` | 1 for warm-up sets; they are kept but excluded from working-set counts and estimates. |
| `extra` | `tempo`, `per_side`, `bodyweight`, `assist_kg`, `equipment` (belt, sleeves), `failed_reps`, `notes`. |

Estimated 1RM (e1RM) is a derived number, not a column: compute it from working sets with reps ≤ 10 (Epley `load × (1 + reps/30)`, or the `strength-training` skill's script) and say it is an estimate.

## `planned_workouts`: what I prescribed
One row per planned session, any sport. Rest days may be rows of type `rest` if useful for the calendar view.
| Column | Meaning |
|---|---|
| `id` | ULID. Stable: the calendar export derives UIDs from it. |
| `date` | Local date. |
| `slot` | `am`, `pm` or `any`. |
| `sport` | As `activities.sport`. NULL for `rest`. Lets views separate a hybrid athlete's run and lift days. |
| `type` | The session's intent. Suggested words (free text is allowed; views colour unknown types consistently): *any sport* `easy`, `recovery`, `technique`, `test`, `mobility`, `cross`, `rest`, `other`; *endurance* `long`, `tempo`, `intervals`, `hills`, `race`; *strength* `strength`, `heavy`, `power`, `hypertrophy`; *other* `conditioning`, `skill`, `competition`. |
| `title` | Athlete-facing title, e.g. "Easy 8 km", "Squat + bench (heavy)". |
| `description` | Athlete-facing, short. Appears in the calendar and views. |
| `structure` | JSON step list (see below). Optional for simple sessions; strongly recommended for strength sessions. |
| `target_distance_m`, `target_duration_s` | Meters / seconds. Set `target_duration_s` for every non-rest session, as an estimate if it is prescribed by distance or by sets: weekly time is the volume measure views use across sports. |
| `key` | 1 for the one to three sessions that matter most this week (the long run, the heavy day, the test). Views highlight them; the rest of the week bends around them. |
| `status` | `planned`, `done`, `partial`, `skipped`, `moved`. When I move a session I change its `date` and leave it `planned`; `moved` is for sessions I deliberately keep as a record of a move. |
| `block_id` | The block this belongs to. |
| `coach_notes` | Coach working rationale; omitted from starter views and the subscribed calendar feed. Included in the athlete's full workspace export. Not a secret store. |
| `updated_at` | ISO 8601 with offset. |

**`structure`** is a compact, device-agnostic step list: `{"steps":[...], "notes":"..."}`. The UI kit's `<rc-workout>` renders it and `make_ics.py` writes it into calendar descriptions.
- An **endurance step** is `{"kind": "warmup|work|recovery|cooldown|steady|rest", "duration": {"time_s": 900} or {"distance_m": 1000} or {"open": true}, "target": {...}, "note": "..."}`.
- A **repeat** is `{"kind": "repeat", "times": 5, "steps": [...]}` (intervals, circuits, supersets: put exercise steps inside a repeat for rounds).
- An **exercise step** is `{"kind": "exercise", "name": "Back squat", "sets": 3, "reps": 5, "load": {...}, "target": {...}, "rest_s": 180, "tempo": "3-1-1", "note": "..."}`. `reps` may be a number, a range `[8, 12]` or `"AMRAP"`; a timed or distance exercise uses `"duration"` like an endurance step instead of `reps`. `load` is `{"kg": 100}`, `{"kg": [95, 102.5]}`, `{"pct_1rm": [70, 75]}` or `{"bodyweight": true}`. For different sets (a top set and back-offs), make `sets` an array: `[{"reps": 3, "load": {"kg": 140}, "target": {"rpe": 8}}, {"reps": 5, "load": {"kg": 120}, "times": 3}]`.
- **Targets** may be ranges (`[low, high]`) or single values of `pace_s_km`, `hr_bpm`, `hr_zone`, `rpe`, `rir`, `pct_1rm`, or `talk_test` (text).

Example: warm up 15 min at RPE 2 to 3, 5 x (1000 m at 235 to 245 s/km with 2 min recovery), cool down 10 min; or squat 1 × 3 @ RPE 8 then 3 × 5 at 85% of that load.

`description`, `structure.notes` and step `note`s are displayed to the athlete. Write useful session instructions, not SQL, file paths or tool bookkeeping.

## `blocks`: training blocks
`id`, `name` (e.g. "Base 1", "Strength block 2"), `start_date`, `end_date` (local dates, inclusive), `focus` (one line), `notes`. A block can span several disciplines; say in `focus` what each is doing ("Build running volume; hold strength at two sessions").

`name` and `focus` appear in Plan and should be plain-language training copy. `notes` is working memory, omitted from the starter Plan view; keep the reviewed explanation in `plan/athlete-summary.md`.

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
Primary key `(date, name, source)`. `date` is a local date. `name` e.g. `resting_hr` (bpm), `hrv` (ms; say in `unit` which measure, e.g. `ms_rmssd`), `vo2max_est` (ml/kg/min, a watch's estimate: treat as noisy), `sleep_h` (hours), `ftp_w` (cycling, watts), `css_s_100m` (swimming). `value` real, `unit` text, `source` (`screenshot`, `file`, `manual`, ...), `source_refs` JSON list of blob hashes. Body weight is not tracked by default; track it only if the athlete asks and there are no eating-related concerns (a weight-class athlete's weigh-in result is recorded on the `goal_events` row, not as a trend to manage).

## `goal_events`: dated goals
Races, meets, matches, tests, trips: anything with a date the training builds toward. Past ones with results belong here too: they anchor future targets (race times for paces, meet lifts for strength).
| Column | Meaning |
|---|---|
| `id`, `date` (local), `name` | |
| `sport` | As `activities.sport`; NULL for a multi-sport event. |
| `kind` | `race`, `meet`, `match`, `test` (a time trial, a mock meet, a fitness test), `trip`, `other`. |
| `priority` | `A`, `B`, `C`. |
| `distance_m` | Races only. |
| `goal` | JSON. Always include `text`, a short athlete-facing line ("Sub 1:45", "Finish strong", "500 kg total, 9/9 lifts"), plus structured keys that help me: `time_s`, `total_kg`, `lifts` (`{"squat":180,...}`), `place`. Add `b_text`, `c_text` for B and C goals. |
| `result` | JSON, same idea: `text` ("1:46:12, 212th"), plus `time_s`, `total_kg`, `lifts`, `place`, `source`. |
| `notes` | Athlete-facing: Calendar displays it. Internal analysis goes in working notes or the journal. |

## `gear`, `activity_gear`
`gear`: `id`, `name`, `kind` (`shoe`, `bike`, `belt`, `watch`, `other`), `started_at`, `retired_at`, `distance_offset_m` (meters already on it before tracking), `notes`. `activity_gear` (`activity_id`, `gear_id`; primary key on both) links activities to gear (many to many). Shoe mileage = `distance_offset_m` + sum of linked activities' `distance_m`.

## Migration log
| # | File | Applied | Notes |
|---|---|---|---|
| 0001 | `migrations/0001_init.sql` | {{created_date}} | Starter schema (created with the workspace). |

How to add one: write `migrations/NNNN_short_name.sql` (use `ALTER TABLE ... ADD COLUMN`, or create-copy-rename for anything bigger, and make it safe to read as documentation), apply it once with Python's `sqlite3` module (`executescript`), update the relevant section of this file, add a log line, then re-run `preview_ui`.
