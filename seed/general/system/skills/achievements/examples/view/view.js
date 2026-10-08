import { coach } from '/kit/1/kit.js';

await coach.ready;
const ledgerPath = 'data/achievements.json';
const byId = id => document.getElementById(id);
const text = value => typeof value === 'string' ? value : '';
const statuses = { proposed: 'Proposed · not agreed yet', active: 'Agreed challenge', paused: 'Paused', completed: 'Completed', retired: 'Retired' };
const el = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
};
const talk = prefill => coach.openChat({ prefill, ref: { viewId: 'achievements' } }).catch(() => {
  byId('error').hidden = false;
});
for (const button of document.querySelectorAll('.chat')) {
  button.addEventListener('click', () => talk('I’d like to talk about my training achievements.'));
}

// A local date stays a local date; never reinterpret it through UTC or "now".
function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid achievement date');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid achievement date');
  return new Intl.DateTimeFormat(coach.env.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

function localImage(path) {
  // No external/authenticated URLs, traversal, SVG, data URLs or CSS injection.
  return typeof path === 'string' && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(path) ? path : null;
}

function medal(record) {
  const fallback = el('span', text(record.symbol).slice(0, 8) || '★', 'medal');
  fallback.dataset.tone = ['amber', 'teal', 'slate'].includes(record.tone) ? record.tone : 'amber';
  fallback.setAttribute('aria-hidden', 'true');
  const path = localImage(record.image);
  if (!path) return fallback;
  const holder = el('span', '', 'medal-art');
  const picture = el('img', '', 'medal-image');
  picture.alt = ''; // Adjacent text describes the achievement independently.
  picture.hidden = true;
  holder.append(fallback, picture);
  picture.addEventListener('load', () => { fallback.hidden = true; picture.hidden = false; }, { once: true });
  picture.addEventListener('error', () => { picture.remove(); fallback.hidden = false; }, { once: true });
  picture.src = path;
  return holder;
}

function achievement(record) {
  const node = el('article', '', 'moment');
  const top = el('div', '', 'moment-top');
  const heading = el('div');
  heading.append(el('h3', record.title));
  const date = el('time', formatDate(record.earned_on));
  date.dateTime = record.earned_on;
  heading.append(date);
  top.append(medal(record), heading);
  node.append(top, el('p', record.description));
  if (text(record.basis)) node.append(el('p', record.basis, 'basis'));
  return node;
}

function challenge(record) {
  const node = el('article', '', 'challenge');
  const top = el('div', '', 'challenge-top');
  top.append(el('h3', record.title), el('span', statuses[record.status], 'status'));
  node.append(top);
  if (text(record.description)) node.append(el('p', record.description));
  node.append(el('p', record.criteria, 'criteria'));
  if (text(record.period)) node.append(el('p', record.period, 'basis'));
  if (text(record.change_note)) node.append(el('p', record.change_note, 'change-note'));
  const button = el('button', 'Discuss with coach');
  button.type = 'button';
  button.setAttribute('aria-label', `Discuss with coach: ${record.title}`);
  button.addEventListener('click', () => talk(`I’d like to discuss the challenge “${record.title}”.`));
  node.append(button);
  return node;
}

function readLedger(contents) {
  const value = JSON.parse(contents);
  if (value?.version !== 1 || !Array.isArray(value.achievements) || !Array.isArray(value.challenges)) throw new Error('Unsupported collection layout');
  const ids = new Set();
  for (const record of [...value.achievements, ...value.challenges]) {
    if (!record || !text(record.id).trim() || !text(record.title).trim() || ids.has(record.id)) throw new Error('Invalid or duplicate collection record');
    ids.add(record.id);
  }
  for (const record of value.achievements) {
    if (!text(record.description).trim()) throw new Error('Missing achievement description');
    formatDate(text(record.earned_on));
  }
  for (const record of value.challenges) {
    if (!Object.hasOwn(statuses, record.status) || !text(record.criteria).trim()) throw new Error('Invalid challenge');
    if (['active', 'paused', 'completed'].includes(record.status)) formatDate(text(record.accepted_on));
  }
  return value;
}

let generation = 0;
async function refresh() {
  const request = ++generation;
  try {
    const contents = await coach.files.read(ledgerPath).catch(error => {
      // The renderer deliberately removes files in its empty fixture. A missing
      // live ledger is an error, not evidence that the collection is empty.
      if (coach.env.mode === 'preview' && String(error?.message).includes('(empty-state preview has no files)')) {
        return JSON.stringify({ version: 1, achievements: [], challenges: [] });
      }
      throw error;
    });
    const ledger = readLedger(contents);
    if (request !== generation) return;
    // Build before swapping so a bad refresh retains the last usable collection.
    const earned = [...ledger.achievements].sort((a, b) => b.earned_on.localeCompare(a.earned_on)).map(achievement);
    const current = ledger.challenges.filter(item => !['completed', 'retired'].includes(item.status)).map(challenge);
    const past = ledger.challenges.filter(item => ['completed', 'retired'].includes(item.status)).map(challenge);
    byId('earned').replaceChildren(...earned);
    byId('challenges').replaceChildren(...current);
    byId('past-challenges').replaceChildren(...past);
    byId('empty').hidden = earned.length > 0;
    byId('challenges-section').hidden = ledger.challenges.length === 0;
    byId('past').hidden = past.length === 0;
    byId('content').hidden = false;
    byId('error').hidden = true;
  } catch {
    if (request !== generation) return;
    byId('error').hidden = false;
    // No raw errors or ledger content go on the athlete's screen or into reports.
    coach.report('warn', 'Achievement collection could not refresh.').catch(() => {});
  } finally {
    if (request === generation) byId('loading').hidden = true;
  }
}
byId('retry').addEventListener('click', () => { coach.track(refresh()); });
coach.subscribe([`file:${ledgerPath}`], () => { coach.track(refresh()); });
coach.onEnv(() => { coach.track(refresh()); });
await coach.track(refresh());
