# Optional achievement ledger and gallery

This is a starting point you own, not a harness contract. It is deliberately
absent from the day-zero database and navigation. Read the parent skill before
using it. JSON is enough for a small personal collection; move to coach.db and
evolve the view if the athlete's needs warrant it.

## Adopt without overwriting

1. Inspect existing records, preferences and views first. If using this layout,
   copy `achievements.json` to `/workspace/data/achievements.json` **only when that
   file does not exist**. Never replace a real collection with the empty example.
2. Document this layout in `data/schema.md` and its location in `AGENTS.md`.
   Use `version: 1`, `achievements: []` and `challenges: []` at the top level.
   IDs are unique across both arrays. These arrays contain actual records only;
   the illustration below is not a starter award to copy into an athlete's
   collection.
3. If a gallery would help, copy the files in `view/` to
   `/workspace/ui/views/achievements/`, preserving any existing custom view.
   Its manifest reads only `file:data/achievements.json`; it cannot award, edit
   criteria or complete a challenge. It can open chat for discussion. It starts
   with hidden placement: add `achievements` to `ui/app.json.nav` and adjust
   placement if you want a tab, or keep it reachable by a link from Progress.
4. Translate the example's labels and prose to the athlete's language. Read
   the `ui-kit` skill, preview current/empty data and inspect the screenshots,
   then publish. Editing records later refreshes an open gallery through its
   file subscription; artwork changes require publishing its new asset bundle.

## Achievement records

| Field | Meaning |
|---|---|
| `id` | Stable ID for the accomplishment, kept when correcting text or art. |
| `title` | Short personal name. |
| `description` | What happened and why it mattered, written for the athlete. |
| `earned_on` | Actual local date `YYYY-MM-DD`, not the date it was rediscovered. |
| `basis` | Plain-language attribution, e.g. `Result you reported`. No invented verification. |
| `source_refs` | Array of actual conversation event IDs, activity/result IDs or raw hashes; use prefixes such as `activity:` when needed. |
| `challenge_id` | Optional link to an agreed challenge. |
| `symbol` | Optional short text/emoji drawn on the local medal; default is a star. |
| `tone` | Optional visual palette: `amber`, `teal` or `slate`. These aren't award ranks. |
| `image` | Optional raster asset path within this view, e.g. `assets/first-finish.png`. |

An illustrative record (use the athlete's real data and real references):

```json
{
  "id": "achievement-first-finish",
  "title": "The First Finish",
  "description": "Your first half marathon, after the months you spent getting to the start line.",
  "earned_on": "2026-10-04",
  "basis": "Result you reported",
  "source_refs": ["evt_actual_source_message"],
  "symbol": "21",
  "tone": "amber"
}
```

Working notes, diagnoses and raw conversations do not belong in this file; the
view has permission to read the whole file. Describe meaningful recognition
honestly rather than inventing a quantitative performance claim. Keep sources
in the record even though the gallery doesn't display their IDs. Record an
invalidated award's correction in your journal/history and correct the display.

## Challenge records

Use `id`, `title`, `description`, `criteria` (plain text), `status`, `source_refs`
and, once agreed, `accepted_on` (local date). Optional `period` describes the
agreed window; `change_note` explains the latest revision or pause to the
athlete. Keep prior criteria, dates, reasons and source references in a
`revisions` array or a documented linked note. Status suggestions are
`proposed`, `active`, `paused`, `completed`, `retired`; you can evolve them with
the view. Active/paused/completed records need an actual agreement. Completing
a challenge is your judgment from evidence, not a button the athlete taps.

Link an earned record through `challenge_id`; you can add `achievement_id` to
the challenge as a reciprocal pointer. Neither pointer alone proves completion.
Retiring a challenge or pausing training does not remove earned achievements.

## Artwork

`view.css` draws local, replaceable medals with text symbols. No provider, fee,
external URL or image generation is needed. The title, description and date
remain readable independently of art. The view accepts only local PNG/JPEG/WebP
paths under its own asset bundle; a failed image falls back to the local medal.
An uploaded raster, an image rendered in the workspace or `generate_image`'s
returned `workspace_path` can be copied into the view's `assets/` directory,
then previewed and published. Generated PNGs live in `exports/images/`; they
also have a private blob SHA for chat/avatar use (`image-generation` skill).
A blob SHA or authenticated gateway URL is not a view image URL. Reuse the
workspace PNG instead of generating it again. Never send private athlete data
to an image provider. A decorative requested picture without an accomplishment
stays outside the earned array.
