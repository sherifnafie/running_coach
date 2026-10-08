/**
 * <rc-sheet heading="…" id="details">…content…</rc-sheet>: a bottom sheet built on the native <dialog>, so focus,
 * Escape and the backdrop work everywhere. Open with `sheet.show()`, or any `<button data-open-sheet="details">` on
 * the page. Close with `sheet.close()`, the close button, Escape or a tap on the backdrop. Fires `open` and `close`.
 * Yours to change.
 */
class RcSheet extends HTMLElement {
  static observedAttributes = ['heading'];

  attributeChangedCallback() {
    if (!this._title) return;
    this._title.textContent = this.getAttribute('heading') ?? '';
    this._dialog.setAttribute('aria-label', this._title.textContent);
  }

  connectedCallback() {
    if (this._dialog) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'rc-sheet';
    const head = document.createElement('div');
    head.className = 'rc-sheet__head';
    const title = document.createElement('h2');
    title.textContent = this.getAttribute('heading') ?? '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rc-sheet__close';
    close.setAttribute('aria-label', this.getAttribute('close-label') ?? 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.close());
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'rc-sheet__body';
    body.append(...this.childNodes);
    dialog.append(head, body);
    // A tap on the backdrop (the dialog element itself, outside its content) closes the sheet.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) this.close();
    });
    dialog.addEventListener('close', () => this.dispatchEvent(new CustomEvent('close')));
    if (title.textContent) dialog.setAttribute('aria-label', title.textContent);
    this.append(dialog);
    this._dialog = dialog;
    this._title = title;
  }

  show() {
    if (!this._dialog.open) {
      this._dialog.showModal();
      this.dispatchEvent(new CustomEvent('open'));
    }
  }

  close() {
    if (this._dialog.open) this._dialog.close();
  }
}

if (!customElements.get('rc-sheet')) customElements.define('rc-sheet', RcSheet);

document.addEventListener('click', (e) => {
  const trigger = e.target instanceof Element ? e.target.closest('[data-open-sheet]') : null;
  if (!trigger) return;
  const sheet = document.getElementById(trigger.getAttribute('data-open-sheet'));
  if (sheet && typeof sheet.show === 'function') sheet.show();
});
