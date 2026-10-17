// Unified input: keyboard + mouse, gamepad (standard mapping) and dual virtual sticks on touch.
// Continuous state is read through getMove()/getAim(); one-shot actions are queued
// and consumed by the simulation, so a press is never lost between fixed ticks.

const KEY_ACTIONS = {
  Space: 'bomb',
  KeyE: 'bomb',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  KeyQ: 'dash',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'mute',
  Backquote: 'debug',
  F3: 'debug',
};

const PAD_ACTIONS = { 0: 'confirm', 4: 'bomb', 5: 'dash', 6: 'dash', 9: 'pause', 12: 'navUp', 13: 'navDown', 14: 'navLeft', 15: 'navRight' };
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3']);
const DEADZONE = 0.2;
const STICK_RADIUS = 56;

const deadzone = (x, y) => {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  const s = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
  return [x * s, y * s];
};

export class Input {
  constructor(target) {
    this.keys = new Set();
    this.actions = new Set();
    this.mouse = { x: 0, y: 0, down: false, seen: false };
    this.sticks = { move: null, aim: null };
    this.pad = { lx: 0, ly: 0, rx: 0, ry: 0, fire: false, buttons: [] };
    this.device = 'keyboard';
    this.touchCapable = false;
    this._move = { x: 0, y: 0 };
    this._aim = { x: 0, y: 0, fire: false };

    addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code) && !(e.target instanceof HTMLButtonElement && e.code === 'Space')) e.preventDefault();
      this.keys.add(e.code);
      this.device = 'keyboard';
      if (!e.repeat && KEY_ACTIONS[e.code]) this.actions.add(KEY_ACTIONS[e.code]);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.down = false;
    });

    target.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.seen = true;
      this.device = 'keyboard';
    });
    target.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2) this.actions.add('bomb');
      this.device = 'keyboard';
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    const opts = { passive: false };
    target.addEventListener('touchstart', (e) => this._touchStart(e), opts);
    target.addEventListener('touchmove', (e) => this._touchMove(e), opts);
    target.addEventListener('touchend', (e) => this._touchEnd(e), opts);
    target.addEventListener('touchcancel', (e) => this._touchEnd(e), opts);
  }

  /** Queue an action from outside (e.g. on-screen touch buttons). */
  push(action) {
    this.actions.add(action);
  }

  consume(action) {
    return this.actions.delete(action);
  }

  /** Drop actions nobody consumed this tick so they don't fire later out of context. */
  flush() {
    this.actions.clear();
  }

  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) return;
    const pad = this.pad;
    [pad.lx, pad.ly] = deadzone(gp.axes[0] || 0, gp.axes[1] || 0);
    [pad.rx, pad.ry] = deadzone(gp.axes[2] || 0, gp.axes[3] || 0);
    pad.fire = (gp.buttons[7] && gp.buttons[7].value > 0.3) || Math.hypot(pad.rx, pad.ry) > 0.35;
    gp.buttons.forEach((b, i) => {
      const was = pad.buttons[i];
      pad.buttons[i] = b.pressed;
      if (b.pressed && !was && PAD_ACTIONS[i]) this.actions.add(PAD_ACTIONS[i]);
    });
    if (pad.lx || pad.ly || pad.rx || pad.ry || gp.buttons.some((b) => b.pressed)) this.device = 'gamepad';
  }

  getMove() {
    const m = this._move;
    let x = 0;
    let y = 0;
    const k = this.keys;
    if (k.has('KeyA')) x -= 1;
    if (k.has('KeyD')) x += 1;
    if (k.has('KeyW')) y -= 1;
    if (k.has('KeyS')) y += 1;
    if (x || y) {
      const l = Math.hypot(x, y);
      x /= l;
      y /= l;
    } else if (this.sticks.move) {
      const s = this.sticks.move;
      x = s.dx;
      y = s.dy;
    } else if (this.pad.lx || this.pad.ly) {
      x = this.pad.lx;
      y = this.pad.ly;
    }
    m.x = x;
    m.y = y;
    return m;
  }

  /** Aim direction (unnormalised) and fire flag. `px/py` = player position in CSS pixels. */
  getAim(px, py) {
    const a = this._aim;
    const k = this.keys;
    let x = 0;
    let y = 0;
    if (k.has('ArrowLeft')) x -= 1;
    if (k.has('ArrowRight')) x += 1;
    if (k.has('ArrowUp')) y -= 1;
    if (k.has('ArrowDown')) y += 1;
    if (x || y) {
      a.x = x; a.y = y; a.fire = true;
    } else if (this.sticks.aim) {
      const s = this.sticks.aim;
      a.x = s.dx; a.y = s.dy;
      a.fire = Math.hypot(s.dx, s.dy) > 0.25;
    } else if (this.device === 'gamepad') {
      a.x = this.pad.rx; a.y = this.pad.ry;
      a.fire = this.pad.fire;
    } else if (this.mouse.seen) {
      a.x = this.mouse.x - px; a.y = this.mouse.y - py;
      a.fire = this.mouse.down;
    } else {
      a.x = 0; a.y = 0; a.fire = false;
    }
    return a;
  }

  _touchStart(e) {
    e.preventDefault();
    this.touchCapable = true;
    this.device = 'touch';
    for (const t of e.changedTouches) {
      const left = t.clientX < innerWidth / 2;
      const slot = left ? 'move' : 'aim';
      if (this.sticks[slot]) continue;
      this.sticks[slot] = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY, dx: 0, dy: 0 };
    }
  }

  _touchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      for (const slot of ['move', 'aim']) {
        const s = this.sticks[slot];
        if (!s || s.id !== t.identifier) continue;
        let dx = t.clientX - s.ox;
        let dy = t.clientY - s.oy;
        const d = Math.hypot(dx, dy);
        // Floating stick: the origin follows the finger once it overshoots the radius.
        if (d > STICK_RADIUS) {
          s.ox += (dx / d) * (d - STICK_RADIUS);
          s.oy += (dy / d) * (d - STICK_RADIUS);
          dx = t.clientX - s.ox;
          dy = t.clientY - s.oy;
        }
        s.x = t.clientX;
        s.y = t.clientY;
        s.dx = dx / STICK_RADIUS;
        s.dy = dy / STICK_RADIUS;
      }
    }
  }

  _touchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      for (const slot of ['move', 'aim']) {
        if (this.sticks[slot] && this.sticks[slot].id === t.identifier) this.sticks[slot] = null;
      }
    }
  }

  static get stickRadius() {
    return STICK_RADIUS;
  }
}
