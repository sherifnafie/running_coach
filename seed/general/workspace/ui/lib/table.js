/**
 * <rc-table>: a sortable table. Set properties from view.js:
 *   table.columns = [{ key: 'date', label: 'Date' }, { key: 'kg', label: 'Load', numeric: true, format: (v) => `${v} kg` }];
 *   table.rows = [{ date: '2026-10-08', kg: 100 }, …];
 * Tap a header to sort; tap again to reverse. `sort="date:desc"` sets the starting order. Yours to change.
 */
class RcTable extends HTMLElement {
  constructor() {
    super();
    this._columns = [];
    this._rows = [];
    const [key, dir] = (this.getAttribute('sort') ?? '').split(':');
    this._sort = key ? { key, dir: dir === 'desc' ? 'desc' : 'asc' } : null;
  }

  set columns(v) { this._columns = Array.isArray(v) ? v : []; this._render(); }
  get columns() { return this._columns; }
  set rows(v) { this._rows = Array.isArray(v) ? v : []; this._render(); }
  get rows() { return this._rows; }

  connectedCallback() { this._render(); }

  _sorted() {
    if (!this._sort) return this._rows;
    const { key, dir } = this._sort;
    const sign = dir === 'desc' ? -1 : 1;
    return [...this._rows].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign;
    });
  }

  _render() {
    if (!this.isConnected) return;
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const col of this._columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      if (col.numeric) th.className = 'num';
      const button = document.createElement('button');
      button.type = 'button';
      const active = this._sort?.key === col.key;
      button.textContent = `${col.label ?? col.key}${active ? (this._sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}`;
      if (active) th.setAttribute('aria-sort', this._sort.dir === 'asc' ? 'ascending' : 'descending');
      button.addEventListener('click', () => {
        this._sort = { key: col.key, dir: active && this._sort.dir === 'asc' ? 'desc' : 'asc' };
        this._render();
      });
      th.append(button);
      head.append(th);
    }
    const body = table.createTBody();
    for (const row of this._sorted()) {
      const tr = body.insertRow();
      for (const col of this._columns) {
        const td = tr.insertCell();
        if (col.numeric) td.className = 'num';
        const v = row[col.key];
        td.textContent = v == null ? '–' : col.format ? col.format(v, row) : String(v);
      }
    }
    this.replaceChildren(table);
  }
}

if (!customElements.get('rc-table')) customElements.define('rc-table', RcTable);
