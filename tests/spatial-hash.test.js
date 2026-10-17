import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpatialHash } from '../src/engine/spatial-hash.js';
import { Rng } from '../src/engine/math.js';

test('query finds overlapping objects and nothing far away', () => {
  const h = new SpatialHash(50);
  const near = { x: 100, y: 100, r: 10 };
  const far = { x: 900, y: 900, r: 10 };
  h.insert(near);
  h.insert(far);
  const out = h.query(110, 105, 5);
  assert.ok(out.includes(near));
  assert.ok(!out.includes(far));
});

test('objects spanning several cells are returned once', () => {
  const h = new SpatialHash(20);
  const big = { x: 50, y: 50, r: 45 }; // covers ~25 cells
  h.insert(big);
  const out = h.query(50, 50, 60);
  assert.equal(out.filter((o) => o === big).length, 1);
});

test('handles negative coordinates', () => {
  const h = new SpatialHash(32);
  const o = { x: -100, y: -40, r: 4 };
  h.insert(o);
  assert.deepEqual(h.query(-98, -42, 2), [o]);
});

test('broad phase never misses a true overlap (vs brute force)', () => {
  const rng = new Rng(99);
  const h = new SpatialHash(64);
  const objs = Array.from({ length: 400 }, () => ({ x: rng.range(0, 2000), y: rng.range(0, 1300), r: rng.range(4, 40) }));
  objs.forEach((o) => h.insert(o));
  for (let i = 0; i < 200; i++) {
    const qx = rng.range(0, 2000);
    const qy = rng.range(0, 1300);
    const qr = rng.range(1, 80);
    const found = new Set(h.query(qx, qy, qr));
    for (const o of objs) {
      if (Math.hypot(o.x - qx, o.y - qy) <= o.r + qr) assert.ok(found.has(o), 'missed an overlapping object');
    }
  }
});

test('clear empties the hash and recycles cell arrays', () => {
  const h = new SpatialHash(64);
  for (let i = 0; i < 50; i++) h.insert({ x: i * 70, y: 0, r: 5 });
  const cells = h.cellCount;
  h.clear();
  assert.equal(h.cellCount, 0);
  assert.equal(h.pool.length, cells);
  assert.deepEqual(h.query(0, 0, 10), []);
});
