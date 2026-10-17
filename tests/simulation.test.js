import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WarpGrid } from '../src/engine/grid.js';
import { Particles } from '../src/engine/particles.js';

test('warp grid: an impulse displaces nodes, then the springs settle back to rest', () => {
  const g = new WarpGrid(800, 600, 40);
  assert.equal(g.energy(), 0);
  g.applyForce(400, 300, 200, 1500);
  for (let i = 0; i < 30; i++) g.update(1 / 120);
  const peak = g.energy();
  assert.ok(peak > 100, `expected visible displacement, got ${peak}`);
  for (let i = 0; i < 120 * 8; i++) g.update(1 / 120);
  assert.ok(g.energy() < peak * 0.01, 'grid did not settle');
});

test('warp grid: border nodes stay pinned and displacement is bounded', () => {
  const g = new WarpGrid(400, 400, 40);
  for (let k = 0; k < 20; k++) {
    g.applyForce(200, 200, 400, 1e5);
    g.update(1 / 120);
  }
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      const edge = r === 0 || c === 0 || r === g.rows - 1 || c === g.cols - 1;
      if (edge) assert.equal(g.dx[i], 0);
      assert.ok(Math.abs(g.dx[i]) <= g.maxDisp && Math.abs(g.dy[i]) <= g.maxDisp);
      assert.ok(Number.isFinite(g.vx[i]));
    }
  }
});

test('particles: respect capacity, move, and expire', () => {
  const p = new Particles(100);
  p.emit(0, 0, { count: 150, speed: 100, speedMin: 100, life: 0.5, lifeMin: 0.5, drag: 0 });
  assert.equal(p.n, 100);
  p.update(0.25);
  assert.equal(p.n, 100);
  for (let i = 0; i < p.n; i++) assert.ok(Math.abs(Math.hypot(p.x[i], p.y[i]) - 25) < 1e-3);
  p.update(0.3);
  assert.equal(p.n, 0);
});

test('particles: swap-remove keeps the live set packed', () => {
  const p = new Particles(10);
  p.emit(0, 0, { count: 5, life: 1, lifeMin: 1 });
  p.emit(0, 0, { count: 5, life: 0.1, lifeMin: 0.1 });
  p.update(0.2);
  assert.equal(p.n, 5);
  for (let i = 0; i < p.n; i++) assert.ok(p.life[i] > 0);
});
