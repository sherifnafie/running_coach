/** <rc-workout>: renders planned_workouts.structure (endurance steps, repeats, exercises with sets, targets). */
import { h, parseJson } from '../util';
import { buildWorkoutModel, type WorkoutItem } from '../workout';
import { RcBound, define, getCoach } from './base';
import { pick } from './values';

function exerciseEl(it: WorkoutItem): HTMLElement {
  const groups = it.sets ?? [];
  const single = groups.length <= 1;
  return h(
    'li',
    { class: 'rc-exercise' },
    h('span', { class: 'rc-step__bar', 'aria-hidden': 'true' }),
    h('span', { class: 'rc-exercise__name' }, it.kindLabel),
    single ? h('span', { class: 'rc-exercise__scheme' }, it.duration) : null,
    single && it.target ? h('span', { class: 'rc-exercise__load' }, it.target) : null,
    !single
      ? h(
          'ul',
          { class: 'rc-exercise__sets' },
          ...groups.map((g) => h('li', null, h('span', { class: 'rc-exercise__scheme' }, g.scheme), [g.load, g.target].filter(Boolean).length ? h('span', { class: 'rc-exercise__load' }, [g.load, g.target].filter(Boolean).join(' · ')) : null)),
        )
      : null,
    it.meta ? h('span', { class: 'rc-exercise__meta' }, it.meta) : null,
    it.note ? h('span', { class: 'rc-step__note' }, it.note) : null,
  );
}

function stepEl(it: WorkoutItem): HTMLElement {
  if (it.type === 'exercise') return exerciseEl(it);
  if (it.type === 'repeat') {
    const li = h('li', { class: 'rc-repeat' });
    li.append(
      h('div', { class: 'rc-repeat__head' }, h('span', { class: 'rc-repeat__times' }, `${it.times} ×`), h('span', null, 'repeat')),
      h('ol', { class: 'rc-workout__steps', 'aria-label': `Repeat ${it.times} times` }, ...(it.children ?? []).map(stepEl)),
    );
    return li;
  }
  return h(
    'li',
    { class: `rc-step rc-step--${/^[a-z]+$/.test(it.kind) ? it.kind : 'work'}` },
    h('span', { class: 'rc-step__bar', 'aria-hidden': 'true' }),
    h('span', { class: 'rc-step__kind' }, it.kindLabel),
    h('span', { class: 'rc-step__dur' }, it.duration),
    it.target ? h('span', { class: 'rc-step__target' }, it.target) : null,
    it.note ? h('span', { class: 'rc-step__note' }, it.note) : null,
  );
}

class RcWorkout extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'structure', 'units', 'compact', 'empty'];
  private _structure: unknown;

  get structure(): unknown {
    return this._structure ?? this.getAttribute('structure') ?? pick(this.rows?.[0], 'structure');
  }
  set structure(v: unknown) {
    this._structure = v;
    this.requestRender();
  }

  protected render(): void {
    if (this.error) {
      this.replaceChildren(this.errorEl());
      return;
    }
    const coach = getCoach();
    const units = (this.getAttribute('units') as 'metric' | 'imperial' | null) ?? coach.env.units;
    const raw = this.structure;
    const model = buildWorkoutModel(parseJson(raw) ?? raw, units, coach.env.locale);
    for (const w of model.warnings) coach.report('warn', `<rc-workout> ${w}`);
    if (model.items.length === 0) {
      this.replaceChildren(this.loading ? '' : h('p', { class: 'rc-workout__empty' }, this.attr('empty', 'No structured steps for this workout.')));
      return;
    }
    if (this.boolAttr('compact')) {
      this.replaceChildren(h('p', { class: 'rc-workout__summary' }, model.summary));
      return;
    }
    this.replaceChildren(h('div', { class: 'rc-workout' }, h('ol', { class: 'rc-workout__steps' }, ...model.items.map(stepEl)), model.notes ? h('p', { class: 'rc-workout__notes' }, model.notes) : null));
  }
}

export function registerWorkout(): void {
  define('rc-workout', RcWorkout);
}
