// Today: the home view. A worked example of the kit, for any sport or mix of sports:
//   - coach.db.query for reads, coach.db.write for direct writes (no model turn),
//   - coach.act(..., { wake: true }) to tell the coach about it,
//   - kit components (<rc-card>, <rc-workout> ...) assembled with h(),
//   - `types` for sport and session-type labels that match the calendar's colours.
// h(tag, attrs, ...children) builds DOM without innerHTML; on* attributes add event listeners.
import { coach, h, types } from '/kit/1/kit.js?v=0.3.7';

const t = (text) => coach.t(text);
const $ = (id) => document.getElementById(id);
const { format, dates } = coach;
const PENDING = ['planned', 'moved'];
const DISTANCE_PACE = ['run', 'walk', 'hike'];
let sessions = [];

await coach.ready;
let renderedLocale = coach.env.locale;
coach.onEnv((env) => { if (env.locale !== renderedLocale) { renderedLocale = env.locale; coach.track(refresh()); } });
const today = dates.todayIn(coach.env.now().getTime(), coach.env.tz);
$('header').setAttribute('subheading', format.date(today, 'long'));
coach.subscribe(['db:planned_workouts', 'db:activities', 'db:exercise_sets'], refresh);
await refresh();

async function refresh() {
  $('header').setAttribute('subheading', format.date(today, 'long'));
  const [todays, counts, last, next] = await Promise.all([
    coach.db.query(
      `SELECT id, date, slot, sport, type, title, description, structure, target_distance_m, target_duration_s, key, status
         FROM planned_workouts WHERE date = ?
        ORDER BY CASE slot WHEN 'am' THEN 0 WHEN 'pm' THEN 2 ELSE 1 END, key DESC`,
      [today],
    ),
    coach.db.one('SELECT (SELECT count(*) FROM planned_workouts) AS planned, (SELECT count(*) FROM activities) AS done'),
    coach.db.one(
      `SELECT a.id, a.title, a.sport, a.started_at, a.distance_m, a.duration_s, a.avg_pace_s_km, a.rpe,
              (SELECT count(*) FROM exercise_sets s WHERE s.activity_id = a.id AND s.is_warmup = 0) AS sets
         FROM activities a ORDER BY a.started_at DESC LIMIT 1`,
    ),
    coach.db.one(
      `SELECT id, date, sport, type, title, target_distance_m, target_duration_s FROM planned_workouts
        WHERE date > ? AND status IN ('planned', 'moved') AND key = 1
        ORDER BY date LIMIT 1`,
      [today],
    ),
  ]);
  sessions = todays;
  const empty = (!counts || counts.planned === 0) && !(counts && counts.done > 0);

  // Day zero: friendly empty state instead of blank cards.
  $('onboarding').hidden = !empty;
  $('say-hi').onclick = () => coach.openChat({ prefill: t("Hi coach! Where do we start?") });
  renderSessions(empty);
  await renderLast(last);
  renderNext(next);
  $('supporting').hidden = !last && !next;
}

// ---------------------------------------------------------------- today's sessions

function renderSessions(empty) {
  const box = $('sessions');
  if (empty) return box.replaceChildren();
  if (sessions.length === 0) {
    box.replaceChildren(h('rc-empty', { icon: 'calendar', heading: t("Nothing planned today"), message: t("Enjoy the day. Ask your coach if you want to add something.") }));
    return;
  }
  box.replaceChildren(...sessions.map(sessionCard));
}

/** "Run · Tempo · 45 min" (sport and type both shown only when they differ). */
function sessionLine(w) {
  const sport = w.sport ? types.label(w.sport) : '';
  const type = w.type === 'rest' ? t("Rest day") : types.label(w.type);
  const target = w.target_distance_m ? format.distance(w.target_distance_m) : w.target_duration_s ? format.duration(w.target_duration_s, 'short') : '';
  return [sport, type && type !== sport ? type : '', target].filter(Boolean).join(' · ');
}

function sessionCard(w) {
  const pending = PENDING.includes(w.status);
  const tone = { done: 'ok', partial: 'ok', skipped: 'warn' }[w.status];
  return h(
    'rc-card',
    // Highlight what is still to do; a rest day is not a task.
    { heading: w.title, subheading: sessionLine(w), tone: pending && w.type !== 'rest' ? 'accent' : 'default' },
    tone ? h('rc-badge', { tone }, statusText(w.status)) : w.key ? h('rc-badge', { tone: 'accent' }, t("Key session")) : null,
    w.description ? h('p', null, w.description) : null,
    w.structure ? h('rc-workout', { structure: w.structure }) : null,
    h(
      'div',
      { class: 'rc-row' },
      // The primary action is the biggest thing on the card; everything else is quieter.
      w.type !== 'rest' && pending ? h('rc-button', { variant: 'primary', icon: 'check', onClick: () => setStatus(w, 'done') }, t("Mark done")) : null,
      w.type !== 'rest' && pending ? h('rc-button', { variant: 'secondary', onClick: () => setStatus(w, 'skipped') }, t("Skip")) : null,
      !pending ? h('rc-button', { variant: 'ghost', onClick: () => setStatus(w, 'planned') }, t("Undo")) : null,
      h('rc-button', { variant: 'ghost', icon: 'chat', onClick: () => coach.openChat({ prefill: `${t("About today's session")} (${w.title}): `, ref: { viewId: 'today' } }) }, t("Ask coach")),
    ),
  );
}

/** Direct write (instant, queued offline), then tell the coach with a wake-up. */
async function setStatus(w, status) {
  const before = w.status;
  w.status = status;
  renderSessions(false); // optimistic
  try {
    await coach.db.write('planned_workouts', 'update', { status, updated_at: coach.env.now().toISOString() }, { id: w.id });
    const action = { done: 'workout_done', skipped: 'workout_skipped', planned: 'workout_reset' }[status];
    await coach.act(action, { id: w.id, date: w.date }, { wake: status !== 'planned' });
    if (status === 'done') coach.toast(t("Nice work. Logged."));
  } catch (err) {
    w.status = before;
    renderSessions(false);
    coach.toast(t("Couldn't save that. Try again."));
    coach.report('warn', `status update failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- last activity + next key session

/** Pick the three numbers that fit the session: distance-based, lifting, or time and effort. */
async function renderLast(a) {
  $('last-card').hidden = !a;
  if (!a) return;
  $('last-title').textContent = `${format.date(a.started_at, 'medium')} · ${a.title || types.label(a.sport)}`;
  const stats = [];
  let note = '';
  if (a.distance_m != null) {
    stats.push([t("Distance"), a.distance_m, 'distance'], [t("Time"), a.duration_s, 'duration']);
    const pace = a.avg_pace_s_km ?? (DISTANCE_PACE.includes(a.sport) && a.duration_s ? a.duration_s / (a.distance_m / 1000) : null);
    stats.push(pace != null ? [t("Pace"), pace, 'pace'] : [t("Effort"), a.rpe != null ? `${format.number(a.rpe)}/10` : null, 'text']);
  } else if (a.sets > 0) {
    const top = await coach.db.one(
      `SELECT exercise, reps, load_kg FROM exercise_sets WHERE activity_id = ? AND is_warmup = 0 AND load_kg IS NOT NULL
        ORDER BY load_kg DESC, reps DESC LIMIT 1`,
      [a.id],
    );
    stats.push([t("Time"), a.duration_s, 'duration'], [t("Sets"), a.sets, 'integer'], [t("Effort"), a.rpe != null ? `${format.number(a.rpe)}/10` : null, 'text']);
    // The top set is too long for a stat tile on a phone; it gets its own line under the numbers.
    if (top) note = `${t("Top set")}: ${top.exercise} ${format.weight(top.load_kg)} × ${format.number(top.reps)}`;
  } else {
    stats.push([t("Time"), a.duration_s, 'duration'], [t("Effort"), a.rpe != null ? `${format.number(a.rpe)}/10` : null, 'text'], [t("Sport"), types.label(a.sport), 'text']);
  }
  // Missing measurements stay missing: rc-stat shows a dash rather than a zero.
  $('last-stats').replaceChildren(...stats.map(([label, value, fmt]) => h('rc-stat', { label, format: fmt, ...(value != null ? { value } : {}) })));
  $('last-note').textContent = note;
  $('last-note').hidden = !note;
}

function renderNext(n) {
  $('next-card').hidden = !n;
  if (!n) return;
  const list = $('next');
  const target = n.target_distance_m ? format.distance(n.target_distance_m) : n.target_duration_s ? format.duration(n.target_duration_s, 'short') : '';
  list.data = [{ id: n.id, title: n.title, subtitle: [format.relativeDay(n.date), n.sport ? types.label(n.sport) : types.label(n.type)].join(' · '), meta: target, icon: 'flag' }];
  list.onselect = () => coach.navigate('calendar', { date: n.date });
}

function statusText(s) {
  return ({ done: t("Done"), partial: t("Partly done"), skipped: t("Skipped") })[s] || s;
}
