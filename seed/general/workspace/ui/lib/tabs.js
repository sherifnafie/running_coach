/**
 * <rc-tabs> with <rc-tab label="…"> children. Keyboard: arrow keys, Home and End move between tabs.
 *   <rc-tabs value="week">
 *     <rc-tab label="This week" value="week">…</rc-tab>
 *     <rc-tab label="Next week" value="next">…</rc-tab>
 *   </rc-tabs>
 * Fires `change` with detail { value } when the athlete picks a tab. Yours to change.
 */
let uid = 0;

class RcTabs extends HTMLElement {
  connectedCallback() {
    if (this._list) return;
    this._id = `rc-tabs-${++uid}`;
    this._list = document.createElement('div');
    this._list.className = 'rc-tabs__list';
    this._list.setAttribute('role', 'tablist');
    this._list.addEventListener('keydown', (e) => this._onKey(e));
    this.prepend(this._list);
    this._build();
  }

  get panels() {
    return [...this.children].filter((el) => el.tagName === 'RC-TAB');
  }

  get value() {
    return this.getAttribute('value') ?? this.panels[0]?.getAttribute('value') ?? '0';
  }

  set value(v) {
    this.setAttribute('value', v);
    this._select(v, false);
  }

  _build() {
    this._list.replaceChildren();
    this.panels.forEach((panel, i) => {
      const value = panel.getAttribute('value') ?? String(i);
      panel.setAttribute('value', value);
      panel.id ||= `${this._id}-panel-${i}`;
      panel.setAttribute('role', 'tabpanel');
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'rc-tabs__tab';
      tab.id = `${this._id}-tab-${i}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      tab.dataset.value = value;
      tab.textContent = panel.getAttribute('label') ?? value;
      tab.addEventListener('click', () => this._select(value, true));
      panel.setAttribute('aria-labelledby', tab.id);
      this._list.append(tab);
    });
    this._select(this.value, false);
  }

  _select(value, fromUser) {
    if (!this._list) return;
    for (const tab of this._list.children) {
      const on = tab.dataset.value === value;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of this.panels) panel.hidden = panel.getAttribute('value') !== value;
    if (fromUser) {
      this.setAttribute('value', value);
      this.dispatchEvent(new CustomEvent('change', { detail: { value }, bubbles: true }));
    }
  }

  _onKey(e) {
    const tabs = [...this._list.children];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    target.focus();
    this._select(target.dataset.value, true);
  }
}

class RcTab extends HTMLElement {}

if (!customElements.get('rc-tab')) customElements.define('rc-tab', RcTab);
if (!customElements.get('rc-tabs')) customElements.define('rc-tabs', RcTabs);
