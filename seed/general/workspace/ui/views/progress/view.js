// Progress: training over the chosen range, for any sport or mix of sports. A few aggregate queries;
// the components get their rows from here. Sections for distance sports and lifting only appear when
// the athlete has that kind of data.
import { coach, types } from '/kit/1/kit.js?v=0.3.7';

const t = (text) => coach.t(text);
const $ = (id) => document.getElementById(id);
const { format, dates } = coach;

await coach.ready;
let renderedLocale = coach.env.locale;
coach.onEnv((env) => { if (env.locale !== renderedLocale) { renderedLocale = env.locale; coach.track(refresh()); } });
const today = dates.todayIn(coach.env.now().getTime(), coach.env.tz);
const thisWeek = dates.startOfWeek(today, 1); // weeks are Monday-based, matching the SQL
const lastWeek = dates.addDays(thisWeek, -7);

$('range').addEventListener('change', () => void refresh());
coach.subscribe(['db:activities', 'db:planned_workouts', 'db:goal_events', 'db:exercise_sets'], () => void refresh());
await refresh();

async function refresh() {
  const weeks = Number($('range').value) || 12;
  const since = dates.addDays(thisWeek, -7 * (weeks - 1)); // first Monday shown
  const WEEK = (col) => `date(substr(${col}, 1, 10), '-6 days', 'weekday 1')`;
  const [totals, bySport, plan, lifts, e1rm, results] = await Promise.all([
    coach.db.one('SELECT (SELECT count(*) FROM activities) AS sessions, (SELECT count(*) FROM goal_events) AS events'),
    coach.db.query(
      `SELECT ${WEEK('started_at')} AS week, sport, count(*) AS n, sum(coalesce(duration_s, 0)) AS secs,
              sum(coalesce(distance_m, 0)) AS dist, max(distance_m) AS longest
         FROM activities WHERE substr(started_at, 1, 10) >= ? AND substr(started_at, 1, 10) <= ?
        GROUP BY week, sport ORDER BY week`,
      [since < lastWeek ? since : lastWeek, today], // last week too, for the "vs last week" delta
    ),
    coach.db.query(
      `SELECT status, count(*) AS n FROM planned_workouts
        WHERE date >= ? AND date < ? AND type <> 'rest' GROUP BY status`,
      [since, today],
    ),
    coach.db.query(
      `SELECT exercise, count(*) AS sets, max(load_kg) AS top_load,
              max(CASE WHEN reps BETWEEN 1 AND 10 AND load_kg IS NOT NULL
                       THEN CASE WHEN reps = 1 THEN load_kg ELSE load_kg * (1 + reps / 30.0) END END) AS best
         FROM exercise_sets WHERE is_warmup = 0 AND substr(performed_at, 1, 10) >= ? AND substr(performed_at, 1, 10) <= ?
        GROUP BY exercise ORDER BY sets DESC LIMIT 5`,
      [since, today],
    ),
    coach.db.query(
      `SELECT exercise, ${WEEK('performed_at')} AS week,
              max(CASE WHEN reps = 1 THEN load_kg ELSE load_kg * (1 + reps / 30.0) END) AS e1rm
         FROM exercise_sets WHERE is_warmup = 0 AND load_kg IS NOT NULL AND reps BETWEEN 1 AND 10
          AND substr(performed_at, 1, 10) >= ? AND substr(performed_at, 1, 10) <= ?
        GROUP BY exercise, week ORDER BY week`,
      [since, today],
    ),
    coach.db.query(`SELECT name, date, sport, kind, distance_m, result FROM goal_events WHERE result IS NOT NULL ORDER BY date DESC LIMIT 5`),
  ]);

  // Day zero: friendly empty state instead of a wall of empty charts.
  const empty = !totals || (totals.sessions === 0 && totals.events === 0);
  $('onboarding').hidden = !empty;
  $('content').hidden = empty;
  if (empty) return;

  const shown = bySport.filter((r) => r.week >= since);
  const mondays = dates.range(since, thisWeek).filter((d) => dates.weekday(d) === 1);
  renderTime(shown, bySport, mondays);
  renderDistance(shown, mondays);
  renderPlanDone(plan);
  renderStrength(lifts, e1rm);
  renderConsistency(shown, mondays);
  renderResults(results);
}

/** Stacked weekly bars. Weeks without training still get a (zero) slot so gaps stay visible. */
function stacked(rows, mondays, value) {
  const data = rows.filter((r) => value(r) > 0).map((r) => ({ x: r.week, y: value(r), series: types.label(r.sport) }));
  const first = data[0]?.series;
  if (first) for (const m of mondays) if (!data.some((d) => d.x === m)) data.push({ x: m, y: 0, series: first });
  return data.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
}

function renderTime(shown, all, mondays) {
  $('time').data = stacked(shown, mondays, (r) => r.secs);
  const sum = (week) => all.filter((r) => r.week === week).reduce((n, r) => n + r.secs, 0);
  const now = sum(thisWeek);
  const s = $('s-week');
  s.setAttribute('value', now);
  s.setAttribute('delta', now - sum(lastWeek));
  $('s-sessions').setAttribute('value', shown.reduce((n, r) => n + r.n, 0));
}

function renderDistance(shown, mondays) {
  const data = stacked(shown, mondays, (r) => r.dist);
  $('distance-card').hidden = data.every((d) => !d.y);
  $('distance').data = data;
  const longest = Math.max(0, ...shown.map((r) => r.longest ?? 0));
  if (longest > 0) $('s-longest').setAttribute('value', longest);
}

function renderPlanDone(plan) {
  const count = (s) => plan.find((p) => p.status === s)?.n ?? 0;
  const resolved = count('done') + count('partial') + count('skipped') + count('planned');
  const el = $('s-done');
  if (resolved === 0) return el.setAttribute('value', '–');
  el.setAttribute('format', 'percent');
  el.setAttribute('value', Math.round(((count('done') + count('partial')) / resolved) * 100));
}

function renderStrength(lifts, e1rm) {
  $('strength-card').hidden = lifts.length === 0;
  if (lifts.length === 0) return;
  const top = lifts.slice(0, 3).map((l) => l.exercise);
  $('e1rm').data = e1rm.filter((r) => top.includes(r.exercise)).map((r) => ({ x: r.week, y: Math.round(r.e1rm * 10) / 10, series: r.exercise }));
  $('lifts').data = lifts.map((l) => ({
    icon: 'progress',
    title: l.exercise,
    subtitle: [`${format.number(l.sets)} ${l.sets === 1 ? t("set") : t("sets")}`, l.top_load != null ? `${t("top")} ${format.weight(l.top_load)}` : ''].filter(Boolean).join(' · '),
    meta: l.best != null ? `e1RM ${format.weight(Math.round(l.best * 10) / 10)}` : '',
  }));
}

/** Only finished weeks count, so the week in progress never counts against you. */
function renderConsistency(shown, mondays) {
  const finished = mondays.filter((m) => m < thisWeek);
  const counts = new Map();
  for (const r of shown) counts.set(r.week, (counts.get(r.week) ?? 0) + r.n);
  const c = $('consistency');
  if (finished.length === 0) return c.setAttribute('value', '–');
  const good = finished.filter((w) => (counts.get(w) ?? 0) >= 2).length;
  c.setAttribute('value', `${format.number(good)} ${t('of')} ${format.number(finished.length)}`);
  c.setAttribute('unit', t("weeks"));
}

function renderResults(results) {
  $('results').data = results.map((r) => {
    const result = coach.json(r.result, {}) ?? {};
    const text = result.text || (result.time_s ? format.duration(result.time_s) : '');
    const short = text.length <= 16; // long results (a powerlifting total) go on their own line, not in the narrow meta column
    return {
      icon: 'trophy',
      title: r.name,
      subtitle: [format.date(r.date, 'medium'), r.kind ? types.label(r.kind) : r.sport ? types.label(r.sport) : '', r.distance_m ? format.distance(r.distance_m) : '', short ? '' : text].filter(Boolean).join(' · '),
      meta: short ? text : '',
    };
  });
}
