/**
 * <rc-week-strip> and <rc-calendar>.
 *
 * Data convention (sql columns or the `data`/`items` property): id, date (YYYY-MM-DD), type, title,
 * status, optional meta | distance_m | target_distance_m | target_duration_s, optional source
 * ('planned' rows are movable; 'activity'/'race' rows are not).
 */
import { addDays, addMonths, dateOf, monthGrid, startOfMonth, startOfWeek, weekDates } from '../dates';
import { h } from '../util';
import { RcBound, define, emit, getCoach } from './base';
import { iconSvg } from './basic';
import { toDayItems, typeGlyph, typeKey, typeLabel, statusLabel, type DayItem } from './types';

const labelText = (text: string) => getCoach().t(text);
const STATUS_MARK: Record<string, string> = { done: '✓', partial: '◐', skipped: '✕', moved: '→' };

function itemMeta(it: DayItem): string {
  const f = getCoach().format;
  const r = it.row;
  if (r.meta != null && r.meta !== '') return String(r.meta);
  const d = (r.distance_m ?? r.target_distance_m) as number | null | undefined;
  if (typeof d === 'number' && d > 0) return f.distance(d);
  const t = (r.duration_s ?? r.target_duration_s) as number | null | undefined;
  if (typeof t === 'number' && t > 0) return f.duration(t, 'short');
  return '';
}

function itemLabel(it: DayItem): string {
  const f = getCoach().format;
  return `${it.title}, ${getCoach().t(typeLabel(it.type))}, ${f.date(it.date, 'long')}, ${getCoach().t(statusLabel(it.status)).toLowerCase()}`;
}

function today(): string {
  const env = getCoach().env;
  return dateOf(env.now(), env.tz);
}

function groupByDate(items: DayItem[]): Map<string, DayItem[]> {
  const m = new Map<string, DayItem[]>();
  for (const it of items) {
    const a = m.get(it.date);
    if (a) a.push(it);
    else m.set(it.date, [it]);
  }
  return m;
}

// ----------------------------------------------------------------------------- week strip

class RcWeekStrip extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'start', 'selected', 'week-starts-on'];

  get selected(): string {
    return this.getAttribute('selected') ?? '';
  }
  set selected(v: string) {
    this.setAttribute('selected', v);
  }

  protected render(): void {
    const coach = getCoach();
    const env = coach.env;
    const wso = (this.hasAttribute('week-starts-on') ? Number(this.getAttribute('week-starts-on')) : env.weekStartsOn) === 0 ? 0 : 1;
    const t = today();
    const start = this.getAttribute('start') ?? startOfWeek(t, wso);
    const days = weekDates(start);
    const items = groupByDate(toDayItems(this.rows, []));
    const sel = this.selected;
    const strip = h('div', { class: 'rc-strip', role: 'group', 'aria-label': labelText('Week') });
    for (const d of days) {
      const its = items.get(d) ?? [];
      const dow = coach.format.date(d, 'weekday-short');
      const label = `${coach.format.date(d, 'long')}${its.length ? `: ${its.map((i) => `${i.title} (${coach.t(statusLabel(i.status)).toLowerCase()})`).join(', ')}` : `, ${labelText('Nothing planned')}`}`;
      const btn = h(
        'button',
        { type: 'button', class: `rc-day${d === t ? ' is-today' : ''}${d === sel ? ' is-selected' : ''}`, 'aria-label': label, 'aria-pressed': sel ? String(d === sel) : null, 'aria-current': d === t ? 'date' : null },
        h('span', { class: 'rc-day__dow', 'aria-hidden': 'true' }, dow.slice(0, 3)),
        h('span', { class: 'rc-day__num', 'aria-hidden': 'true' }, coach.format.date(d, 'day')),
        h(
          'span',
          { class: 'rc-day__dots', 'aria-hidden': 'true' },
          ...its.slice(0, 3).map((i) => h('span', { class: `rc-dot rc-type-${typeKey(i.type)} is-${i.status}` }, STATUS_MARK[i.status] && i.status !== 'moved' ? STATUS_MARK[i.status] : '')),
        ),
      );
      btn.addEventListener('click', () => {
        this.setAttribute('selected', d);
        emit(this, 'select', { date: d, items: its.map((i) => i.row) });
      });
      strip.append(btn);
    }
    this.replaceChildren(strip);
  }
}

// ----------------------------------------------------------------------------- calendar

interface DragState {
  item: DayItem;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ghost?: HTMLElement;
  over?: string;
  source: HTMLElement;
}

class RcCalendar extends RcBound {
  static observedAttributes = [...RcBound.baseAttrs, 'mode', 'date', 'week-starts-on', 'movable', 'movable-statuses', 'write-target', 'write-status', 'write-key', 'act-name', 'agenda', 'selected', 'empty'];

  private anchor = '';
  private selDate = '';
  private selId = '';
  private moveId = '';
  private drag: DragState | null = null;
  private deferred = false;
  private suppressClick = false;
  private focusDate = '';
  private live!: HTMLElement;

  get items(): Array<Record<string, unknown>> | null {
    return this.rows;
  }
  set items(v: Array<Record<string, unknown>> | null) {
    this.data = v;
  }

  get mode(): 'month' | 'week' {
    return this.getAttribute('mode') === 'week' ? 'week' : 'month';
  }
  set mode(v: 'month' | 'week') {
    this.setAttribute('mode', v);
  }

  private get wso(): 0 | 1 {
    return (this.hasAttribute('week-starts-on') ? Number(this.getAttribute('week-starts-on')) : getCoach().env.weekStartsOn) === 0 ? 0 : 1;
  }
  private get movableStatuses(): string[] {
    return this.attr('movable-statuses', 'planned,moved')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  private get dayItems(): DayItem[] {
    return toDayItems(this.rows, this.boolAttr('movable') ? this.movableStatuses : []);
  }

  protected override setup(): void {
    this.live = h('div', { class: 'rc-sr', 'aria-live': 'polite', role: 'status' });
    this.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.moveId) {
        this.cancelMove();
        e.stopPropagation();
      }
    });
  }

  protected override attrChanged(name: string): void {
    super.attrChanged(name);
    if (name === 'date') this.anchor = '';
    if (name === 'selected') this.selDate = this.getAttribute('selected') ?? '';
  }

  /** Show the period containing `date`. */
  goTo(date: string): void {
    this.anchor = date;
    this.requestRender();
    this.announceRange();
  }

  /** Begin tap-to-move for an item: the next tapped day becomes its new date. */
  startMove(id: string): void {
    const it = this.dayItems.find((i) => i.id === id);
    if (!it?.movable) return;
    this.moveId = id;
    this.requestRender();
    this.announce(`Pick a new day for ${it.title}. Press Escape to cancel.`);
  }
  cancelMove(): void {
    this.moveId = '';
    this.requestRender();
  }

  private announce(msg: string): void {
    this.live.textContent = msg;
  }
  private announceRange(): void {
    const f = getCoach().format;
    this.announce(this.mode === 'month' ? f.date(this.curAnchor(), 'month') : `Week of ${f.date(startOfWeek(this.curAnchor(), this.wso), 'long')}`);
  }

  private curAnchor(): string {
    if (this.anchor) return this.anchor;
    const a = this.getAttribute('date');
    return a && /^\d{4}-\d{2}-\d{2}$/.test(a) ? a : today();
  }

  protected render(): void {
    if (this.drag?.active) {
      this.deferred = true;
      return;
    }
    if (this.error) {
      this.replaceChildren(this.errorEl());
      return;
    }
    const coach = getCoach();
    const f = coach.format;
    const anchor = this.curAnchor();
    const mode = this.mode;
    const items = this.dayItems;
    const by = groupByDate(items);
    const t = today();
    if (!this.selDate) this.selDate = this.getAttribute('selected') ?? '';
    const moving = items.find((i) => i.id === this.moveId);

    const root = h('div', { class: `rc-cal rc-cal--${mode}${this.moveId ? ' is-moving' : ''}` });

    // ---- toolbar
    const title = mode === 'month' ? f.date(anchor, 'month') : `${f.date(startOfWeek(anchor, this.wso), 'short')} – ${f.date(addDays(startOfWeek(anchor, this.wso), 6), 'short')}`;
    const step = (dir: -1 | 1) => {
      this.anchor = mode === 'month' ? addMonths(anchor, dir) : addDays(anchor, dir * 7);
      this.requestRender();
      this.announceRange();
      emit(this, 'navigate', { mode, anchor: this.anchor });
    };
    root.append(
      h(
        'div',
        { class: 'rc-cal__bar' },
        h('button', { type: 'button', class: 'rc-cal__nav', 'aria-label': mode === 'month' ? labelText('Previous month') : labelText('Previous week'), onClick: () => step(-1) }, iconSvg('chevron-left', 22)),
        h('h2', { class: 'rc-cal__title' }, title),
        h('button', { type: 'button', class: 'rc-cal__nav', 'aria-label': mode === 'month' ? labelText('Next month') : labelText('Next week'), onClick: () => step(1) }, iconSvg('chevron-right', 22)),
        h(
          'button',
          {
            type: 'button',
            class: 'rc-cal__today',
            onClick: () => {
              this.anchor = t;
              this.selDate = t;
              this.requestRender();
              this.announceRange();
              emit(this, 'navigate', { mode, anchor: t });
            },
          },
          labelText('Today'),
        ),
      ),
    );

    if (moving) {
      root.append(
        h(
          'div',
          { class: 'rc-cal__banner', role: 'status' },
          h('span', null, `${labelText('Pick a new day for')} “${moving.title}”`),
          h('button', { type: 'button', class: 'rc-cal__cancel', onClick: () => this.cancelMove() }, labelText('Cancel')),
        ),
      );
    }

    // ---- body
    if (mode === 'month') {
      const first = startOfMonth(anchor);
      const rows = monthGrid(anchor, this.wso);
      const dow = h('div', { class: 'rc-cal__dow', 'aria-hidden': 'true' });
      for (const d of rows[0] ?? []) dow.append(h('span', null, f.date(d, 'weekday-short').slice(0, 3)));
      const grid = h('div', { class: 'rc-cal__grid', role: 'group', 'aria-label': f.date(anchor, 'month') });
      for (const row of rows) {
        for (const d of row) {
          const its = by.get(d) ?? [];
          const outside = d.slice(0, 7) !== first.slice(0, 7);
          const cell = h('div', { class: `rc-cal__cell${outside ? ' is-outside' : ''}${d === t ? ' is-today' : ''}${d === this.selDate ? ' is-selected' : ''}`, 'data-date': d });
          const tab = (this.focusDate || this.selDate || (t.slice(0, 7) === first.slice(0, 7) ? t : first)) === d ? 0 : -1;
          cell.append(
            h(
              'button',
              {
                type: 'button',
                class: 'rc-cal__day',
                tabindex: tab,
                'aria-label': `${f.date(d, 'long')}${its.length ? `, ${its.length} ${its.length === 1 ? 'item' : 'items'}` : ''}`,
                'aria-current': d === t ? 'date' : null,
                'aria-pressed': String(d === this.selDate),
                'data-day': d,
                onClick: () => this.pickDay(d),
                onKeydown: (e) => this.dayKey(e as KeyboardEvent, d),
              },
              f.date(d, 'day'),
            ),
          );
          const shown = its.slice(0, 3);
          for (const it of shown) cell.append(this.chip(it, false));
          if (its.length > shown.length) cell.append(h('button', { type: 'button', class: 'rc-cal__more', 'aria-label': `${its.length - shown.length} more on ${f.date(d, 'long')}`, onClick: () => this.pickDay(d) }, `+${its.length - shown.length}`));
          grid.append(cell);
        }
      }
      root.append(dow, grid);
      if (this.attr('agenda', 'on') !== 'off') root.append(this.agenda(by));
    } else {
      const list = h('div', { class: 'rc-cal__weeklist', role: 'group', 'aria-label': title });
      for (const d of weekDates(startOfWeek(anchor, this.wso))) {
        const its = by.get(d) ?? [];
        const day = h(
          'div',
          { class: `rc-cal__wrow rc-cal__cell${d === t ? ' is-today' : ''}${d === this.selDate ? ' is-selected' : ''}`, 'data-date': d },
          h(
            'button',
            {
              type: 'button',
              class: 'rc-cal__wday',
              'aria-label': f.date(d, 'long'),
              'aria-current': d === t ? 'date' : null,
              'data-day': d,
              onClick: () => this.pickDay(d),
              onKeydown: (e) => this.dayKey(e as KeyboardEvent, d),
            },
            h('span', { class: 'rc-cal__wdow', 'aria-hidden': 'true' }, f.date(d, 'weekday-short')),
            h('span', { class: 'rc-cal__wnum', 'aria-hidden': 'true' }, f.date(d, 'day')),
          ),
          h('div', { class: 'rc-cal__witems' }, ...(its.length ? its.map((i) => this.chip(i, true)) : [h('span', { class: 'rc-cal__rest' }, this.moveId ? labelText('Move here') : labelText('Nothing planned'))])),
        );
        list.append(day);
      }
      root.append(list);
    }

    // ---- selected item bar
    const sel = items.find((i) => i.id === this.selId);
    if (sel && !this.moveId) {
      root.append(
        h(
          'div',
          { class: 'rc-cal__sel', role: 'group', 'aria-label': labelText('Selected workout') },
          h('div', { class: 'rc-cal__seltext' }, h('strong', null, sel.title), h('span', null, ` · ${f.date(sel.date, 'medium')} · ${coach.t(statusLabel(sel.status))}`)),
          sel.movable ? h('button', { type: 'button', class: 'rc-btn rc-btn--secondary rc-cal__movebtn', onClick: () => this.startMove(sel.id) }, iconSvg('arrow-right', 18), h('span', { class: 'rc-btn__label' }, 'Move…')) : null,
        ),
      );
    }
    if (items.length === 0 && !this.loading && this.hasAttribute('empty')) root.append(h('p', { class: 'rc-cal__empty' }, this.attr('empty')));
    root.append(this.live);
    this.replaceChildren(root);

    if (this.focusDate) {
      const target = this.querySelector<HTMLElement>(`[data-day="${this.focusDate}"]`);
      this.focusDate = '';
      target?.focus();
    }
  }

  private agenda(by: Map<string, DayItem[]>): HTMLElement {
    const f = getCoach().format;
    const box = h('div', { class: 'rc-cal__agenda' });
    if (!this.selDate) return box;
    const its = by.get(this.selDate) ?? [];
    box.append(h('h3', { class: 'rc-cal__agendatitle' }, f.date(this.selDate, 'long')));
    if (its.length === 0) box.append(h('p', { class: 'rc-cal__rest' }, labelText('Nothing planned.')));
    else box.append(...its.map((i) => this.chip(i, true)));
    return box;
  }

  private chip(it: DayItem, full: boolean): HTMLElement {
    const glyph = typeGlyph(it.type);
    const mark = STATUS_MARK[it.status] ?? '';
    const meta = full ? itemMeta(it) : '';
    const b = h(
      'button',
      {
        type: 'button',
        class: `rc-cal__item rc-type-${typeKey(it.type)} is-${it.status}${full ? ' is-full' : ''}${it.id === this.selId ? ' is-selected' : ''}${it.movable ? ' is-movable' : ''}`,
        'data-id': it.id,
        'aria-label': itemLabel(it),
        'aria-pressed': String(it.id === this.selId),
      },
      h('span', { class: 'rc-cal__glyph', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'rc-cal__itemtitle' }, it.title),
      meta ? h('span', { class: 'rc-cal__itemmeta' }, meta) : null,
      mark ? h('span', { class: 'rc-cal__mark', 'aria-hidden': 'true' }, mark) : null,
    );
    b.addEventListener('click', () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.selId = it.id;
      this.selDate = it.date;
      emit(this, 'select', { id: it.id, date: it.date, item: it.row });
      this.requestRender();
    });
    if (it.movable) b.addEventListener('pointerdown', (e) => this.onPointerDown(e, it, b));
    return b;
  }

  private pickDay(d: string): void {
    if (this.moveId) {
      const it = this.dayItems.find((i) => i.id === this.moveId);
      this.moveId = '';
      if (it) void this.moveItem(it, d);
      else this.requestRender();
      return;
    }
    this.selDate = d;
    this.selId = '';
    emit(this, 'select-date', { date: d });
    this.requestRender();
  }

  private dayKey(e: KeyboardEvent, d: string): void {
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next: string | null = null;
    if (e.key in deltas) next = addDays(d, deltas[e.key] as number);
    else if (e.key === 'PageDown') next = addMonths(d, 1).slice(0, 8) + d.slice(8);
    else if (e.key === 'PageUp') next = addMonths(d, -1).slice(0, 8) + d.slice(8);
    else if (e.key === 'Home') next = startOfWeek(d, this.wso);
    else if (e.key === 'End') next = addDays(startOfWeek(d, this.wso), 6);
    if (!next) return;
    e.preventDefault();
    this.focusDate = next;
    const a = this.curAnchor();
    if (this.mode === 'month' ? next.slice(0, 7) !== a.slice(0, 7) && !this.querySelector(`[data-day="${next}"]`) : !this.querySelector(`[data-day="${next}"]`)) this.anchor = next;
    this.requestRender();
  }

  // ---------------------------------------------------------------- moving

  private async moveItem(it: DayItem, toDate: string): Promise<void> {
    const coach = getCoach();
    const fromDate = it.date;
    if (toDate === fromDate) {
      this.requestRender();
      return;
    }
    const ev = emit(this, 'move', { id: it.id, fromDate, toDate, item: it.row }, { cancelable: true });
    if (ev.defaultPrevented) return;
    const target = this.getAttribute('write-target');
    // Optimistic local update.
    const prev = this.rows;
    if (this.rows) this.rows = this.rows.map((r) => (String(r.id) === it.id ? { ...r, date: toDate, ...(this.getAttribute('write-status') ? { status: this.getAttribute('write-status') } : {}) } : r));
    this.selId = it.id;
    this.selDate = toDate;
    this.requestRender();
    this.announce(`${it.title} moved to ${coach.format.date(toDate, 'long')}`);
    if (!target) return;
    try {
      const status = this.getAttribute('write-status');
      await coach.db.write(target, 'update', { date: toDate, ...(status ? { status } : {}) }, { [this.attr('write-key', 'id')]: it.id });
      const act = this.getAttribute('act-name');
      if (act) await coach.act(act, { id: it.id, from: fromDate, to: toDate }, { wake: true });
      emit(this, 'moved', { id: it.id, fromDate, toDate });
    } catch (e) {
      this.rows = prev;
      this.requestRender();
      coach.toast("Couldn't move that workout.");
      coach.report('error', `<rc-calendar> move failed: ${(e as Error).message}`);
    }
  }

  private onPointerDown(e: PointerEvent, item: DayItem, el: HTMLElement): void {
    if (!this.boolAttr('movable') || (e.pointerType === 'mouse' && e.button !== 0) || this.moveId) return;
    const st: DragState = { item, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, source: el };
    this.drag = st;
    const begin = () => {
      if (this.drag !== st) return;
      st.active = true;
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add('rc-cal__ghost');
      ghost.removeAttribute('data-id');
      ghost.style.width = `${el.getBoundingClientRect().width}px`;
      document.body.append(ghost);
      st.ghost = ghost;
      this.classList.add('is-dragging');
      this.announce(`Dragging ${item.title}`);
      try {
        el.setPointerCapture(st.pointerId);
      } catch {
        /* ignore */
      }
    };
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
      // start on first significant movement
    } else {
      st.timer = setTimeout(begin, 300);
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== st.pointerId || this.drag !== st) return;
      const dx = ev.clientX - st.startX;
      const dy = ev.clientY - st.startY;
      if (!st.active) {
        if (Math.hypot(dx, dy) > (ev.pointerType === 'touch' ? 10 : 5)) {
          if (ev.pointerType === 'touch') return cleanup(); // user is scrolling
          begin();
        } else return;
      }
      ev.preventDefault();
      if (st.ghost) {
        st.ghost.style.transform = `translate(${ev.clientX - 20}px, ${ev.clientY - 20}px)`;
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-date]');
      const date = under?.getAttribute('data-date') ?? undefined;
      if (date !== st.over) {
        this.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
        under?.classList.add('is-drop');
        st.over = date;
      }
    };
    const touchBlock = (ev: TouchEvent) => {
      if (st.active) ev.preventDefault();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== st.pointerId) return;
      const dropped = st.active ? st.over : undefined;
      const wasActive = st.active;
      cleanup();
      if (wasActive) {
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        if (dropped && dropped !== item.date) void this.moveItem(item, dropped);
        else this.requestRender();
      }
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === st.pointerId) {
        cleanup();
        this.requestRender();
      }
    };
    const cleanup = () => {
      if (st.timer) clearTimeout(st.timer);
      st.ghost?.remove();
      this.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
      this.classList.remove('is-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', touchBlock);
      st.active = false;
      if (this.drag === st) this.drag = null;
      if (this.deferred) {
        this.deferred = false;
        this.requestRender();
      }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', touchBlock, { passive: false });
  }
}

export function registerCalendar(): void {
  define('rc-week-strip', RcWeekStrip);
  define('rc-calendar', RcCalendar);
}
