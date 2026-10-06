# Building and publishing views

Views live in `/workspace/ui/views/<id>/`. Each directory contains `view.json`,
an entry HTML file, and local CSS/JS/assets. The coach owns these source files.
The harness serves immutable published copies on a dedicated origin and embeds
them with `sandbox="allow-scripts"`; same-origin access and navigation/popups
are unavailable. Chat, settings, history/revert, and export remain reachable.

```json
{
  "id": "today", "title": "Today", "icon": "today",
  "placement": {"nav": 0}, "entry": "index.html", "kit": "1",
  "reads": ["db:planned_workouts"],
  "writes": [{"db": "planned_workouts", "ops": ["update"], "columns": ["status"]}],
  "actions": ["workout_done"], "refresh": "on-change"
}
```

IDs are lowercase letters/digits/dashes, at most 32 characters, and must match
the directory name. `placement` is `{nav:number}`, `{home_card:number}`, or
`{hidden:true}`. `params` declares deep-link parameters (`string`, `date`,
`number`). An optional `card:{entry,height:'s|m|l'}` declares a compact entry.
File read targets are relative globs. File writes are restricted to declared
`athlete-input/` targets. DB writes must declare operations and any restricted
columns. Keep declarations limited to the data the view needs.

`ui/app.json` defines `{version:1, nav:['today',...], home:'today',
theme:{accent:'#2563eb'}}`. Navigation IDs must exist and be unique. The shell
keeps chat accessible even when the coach reorganizes navigation.

## Preview workflow

1. Read `/system/docs/ui-kit.md` and `/system/docs/bridge.md`. Start from a seed
   view and check `/workspace/data/schema.md` against the actual schema.
2. Edit the manifest and external HTML/CSS/JS files. Load kit assets from
   `/kit/1/`. Avoid inline scripts/handlers and all external URLs.
3. Run `preview_ui({views:['today']})`. Static checks validate manifests,
   references, kit version, reads/writes and bundle size. Chromium runs the view
   at phone light/dark, tablet light, and empty-state sizes using the real
   bridge permissions and an empty database with the same schema.
4. Resolve every runtime/CSP/static error and critical accessibility violation.
   The first render must stay below 1.5 s at 4× CPU throttling; the view bundle
   must stay at or below 500 KB excluding the kit. Serious accessibility issues
   are warnings, but should be fixed when practical.
5. Inspect every returned screenshot: text wrapping, tap targets, dark mode,
   empty states, chart labels, and scrolling. A green automated gate alone does
   not establish that a layout is useful.
6. Run `publish_ui({views:['today'], summary:'...what changed...'})`. Publishing
   reruns the gates and atomically swaps versions. Describe the athlete-facing
   change in the summary. Helpers may build and preview; the coach publishes.

After a database migration, update `data/schema.md`, fix dependent views and
revalidate them. On errors the client can return to the previous version and
reports `ui.error` to the coach. The athlete can also revert from view history;
respect that choice and fix the underlying issue before proposing another
version.

## Isolation

The view CSP restricts scripts/styles/images/fonts to local assets and the kit;
`connect-src 'none'` prevents network requests. The host checks bridge source
windows and validates schema/methods. Gateway queries use a read-only connection
and verify real table access before execution. Modules and fonts require the
views origin's `Access-Control-Allow-Origin: *` because the sandbox has an
opaque origin. These limits are harness guarantees, not conventions a view may
override.
