// Today: the home view. A worked example of the kit:
//   - coach.db.query for reads, coach.db.write for direct writes (no model turn),
//   - coach.act(..., { wake: true }) to tell the coach about it,
//   - kit components (<rc-card>, <rc-workout>, <rc-form> ...) assembled with h().
// h(tag, attrs, ...children) builds DOM without innerHTML; on* attributes add event listeners.
import { coach, h } from '/kit/1/kit.js';

const $ = (id) => document.getElementById(id);
const { format, dates } = coach;
const PENDING = ['planned', 'moved'];
let sessions = [];

await coach.ready;
const today = dates.todayIn(coach.env.now().getTime(), coach.env.tz);
$('header').setAttribute('subheading', format.date(today, 'long'));
coach.subscribe(['db:planned_workouts', 'db:activities', 'db:checkins'], refresh);
await refresh();

async function refresh() {
  const [todays, counts, last, next, checkins] = await Promise.all([
    coach.db.query(
      `SELECT id, date, slot, type, title, description, structure, target_distance_m, target_duration_s, status
         FROM planned_workouts WHERE date = ?
        ORDER BY CASE slot WHEN 'am' THEN 0 WHEN 'pm' THEN 2 ELSE 1 END`,
      [today],
    ),
    coach.db.one('SELECT (SELECT count(*) FROM planned_workouts) AS planned, (SELECT count(*) FROM activities) AS runs'),
    coach.db.one('SELECT title, started_at, distance_m, duration_s, avg_pace_s_km FROM activities ORDER BY started_at DESC LIMIT 1'),
    coach.db.one(
      `SELECT id, date, type, title, target_distance_m FROM planned_workouts
        WHERE date > ? AND status IN ('planned', 'moved') AND type IN ('long', 'tempo', 'intervals', 'hills', 'race')
        ORDER BY date LIMIT 1`,
      [today],
    ),
    coach.db.query('SELECT kind FROM checkins WHERE substr(at, 1, 10) = ?', [today]),
  ]);
  sessions = todays;
  const empty = !counts || counts.planned === 0;

  // Day zero: friendly empty state instead of blank cards.
  $('onboarding').hidden = !empty;
  $('say-hi').onclick = () => coach.openChat({ prefill: 'Hi coach! Where do we start?' });
  renderSessions(empty);
  renderCheckin(checkins.length, empty);
  renderLast(last);
  renderNext(next);
}

// ---------------------------------------------------------------- today's sessions

function renderSessions(empty) {
  const box = $('sessions');
  if (empty) return box.replaceChildren();
  if (sessions.length === 0) {
    box.replaceChildren(h('rc-empty', { icon: 'calendar', heading: 'Nothing planned today', message: 'Enjoy the day. Ask your coach if you want to add something.' }));
    return;
  }
  box.replaceChildren(...sessions.map(sessionCard));
}

function sessionCard(w) {
  const pending = PENDING.includes(w.status);
  const target = w.target_distance_m ? format.distance(w.target_distance_m) : w.target_duration_s ? format.duration(w.target_duration_s, 'short') : '';
  const tone = { done: 'ok', partial: 'ok', skipped: 'warn' }[w.status];
  return h(
    'rc-card',
    { heading: w.title, subheading: [typeName(w.type), target].filter(Boolean).join(' · '), tone: pending ? 'accent' : 'default' },
    tone ? h('rc-badge', { tone }, statusText(w.status)) : null,
    w.description ? h('p', null, w.description) : null,
    w.structure ? h('rc-workout', { structure: w.structure }) : null,
    h(
      'div',
      { class: 'rc-row' },
      // The primary action is the biggest thing on the card; everything else is quieter.
      w.type !== 'rest' && pending ? h('rc-button', { variant: 'primary', icon: 'check', onClick: () => setStatus(w, 'done') }, 'Mark done') : null,
      w.type !== 'rest' && pending ? h('rc-button', { variant: 'secondary', onClick: () => setStatus(w, 'skipped') }, 'Skip') : null,
      !pending ? h('rc-button', { variant: 'ghost', onClick: () => setStatus(w, 'planned') }, 'Undo') : null,
      h('rc-button', { variant: 'ghost', icon: 'chat', onClick: () => coach.openChat({ prefill: `About today's ${w.title}: `, ref: { viewId: 'today' } }) }, 'Ask coach'),
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
    if (status === 'done') coach.toast('Nice work. Logged.');
  } catch (err) {
    w.status = before;
    renderSessions(false);
    coach.toast("Couldn't save that. Try again.");
    coach.report('warn', `status update failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- check-in shortcut

function renderCheckin(doneKinds, empty) {
  const card = $('checkin-card');
  card.hidden = empty;
  const form = $('checkin-form');
  const open = $('checkin-open');
  open.setAttribute('label', doneKinds ? 'Add to today’s check-in' : 'How are you feeling?');
  open.onclick = () => {
    form.hidden = !form.hidden;
  };
  if (form.fields.length === 0) {
    form.fields = [
      { id: 'energy', type: 'scale', label: 'Energy', min: 1, max: 5, anchors: { 1: 'Drained', 5: 'Great' } },
      { id: 'sleep', type: 'scale', label: 'Sleep last night', min: 1, max: 5, anchors: { 1: 'Poor', 5: 'Great' } },
      { id: 'pain', type: 'body_map', label: 'Anything hurting?' },
      { id: 'note', type: 'text', label: 'Anything else?', multiline: true, max_len: 300 },
    ];
    form.addEventListener('submit', (e) => saveCheckin(e.detail.values));
  }
}

async function saveCheckin(v) {
  const at = coach.env.now().toISOString();
  const rows = [];
  if (v.energy) rows.push(['energy', { score: v.energy }]);
  if (v.sleep) rows.push(['sleep', { score: v.sleep }]);
  for (const p of v.pain ?? []) rows.push(['pain', p]); // { region, severity? } with region ids from the body map
  if (v.note) rows.push(['note', { text: v.note }]);
  if (rows.length === 0) return coach.toast('Pick at least one answer.');
  try {
    for (const [kind, value] of rows) {
      await coach.db.write('checkins', 'insert', { id: coach.id(), at, kind, value: JSON.stringify(value), source: 'view' });
    }
    await coach.act('checkin_saved', { kinds: rows.map((r) => r[0]) }, { wake: true });
    coach.toast('Thanks, saved.');
    $('checkin-form').hidden = true;
    $('checkin-form').reset();
  } catch (err) {
    coach.toast("Couldn't save your check-in.");
    coach.report('warn', `check-in failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- last activity + next key session

function renderLast(a) {
  $('last-card').hidden = !a;
  if (!a) return;
  $('last-title').textContent = `${format.date(a.started_at, 'medium')} · ${a.title || 'Run'}`;
  for (const [id, value] of [['last-distance', a.distance_m], ['last-time', a.duration_s], ['last-pace', a.avg_pace_s_km]]) {
    if (value != null) $(id).setAttribute('value', value);
  }
}

function renderNext(n) {
  $('next-card').hidden = !n;
  if (!n) return;
  const list = $('next');
  list.data = [{ id: n.id, title: n.title, subtitle: `${format.relativeDay(n.date)} · ${typeName(n.type)}`, meta: n.target_distance_m ? format.distance(n.target_distance_m) : '', icon: 'flag' }];
  list.onselect = () => coach.navigate('calendar', { date: n.date });
}

function typeName(t) {
  return ({ easy: 'Easy run', long: 'Long run', tempo: 'Tempo', intervals: 'Intervals', hills: 'Hills', race: 'Race', strength: 'Strength', rest: 'Rest day', cross: 'Cross-training' })[t] || 'Workout';
}
function statusText(s) {
  return ({ done: 'Done', partial: 'Partly done', skipped: 'Skipped' })[s] || s;
}
