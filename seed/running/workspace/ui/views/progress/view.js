// Progress: mostly declarative. The HTML holds the SQL; this script only supplies the date
// parameters for the chosen range and fills the two things SQL alone doesn't format well.
import { coach } from '/kit/1/kit.js';

const $ = (id) => document.getElementById(id);
const { format, dates } = coach;

await coach.ready;
const today = dates.todayIn(coach.env.now().getTime(), coach.env.tz);
const thisWeek = dates.startOfWeek(today, 1); // weeks are Monday-based, matching the SQL
const lastWeek = dates.addDays(thisWeek, -7);

$('range').addEventListener('change', (e) => setRange(Number(e.detail.value)));
coach.subscribe(['db:activities', 'db:races'], () => void extras(Number($('range').value)));
setRange(Number($('range').value));

async function setRange(weeks) {
  const since = dates.addDays(thisWeek, -7 * (weeks - 1)); // first Monday shown
  // Re-setting `params` makes each bound component re-run its query.
  const set = (id, params) => $(id).setAttribute('params', JSON.stringify(params));
  set('s-week', [thisWeek, lastWeek]);
  set('s-runs', [since]);
  set('s-longest', [since]);
  set('volume', [since, today]);
  set('longest', [since]);
  set('pace', [since]);
  await extras(weeks);
}

/** Things that are easier in JS than in SQL: the empty state, consistency, race results. */
async function extras(weeks) {
  const since = dates.addDays(thisWeek, -7 * (weeks - 1));
  const [totals, perWeek, races] = await Promise.all([
    coach.db.one(`SELECT (SELECT count(*) FROM activities) AS runs, (SELECT count(*) FROM races) AS races`),
    coach.db.query(
      `SELECT date(substr(started_at, 1, 10), '-6 days', 'weekday 1') AS week, count(*) AS n
         FROM activities WHERE sport = 'run' AND substr(started_at, 1, 10) >= ? GROUP BY week`,
      [since],
    ),
    coach.db.query(`SELECT name, date, distance_m, result FROM races WHERE result IS NOT NULL ORDER BY date DESC LIMIT 5`),
  ]);

  // Day zero: friendly empty state instead of a wall of empty charts.
  const empty = !totals || (totals.runs === 0 && totals.races === 0);
  $('onboarding').hidden = !empty;
  $('content').hidden = empty;

  // Only count finished weeks, so the week in progress never counts against you.
  const finished = dates.range(since, dates.addDays(thisWeek, -7)).filter((d) => dates.weekday(d) === 1);
  const counts = new Map(perWeek.map((w) => [w.week, w.n]));
  const consistent = finished.filter((w) => (counts.get(w) ?? 0) >= 3).length;
  const c = $('consistency');
  if (finished.length === 0) c.setAttribute('value', '–');
  else {
    c.setAttribute('value', `${consistent} of ${finished.length}`);
    c.setAttribute('unit', 'weeks');
  }

  $('races').data = races.map((r) => {
    const result = coach.json(r.result, {});
    return {
      icon: 'trophy',
      title: r.name,
      subtitle: [format.date(r.date, 'medium'), r.distance_m ? format.distance(r.distance_m) : ''].filter(Boolean).join(' · '),
      meta: result?.time_s ? format.duration(result.time_s) : '',
    };
  });
}
