---
name: screenshot-extraction
description: "Read workout screenshots (Samsung Health, Garmin Connect, Apple Fitness, Strava, Coros, Polar, Nike Run Club...) into trustworthy activity rows: visible fields only, unit and locale traps, merging screens, graphs, dedupe, when to confirm."
---

# Screenshot extraction

Screenshots are the main way data arrives. The standard is simple and strict: **record what is visible, nothing else**. A blank is better than a plausible guess; a wrong number poisons plans for weeks.

## Procedure
1. **Look at everything the athlete sent** (`read` each image in `/raw`, or hand batches to the `extractor` helper; see "Delegating"). Identify the app, the language, the screen type (summary, splits, HR graph, map, weekly list, watch face), and whether several images are one workout.
2. **Transcribe visible fields exactly as shown** with their units, then normalize to meters, seconds, s/km, bpm, ISO timestamps with offset. Fields to look for: date and start time, sport/activity type, distance, duration (say which: elapsed, moving, "workout time"), average pace, average and max HR, cadence, elevation gain, calories, laps or splits, HR zones, weather, shoes, the athlete's own title or notes, any "feel" emoji.
3. **Mark what you could not see** (`extra.not_visible`) and what you read off a graph (approximate). Never fill a gap from other fields unless it is arithmetic you can show (pace from time and distance, labelled as computed).
4. **Run consistency checks** (below). Disagreement lowers confidence and tells you what to ask.
5. **Dedupe** with `check_db.py --candidate`, and check whether the image hash is already in some `source_refs`.
6. **Insert with provenance:** `source: screenshot`, `source_refs` (all image hashes for this workout), `extracted_by` (your model id), a calibrated `confidence`, `confirmed: 0`.
7. **Confirm only what matters** and ask for the subjective layer (RPE, how it felt, pain) with one tap.

## Consistency checks (cheap and powerful)
- Pace × distance should equal time (within a few seconds). A mismatch usually means you misread a digit (3/8, 1/7, 5/6 are common) or mixed units.
- If splits are shown: split distances should sum to the total; split times to the duration. Last split is often partial.
- HR average between resting and max; max ≥ average.
- Is the date plausible (not in the future; matching what the athlete said)? The date *on the screen* is the workout's date, not when the screenshot was taken.
- Pace plausibility for this athlete: a run 90 seconds per km faster than anything in their history deserves a question, not a silent acceptance.

## App notes: what you will typically find
Layouts change with every app version and locale. Treat this as a list of what to look for, not what you'll see; when you learn how *this athlete's* screens look, write it in a skill of your own (`/workspace/skills/`).
- **Samsung Health** (exercise detail on phone or watch): activity type and date/time at the top; distance, duration, average pace written like `5'32"` per km, average HR, calories, sometimes cadence and elevation; further tabs or cards for pace chart, HR chart, HR zones and splits. Watch screens show less than phone screens. Locale may use decimal commas.
- **Garmin Connect:** title, date, then distance, time, pace, HR, elevation, calories; a Splits table per km or mile; Stats may list "Timer time", "Moving time" and "Elapsed time" separately; training effect, load, recovery time are Garmin-specific scores.
- **Apple Fitness / Workout summary:** workout time, distance, active and total calories, average pace, average HR, elevation, splits, HR zones. Units follow the phone's setting.
- **Strava:** distance, "Moving Time" (elapsed is hidden under details), pace, elevation, splits table, "Relative Effort" (a Strava-proprietary score).
- **Coros / Polar / Suunto:** summary cards with distance, time, pace, HR, plus their own load and effect scores (training load, cardio load, running index).
- **Nike Run Club:** distance, time, average pace, splits and a "how did it feel" emoji the athlete picked.
- **Proprietary scores** (training effect, relative effort, body battery, readiness, load, "running index") are the app's inventions, not RPE and not comparable across apps. Keep in `extra` with the app name if useful; never use them as RPE.

## Unit and locale traps
- `km` vs `mi`: tiny labels. If unsure, test: an easy pace of 5:30 reads as per km; the same effort per mile would be ~8:50. If still unsure, ask.
- Decimal commas and thousands separators (`10,4 km`; `1.234 m`). Pace (`5'32"/km`) vs speed (`10.9 km/h`). Durations over an hour as `65:20` or `1:05:20`.
- 12-hour vs 24-hour clocks and AM/PM; `04/10` could be 4 October or 10 April: use other cues (day of week, neighbouring entries) or ask. Month names in other languages.
- Elapsed vs moving time: don't mix them. `duration_s` is elapsed (if only "workout time"/"duration" is shown, store it and note `extra.duration_basis`).
- Elevation in feet; cadence `spm` (steps) vs `rpm`; calories in kJ.
- Dark mode and low contrast, cropped screenshots, screenshots of screenshots, edited images.
- **No timezone on screens.** They show local wall-clock time. Assume the athlete's timezone *for that date* (they may have been travelling) and say so only if it matters.

## Merging multiple screens
Same date, time and distance: one workout. Fill fields from the summary first, then splits, then graphs; keep all hashes in `source_refs`. If two images disagree, record the more reliable (summary over graph), lower confidence, note the conflict in `extra`. If they look like two workouts, keep two rows.

## Reading graphs
HR and pace graphs give shape, not data. Read axis labels, min/max and obvious landmarks ("HR rises from ~135 to ~160 over the run"); store as approximate in `extra` with `approx: true`. Don't extract per-point series. HR-zone bars give time or percent per zone: record them as shown, with the zone boundaries if displayed; zone definitions differ between apps and people.

## Confidence guide
- **0.9 to 1.0:** crisp, complete, checks all agree.
- **0.7 to 0.9:** minor ambiguity (a digit, a unit inferred from context), one check unverifiable.
- **0.5 to 0.7:** blurry, partial, or a check fails. Ask before relying on it.
- **Below 0.5:** don't record as fact; ask for a clearer image or the number.

## When to confirm, and how
Confirm what would change a decision: the date, the distance, the duration, whether it was a race or a treadmill run. Skip what wouldn't (cadence, calories). Keep it light and specific:
> "Got it: Thursday, 10.4 km in 55:40. Was that the treadmill or outdoors?" *(quick replies: Outdoors / Treadmill)*

With several activities, batch them in one message. After a confirmation, set `confirmed = 1` and raise `confidence`.

## Delegating to `extractor`
Use the helper for a pile (four or more images, a backfill of weeks), or when you can't see images. Run it in the background with the image paths and the athlete's timezone; it returns JSON with `fields_confidence` and `not_visible`. Always spot-check: reconcile every row against the screenshot for date, distance and duration, and run the dedupe check before inserting. The harness may route images through an extractor automatically if your model lacks vision, and will say so.

## Worked example
Three Samsung Health screenshots arrive with "tempo done, brutal". Summary: "Running", `Thu, Oct 7, 6:41 AM`, `8.20 km`, `41:12`, avg `5'01"`, avg HR 163, 612 kcal. Splits: five splits 5'00", 4'59", 5'03", 5'01", 5'02" plus a short last. HR graph: climbs from ~140 to ~172.

Checks: 5'01" × 8.20 = 41:12 ✓; splits average to ~5'01" ✓. Not visible: cadence, elevation, max HR (graph suggests ~172, approximate). Insert: `distance_m 8200, duration_s 2472, avg_pace_s_km 301.5, avg_hr 163`, `max_hr` NULL with `extra: {"hr_graph_peak_approx": 172, "not_visible": ["cadence","elev_gain","max_hr"], "app": "samsung_health", "locale": "en"}`, confidence 0.93. Then to the athlete: "Logged: 8.2 km in 41:12, avg 5:01/km, HR 163. Nice, even splits. How hard was it, 1 to 10?" with a scale form. Planned workout "Tempo" that day: set `planned_id` and status `done`.

## Pitfalls
Reading pace as per mile (or the reverse). Averaging paces instead of recomputing from totals. Trusting a "feel" emoji as RPE. Letting an app's training-effect score masquerade as load. Assuming timezone. Treating a repeated upload as a new run. Inferring zones or cadence you can't see. Asking the athlete to retype what is already on the screen. Burying a blurry digit under high confidence.

## Evidence notes
Procedural skill; no training claims. Practical note, no published error rates cited: vision models read dense small digits imperfectly, which is why the consistency checks above are the safeguard, not optional extras. Wrist-based HR shown in screenshots has known accuracy limits during running (*moderate*; e.g., Gillinov et al., Med Sci Sports Exerc 2017), so treat HR as indicative.
