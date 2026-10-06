---
name: file-import
description: Parse FIT, GPX, TCX, CSV and ZIP exports (including Samsung Health's personal-data export) into activity rows with provenance, using bundled scripts. Covers timezones, cross-source dedupe, units and raw-to-derived links.
---

# File import

Files are richer than screenshots and exact, but they have their own traps: timezones, pauses, duplicates across sources, and format quirks. The scripts in `scripts/` do the parsing and print normalized JSON; you do the judgment. They never invent: missing means `null`.

## Quick start
```bash
S=/system/skills/file-import/scripts
python3 $S/fit_to_json.py /raw/<sha>.fit --tz <athlete IANA tz>        # Garmin, Coros, Polar, Wahoo...
python3 $S/gpx_to_json.py /raw/<sha>.gpx --tz <athlete IANA tz>        # Strava/Garmin exports, route apps
python3 $S/tcx_to_json.py /raw/<sha>.tcx --tz <athlete IANA tz>
python3 $S/samsung_export.py /raw/<sha>.zip --list --since 2026-08-01  # then without --list for JSON
```
Add `--records --every 10` to include sampled per-point data. All print `{"format", "activities": [...], "warnings": [...]}`. Activity keys line up with the `activities` table (`started_at`, `started_at_utc`, `sport`, `distance_m`, `duration_s` (elapsed), `moving_s`, `elev_gain_m`, `avg_hr`, `max_hr`, `avg_cadence_spm`, `avg_pace_s_km`, `laps`, `extra`). **Read `warnings` every time.** Libraries: `fitdecode` and `gpxpy` may be installed (the sandbox image has them) but the scripts fall back to the standard library, and say when they do.

Raw files live in `/raw` (read-only, named by sha256). Never edit one; derive from it and record the hash in `source_refs`.

## Procedure
1. **Identify** the file (extension, and `file`/`head` if unsure; `.fit.gz` and `.tcx.gz` need `gunzip -c`). For a zip, list before extracting: `python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(sum(i.file_size for i in z.infolist())//2**20,'MB'); print(*z.namelist()[:50],sep='\n')" file.zip`. Extract only what you need into `/tmp/<dir>`, never into the workspace.
2. **Run the script**, read the warnings, and sanity check: does the sport match what the athlete said? Is the pace plausible for them? Does the distance agree with their message?
3. **Dedupe** against what's already there (`check_db.py --candidate`; see below).
4. **Insert** with provenance: `source: file`, `source_refs: ["<sha256>"]`, `extracted_by` = script name plus your model id (e.g. `fit_to_json.py/claude-sonnet-5-5`), `confidence` ~0.95 for a clean parse (lower if the script warned), `confirmed: 0` unless the athlete confirmed something uncertain. Put what's useful and non-core in `extra` (device, decoder, elevation basis).
5. **Link and ask.** Match `planned_id` when it's clear. Then ask for RPE and how it felt; files don't carry that.

## Format notes
- **FIT** (binary, from watches and bike computers). Messages: `file_id`, `session` (summary), `lap`, `record` (per-sample), `activity`. Timestamps are UTC. Positions are semicircles (degrees = value × 180 / 2^31). `enhanced_speed` and `enhanced_altitude` supersede `speed` and `altitude`. Running cadence is one foot: steps per minute is twice the value. `activity.local_timestamp − timestamp` gives the device's local offset (the script uses it). Smart recording means samples are not 1 Hz: never assume uniform spacing. Pauses make timer time shorter than elapsed time. **Developer fields** (running power from a pod, Connect IQ apps) appear only with `fitdecode`; the built-in decoder skips them. Indoor and treadmill runs have no GPS; their distance comes from a footpod or the watch's estimate and is less reliable (the script flags this). Invalid values (all-ones) become `null`.
- **GPX** (XML). `trkpt` with lat, lon, `ele`, `time`; heart rate and cadence live in Garmin `TrackPointExtension` (`hr`, `cad`). Distance isn't stored: it is computed from GPS points (typically within about 0.5 to 2% of a watch's number). A GPX with no times is a *route*, not an activity: the script says so. Elevation is noisy; gain depends on smoothing (the script uses a 3 m hysteresis, adjustable), so it won't match Strava or Garmin exactly. Times are UTC.
- **TCX** (XML). `Lap` elements carry total time, distance, average and max HR; trackpoints carry time, position, altitude, cumulative distance, HR and cadence. The activity `Id` is the UTC start. `RunCadence` is one foot.
- **CSV / spreadsheets.** Read the head with pandas (`pd.read_csv(path, nrows=5, encoding="utf-8-sig", sep=None, engine="python")` sniffs the delimiter). Check: header row position, delimiter (`;` and decimal commas in many locales), units in the column names or settings, whether datetimes carry a timezone (most don't), and elapsed vs moving time. Bulk exports the athlete downloads themselves are the legitimate source for history: Garmin Connect's activity CSV, Strava's `activities.csv` plus the `activities/` folder of FIT, GPX or TCX files. Layouts change over the years, so go by the header, not by memory. Strava's CSV dates are UTC strings; Garmin's are local without a zone. For a one-off, convert with a short script, check three rows by eye against what the athlete remembers, then bulk-insert in a transaction.

## Samsung Health export
The "Download personal data" zip (athlete-initiated; it contains *everything* Samsung Health holds: sleep, weight, location, heart rate. Tell them you will only use exercise-related tables, and that the zip stays in their raw files). Exercise sessions are in `com.samsung.shealth.exercise.<timestamp>.csv`.
- The **first line is a metadata row**, not the header. The real header is line 2.
- Columns have long prefixes, `com.samsung.health.exercise.start_time`, `...duration`, `...distance`, `...mean_heart_rate`. Rows often end with a trailing comma.
- `duration` is milliseconds; distance is meters; `mean_speed` is m/s; `calorie` is kcal; `exercise_type` is a numeric code (1002 run, 1001 walk, 11007 cycling, 13001 hiking, 14001 swimming, 0 custom).
- `start_time` strings like `2026-10-04 05:12:03.000` have been **UTC** in exports seen so far, with the athlete's local offset in `time_offset` (`UTC+0200`). That is an assumption that varies between app versions: **verify on one session the athlete remembers** ("did you start around 7:15 on Sunday?") before bulk import. The script defaults to UTC, reports its assumption, and has `--time-basis local` if the check shows otherwise.
- The same session can appear twice when a watch and a phone both recorded it (`deviceuuid`, `pkg_name` differ). Dedupe.
- Per-second HR, speed and location are in separate JSON files under `jsons/`; `--live` adds an HR summary when it can find them.
- Other tables (sleep, heart rate, steps): `samsung_export.py <zip> --table sleep --limit 20` prints clean rows. Import only what you will use (resting HR, sleep duration). Body weight: not unless the athlete asks and there are no eating-related concerns.

## Dedupe across sources
Same workout from different sources: start times within 10 to 15 minutes, distance within ~3%, duration within ~6%. Two sessions the same morning (am and pm) are not duplicates. When you merge: prefer the better source (file > screenshot > typed), fill gaps from the other without overwriting known values with null, put every hash in `source_refs`, and note the merge in `extra.merged_from`. If a hash is already in some row's `source_refs`, the upload is a repeat.

## Timezones
Files give UTC. Convert with the athlete's zone **for that date** (daylight saving: don't use today's offset), or use the file's own offset (FIT `local_timestamp`, Samsung `time_offset`) if they were travelling. Store `started_at` with the offset in force at the run. Local date and week assignment use the local time.

## Bulk backfill
For a long history: list first (`--list`), import month by month in a transaction, report counts back to the athlete ("found 43 runs from May to October; added 41, skipped 2 duplicates"), spot-check three sessions against what they remember, and ask about gaps (an injury break, a lost watch). Don't import cross-training or walks you won't use unless the load picture needs them (`training-load`).

## Pitfalls
- **Moving vs elapsed pace.** Store elapsed in `duration_s`, timer time in `moving_s`; say which basis pace uses (`extra.pace_basis`).
- **Wrist HR "cadence lock":** early in a run, optical HR can lock onto cadence (HR ≈ 160 to 180, flat). If average HR is implausibly high and flat for an easy run, say it's unreliable instead of building paces on it.
- **Treadmill distance** is often miscalibrated; trust it less than outdoor GPS.
- **Elevation** differs by source (barometer vs GPS); don't compare across sources.
- **Third-party files:** the athlete may upload a friend's file or an old one. If the date, sport or pace doesn't fit, ask.
- **Multi-sport files** (triathlon, brick sessions) have several `session` messages: the script returns each.
- **Huge or malformed files:** the scripts exit with a clear error rather than guessing; don't hand-parse unless you must, and then keep the same rules (no invented values).
- **Zip safety:** list before extracting, check total size, extract to `/tmp`.

## Evidence notes
- Wearable optical HR accuracy during running is imperfect and worse at high intensity or with arm movement (*moderate*; Gillinov et al., Med Sci Sports Exerc 2017); chest straps are better.
- Sports-watch GPS distance is usually within a few percent outdoors, worse in obstructed areas (*moderate*; validation studies, e.g. Gilgen-Ammann et al., JMIR mHealth 2020).
- Cadence lock is widely reported by device makers and users (*weak/practical*).
- FIT field definitions follow the public FIT SDK profile; the built-in decoder implements a documented subset. Citations are from memory; verify before quoting.
