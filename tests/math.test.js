import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, angleDiff, Rng, weightedSample, hashString, damp } from '../src/engine/math.js';

test('clamp keeps values in range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('angleDiff returns the shortest signed rotation', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);
  close(angleDiff(0, Math.PI / 2), Math.PI / 2);
  close(angleDiff(Math.PI / 2, 0), -Math.PI / 2);
  close(angleDiff(0.1, Math.PI * 2 - 0.1), -0.2); // wraps across 0
  close(angleDiff(Math.PI * 2 - 0.1, 0.1), 0.2);
  close(angleDiff(5 * Math.PI, 0), Math.PI);
});

test('damp converges toward the target and is frame-rate independent', () => {
  let a = 0;
  for (let i = 0; i < 60; i++) a = damp(a, 10, 5, 1 / 60);
  let b = 0;
  for (let i = 0; i < 240; i++) b = damp(b, 10, 5, 1 / 240);
  assert.ok(Math.abs(a - b) < 1e-9);
  assert.ok(a > 9.9);
});

test('Rng is deterministic for a given seed', () => {
  const a = new Rng(1234);
  const b = new Rng(1234);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  assert.notEqual(new Rng(1).next(), new Rng(2).next());
});

test('Rng.int is inclusive and uniform-ish', () => {
  const r = new Rng(42);
  const seen = new Map();
  for (let i = 0; i < 6000; i++) {
    const v = r.int(1, 6);
    assert.ok(v >= 1 && v <= 6 && Number.isInteger(v));
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  assert.equal(seen.size, 6);
  for (const n of seen.values()) assert.ok(n > 800 && n < 1200, `bucket count ${n}`);
});

test('weightedSample returns distinct items and skips zero weights', () => {
  const r = new Rng(7);
  const items = ['a', 'b', 'c', 'd', 'zero'];
  for (let i = 0; i < 200; i++) {
    const out = weightedSample(items, (x) => (x === 'zero' ? 0 : 1), 3, r);
    assert.equal(out.length, 3);
    assert.equal(new Set(out).size, 3);
    assert.ok(!out.includes('zero'));
  }
  assert.deepEqual(weightedSample(['zero'], () => 0, 3, r), []);
});

test('hashString is stable (daily seeds must match across clients)', () => {
  assert.equal(hashString(''), 0x811c9dc5);
  assert.equal(hashString('void-pulse:2026-01-01'), hashString('void-pulse:2026-01-01'));
  assert.notEqual(hashString('void-pulse:2026-01-01'), hashString('void-pulse:2026-01-02'));
});
