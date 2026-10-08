/**
 * <rc-timer>: a workout timer for use mid-session.
 *   <rc-timer></rc-timer>                                   stopwatch
 *   <rc-timer seconds="90" label="Rest"></rc-timer>         countdown
 *   <rc-timer rounds="6" steps='[{"label":"Run","seconds":180},{"label":"Walk","seconds":60}]'></rc-timer>
 *                                                           intervals: the steps repeated `rounds` times
 * Beeps for the last three seconds and at each change, vibrates where the device allows, and asks to keep the screen
 * on while running. Events: `timer-step` (detail { index, label, round }) and `timer-done` (detail { seconds }),
 * e.g. to log the session with coach.db.write. Labels: start-label, pause-label, reset-label, skip-label,
 * done-label, next-label attributes. Yours to change.
 */
const fmt = (s) => {
  const t = Math.max(0, Math.ceil(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

class RcTimer extends HTMLElement {
  connectedCallback() {
    if (this._time) return;
    this._label = this._el('div', 'rc-timer__label');
    this._time = this._el('div', 'rc-timer__time');
    this._time.setAttribute('role', 'timer');
    this._time.setAttribute('aria-live', 'off');
    this._next = this._el('div', 'rc-timer__next');
    const bar = this._el('div', 'rc-timer__bar');
    this._fill = document.createElement('span');
    bar.append(this._fill);
    const controls = this._el('div', 'rc-timer__controls');
    this._startBtn = this._button(this.getAttribute('start-label') ?? 'Start', '', () => (this._running ? this.pause() : this.start()));
    this._skipBtn = this._button(this.getAttribute('skip-label') ?? 'Skip', 'secondary', () => this.skip());
    this._resetBtn = this._button(this.getAttribute('reset-label') ?? 'Reset', 'ghost', () => this.reset());
    controls.append(this._startBtn, this._skipBtn, this._resetBtn);
    this.replaceChildren(this._label, this._time, this._next, bar, controls);
    this.reset();
  }

  disconnectedCallback() {
    this._stopLoop();
    this._releaseWakeLock();
  }

  /** The plan as a flat list of steps; empty for a stopwatch. */
  get plan() {
    let steps = [];
    try {
      steps = JSON.parse(this.getAttribute('steps') ?? '[]');
    } catch {
      steps = [];
    }
    if (!steps.length && this.hasAttribute('seconds')) steps = [{ label: this.getAttribute('label') ?? '', seconds: Number(this.getAttribute('seconds')) }];
    const rounds = Math.max(1, Number(this.getAttribute('rounds') ?? 1) || 1);
    const flat = [];
    for (let r = 1; r <= rounds; r++) for (const s of steps) flat.push({ label: s.label ?? '', seconds: Number(s.seconds) || 0, round: r, rounds });
    return flat.filter((s) => s.seconds > 0);
  }

  start() {
    if (this._finished) this.reset();
    this._running = true;
    this._last = performance.now();
    this._startBtn.setAttribute('label', this.getAttribute('pause-label') ?? 'Pause');
    this._ensureAudio();
    this._requestWakeLock();
    if (this._elapsed === 0 && this._steps.length) this._announce();
    const tick = () => {
      if (!this._running) return;
      const now = performance.now();
      this._advance((now - this._last) / 1000);
      this._last = now;
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  pause() {
    this._running = false;
    this._stopLoop();
    this._startBtn.setAttribute('label', this.getAttribute('start-label') ?? 'Start');
    this._releaseWakeLock();
  }

  reset() {
    this.pause();
    this._steps = this.plan;
    this._index = 0;
    this._inStep = 0;
    this._elapsed = 0;
    this._finished = false;
    this._lastBeep = null;
    this._skipBtn.hidden = this._steps.length < 2;
    this._paint();
  }

  skip() {
    if (this._index < this._steps.length) this._nextStep();
  }

  _advance(dt) {
    this._elapsed += dt;
    if (!this._steps.length) return this._paint();
    this._inStep += dt;
    const step = this._steps[this._index];
    const left = step.seconds - this._inStep;
    const whole = Math.ceil(left);
    if (whole <= 3 && whole >= 1 && whole !== this._lastBeep) {
      this._lastBeep = whole;
      this._beep(660, 0.12);
    }
    if (left <= 0) this._nextStep();
    this._paint();
  }

  _nextStep() {
    this._index += 1;
    this._inStep = 0;
    this._lastBeep = null;
    if (this._index >= this._steps.length) {
      this._finished = true;
      this.pause();
      this._beep(880, 0.5);
      this._vibrate([300, 100, 300]);
      this.dispatchEvent(new CustomEvent('timer-done', { detail: { seconds: Math.round(this._elapsed) }, bubbles: true }));
    } else {
      this._beep(880, 0.25);
      this._vibrate(200);
      this._announce();
    }
    this._paint();
  }

  _announce() {
    const s = this._steps[this._index];
    if (s) this.dispatchEvent(new CustomEvent('timer-step', { detail: { index: this._index, label: s.label, round: s.round }, bubbles: true }));
  }

  _paint() {
    const steps = this._steps;
    if (!steps.length) {
      this._label.textContent = this.getAttribute('label') ?? '';
      this._time.textContent = fmt(this._elapsed);
      this._next.textContent = '';
      this._fill.parentElement.hidden = true;
      return;
    }
    if (this._finished) {
      this._label.textContent = this.getAttribute('done-label') ?? 'Done';
      this._time.textContent = fmt(0);
      this._next.textContent = '';
      this._fill.style.width = '100%';
      return;
    }
    const step = steps[this._index];
    const next = steps[this._index + 1];
    const rounds = step.rounds > 1 ? ` · ${step.round}/${step.rounds}` : '';
    this._label.textContent = `${step.label}${rounds}`;
    this._time.textContent = fmt(step.seconds - this._inStep);
    this._next.textContent = next ? `${this.getAttribute('next-label') ?? 'Next'}: ${next.label} ${fmt(next.seconds)}` : '';
    const total = steps.reduce((a, s) => a + s.seconds, 0);
    const done = steps.slice(0, this._index).reduce((a, s) => a + s.seconds, 0) + this._inStep;
    this._fill.style.width = `${Math.min(100, (done / total) * 100)}%`;
  }

  _ensureAudio() {
    try {
      this._audio ??= new AudioContext();
      if (this._audio.state === 'suspended') void this._audio.resume();
    } catch {
      this._audio = null;
    }
  }

  _beep(freq, seconds) {
    const ctx = this._audio;
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + seconds);
    } catch {
      /* audio is a nicety */
    }
  }

  _vibrate(pattern) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* not allowed here */
    }
  }

  async _requestWakeLock() {
    try {
      this._wakeLock ??= await navigator.wakeLock?.request('screen');
    } catch {
      /* not allowed in this frame; the timer still works */
    }
  }

  _releaseWakeLock() {
    void this._wakeLock?.release?.().catch(() => {});
    this._wakeLock = null;
  }

  _stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _el(tag, cls) {
    const el = document.createElement(tag);
    el.className = cls;
    return el;
  }

  _button(label, variant, onClick) {
    const b = document.createElement('rc-button');
    if (variant) b.setAttribute('variant', variant);
    b.setAttribute('label', label);
    b.addEventListener('click', onClick);
    return b;
  }
}

if (!customElements.get('rc-timer')) customElements.define('rc-timer', RcTimer);
