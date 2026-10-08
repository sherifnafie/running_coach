// Calendar: <rc-calendar> (see index.html) does the drawing, dragging and writing.
// This script adds the layout toggle, deep links (coach.navigate('calendar', { date })), a legend built
// from the types actually in use, and a detail card that fits the sport.
import { coach, h, types } from '/kit/1/kit.js?v=0.3.7';

const t = (text) => coach.t(text);
const $ = (id) => document.getElementById(id);
const { format } = coach;
const cal = $('cal');
const DISTANCE_PACE = ['run', 'walk', 'hike'];

await coach.ready;
let selectedItem;
let renderedLocale = coach.env.locale;
coach.onEnv((env) => { if (env.locale !== renderedLocale) { renderedLocale = env.locale; coach.track(renderLegend()); if (selectedItem) coach.track(showDetail(selectedItem)); } });

// Deep link from other views: ?date=YYYY-MM-DD&mode=week arrive as coach.env.params.
const { date, mode } = coach.env.params;
if (mode === 'week' || mode === 'month') {
  cal.mode = mode;
  $('mode').value = mode;
}
if (date) {
  cal.goTo(date);
  cal.setAttribute('selected', date);
}

$('mode').addEventListener('change', (e) => {
  cal.mode = e.detail.value;
});
cal.addEventListener('select', (e) => showDetail(e.detail.item));
cal.addEventListener('select-date', () => { selectedItem = undefined; $('detail').hidden = true; });
cal.addEventListener('moved', (e) => coach.toast(`${t('Moved to')} ${format.date(e.detail.toDate, 'medium')}`));
coach.subscribe(['db:planned_workouts', 'db:activities', 'db:goal_events'], () => void renderLegend());
await renderLegend();

/** Legend: the same labels, colours and letters the calendar uses, for the types that actually appear. */
async function renderLegend() {
  const rows = await coach.db.query(
    `SELECT type, count(*) AS n FROM (
       SELECT type FROM planned_workouts WHERE type <> 'rest'
       UNION ALL SELECT sport FROM activities WHERE planned_id IS NULL
       UNION ALL SELECT coalesce(kind, 'competition') FROM goal_events)
     GROUP BY lower(type) ORDER BY n DESC LIMIT 12`,
  );
  $('key').replaceChildren(
    ...rows.map((r) => h('li', { class: types.className(r.type) }, h('span', { class: 'swatch', 'aria-hidden': 'true' }, types.glyph(r.type)), types.label(r.type))),
  );
  $('key-card').hidden = rows.length === 0;
}

/** Show the tapped item's details. Rows carry `source`: planned | activity | event. */
async function showDetail(item) {
  selectedItem = item;
  const card = $('detail');
  const when = format.date(item.date, 'long');
  let body = [];
  if (item.source === 'activity') body = await activityDetail(item.id);
  else if (item.source === 'event') body = await eventDetail(item.id);
  else {
    const w = await coach.db.one('SELECT sport, type, description, structure, status FROM planned_workouts WHERE id = ?', [item.id]);
    body = [
      w?.sport ? h('p', { class: 'rc-muted' }, [types.label(w.sport), w.type !== w.sport ? types.label(w.type) : ''].filter(Boolean).join(' · ')) : null,
      w?.description ? h('p', null, w.description) : null,
      w?.structure ? h('rc-workout', { structure: w.structure }) : null,
    ];
  }
  card.replaceChildren(
    h('div', { class: 'rc-card__head' }, h('h2', { class: 'rc-card__title' }, item.title), h('p', { class: 'rc-card__sub' }, [when, statusText(item.status)].filter(Boolean).join(' · '))),
    ...body.filter(node => node != null && node !== false),
    h('div', { class: 'detail-actions' }, h('rc-button', { variant: 'ghost', icon: 'chat', onClick: () => coach.openChat({ prefill: `${t("About this session")} (${item.title}, ${format.date(item.date, 'medium')}): `, ref: { viewId: 'calendar', params: { date: item.date } } }) }, t("Ask coach about this"))),
  );
  card.hidden = false;
}

async function activityDetail(id) {
  const [a, sets] = await Promise.all([
    coach.db.one('SELECT sport, distance_m, duration_s, avg_pace_s_km, avg_hr, rpe, feel FROM activities WHERE id = ?', [id]),
    coach.db.query(
      `SELECT exercise, count(*) AS n, max(load_kg) AS top, max(reps) AS reps FROM exercise_sets
        WHERE activity_id = ? AND is_warmup = 0 GROUP BY exercise ORDER BY min(set_index)`,
      [id],
    ),
  ]);
  if (!a) return [];
  const stat = (label, value, fmt) => h('rc-stat', { label, format: fmt, ...(value != null ? { value } : {}) });
  const stats = [];
  if (a.distance_m != null) {
    const pace = a.avg_pace_s_km ?? (DISTANCE_PACE.includes(a.sport) && a.duration_s ? a.duration_s / (a.distance_m / 1000) : null);
    stats.push(stat(t("Distance"), a.distance_m, 'distance'), stat(t("Time"), a.duration_s, 'duration'), pace != null ? stat(t("Pace"), pace, 'pace') : stat(t("Avg HR"), a.avg_hr, 'integer'));
  } else {
    stats.push(stat(t("Time"), a.duration_s, 'duration'), stat(t("Effort"), a.rpe != null ? `${format.number(a.rpe)}/10` : null, 'text'), stat(t("Sport"), types.label(a.sport), 'text'));
  }
  return [
    h('div', { class: 'rc-grid', 'data-cols': '3' }, ...stats),
    sets.length
      ? h('ul', { class: 'set-list' }, ...sets.map((s) => h('li', null, h('strong', null, s.exercise), h('span', null, `${format.number(s.n)} ${s.n === 1 ? t("set") : t("sets")}${s.top != null ? ` · ${t("top")} ${format.weight(s.top)}` : ''}`))))
      : null,
    a.feel ? h('p', null, `“${a.feel}”`) : null,
  ];
}

async function eventDetail(id) {
  const e = await coach.db.one('SELECT sport, kind, distance_m, priority, goal, result, notes FROM goal_events WHERE id = ?', [id]);
  if (!e) return [];
  const goal = coach.json(e.goal, {}) ?? {};
  const result = coach.json(e.result, {}) ?? {};
  const line = [e.kind ? types.label(e.kind) : '', e.sport ? types.label(e.sport) : '', e.distance_m ? format.distance(e.distance_m) : '', e.priority ? `${t("Priority")} ${e.priority}` : ''].filter(Boolean).join(' · ');
  return [
    line ? h('p', null, line) : null,
    goal.text || goal.time_s ? h('p', null, `${t("Goal")}: ${goal.text || format.duration(goal.time_s)}`) : null,
    result.text || result.time_s ? h('p', null, `${t("Result")}: ${result.text || format.duration(result.time_s)}`) : null,
    e.notes ? h('p', { class: 'rc-muted' }, e.notes) : null,
  ];
}

const statusText = (s) => ({ planned: t("Planned"), done: t("Done"), partial: t("Partly done"), skipped: t("Skipped"), moved: t("Moved") })[s] || s || '';
