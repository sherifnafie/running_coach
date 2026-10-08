// Plan: a read-only overview of the current training block, for any sport or mix of sports. Shows the
// typical pattern of a "summary" view: a few focused queries, results handed to kit components via properties.
import { coach, h, types } from '/kit/1/kit.js?v=0.3.7';

const t = (text) => coach.t(text);
const $ = (id) => document.getElementById(id);
const { format, dates } = coach;

await coach.ready;
let renderedLocale = coach.env.locale;
coach.onEnv((env) => { if (env.locale !== renderedLocale) { renderedLocale = env.locale; coach.track(refresh()); } });
const today = dates.todayIn(coach.env.now().getTime(), coach.env.tz);
coach.subscribe(['db:blocks', 'db:planned_workouts', 'db:goal_events'], refresh);
$('start-chat').onclick = () => coach.openChat({ prefill: t("Hi coach! Can you build my plan?") });
$('discuss').onclick = () => coach.openChat({ prefill: t("I have a question about my plan: "), ref: { viewId: 'plan' } });
await refresh();

async function refresh() {
  const [blocks, any] = await Promise.all([
    coach.db.query('SELECT id, name, start_date, end_date, focus FROM blocks ORDER BY start_date'),
    coach.db.one('SELECT count(*) AS n FROM planned_workouts'),
  ]);
  const empty = blocks.length === 0 && !any?.n;
  $('onboarding').hidden = !empty;
  $('content').hidden = empty;
  if (empty) return;

  // The block we are in, else the next one, else the most recent.
  const block = blocks.find((b) => b.start_date <= today && today <= b.end_date) ?? blocks.find((b) => b.start_date > today) ?? blocks[blocks.length - 1];
  renderBlock(block, blocks);

  // Everything below is scoped to the block's dates, or the next 8 weeks without a block. Weeks are Monday-based.
  const from = block ? block.start_date : dates.startOfWeek(today, 1);
  const to = block ? block.end_date : dates.addDays(from, 8 * 7 - 1);
  const [rows, keys, event] = await Promise.all([
    coach.db.query(
      `SELECT date(date, '-6 days', 'weekday 1') AS week, coalesce(sport, type) AS sport, count(*) AS sessions,
              sum(coalesce(target_duration_s, 0)) AS secs, sum(coalesce(target_distance_m, 0)) AS dist, sum(key) AS keys
         FROM planned_workouts WHERE date BETWEEN ? AND ? AND type <> 'rest' AND status <> 'skipped'
        GROUP BY week, coalesce(sport, type) ORDER BY week`,
      [from, to],
    ),
    coach.db.query(
      `SELECT id, date, sport, type, title, target_distance_m, target_duration_s FROM planned_workouts
        WHERE date BETWEEN ? AND ? AND date >= ? AND key = 1 AND status IN ('planned', 'moved') ORDER BY date LIMIT 8`,
      [from, to, today],
    ),
    coach.db.one(`SELECT name, date, sport, kind, distance_m, priority, goal FROM goal_events WHERE date >= ?
                   ORDER BY CASE priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, date LIMIT 1`, [today]),
  ]);
  renderVolume(rows);
  renderKeySessions(keys);
  renderEvent(event);
}

function renderBlock(block, blocks) {
  $('block-card').hidden = !block;
  if (!block) return;
  $('block-name').textContent = block.name;
  $('block-dates').textContent = `${format.date(block.start_date, 'short')} – ${format.date(block.end_date, 'short')}`;
  $('block-focus').textContent = block.focus ?? '';
  const total = Math.ceil((dates.diffDays(block.start_date, block.end_date) + 1) / 7);
  const week = Math.min(total, Math.max(0, Math.floor(dates.diffDays(block.start_date, today) / 7) + 1));
  const ring = $('block-ring');
  ring.setAttribute('max', total);
  ring.setAttribute('value', week);
  ring.setAttribute('text', week > 0 ? `${week}/${total}` : `${total}`);

  // Phases: proportional bar (decorative) + list (the accessible version).
  $('phase-bar').replaceChildren(
    ...blocks.map((b) => h('span', { class: b.end_date < today ? 'past' : b.id === block.id && b.start_date <= today ? 'now' : '', style: `flex-grow:${dates.diffDays(b.start_date, b.end_date) + 1}` })),
  );
  $('phases').data = blocks.map((b) => ({
    title: b.name,
    subtitle: `${format.date(b.start_date, 'short')} – ${format.date(b.end_date, 'short')}${b.focus ? ` · ${b.focus}` : ''}`,
    badge: b.id === block.id && b.start_date <= today && today <= b.end_date ? t("Now") : b.end_date < today ? t("Done") : '',
    tone: b.id === block.id ? 'accent' : 'default',
  }));
}

/** Rows are (week, sport): the chart stacks sports, the table sums each week. */
function renderVolume(rows) {
  // Time is the cross-sport measure. A plan written only in distances (older plans, some runners) falls back
  // to distance rather than showing an empty chart; the coach should add target_duration_s.
  const byDistance = rows.every((r) => !r.secs) && rows.some((r) => r.dist > 0);
  const chart = $('volume');
  chart.setAttribute('y-format', byDistance ? 'distance' : 'duration');
  chart.setAttribute('label', byDistance ? t("Planned distance per week") : t("Planned training time per week"));
  chart.data = rows.map((r) => ({ x: r.week, y: byDistance ? r.dist : r.secs, series: types.label(r.sport) }));
  const weeks = new Map();
  for (const r of rows) {
    const w = weeks.get(r.week) ?? { week: r.week, secs: 0, dist: 0, sessions: 0, keys: 0 };
    w.secs += r.secs; w.dist += r.dist; w.sessions += r.sessions; w.keys += r.keys ?? 0;
    weeks.set(r.week, w);
  }
  const list = [...weeks.values()];
  const showDistance = list.some((w) => w.dist > 0); // only when something is prescribed by distance
  const thisWeek = dates.startOfWeek(today, 1);
  const cols = [t("Week of"), t("Time"), t("Sessions"), t("Key"), ...(showDistance ? [t("Distance")] : [])];
  $('weeks').replaceChildren(
    h('caption', null, t("Planned training by week")),
    h('thead', null, h('tr', null, ...cols.map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', null, ...list.map((w) => h('tr', { class: w.week === thisWeek ? 'is-current' : '' },
      h('th', { scope: 'row' }, format.date(w.week, 'short')),
      h('td', null, w.secs ? format.duration(w.secs, 'short') : '–'),
      h('td', null, String(w.sessions)),
      h('td', null, w.keys ? String(w.keys) : '–'),
      ...(showDistance ? [h('td', null, w.dist ? format.distance(w.dist) : '–')] : []),
    ))),
  );
}

function renderKeySessions(keys) {
  $('key-card').hidden = keys.length === 0;
  const list = $('key-sessions');
  list.data = keys.map((k) => ({
    id: k.id, date: k.date, icon: 'flag', title: k.title,
    subtitle: [format.date(k.date, 'medium'), types.label(k.sport || k.type)].join(' · '),
    meta: k.target_distance_m ? format.distance(k.target_distance_m) : k.target_duration_s ? format.duration(k.target_duration_s, 'short') : '',
  }));
  list.onselect = (e) => coach.navigate('calendar', { date: e.detail.item.date });
}

function renderEvent(e) {
  $('event-card').hidden = !e;
  if (!e) return;
  const weeksToGo = Math.max(0, Math.round(dates.diffDays(today, e.date) / 7));
  const goal = coach.json(e.goal, {}) ?? {};
  const goalText = goal.text || (goal.time_s ? format.duration(goal.time_s) : '');
  $('event').replaceChildren(
    h('p', { class: 'event-name' }, e.name),
    h('p', { class: 'rc-muted' }, [format.date(e.date, 'long'), e.kind ? types.label(e.kind) : '', e.sport ? types.label(e.sport) : '', e.distance_m ? format.distance(e.distance_m) : '', e.priority ? `${t("Priority")} ${e.priority}` : ''].filter(Boolean).join(' · ')),
    h('p', null, [weeksToGo === 0 ? t("This week") : `${weeksToGo} ${weeksToGo === 1 ? t("week to go") : t("weeks to go")}`, goalText ? `${t("Goal")}: ${goalText}` : ''].filter(Boolean).join(' · ')),
  );
}
