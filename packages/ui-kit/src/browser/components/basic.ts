/**
 * Layout and basic controls: rc-page, rc-header, rc-card, rc-icon, rc-badge, rc-chip, rc-button,
 * rc-empty, rc-segmented, rc-markdown.
 */
import icons from '../icons.json';
import { renderMarkdown } from '../markdown';
import { h, parseJson, s } from '../util';
import { RcElement, define, emit, getCoach } from './base';

// ----------------------------------------------------------------------------- icons

const ICONS = icons as Record<string, string[]>;
export const iconNames = Object.keys(ICONS);

export function iconSvg(name: string, size = 20): SVGSVGElement {
  const paths = ICONS[name] ?? ICONS.circle ?? [];
  return s(
    'svg',
    { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'rc-icon__svg' },
    ...paths.map((d) => s('path', { d })),
  );
}

class RcIcon extends RcElement {
  static observedAttributes = ['name', 'size', 'label'];
  protected render(): void {
    const label = this.getAttribute('label');
    if (label) {
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', label);
    } else {
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
      this.setAttribute('aria-hidden', 'true');
    }
    this.replaceChildren(iconSvg(this.attr('name', 'circle'), Number(this.attr('size', '20')) || 20));
  }
}

// ----------------------------------------------------------------------------- page / header / card

class RcPage extends RcElement {
  protected override setup(): void {
    if (!this.hasAttribute('role') && !document.querySelector('[role=main], main')) this.setAttribute('role', 'main');
  }
  protected render(): void {}
}

class RcHeader extends RcElement {
  static observedAttributes = ['heading', 'subheading', 'back', 'level'];
  private titleEl!: HTMLElement;
  private subEl!: HTMLElement;
  private actions!: HTMLElement;
  private backEl?: HTMLButtonElement;

  protected override setup(): void {
    const extra = [...this.childNodes];
    this.titleEl = h('h1', { class: 'rc-header__title' });
    this.subEl = h('p', { class: 'rc-header__sub' });
    this.actions = h('div', { class: 'rc-header__actions' });
    for (const n of extra) this.actions.append(n);
    this.replaceChildren(h('div', { class: 'rc-header__row' }, h('div', { class: 'rc-header__text' }, this.titleEl, this.subEl), this.actions));
  }

  protected render(): void {
    const level = this.attr('level', '1') === '2' ? 'h2' : 'h1';
    if (this.titleEl.localName !== level) {
      const el = h(level, { class: 'rc-header__title' });
      this.titleEl.replaceWith(el);
      this.titleEl = el;
    }
    this.titleEl.textContent = this.attr('heading');
    this.subEl.textContent = this.attr('subheading');
    this.subEl.hidden = !this.attr('subheading');
    this.actions.hidden = this.actions.childNodes.length === 0;
    const back = this.getAttribute('back');
    if (back && !this.backEl) {
      this.backEl = h('button', { type: 'button', class: 'rc-header__back', 'aria-label': 'Back' }, iconSvg('chevron-left', 22));
      this.backEl.addEventListener('click', () => {
        const target = this.getAttribute('back');
        if (emit(this, 'back', { to: target }, { cancelable: true }).defaultPrevented) return;
        if (target) getCoach().navigate(target);
      });
      this.querySelector('.rc-header__row')?.prepend(this.backEl);
    } else if (!back && this.backEl) {
      this.backEl.remove();
      this.backEl = undefined;
    }
  }
}

class RcCard extends RcElement {
  static observedAttributes = ['heading', 'subheading', 'tone', 'interactive'];
  private head?: HTMLElement;

  protected override setup(): void {
    this.addEventListener('keydown', (e) => {
      if (this.boolAttr('interactive') && e.target === this && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.click();
      }
    });
    this.addEventListener('click', () => {
      if (this.boolAttr('interactive')) emit(this, 'press');
    });
  }

  protected render(): void {
    const heading = this.getAttribute('heading');
    const sub = this.getAttribute('subheading');
    if (heading || sub) {
      if (!this.head) {
        this.head = h('div', { class: 'rc-card__head' });
        this.prepend(this.head);
      }
      const parts: HTMLElement[] = [];
      if (heading) parts.push(h('h2', { class: 'rc-card__title' }, heading));
      if (sub) parts.push(h('p', { class: 'rc-card__sub' }, sub));
      this.head.replaceChildren(...parts);
    } else if (this.head) {
      this.head.remove();
      this.head = undefined;
    }
    if (this.boolAttr('interactive')) {
      this.setAttribute('role', 'button');
      this.tabIndex = 0;
    } else if (this.getAttribute('role') === 'button') {
      this.removeAttribute('role');
      this.removeAttribute('tabindex');
    }
  }
}

// ----------------------------------------------------------------------------- badge / chip

class RcBadge extends RcElement {
  static observedAttributes = ['tone'];
  protected render(): void {}
}

class RcChip extends RcElement {
  static observedAttributes = ['selected', 'selectable', 'interactive', 'disabled', 'tone'];
  private inner?: HTMLElement;
  private label: Node[] = [];

  protected override setup(): void {
    this.label = [...this.childNodes];
  }

  protected render(): void {
    const interactive = this.boolAttr('selectable') || this.boolAttr('interactive');
    const wanted = interactive ? 'button' : 'span';
    if (!this.inner || this.inner.localName !== wanted) {
      this.inner = h(wanted, { class: 'rc-chip__body' });
      if (wanted === 'button') {
        this.inner.setAttribute('type', 'button');
        this.inner.addEventListener('click', () => {
          if (this.boolAttr('selectable')) {
            this.toggleAttribute('selected', !this.boolAttr('selected'));
            emit(this, 'change', { selected: this.boolAttr('selected'), value: this.getAttribute('value') });
          } else emit(this, 'press', { value: this.getAttribute('value') });
        });
      }
      this.inner.append(...this.label);
      this.replaceChildren(this.inner);
    }
    if (this.inner instanceof HTMLButtonElement) {
      this.inner.disabled = this.boolAttr('disabled');
      if (this.boolAttr('selectable')) this.inner.setAttribute('aria-pressed', String(this.boolAttr('selected')));
      else this.inner.removeAttribute('aria-pressed');
    }
  }
}

// ----------------------------------------------------------------------------- button

class RcButton extends RcElement {
  static observedAttributes = ['disabled', 'loading', 'icon', 'label', 'aria-label', 'type'];
  private btn!: HTMLButtonElement;
  private labelEl!: HTMLSpanElement;

  protected override setup(): void {
    const kids = [...this.childNodes];
    this.labelEl = h('span', { class: 'rc-btn__label' });
    this.labelEl.append(...kids);
    this.btn = h('button', { type: 'button', class: 'rc-btn' });
    this.btn.append(this.labelEl);
    this.replaceChildren(this.btn);
  }

  override focus(options?: FocusOptions): void {
    this.btn?.focus(options);
  }

  protected render(): void {
    const label = this.getAttribute('label');
    if (label != null) this.labelEl.textContent = label;
    this.btn.setAttribute('type', this.attr('type', 'button'));
    this.btn.disabled = this.boolAttr('disabled') || this.boolAttr('loading');
    if (this.boolAttr('loading')) this.btn.setAttribute('aria-busy', 'true');
    else this.btn.removeAttribute('aria-busy');
    const al = this.getAttribute('aria-label');
    if (al) this.btn.setAttribute('aria-label', al);
    this.btn.querySelector('.rc-icon__svg')?.remove();
    const icon = this.getAttribute('icon');
    if (icon) this.btn.prepend(iconSvg(icon, 20));
    if (this.boolAttr('loading') && !this.btn.querySelector('.rc-spinner')) this.btn.prepend(h('span', { class: 'rc-spinner', 'aria-hidden': 'true' }));
    if (!this.boolAttr('loading')) this.btn.querySelector('.rc-spinner')?.remove();
  }
}

// ----------------------------------------------------------------------------- empty state

class RcEmpty extends RcElement {
  static observedAttributes = ['heading', 'message', 'icon'];
  private actions!: HTMLElement;
  private msgText = '';
  private msg!: HTMLElement;

  protected override setup(): void {
    const kids = [...this.childNodes];
    this.actions = h('div', { class: 'rc-empty__actions' });
    const text: string[] = [];
    for (const n of kids) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (n.textContent?.trim()) text.push(n.textContent.trim());
      } else this.actions.append(n);
    }
    this.msgText = text.join(' ');
    this.msg = h('p', { class: 'rc-empty__msg' });
    this.replaceChildren(h('div', { class: 'rc-empty__icon' }), h('h3', { class: 'rc-empty__title' }), this.msg, this.actions);
    this.setAttribute('role', 'status');
  }

  protected render(): void {
    const icon = this.querySelector('.rc-empty__icon');
    icon?.replaceChildren(iconSvg(this.attr('icon', 'info'), 32));
    const title = this.querySelector('.rc-empty__title') as HTMLElement;
    title.textContent = this.attr('heading');
    title.hidden = !this.attr('heading');
    this.msg.textContent = this.getAttribute('message') ?? this.msgText;
    this.msg.hidden = !this.msg.textContent;
    this.actions.hidden = this.actions.childNodes.length === 0;
  }
}

// ----------------------------------------------------------------------------- segmented control

interface SegOption {
  value: string;
  label: string;
}

class RcSegmented extends RcElement {
  static observedAttributes = ['options', 'value', 'label'];
  private group!: HTMLElement;

  protected override setup(): void {
    if (!this.hasAttribute('options')) {
      // allow <rc-segmented><option value="4">4 wk</option>...</rc-segmented>
      const opts = [...this.querySelectorAll('option, rc-option')].map((o) => ({ value: o.getAttribute('value') ?? o.textContent ?? '', label: o.textContent ?? '' }));
      if (opts.length) this.setAttribute('options', JSON.stringify(opts));
    }
    this.group = h('div', { class: 'rc-seg', role: 'radiogroup' });
    this.replaceChildren(this.group);
    this.group.addEventListener('keydown', (e) => {
      const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
      if (!keys.includes(e.key)) return;
      const btns = [...this.group.querySelectorAll<HTMLButtonElement>('button')];
      const idx = btns.findIndex((b) => b === document.activeElement);
      const next = btns[(idx + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
      if (next) {
        e.preventDefault();
        next.focus();
        next.click();
      }
    });
  }

  get options(): SegOption[] {
    const raw = this.getAttribute('options') ?? '';
    const parsed = parseJson<unknown>(raw);
    const list = Array.isArray(parsed) ? parsed : raw ? raw.split(',').map((x) => x.trim()) : [];
    return list
      .map((o): SegOption | null => {
        if (typeof o === 'string' || typeof o === 'number') return { value: String(o), label: String(o) };
        if (o && typeof o === 'object') {
          const r = o as Record<string, unknown>;
          const value = String(r.value ?? r.label ?? '');
          return { value, label: String(r.label ?? value) };
        }
        return null;
      })
      .filter((o): o is SegOption => !!o);
  }
  set options(v: SegOption[]) {
    this.setAttribute('options', JSON.stringify(v));
  }
  get value(): string {
    return this.getAttribute('value') ?? this.options[0]?.value ?? '';
  }
  set value(v: string) {
    this.setAttribute('value', v);
  }

  protected render(): void {
    const label = this.getAttribute('label');
    if (label) this.group.setAttribute('aria-label', label);
    const cur = this.value;
    this.group.replaceChildren(
      ...this.options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: 'rc-seg__opt',
            'aria-checked': String(o.value === cur),
            tabindex: o.value === cur ? 0 : -1,
            onClick: () => {
              if (o.value === this.value) return;
              this.setAttribute('value', o.value);
              emit(this, 'change', { value: o.value });
            },
          },
          o.label,
        ),
      ),
    );
  }
}

// ----------------------------------------------------------------------------- markdown

class RcMarkdown extends RcElement {
  static observedAttributes = ['src', 'file', 'empty', 'omit-title'];
  private text: string | null = null;
  private initial = '';
  private state: 'idle' | 'loading' | 'error' = 'idle';
  private unsub?: () => void;
  private seq = 0;

  get value(): string {
    return this.text ?? this.getAttribute('src') ?? this.initial;
  }
  set value(v: string) {
    this.text = v;
    this.requestRender();
  }

  protected override setup(): void {
    this.initial = this.textContent ?? '';
    this.replaceChildren();
  }

  protected override connected(): void {
    this.bindFile();
  }
  protected override disconnected(): void {
    this.unsub?.();
  }
  protected override attrChanged(name: string): void {
    if (name === 'file') this.bindFile();
    if (name === 'src') this.text = null;
  }

  private bindFile(): void {
    this.unsub?.();
    this.unsub = undefined;
    const file = this.getAttribute('file');
    if (!file) return;
    const coach = getCoach();
    const load = async () => {
      const my = ++this.seq;
      this.state = 'loading';
      try {
        await coach.ready;
        const t = await coach.files.read(file);
        if (my !== this.seq) return;
        this.text = t;
        this.state = 'idle';
      } catch (e) {
        if (my !== this.seq) return;
        this.text = '';
        this.state = 'error';
        coach.report('warn', `<rc-markdown> could not read ${file}: ${(e as Error).message}`);
      }
      this.requestRender();
    };
    void coach.track(load());
    this.unsub = coach.subscribe([`file:${file}`], () => void load());
  }

  protected render(): void {
    const src = this.value;
    this.classList.add('rc-md');
    if (!src.trim()) {
      const empty = this.getAttribute('empty');
      this.replaceChildren(empty ? h('p', { class: 'rc-md__empty' }, empty) : '');
      return;
    }
    this.replaceChildren(renderMarkdown(src, document, { omitTitle: this.getAttribute('omit-title') ?? undefined }));
  }
}

// ----------------------------------------------------------------------------- register

export function registerBasic(): void {
  define('rc-icon', RcIcon);
  define('rc-page', RcPage);
  define('rc-header', RcHeader);
  define('rc-card', RcCard);
  define('rc-badge', RcBadge);
  define('rc-chip', RcChip);
  define('rc-button', RcButton);
  define('rc-empty', RcEmpty);
  define('rc-segmented', RcSegmented);
  define('rc-markdown', RcMarkdown);
}
