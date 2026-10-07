// Calendar: <rc-calendar> (see index.html) does the drawing, dragging and writing.
// This script adds the layout toggle, deep links (coach.navigate('calendar', { date })) and a detail card.
import { coach, h } from '/kit/1/kit.js';

const t = (text) => coach.t(text);
const $ = (id) => document.getElementById(id);
const { format } = coach;
const cal = $('cal');

await coach.ready;
let renderedLocale = coach.env.locale;
coach.onEnv((env) => { if (env.locale !== renderedLocale) { renderedLocale = env.locale; renderLegend(); if (selectedItem) coach.track(showDetail(selectedItem)); } });

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

// Legend: same type names, colours and letters the calendar uses.
let selectedItem;
renderLegend();
function renderLegend() {
  $('key').replaceChildren();
  for (const [type, label, glyph] of [['easy', t("Easy"), 'E'], ['long', t("Long run"), 'L'], ['tempo', t("Tempo"), 'T'], ['intervals', t("Intervals"), 'I'], ['hills', t("Hills"), 'H'], ['race', t("Race"), 'R'], ['strength', t("Strength"), 'S'], ['cross', t("Cross-train"), 'X']]) {
    $('key').append(h('li', { class: `rc-type-${type}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }, glyph), label));
  }
}

/** Show the tapped item's details. Rows carry `source`: planned | activity | race. */
async function showDetail(item) {
  selectedItem = item;
  const card = $('detail');
  const when = format.date(item.date, 'long');
  let body = [];
  if (item.source === 'activity') {
    const a = await coach.db.one('SELECT distance_m, duration_s, avg_pace_s_km, avg_hr, rpe, feel FROM activities WHERE id = ?', [item.id]);
    body = [
      h('div', { class: 'rc-grid', 'data-cols': '3' }, h('rc-stat', { label: t("Distance"), value: a?.distance_m, format: 'distance' }), h('rc-stat', { label: t("Time"), value: a?.duration_s, format: 'duration' }), h('rc-stat', { label: t("Pace"), value: a?.avg_pace_s_km, format: 'pace' })),
      a?.feel ? h('p', null, `“${a.feel}”`) : null,
    ];
  } else if (item.source === 'race') {
    const r = await coach.db.one('SELECT distance_m, priority, notes FROM races WHERE id = ?', [item.id]);
    body = [h('p', null, [r?.distance_m ? format.distance(r.distance_m) : '', r?.priority ? `${r.priority} race` : ''].filter(Boolean).join(' · ')), r?.notes ? h('p', { class: 'rc-muted' }, r.notes) : null];
  } else {
    const w = await coach.db.one('SELECT description, structure, status FROM planned_workouts WHERE id = ?', [item.id]);
    body = [w?.description ? h('p', null, w.description) : null, w?.structure ? h('rc-workout', { structure: w.structure }) : null];
  }
  card.replaceChildren(
    h('div', { class: 'rc-card__head' }, h('h2', { class: 'rc-card__title' }, item.title), h('p', { class: 'rc-card__sub' }, `${when} · ${statusText(item.status)}`)),
    ...body,
    h('div', { class: 'detail-actions' }, h('rc-button', { variant: 'ghost', icon: 'chat', onClick: () => coach.openChat({ prefill: `About my ${item.title} on ${format.date(item.date, 'medium')}: `, ref: { viewId: 'calendar', params: { date: item.date } } }) }, t("Ask coach about this"))),
  );
  card.hidden = false;
}

const statusText = (s) => ({ planned: t("Planned"), done: t("Done"), partial: t("Partly done"), skipped: t("Skipped"), moved: t("Moved") })[s] || s;
