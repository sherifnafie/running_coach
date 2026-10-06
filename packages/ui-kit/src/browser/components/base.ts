/**
 * Component base classes. Components are light-DOM custom elements (no shadow DOM) so the coach's
 * own CSS can style them and axe/screen readers see plain DOM. They build their static structure
 * once (`setup`) and re-render (`render`) when attributes or data change.
 */
import type { Coach, Unsubscribe } from '../coach';
import { isRecord, parseJson, sqlTargets, type Row } from '../util';

let coachRef: Coach | undefined;
export function setCoach(c: Coach): void {
  coachRef = c;
}
export function getCoach(): Coach {
  if (!coachRef) throw new Error('UI kit: coach not initialised');
  return coachRef;
}

/** Run `fn` once the document has been parsed (children are present). */
export function whenParsed(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

export function emit<T>(el: Element, name: string, detail?: T, init: { cancelable?: boolean } = {}): CustomEvent<T> {
  const ev = new CustomEvent<T>(name, { detail: detail as T, bubbles: true, composed: true, cancelable: init.cancelable });
  el.dispatchEvent(ev);
  return ev;
}

export abstract class RcElement extends HTMLElement {
  private didSetup = false;
  private queued = false;
  private envUnsub?: Unsubscribe;

  connectedCallback(): void {
    whenParsed(() => {
      if (!this.isConnected) return;
      if (!this.didSetup) {
        this.didSetup = true;
        this.setup();
      }
      this.render();
      this.envUnsub?.();
      this.envUnsub = getCoach().onEnv(() => this.requestRender());
      this.connected();
    });
  }

  disconnectedCallback(): void {
    this.envUnsub?.();
    this.envUnsub = undefined;
    this.disconnected();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.didSetup || oldValue === newValue) return;
    this.attrChanged(name);
    this.requestRender();
  }

  /** Coalesce multiple changes into one render. */
  requestRender(): void {
    if (!this.didSetup || this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.isConnected) this.render();
    });
  }

  protected get isSetup(): boolean {
    return this.didSetup;
  }

  /** Build static DOM once. */
  protected setup(): void {}
  /** (Re)render dynamic parts. */
  protected abstract render(): void;
  protected connected(): void {}
  protected disconnected(): void {}
  protected attrChanged(_name: string): void {}

  protected attr(name: string, fallback = ''): string {
    return this.getAttribute(name) ?? fallback;
  }
  protected boolAttr(name: string): boolean {
    const v = this.getAttribute(name);
    return v !== null && v !== 'false' && v !== '0';
  }
}

/**
 * Data-bound element: `sql` (+ optional `params` JSON array and `deps`) runs through coach.db.query
 * once the bridge is ready and re-runs when the underlying tables change. Rows can also be set
 * directly with the `data` property.
 */
export abstract class RcBound extends RcElement {
  static baseAttrs = ['sql', 'params', 'deps'];

  rows: Row[] | null = null;
  error: string | null = null;
  private fetching = false;
  private unsub?: Unsubscribe;
  private seq = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  /** True until the first query result (or error) arrived, and while a refresh is running. */
  get loading(): boolean {
    return this.fetching || (this.hasAttribute('sql') && this.rows === null && this.error === null);
  }

  get data(): Row[] | null {
    return this.rows;
  }
  set data(v: Row[] | null) {
    this.rows = Array.isArray(v) ? v : null;
    this.error = null;
    this.requestRender();
  }

  /** Re-run the query now. */
  refresh(): Promise<void> {
    return getCoach().track(this.load());
  }

  protected override connected(): void {
    this.bind();
  }
  protected override disconnected(): void {
    this.unbind();
  }
  protected override attrChanged(name: string): void {
    if (RcBound.baseAttrs.includes(name)) this.bind();
  }

  private unbind(): void {
    this.unsub?.();
    this.unsub = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private bind(): void {
    this.unbind();
    const sql = this.getAttribute('sql');
    if (!sql || !this.isConnected) return;
    // SQL with ? placeholders waits for its `params` attribute (set by the view's script).
    if (!this.hasAttribute('params') && /\?\d*/.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) return;
    void this.refresh();
    const coach = getCoach();
    const deps = this.getAttribute('deps');
    const targets = deps
      ? deps
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => (d.includes(':') ? d : `db:${d}`))
      : sqlTargets(sql);
    this.unsub = coach.subscribe(targets.length ? targets : ['db:*'], () => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => void this.refresh(), 60);
    });
  }

  private async load(): Promise<void> {
    const sql = this.getAttribute('sql');
    if (!sql) return;
    const my = ++this.seq;
    const coach = getCoach();
    this.setAttribute('aria-busy', 'true');
    this.fetching = true;
    try {
      let params: unknown[] | undefined;
      const raw = this.getAttribute('params');
      if (raw) {
        const p = parseJson<unknown>(raw);
        if (!Array.isArray(p)) throw new Error('params must be a JSON array');
        params = p;
      }
      await coach.ready;
      const rows = await coach.db.query(sql, params);
      if (my !== this.seq) return;
      this.rows = rows;
      this.error = null;
    } catch (e) {
      if (my !== this.seq) return;
      this.error = (e as Error).message || String(e);
      coach.report('error', `<${this.localName}> query failed: ${this.error}`, { sql });
    } finally {
      if (my === this.seq) {
        this.fetching = false;
        this.removeAttribute('aria-busy');
        this.render();
      }
    }
  }

  /** Standard inline error element. */
  protected errorEl(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'rc-error';
    d.setAttribute('role', 'alert');
    d.textContent = `Couldn’t load this section. ${this.error ?? ''}`.trim();
    return d;
  }
}

/** Call `cb(width)` whenever the element's width changes (rAF-throttled). Returns a disposer. */
export function observeWidth(el: HTMLElement, cb: (w: number) => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let last = 0;
  let raf = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(el.clientWidth);
    if (w > 0 && w !== last) {
      last = w;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => cb(w));
    }
  });
  ro.observe(el);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}

export function define(name: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(name)) customElements.define(name, ctor);
}

export { isRecord };
