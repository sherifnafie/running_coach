# UI kit 1

Coach-authored views use `/kit/1/kit.js` and `/kit/1/kit.css`. The kit installs
`window.coach` and light-DOM custom elements. Import `coach`, `h`, `format`,
`dates` or `types` from the JS module. Keep your JavaScript in an external module: inline
scripts and event handlers are blocked by the view CSP.

```html
<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>My view</title>
  <link rel="stylesheet" href="/kit/1/kit.css">
  <script type="module" src="view.js"></script>
</head><body>
  <rc-page>
    <rc-header heading="My view" subheading="A useful summary"></rc-header>
    <rc-stat id="distance" label="Distance" format="distance"></rc-stat>
  </rc-page>
</body></html>
```

```js
import { coach } from '/kit/1/kit.js';
await coach.ready;
const rows = await coach.db.query('SELECT sum(distance_m) AS value FROM activities');
document.getElementById('distance').setAttribute('value', rows[0]?.value ?? 0);
```

Declare `db:activities` in this view's `reads`. See `bridge.md` for data access
and `views.md` for manifests, preview, and publish.

## Your own components: `ui/lib/`

`/workspace/ui/lib/` holds components that belong to you. It starts with tabs, a
bottom sheet, a workout timer and a sortable table (see its
`README.md`), and you can change, add or delete anything there. It is copied
into every view when you publish, as `lib/`, so a view uses it with
`<link rel="stylesheet" href="lib/lib.css">` and
`<script type="module" src="lib/timer.js"></script>`. Published views are
immutable: republish the views that use a file after changing it. A view with
its own `lib/` folder gets that instead.

The kit defines an element only if its name isn't taken. To replace a kit
component, define your own version in `ui/lib/` and load that script before
`/kit/1/kit.js`. The kit's readable source is in `/system/docs/ui-kit-source/`.

## Components

Attributes use strings; structured data goes in JSON attributes or the named
JavaScript properties below. Add event listeners in `view.js`. Components expose
plain semantic HTML so your CSS and accessibility tools can inspect them.

| Element | Useful attributes / properties | Events / notes |
| --- | --- | --- |
| `rc-page` | Page wrapper | Responsive spacing, safe-area padding |
| `rc-header` | `heading`, `subheading`, `back`, `level` | Page heading |
| `rc-card` | `heading`, `subheading`, `tone` | Slotted ordinary children |
| `rc-button` | `variant`, `icon`, `label`, `disabled`, `loading` | `click`; visible text or `label` required |
| `rc-badge`, `rc-chip` | `tone`; chip: `selected`, `selectable`, `disabled` | Chip `change` |
| `rc-empty` | `heading`, `message`, `icon` | Place a useful next action inside |
| `rc-icon` | `name`, `size`, `label` | Decorative unless labelled |
| `rc-segmented` | `options` JSON `{value,label}[]`, `value`, `label` | `change`: `event.detail.value` |
| `rc-stat` | `label`, `value`, `unit`, `format`, `delta`, `delta-format`, `hint` | First bound row can supply `value` and `delta` |
| `rc-trend` | `values` JSON, `height`, `label`, `format`, `tone` | Sparkline with accessible summary |
| `rc-progress-ring` | `value`, `max`, `label`, `text`, `size` | Use an explicit denominator |
| `rc-list` | `.data = [{id,title,subtitle,meta,icon,badge,tone}]`, `empty`, `selectable` | `select`: `event.detail.item`; `.onselect` also supported |
| `rc-week-strip` | `start`, `selected`, `week-starts-on`, `.data` | `select-date`, `select` |
| `rc-calendar` | `mode="week|month"`, `date`, `selected`, `movable`, `.data`, `.goTo(date)` | `select`, `select-date`, `before-move`, `moved`; see below |
| `rc-chart` | `type="bar|line|area|scatter"`, `x-format`, `y-format`, `label`, `.data = [{x,y,series?}]` | Empty/error states and accessible data table |
| `rc-workout` | `structure` JSON (or `.structure`), `compact` | Renders endurance steps, repeats, exercises (sets × reps @ load), targets and notes |
| `rc-form` | `.fields = [{id,type,label,...}]`, `submit-label`, `busy` | `submit`: `event.detail.values`; `.reset()` |
| `rc-body-map` | `multi`, `readonly`, `label`, `.value`, `heat` JSON | `change`: selected body-region values |
| `rc-markdown` | `file` workspace path, `src` markdown text, `empty` | Sanitized markdown; file must be declared in `reads` |

`rc-stat`, `rc-trend`, `rc-progress-ring`, `rc-list`, `rc-week-strip`,
`rc-calendar`, `rc-chart`, and `rc-workout` accept `sql`, optional `params` JSON
array, and optional `deps` comma-separated read targets. Bound elements wait for
`coach.ready`, refresh when their targets change, and show query errors.
Queries containing `?` wait until the `params` attribute exists. A manual `.data`
assignment is useful when several components share one query.

Calendar rows should have `id`, `date` (`YYYY-MM-DD`), `type`, `title`, `status`,
and optional `source` (`planned`, `activity`, `event`). Only `planned` rows (or rows
without a source) are movable. `type` is free text: a session type (`tempo`,
`heavy`), a sport (`climb`) or an event kind (`meet`). Known words have fixed
colours and letters; any other word gets a stable colour from a hash and its
initial, so new sports need no kit change. A movable calendar uses
`write-target`, `write-key` (default `id`), `write-status` and `act-name`. Declare
the matching `update` columns and action in the manifest. The component writes
the date/status first and optionally emits the action; failures restore the
previous display. Moving a session is athlete input, not a coaching decision.

## Formatting and layout

`coach.format.distance(m)`, `.duration(seconds)`, `.pace(secondsPerKm)`,
`.weight(kg)` (kg or lb by the athlete's units; `.weightUnit()` for the label),
`.date(dateOrInstant, 'short|medium|long')` and `.relativeDay(date)` respect the
environment's locale, units, and timezone. Use `coach.env.now()` for current time
and `coach.dates.todayIn(coach.env.now().getTime(), coach.env.tz)` for today's
local date. Date-only arithmetic uses `.addDays`, `.startOfWeek`, `.monthGrid`;
never shift a training date through an instant in the browser's timezone.

`format="..."` on `rc-stat` and `y-format` on `rc-chart` accept `distance`,
`duration`, `pace`, `weight`, `number`, `integer`, `percent`, `date`, `time` and `text`.
`rc-chart` with `stacked` stacks bar `series` (e.g. weekly time by sport).

`types.label(type)` (translated), `types.glyph(type)` and `types.className(type)`
(`rc-type-…`, sets `--rc-type-c`) give a view the same labels, letters and
colours the calendar uses, for any session type or sport.

Session `structure` (see `data/schema.md`): endurance steps
`{"kind":"work","duration":{"time_s":300},"target":{"rpe":[7,8]}}`, repeats
`{"kind":"repeat","times":4,"steps":[...]}`, and exercises
`{"kind":"exercise","name":"Back squat","sets":3,"reps":5,"load":{"kg":100},"target":{"rpe":8},"rest_s":180}`
(`sets` may be an array of `{reps, load, target, times}` for top sets and back-offs;
`load` may be `{"pct_1rm":[70,75]}` or `{"bodyweight":true}`; `reps` may be a range or `"AMRAP"`).
Targets: `pace_s_km`, `hr_bpm`, `hr_zone`, `rpe`, `rir`, `pct_1rm`, `talk_test`.

Use the kit's `--rc-*` tokens (`--rc-bg`, `--rc-surface`, `--rc-text`,
`--rc-text-3`, `--rc-accent`, spacing and radii) in view CSS. Utility classes
include `rc-row`, `rc-grid`, `rc-stack`, `rc-muted`; `data-cols` selects a grid's
column count. The host applies light/dark theme and accent. Respect
`prefers-reduced-motion`. Use large tap targets, readable contrast outdoors,
semantic headings, labelled controls, and text or glyphs alongside colour.

Build one clear primary action per view. Day zero must explain what to do next;
missing measurements must remain missing rather than appearing as zero.
Provide a chat shortcut when the athlete needs judgment. Keep queries focused
and charts small. Start from the four seed views; preview both empty and real
data in both themes before publishing.

`h(tag, attributes, ...children)` constructs DOM using text nodes and attributes
without HTML interpolation. Event attributes such as `onClick: fn` install
listeners. Set structured component properties explicitly after construction.
Do not interpolate athlete text with `innerHTML`.
