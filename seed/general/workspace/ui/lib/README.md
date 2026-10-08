# ui/lib: your shared components

Starter code for the athlete's app. It is yours: change it, extend it, delete what you don't use, or replace it entirely.

- Everything here is copied into every view when you publish, as `lib/`. A view uses it with `<link rel="stylesheet" href="lib/lib.css">` and `<script type="module" src="lib/tabs.js"></script>` (or `import './lib/timer.js'` in `view.js`). A view with its own `lib/` folder gets that instead.
- Published views are immutable, so after you change a file here, republish the views that use it.
- Plain modules with no build step, styled with the kit's design tokens (`--rc-*`, see `/system/docs/ui-kit.md`) so they follow the athlete's theme, dark mode and accent.
- The kit (`/kit/1/kit.js`) only defines an element if that name isn't taken yet. To replace a kit component (say `rc-card`), define your own here and load its script before `kit.js` in `index.html`. The kit's readable source is in `/system/docs/ui-kit-source/` if you want to start from it.

What's here:
| File | Gives you |
|---|---|
| `lib.css` | Styles for native `<details>` (expandable sections), `<input type="range">`, a `.switch` checkbox, and the components below. |
| `tabs.js` | `<rc-tabs>` with `<rc-tab label="…">` panels: keyboard-accessible tabs. |
| `sheet.js` | `<rc-sheet heading="…">`: a bottom sheet (native `<dialog>`). Open it with `sheet.show()` or a button with `data-open-sheet="sheet-id"`. |
| `timer.js` | `<rc-timer>`: stopwatch, countdown (`seconds="90"`) or intervals (`steps='[{"label":"Run","seconds":180},{"label":"Walk","seconds":60}]'`, `rounds="5"`), with beeps, vibration where allowed, and `timer-step` / `timer-done` events. |
| `table.js` | `<rc-table>`: a sortable table from `columns` and `rows` properties. |
