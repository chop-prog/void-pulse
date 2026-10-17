/**
 * Canvas 2D renderer with a cheap multi-scale bloom.
 *
 * The frame is downsampled to 1/4 and 1/8 resolution (bilinear filtering does the blur),
 * then both mips are added back with 'lighter' compositing. Works everywhere — no
 * ctx.filter, no WebGL — and costs two small drawImage calls.
 *
 * Quality levels (auto-degraded when frames get slow):
 *   0 — DPR up to 2, two bloom mips
 *   1 — DPR up to 1.25, two bloom mips
 *   2 — DPR 1, one bloom mip
 *   3 — DPR 1, no bloom
 */
const LEVELS = [
  { dpr: 2, bloom: 2 },
  { dpr: 1.25, bloom: 2 },
  { dpr: 1, bloom: 1 },
  { dpr: 1, bloom: 0 },
];

export class Renderer {
  constructor(canvas, level = 0) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.mip1 = document.createElement('canvas');
    this.mip2 = document.createElement('canvas');
    this.m1 = this.mip1.getContext('2d');
    this.m2 = this.mip2.getContext('2d');
    this.level = level;
    this.resize();
  }

  get maxLevel() {
    return LEVELS.length - 1;
  }

  setLevel(level) {
    this.level = Math.max(0, Math.min(this.maxLevel, level));
    this.resize();
  }

  resize() {
    const cfg = LEVELS[this.level];
    this.cssW = innerWidth;
    this.cssH = innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, cfg.dpr);
    this.bloom = cfg.bloom;
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.mip1.width = Math.max(1, w >> 2);
    this.mip1.height = Math.max(1, h >> 2);
    this.mip2.width = Math.max(1, w >> 3);
    this.mip2.height = Math.max(1, h >> 3);
    for (const c of [this.m1, this.m2]) {
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
    }
  }

  get width() {
    return this.canvas.width;
  }

  get height() {
    return this.canvas.height;
  }

  bloomPass() {
    if (!this.bloom) return;
    const { ctx, canvas, mip1, mip2, m1, m2 } = this;
    m1.globalCompositeOperation = 'copy';
    m1.drawImage(canvas, 0, 0, mip1.width, mip1.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    if (this.bloom > 1) {
      m2.globalCompositeOperation = 'copy';
      m2.drawImage(mip1, 0, 0, mip2.width, mip2.height);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(mip2, 0, 0, canvas.width, canvas.height);
    }
    ctx.globalAlpha = 0.6;
    ctx.drawImage(mip1, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
