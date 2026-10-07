// Plan: a read-only overview of the current training block. Shows the typical pattern of a
// "summary" view: a few focused queries, results handed to kit components via properties.
import { coach, h } from '/kit/1/kit.js';

const t = (text) => coach.t(text);
const $ = (id) => document.getElementById(id);
const { format, dates } = coach;

await coach.ready;
let renderedLocale = coach.env.locale;
coach.onEnv((env) => { if (env.locale !== renderedLocale) { renderedLocale = env.locale; coach.track(refresh()); } });
const today = dates.todayIn(coach.env.now().getTime(), coach.env.tz);
coach.subscribe(['db:blocks', 'db:planned_workouts', 'db:races'], refresh);
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

  // Everything below is scoped to the block's dates, or the next 8 weeks without a block.
  const from = block ? block.start_date : dates.startOfWeek(today, coach.env.weekStartsOn);
  const to = block ? block.end_date : dates.addDays(from, 8 * 7 - 1);
  const [weeks, keys, race] = await Promise.all([
    coach.db.query(
      `SELECT date(date, '-6 days', 'weekday 1') AS week, coalesce(sum(target_distance_m), 0) AS dist, count(*) AS sessions,
              max(CASE WHEN type = 'long' THEN target_distance_m END) AS longest
         FROM planned_workouts WHERE date BETWEEN ? AND ? AND type <> 'rest' GROUP BY week ORDER BY week`,
      [from, to],
    ),
    coach.db.query(
      `SELECT id, date, type, title, target_distance_m FROM planned_workouts
        WHERE date BETWEEN ? AND ? AND date >= ? AND type IN ('long', 'tempo', 'intervals', 'hills', 'race') ORDER BY date LIMIT 8`,
      [from, to, today],
    ),
    coach.db.one(`SELECT name, date, distance_m, priority, goal FROM races WHERE date >= ?
                   ORDER BY CASE priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, date LIMIT 1`, [today]),
  ]);
  renderVolume(weeks);
  renderKeySessions(keys);
  renderRace(race);
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

function renderVolume(weeks) {
  $('volume').data = weeks.map((w) => ({ x: w.week, y: w.dist }));
  const thisWeek = dates.startOfWeek(today, 1);
  $('weeks').replaceChildren(
    h('caption', null, t("Planned volume by week")),
    h('thead', null, h('tr', null, ...[t("Week of"), t("Distance"), t("Runs"), t("Longest")].map((c) => h('th', { scope: 'col' }, c)))),
    h('tbody', null, ...weeks.map((w) => h('tr', { class: w.week === thisWeek ? 'is-current' : '' }, h('th', { scope: 'row' }, format.date(w.week, 'short')), h('td', null, format.distance(w.dist)), h('td', null, String(w.sessions)), h('td', null, w.longest ? format.distance(w.longest) : '–')))),
  );
}

function renderKeySessions(keys) {
  $('key-card').hidden = keys.length === 0;
  const list = $('key-sessions');
  list.data = keys.map((k) => ({ id: k.id, date: k.date, icon: 'flag', title: k.title, subtitle: format.date(k.date, 'medium'), meta: k.target_distance_m ? format.distance(k.target_distance_m) : '' }));
  list.onselect = (e) => coach.navigate('calendar', { date: e.detail.item.date });
}

function renderRace(race) {
  $('race-card').hidden = !race;
  if (!race) return;
  const weeksToGo = Math.max(0, Math.round(dates.diffDays(today, race.date) / 7));
  const goal = coach.json(race.goal, {});
  $('race').replaceChildren(
    h('p', { class: 'race-name' }, race.name),
    h('p', { class: 'rc-muted' }, [format.date(race.date, 'long'), race.distance_m ? format.distance(race.distance_m) : '', race.priority ? `${race.priority} race` : ''].filter(Boolean).join(' · ')),
    h('p', null, `${weeksToGo === 0 ? t("Race week") : `${weeksToGo} ${weeksToGo === 1 ? 'week' : t("weeks")} to go`}${goal?.time_s ? ` · goal ${format.duration(goal.time_s)}` : ''}`),
  );
}
