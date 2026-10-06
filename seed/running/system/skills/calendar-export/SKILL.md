---
name: calendar-export
description: Maintain exports/calendar.ics from planned_workouts and races with stable identifiers, athlete-local times, readable workout steps and no private coach notes. Includes make_ics.py for subscription feeds.
---

# Calendar export

The calendar is another copy of the plan the athlete uses. Regenerate the whole subscription feed after a plan change or a direct write from a view, and keep it aligned with `planned_workouts`, `plan/current-week.md` and scheduled wakes. The script formats the plan; you choose the plan and any start times with the athlete.

## Quick start

```bash
python3 /system/skills/calendar-export/scripts/make_ics.py \
  --tz Europe/Amsterdam --check --stamp 2026-10-07T07:00:00+02:00
```

Use the athlete's IANA timezone and timestamp from the situation report, rather than the example above. Defaults read `/workspace/data/coach.db` and atomically replace `/workspace/exports/calendar.ics`; `--db` and `--out` override them. The database is opened read-only. `--check` performs minimal structural validation, not a calendar-client compatibility test.

## Procedure

1. Update the actual `planned_workouts` row and its `updated_at` timestamp. When moving a workout, keep its `id`, change `date`, and normally leave status `planned`. Status `moved` is a historical row and is excluded, as is `skipped`.
2. Confirm the timezone and agreed times. Slots `am` and `pm` default to 07:00 and 17:30; override with `--am 06:30 --pm 18:00`. Slots `any` or NULL stay all-day unless `--any-time HH:MM` supplies a time. Don't invent a precise appointment when only a day was agreed.
3. Run the script with `--check` and the situation-report timestamp in `--stamp`. Look at the event count, and spot-check a moved session, a structured session and any race. After a timezone change, check the dates around daylight-saving transitions too.
4. Keep the prose plan and scheduled wakes consistent, then describe any athlete-visible change briefly. The gateway serves the file through the athlete's secret, revocable subscription URL; do not put that URL in public notes or recreate it yourself.

## What the script exports

- Stable UIDs are `workout-<id>@opencoach` and `race-<id>@opencoach`. A date or title change must not create a new UID. Deleted, skipped and historical moved sessions disappear on the next regeneration; client polling may delay the visible change.
- Timed events carry `TZID` and a generated `VTIMEZONE`. All-day events use `VALUE=DATE` with an exclusive end date on the following day. The athlete's local date is preserved rather than shifted through UTC.
- `description`, target distance/time and recursive workout `structure.steps` become readable `DESCRIPTION` text. `structure.notes` is also exported: keep it athlete-facing. **`coach_notes` is private and never exported.** Race descriptions include distance, priority and a time goal, but not private race notes.
- Event duration uses target time first, otherwise target distance at `--assume-pace` (default 360 s/km), otherwise one hour; it has a 15-minute minimum. This sizes a calendar slot, not a training prediction. All-day events occupy one date regardless of target duration.
- `updated_at` supplies `DTSTAMP`, `LAST-MODIFIED` and the update sequence. Rows without a usable timestamp borrow the newest workout timestamp or `--stamp`; pass a valid situation-report timestamp for an empty plan. An unchanged nonempty plan generates the same bytes.
- Text is escaped, lines use CRLF and long lines fold at 75 UTF-8 octets. Never hand-edit the generated file to change the plan.

## Options and pitfalls

`--units mi` converts description distances and paces for display; database units stay meters, seconds and s/km. `--from YYYY-MM-DD --to YYYY-MM-DD` limits the inclusive date range; don't accidentally truncate the subscribed feed. Rest days are omitted unless `--include-rest`; races are included unless `--no-races`. `--alarm MIN` adds alarms only to timed events, so ask whether the athlete wants them.

If tzdata is unavailable, prefer fixing the sandbox image or correcting the IANA name. `--floating` explicitly emits local times with no timezone; a travelling athlete's calendar may interpret these in the viewer's zone. Use that fallback only with this consequence understood. Avoid appointments during a daylight-saving clock change: the script does not resolve ambiguous or nonexistent wall-clock times for you.

Empty plans still produce a valid calendar. A successful write means the feed was updated, not that Google, Apple or Outlook has polled it. For duplicate calendar entries, check stable row IDs and whether the athlete subscribed twice before changing the export.

## Evidence notes

Calendar encoding, folding, date semantics and timezone components follow RFC 5545 (normative technical specification, especially §§3.1, 3.3.11, 3.6.1 and 3.6.5). Stable identifiers and whole-feed regeneration are interoperability conventions, not coaching recommendations. Client refresh frequency varies; the script's six-hour refresh hints are advisory, not a delivery guarantee.
