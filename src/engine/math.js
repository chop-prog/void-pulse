// Small, allocation-free math helpers shared by the engine and gameplay code.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential smoothing toward `target`. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Shortest signed angle from `a` to `b`, in (-PI, PI]. */
export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/** Mulberry32 — tiny, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash → unsigned 32-bit int. Used to derive daily seeds. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded random source. Gameplay-relevant rolls (waves, upgrades) go through this. */
export class Rng {
  constructor(seed = (Math.random() * 2 ** 32) >>> 0) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }
  next() { return this._next(); }
  range(min, max) { return min + (max - min) * this._next(); }
  /** Inclusive integer range. */
  int(min, max) { return Math.floor(this.range(min, max + 1)); }
  chance(p) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
}

/**
 * Weighted sampling without replacement.
 * Items with a non-positive weight are never selected.
 */
export function weightedSample(items, weightOf, count, rng) {
  const pool = items.filter((it) => weightOf(it) > 0);
  const out = [];
  while (out.length < count && pool.length) {
    let total = 0;
    for (const it of pool) total += weightOf(it);
    let r = rng.next() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= weightOf(pool[idx]);
      if (r < 0) break;
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
