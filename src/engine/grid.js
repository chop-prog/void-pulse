/**
 * Spring-mass background grid that warps under explosions and gravity wells.
 *
 * Each interior node stores a displacement from its rest position. Forces:
 *   - an anchor spring pulling the node back to rest,
 *   - a coupling term (discrete Laplacian of displacement) that propagates ripples to neighbours,
 *   - viscous damping.
 * Integrated with semi-implicit Euler; border nodes are pinned.
 */
export class WarpGrid {
  constructor(width, height, spacing = 40) {
    this.spacing = spacing;
    this.cols = Math.round(width / spacing) + 1;
    this.rows = Math.round(height / spacing) + 1;
    const n = this.cols * this.rows;
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.stiffness = 30;
    this.coupling = 70;
    this.damping = 5;
    this.maxDisp = spacing * 1.6;
  }

  /** Radial impulse; positive `strength` pushes outward, negative pulls inward. */
  applyForce(x, y, radius, strength) {
    const s = this.spacing;
    const { cols, rows, dx, dy, vx, vy } = this;
    const c0 = Math.max(1, Math.floor((x - radius) / s));
    const c1 = Math.min(cols - 2, Math.ceil((x + radius) / s));
    const r0 = Math.max(1, Math.floor((y - radius) / s));
    const r1 = Math.min(rows - 2, Math.ceil((y + radius) / s));
    const r2 = radius * radius;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const ox = c * s + dx[i] - x;
        const oy = r * s + dy[i] - y;
        const d2 = ox * ox + oy * oy;
        if (d2 >= r2 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const f = (strength * (1 - d / radius)) / d;
        vx[i] += ox * f;
        vy[i] += oy * f;
      }
    }
  }

  update(dt) {
    const { cols, rows, dx, dy, vx, vy } = this;
    const k = this.stiffness;
    const kc = this.coupling;
    const kd = this.damping;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        const lx = dx[i - 1] + dx[i + 1] + dx[i - cols] + dx[i + cols] - 4 * dx[i];
        const ly = dy[i - 1] + dy[i + 1] + dy[i - cols] + dy[i + cols] - 4 * dy[i];
        vx[i] += (-k * dx[i] + kc * lx - kd * vx[i]) * dt;
        vy[i] += (-k * dy[i] + kc * ly - kd * vy[i]) * dt;
      }
    }
    const m = this.maxDisp;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        let x = dx[i] + vx[i] * dt;
        let y = dy[i] + vy[i] * dt;
        dx[i] = x > m ? m : x < -m ? -m : x;
        dy[i] = y > m ? m : y < -m ? -m : y;
      }
    }
  }

  /** Total displacement — handy for tests and debug readouts. */
  energy() {
    let e = 0;
    for (let i = 0; i < this.dx.length; i++) e += Math.abs(this.dx[i]) + Math.abs(this.dy[i]);
    return e;
  }

  draw(ctx) {
    this._lines(ctx, 1, 'rgba(70, 90, 255, 0.16)', 1.25);
    this._lines(ctx, 4, 'rgba(110, 120, 255, 0.32)', 2);
  }

  _lines(ctx, every, color, width) {
    const { cols, rows, dx, dy, spacing: s } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let r = 0; r < rows; r += every) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = c * s + dx[i];
        const y = r * s + dy[i];
        if (c === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    for (let c = 0; c < cols; c += every) {
      for (let r = 0; r < rows; r++) {
        const i = r * cols + c;
        const x = c * s + dx[i];
        const y = r * s + dy[i];
        if (r === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}
