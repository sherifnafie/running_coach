// Calendar: <rc-calendar> (see index.html) does the drawing, dragging and writing.
// This script adds the layout toggle, deep links (coach.navigate('calendar', { date })) and a detail card.
import { coach, h } from '/kit/1/kit.js';

const $ = (id) => document.getElementById(id);
const { format } = coach;
const cal = $('cal');

await coach.ready;

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
cal.addEventListener('select-date', () => ($('detail').hidden = true));
cal.addEventListener('moved', (e) => coach.toast(`Moved to ${format.date(e.detail.toDate, 'medium')}`));

// Legend: same type names, colours and letters the calendar uses.
for (const [type, label, glyph] of [['easy', 'Easy', 'E'], ['long', 'Long run', 'L'], ['tempo', 'Tempo', 'T'], ['intervals', 'Intervals', 'I'], ['hills', 'Hills', 'H'], ['race', 'Race', 'R'], ['strength', 'Strength', 'S'], ['cross', 'Cross-train', 'X']]) {
  $('key').append(h('li', { class: `rc-type-${type}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }, glyph), label));
}

/** Show the tapped item's details. Rows carry `source`: planned | activity | race. */
async function showDetail(item) {
  const card = $('detail');
  const when = format.date(item.date, 'long');
  let body = [];
  if (item.source === 'activity') {
    const a = await coach.db.one('SELECT distance_m, duration_s, avg_pace_s_km, avg_hr, rpe, feel FROM activities WHERE id = ?', [item.id]);
    body = [
      h('div', { class: 'rc-grid', 'data-cols': '3' }, h('rc-stat', { label: 'Distance', value: a?.distance_m, format: 'distance' }), h('rc-stat', { label: 'Time', value: a?.duration_s, format: 'duration' }), h('rc-stat', { label: 'Pace', value: a?.avg_pace_s_km, format: 'pace' })),
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
    h('div', { class: 'detail-actions' }, h('rc-button', { variant: 'ghost', icon: 'chat', onClick: () => coach.openChat({ prefill: `About my ${item.title} on ${format.date(item.date, 'medium')}: `, ref: { viewId: 'calendar', params: { date: item.date } } }) }, 'Ask coach about this')),
  );
  card.hidden = false;
}

const statusText = (s) => ({ planned: 'Planned', done: 'Done', partial: 'Partly done', skipped: 'Skipped', moved: 'Moved' })[s] || s;
