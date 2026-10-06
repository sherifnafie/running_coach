---
name: ui-kit
description: Build, preview, and maintain coach-authored app views with UI kit components, declared bridge access, and useful empty states.
---

# UI kit

Use this skill when building or changing an athlete's app views. Read
`/system/docs/ui-kit.md`, `/system/docs/bridge.md`, and `/system/docs/views.md`
before editing. The seed Today, Calendar, Plan, and Progress views demonstrate
the current starter schema and component conventions.

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
