---
name: ui-kit
description: Build, preview, and maintain coach-authored app views with UI kit components, declared bridge access, and useful empty states.
---

# UI kit

Use this skill when building or changing an athlete's app views. Read
`/system/docs/ui-kit.md`, `/system/docs/bridge.md`, and `/system/docs/views.md`
before editing. The seed Today, Calendar, Plan, and Progress views demonstrate
the current starter schema and component conventions.

Shared components you own (tabs, sheet, workout timer, table, and anything you add) live in `/workspace/ui/lib/`, and the kit's own source is in `/system/docs/ui-kit-source/` if you want your version of a kit component; `/system/docs/ui-kit.md` explains both.

Build under `/workspace/ui/views/<id>/`; keep `view.json` reads, writes, actions,
entry, and kit version accurate. Use external scripts and the kit assets at
`/kit/1/`. Access data only through `coach.db` and `coach.files`, and wait for
`coach.ready` before using the environment. Use `coach.env.now()` and locale /
timezone-aware formatters. Treat date-only training dates as local calendar
dates. Keep all athlete text out of `innerHTML`.

Prefer one clear primary action, readable text outdoors, large tap targets,
semantic headings, labelled controls, and text alongside colour. Support dark
mode and reduced motion. Empty states should explain the next useful step and
provide a chat shortcut. Missing measurements stay missing; never invent data
to fill a chart. Keep focused queries and small charts within the publish
performance budget.

For dense views, the kit has optional responsive grids and light section
separators (see its layout docs). Group related facts so they can be scanned;
keep long instructions and primary tasks readable. A simple view may need no
grid or cards at all. Missing optional content should be omitted, not printed
as `null` or `undefined`.

Optional detail controls are described in the kit's docs: native disclosures,
tap/keyboard info popovers, and the workspace's sheet component. They can make
long explanations, definitions and history available without crowding the
first screen. Keep actionable session instructions and important consequences
visible. Use judgment: not every view needs hidden detail or help icons.

Use text written for the athlete: training instructions, useful rationale,
assumptions and uncertainty. Do not display raw working notes, briefings,
helper drafts, SQL or file/tool bookkeeping. Keep a dedicated display source
and declare only that source in the manifest; the starter Plan view reads
`plan/athlete-summary.md`, not `plan/current.md`. Review database "notes" fields
and helper output before showing them. This also applies to new widgets.
When repairing an existing view, preserve its useful customizations, remove
the working-note read declaration, and preview and publish the corrected view.

Simple athlete actions can write directly to declared targets and emit a
declared action to wake the coach when appropriate. Use optimistic feedback
with rollback on rejection. A view must not make clinical or training decisions
on the athlete's behalf.

Run `preview_ui` on changed views, resolve static/runtime/CSP errors and critical
accessibility issues, and inspect every screenshot against current and empty
data. Preview includes phone light/dark, tablet, and empty-state renders.
Then the coach can run `publish_ui` with a clear change summary. A UI-building
helper can preview but cannot publish. After changing the database schema,
update migrations and `data/schema.md`, fix dependent views and revalidate all
affected views. Respect athlete reverts and repair the issue before republishing.
