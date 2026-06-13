// On-screen Game Boy controls for touch devices: a D-pad on the left and
// A / B / START buttons on the right. Each control ORs the matching bits
// into Input.touchButtons; multi-touch is tracked per pointer so you can
// hold a direction and tap A at the same time (and get diagonals).

import { BTN } from './input.js';

const DPAD_BITS = { up: BTN.UP, down: BTN.DOWN, left: BTN.LEFT, right: BTN.RIGHT };

export function isTouchDevice() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const touchApi = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile|Tablet|Touch/i.test(navigator.userAgent);
  // A narrow viewport is a strong hint too (covers in-app webviews that hide
  // the touch APIs). Desktops with a mouse won't match the UA or coarse query.
  const narrow = Math.min(window.innerWidth, window.innerHeight) <= 820;
  return coarse || touchApi || mobileUa || (narrow && touchApi);
}

export class TouchControls {
  constructor(input, { onPack } = {}) {
    this.input = input;
    this.onPack = onPack;
    this.el = document.getElementById('touch-controls');
    if (!this.el) return;
    this.el.style.display = 'flex';
    document.body.classList.add('has-touch');

    this.dpad = this.el.querySelector('#dpad');
    // Per-pointer state: pointerId -> set of bits it currently holds.
    this.pointers = new Map();

    this._bindDpad();
    this._bindButtons();
    this._recompute();
  }

  // ---- D-pad: a single touch zone; direction comes from finger position
  // relative to the pad center, so a diagonal lights up two arrows. ----
  _bindDpad() {
    const handle = (e, down) => {
      e.preventDefault();
      for (const t of e.changedTouches ?? [e]) {
        const id = t.identifier ?? 'mouse';
        if (down) {
          this.pointers.set(`d${id}`, this._dirBits(t));
        } else {
          this.pointers.delete(`d${id}`);
        }
      }
      this._recompute();
    };
    const move = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches ?? [e]) {
        const id = t.identifier ?? 'mouse';
        if (this.pointers.has(`d${id}`)) {
          this.pointers.set(`d${id}`, this._dirBits(t));
          this._recompute();
        }
      }
    };
    this.dpad.addEventListener('touchstart', (e) => handle(e, true), { passive: false });
    this.dpad.addEventListener('touchmove', move, { passive: false });
    this.dpad.addEventListener('touchend', (e) => handle(e, false), { passive: false });
    this.dpad.addEventListener('touchcancel', (e) => handle(e, false), { passive: false });
  }

  /// Direction bits from a touch point inside the D-pad. A small dead zone
  /// at the center maps to no direction; otherwise the dominant axis (and a
  /// second axis when the angle is diagonal) lights up.
  _dirBits(touch) {
    const r = this.dpad.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = touch.clientX - cx;
    const dy = touch.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < r.width * 0.14) return 0; // dead zone
    let bits = 0;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    // Include an axis if it's at least ~40% of the other (gives a wide
    // diagonal band so eight-way feels natural).
    if (ax > ay * 0.4) bits |= dx < 0 ? BTN.LEFT : BTN.RIGHT;
    if (ay > ax * 0.4) bits |= dy < 0 ? BTN.UP : BTN.DOWN;
    return bits;
  }

  // ---- A / B face buttons + the pack (☰) button ----
  _bindButtons() {
    for (const btn of this.el.querySelectorAll('[data-btn]')) {
      const name = btn.dataset.btn;
      const bit = name === 'a' ? BTN.A : name === 'b' ? BTN.B : 0;
      const press = (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        const id = e.changedTouches?.[0]?.identifier ?? 'mouse';
        if (name === 'pack') {
          // ☰ opens/closes the inventory (the mobile stand-in for the I key).
          this.onPack?.();
        } else {
          this.pointers.set(`b${name}${id}`, bit);
          this._recompute();
        }
      };
      const release = (e) => {
        e.preventDefault();
        btn.classList.remove('pressed');
        const id = e.changedTouches?.[0]?.identifier ?? 'mouse';
        this.pointers.delete(`b${name}${id}`);
        this._recompute();
      };
      btn.addEventListener('touchstart', press, { passive: false });
      btn.addEventListener('touchend', release, { passive: false });
      btn.addEventListener('touchcancel', release, { passive: false });
    }
  }

  _recompute() {
    let bits = 0;
    for (const b of this.pointers.values()) bits |= b;
    this.input.setTouch(bits);
    // Light the active arrows for feedback.
    const dirBits = bits;
    for (const [name, bit] of Object.entries(DPAD_BITS)) {
      const arrow = this.dpad.querySelector(`.arrow-${name}`);
      if (arrow) arrow.classList.toggle('on', (dirBits & bit) !== 0);
    }
  }
}
