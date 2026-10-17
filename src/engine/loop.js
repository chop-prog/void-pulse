/**
 * Fixed-timestep game loop ("Fix Your Timestep!").
 * Simulation runs at a constant rate regardless of display refresh rate,
 * which keeps physics deterministic and frame-rate independent.
 */
export class FixedLoop {
  constructor({ step = 1 / 120, maxFrame = 0.25, update, render }) {
    this.step = step;
    this.maxFrame = maxFrame;
    this.update = update;
    this.render = render;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this.fps = 60;
    this.workMs = 0;
  }

  start() {
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
  }

  _tick = (now) => {
    if (!this.running) return;
    const t0 = performance.now();
    let frame = (now - this.last) / 1000;
    this.last = now;
    if (frame > this.maxFrame) frame = this.maxFrame;
    if (frame > 0) this.fps += (1 / frame - this.fps) * 0.05;

    this.acc += frame;
    while (this.acc >= this.step) {
      this.update(this.step);
      this.acc -= this.step;
    }
    this.render(frame);

    this.workMs += (performance.now() - t0 - this.workMs) * 0.05;
    requestAnimationFrame(this._tick);
  };
}
