# Workspace conventions

Your workspace is your memory, your data and the athlete's app. The seed is a scaffold with worked examples; from the first turn everything in `/workspace` is yours to reshape. These conventions exist so that you tomorrow, or a different model next month, can pick up exactly where you left off.

## The map: `AGENTS.md`
- It begins with front-matter: a `pinned:` list of files loaded into every epoch, in order. Then a **Map** (what lives where), **Conventions**, and **Open threads** (things in flight: a pain follow-up, an unfinished intake, a promised plan review, a decision waiting on the athlete).
- Keep it true. If you move a folder, rename a table or add a convention, change `AGENTS.md` in the same turn. Never let it describe a workspace that no longer exists.
- Open threads are the cheapest continuity tool you have. Add one when you promise something; remove it when it's done.

## Pinned files
- Pinned files are loaded every epoch, up to about 12k tokens in total; past that, files are cut in list order and the situation report tells you. So pin the **few things you'd want even if you remembered nothing else**: persona, the athlete profile, the next seven days. Don't pin history, logs or long plans.
- A good profile is short, dated and specific. Compare:
  - weak: "Has had some injury problems."
  - good: "Left Achilles niggle since Aug 2026, settles after warm-up, worse after speed work; physio cleared easy running 12 Sep (details: `athlete/health.md`)."
- Condense often: merge repeats, delete what stopped being true, move detail to an unpinned file and leave a pointer. The date on each "things to remember" bullet is how you later tell what is stale.
- `plan/current-week.md` is prose for the next seven days: what, when, why, and what you've agreed with the athlete. The database has the structured version. They must agree.

## Journaling
`journal/YYYY/MM/DD.md`, one file per day you did something worth recording. For you, not the athlete: terse and honest. A useful entry has three parts: what happened (facts, numbers), what I decided and why, and what's open. Example:
```markdown
# 2026-10-07
- Tempo done (8.2 km, 5x1k @ 4:02 avg), RPE 8, "calf tight on the last two". HR avg 163.
- Decision: keep Thursday easy, drop Saturday strides until calf is quiet for 3 days. Reason: tight + RPE 8 on a fresh plan week.
- Open: ask Thursday how the calf is; if still tight, suggest physio. Athlete prefers short messages; trim next time.
```
If you disagree with something in a skill or a rule of thumb, say so here, with the reason.

## The nightly briefing
`briefing.md` is overwritten each night by consolidation: the first thing the next epoch reads after the pinned files. It's a handover: where things stand, this week's plan and changes, open threads and promises, the athlete's state, watch-outs, scheduled wakes and why, where to look for detail. Write for a reader who remembers nothing, lead with what's urgent, and stay under ~1,500 words. Never put the only copy of an important fact in the briefing: it's replaced tomorrow. Durable facts go in the profile, health notes, DB or journal.

## Data and schema evolution
- `data/schema.md` documents every table and column with units; `data/migrations/NNNN_name.sql` is the ledger of structural change. The starter schema covers activities, planned workouts, blocks, check-ins, metrics, races and gear.
- To change the schema: write the migration file, apply it once with Python's `sqlite3` (`executescript`), update `schema.md` (the relevant section and the migration log), and re-run `preview_ui` for every view that reads the changed tables: a view that queries a column you removed breaks silently until a device opens it. Prefer additive changes (`ALTER TABLE ... ADD COLUMN`, a new table) over renames. For a risky change, copy the file first (`data/coach.db` is snapshotted per modifying turn, but don't rely on that for experiments).
- Keep units SI in the DB (meters, seconds, s/km) and convert for display. Unknown is NULL, not 0. Every derived row carries `source`, `source_refs`, `extracted_by`, `confidence`, `confirmed`.
- Check yourself with `/system/skills/data-hygiene/scripts/check_db.py`.

## Versioning and undo
Your changes are committed at the end of each turn, and the athlete sees them as a readable feed ("Moved Thursday's tempo to Friday"). So prefer purposeful edits, and avoid churn (rewriting a file with trivial changes). Use `git log -p -- <file>` and `git diff` to see how something got to be the way it is; there's no need to run `git commit` yourself. Don't rewrite history. If the athlete reverts a view, you'll get a `user.view_reverted` event; if a person edits files by hand, `workspace.external_change`. Both mean: read what changed, assume it was deliberate, and adjust your notes.

## Your own skills and helper profiles
- When you repeat a procedure three times, write it down in `skills/<name>/SKILL.md` (Agent Skills format: front-matter `name` and `description`, then the body). Good candidates are things that are specific to this athlete: how their screenshots look, how they like a weekly review, their race-day routine. The description should say what it's for and when to use it, because the index only shows that.
- Add or tune helper profiles in `agents/` (front-matter: `name`, `description`, `tier`, `tools`, `write_scope`, `effort`).
- First-party skills in `/system/skills` are read-only and updated with releases. If you want to change one, copy it into `skills/` and edit your copy; leave a note about why.

## Privacy
- Everything about this athlete is health data. Keep sensitive facts in `athlete/health.md`, not in the journal's headlines or the pinned profile beyond what's needed. Don't copy it into helper tasks beyond what the task needs, and never into web searches.
- If the athlete deletes a message or asks you to forget something, remove it from your notes too (history remains tombstoned by the harness). Tell them what you removed.

## `feedback-to-harness.md`
A running list of dated notes for the developers: a tool that behaved oddly, a limit that hurt, something in the constitution or a skill that didn't fit this athlete. Describe the pattern, not the person. The developers read it only if the athlete opted in.

## Exports
`exports/calendar.ics` is subscribed to by the athlete's calendar app. Regenerate it after any plan change using `/system/skills/calendar-export/scripts/make_ics.py`. Anything else in `exports/` (charts, PDFs) may be served to the athlete; never put private notes there.
