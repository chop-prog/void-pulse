import { TAU } from './math.js';

const ALPHAS = [0.2, 0.45, 0.7, 0.95];
const MAX_COLORS = 64;
const BUCKETS = MAX_COLORS * 8; // colour × 4 alpha levels × 2 widths

/**
 * Struct-of-arrays particle system.
 *
 * - Fixed-capacity typed arrays: zero allocations after construction.
 * - Dead particles are swap-removed, so the live set is always packed.
 * - Rendering counting-sorts particles into (colour, alpha, width) buckets
 *   so thousands of sparks cost one stroke() call per bucket instead of one each.
 */
export class Particles {
  constructor(capacity = 3000) {
    this.cap = capacity;
    this.n = 0;
    const F = () => new Float32Array(capacity);
    this.x = F(); this.y = F(); this.vx = F(); this.vy = F();
    this.life = F(); this.max = F(); this.size = F(); this.drag = F();
    this.col = new Uint8Array(capacity);
    this.keys = new Uint16Array(capacity);
    this.order = new Uint16Array(capacity);
    this.counts = new Uint32Array(BUCKETS);
    this.palette = [];
    this.paletteIndex = new Map();
  }

  colorId(color) {
    let id = this.paletteIndex.get(color);
    if (id === undefined) {
      id = this.palette.length < MAX_COLORS ? this.palette.length : 0;
      if (this.palette.length < MAX_COLORS) this.palette.push(color);
      this.paletteIndex.set(color, id);
    }
    return id;
  }

  clear() {
    this.n = 0;
  }

  emit(x, y, o) {
    const { count = 10, color = '#fff', speed = 300, speedMin = 0, life = 0.7, lifeMin = 0.25, size = 2, angle = 0, spread = TAU, drag = 3 } = o;
    const cid = this.colorId(color);
    for (let k = 0; k < count && this.n < this.cap; k++) {
      const i = this.n++;
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speedMin + Math.random() * (speed - speedMin);
      const l = lifeMin + Math.random() * (life - lifeMin);
      this.x[i] = x; this.y[i] = y;
      this.vx[i] = Math.cos(a) * s; this.vy[i] = Math.sin(a) * s;
      this.life[i] = l; this.max[i] = l;
      this.size[i] = size; this.drag[i] = drag;
      this.col[i] = cid;
    }
  }

  update(dt) {
    for (let i = 0; i < this.n; ) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._copy(--this.n, i);
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= d;
      this.vy[i] *= d;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      i++;
    }
  }

  _copy(from, to) {
    this.x[to] = this.x[from]; this.y[to] = this.y[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from];
    this.life[to] = this.life[from]; this.max[to] = this.max[from];
    this.size[to] = this.size[from]; this.drag[to] = this.drag[from];
    this.col[to] = this.col[from];
  }

  draw(ctx) {
    const n = this.n;
    if (!n) return;
    const { keys, order, counts, life, max, size, col } = this;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const a = life[i] / max[i];
      const al = a > 0.75 ? 3 : a > 0.5 ? 2 : a > 0.25 ? 1 : 0;
      const k = col[i] * 8 + al * 2 + (size[i] > 2.5 ? 1 : 0);
      keys[i] = k;
      counts[k]++;
    }
    for (let k = 0, sum = 0; k < BUCKETS; k++) {
      const c = counts[k];
      counts[k] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) order[counts[keys[i]]++] = i;

    ctx.lineCap = 'round';
    let cur = -1;
    for (let j = 0; j < n; j++) {
      const i = order[j];
      const k = keys[i];
      if (k !== cur) {
        if (cur !== -1) ctx.stroke();
        cur = k;
        ctx.beginPath();
        ctx.strokeStyle = this.palette[k >> 3];
        ctx.globalAlpha = ALPHAS[(k >> 1) & 3];
        ctx.lineWidth = k & 1 ? 4 : 2;
      }
      const x = this.x[i];
      const y = this.y[i];
      ctx.moveTo(x, y);
      ctx.lineTo(x - this.vx[i] * 0.035 + 0.1, y - this.vy[i] * 0.035);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
