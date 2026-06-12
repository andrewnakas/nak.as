// Keyboard (and later gamepad/touch) → button bitmask matching sim/src/input.rs.

export const BTN = {
  UP: 1 << 0,
  DOWN: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  A: 1 << 4,
  B: 1 << 5,
  START: 1 << 6,
  SELECT: 1 << 7,
};

const KEY_MAP = {
  ArrowUp: BTN.UP, KeyW: BTN.UP,
  ArrowDown: BTN.DOWN, KeyS: BTN.DOWN,
  ArrowLeft: BTN.LEFT, KeyA: BTN.LEFT,
  ArrowRight: BTN.RIGHT, KeyD: BTN.RIGHT,
  KeyZ: BTN.A, KeyJ: BTN.A, Space: BTN.A,
  KeyX: BTN.B, KeyK: BTN.B,
  Enter: BTN.START,
  ShiftLeft: BTN.SELECT, ShiftRight: BTN.SELECT,
};

export class Input {
  constructor() {
    this.buttons = 0;
    /// While true (inventory open), the game reads 0 buttons.
    this.suppressed = false;
    window.addEventListener('keydown', (e) => {
      const bit = KEY_MAP[e.code];
      if (bit) {
        this.buttons |= bit;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const bit = KEY_MAP[e.code];
      if (bit) {
        this.buttons &= ~bit;
        e.preventDefault();
      }
    });
    window.addEventListener('blur', () => {
      this.buttons = 0;
    });
  }

  read() {
    return this.suppressed ? 0 : this.buttons;
  }
}
