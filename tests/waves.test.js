import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/engine/math.js';
import {
  planWave, resolveFormation, waveBudget, coopBudget, isBossWave, ENEMY_COST, UNLOCK_WAVE, FORMATIONS, SAFE_SPAWN_DIST,
} from '../src/game/waves.js';
import { ENEMIES, BOSS_ORDER } from '../src/game/enemies.js';

const ARENA = { W: 2000, H: 1300 };

test('regular waves never exceed their budget and only use unlocked enemies', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = new Rng(seed);
    for (let n = 1; n <= 30; n++) {
      const plan = planWave(n, rng);
      if (plan.boss) continue;
      const spent = plan.groups.reduce((s, g) => s + g.count * ENEMY_COST[g.type], 0);
      assert.ok(spent <= waveBudget(n), `wave ${n} spent ${spent} > ${waveBudget(n)}`);
      assert.ok(spent >= waveBudget(n) - 1, `wave ${n} left budget unused (${spent})`);
      for (const g of plan.groups) {
        assert.ok(UNLOCK_WAVE[g.type] <= n, `${g.type} appeared on wave ${n}`);
        assert.ok(g.count >= 1);
      }
    }
  }
});

test('spawn groups are ordered in time', () => {
  const plan = planWave(12, new Rng(5));
  for (let i = 1; i < plan.groups.length; i++) assert.ok(plan.groups[i].at >= plan.groups[i - 1].at);
});

test('every fifth wave is a boss wave with exactly one boss', () => {
  for (let n = 1; n <= 25; n++) {
    const plan = planWave(n, new Rng(n));
    assert.equal(plan.boss, isBossWave(n));
    const bosses = plan.groups.filter((g) => ENEMIES[g.type].boss).reduce((s, g) => s + g.count, 0);
    assert.equal(bosses, isBossWave(n) ? 1 : 0);
  }
});

test('bosses rotate through all five, then around again', () => {
  const order = [5, 10, 15, 20, 25, 30, 35].map((n) => planWave(n, new Rng(n)).groups.find((g) => ENEMIES[g.type].boss).type);
  assert.deepEqual(order, ['boss', 'warden', 'brood', 'serpent', 'prism', 'boss', 'warden']);
  for (const t of BOSS_ORDER) assert.ok(ENEMIES[t].title && ENEMIES[t].boss, `${t} needs a title`);
});

test('co-op waves bring 50% more hostiles per extra pilot, solo plans are unchanged', () => {
  for (let n = 1; n <= 20; n++) {
    assert.equal(coopBudget(n, 1), waveBudget(n));
    assert.equal(coopBudget(n, 2), Math.round(waveBudget(n) * 1.5));
    assert.deepEqual(planWave(n, new Rng(9)), planWave(n, new Rng(9), 1));
    const duo = planWave(n, new Rng(9), 2);
    if (duo.boss) continue;
    const spent = duo.groups.reduce((s, g) => s + g.count * ENEMY_COST[g.type], 0);
    assert.ok(spent <= coopBudget(n, 2) && spent >= coopBudget(n, 2) - 1);
  }
});

test('formations keep a safe distance from every co-op pilot', () => {
  const rng = new Rng(21);
  const rand = () => rng.next();
  for (let i = 0; i < 60; i++) {
    const pilots = [{ x: rng.range(0, 2000), y: rng.range(0, 1300) }, { x: rng.range(0, 2000), y: rng.range(0, 1300) }];
    for (const f of [...FORMATIONS, 'top']) {
      for (const [x, y] of resolveFormation(f, 6, pilots, ARENA, rand)) {
        for (const p of pilots) assert.ok(Math.hypot(x - p.x, y - p.y) >= SAFE_SPAWN_DIST, `${f} too close to a pilot`);
      }
    }
  }
});

test('same seed → same plan (daily runs are reproducible)', () => {
  const a = new Rng(2026);
  const b = new Rng(2026);
  for (let n = 1; n <= 15; n++) assert.deepEqual(planWave(n, a), planWave(n, b));
});

test('budget grows monotonically', () => {
  for (let n = 1; n < 50; n++) assert.ok(waveBudget(n + 1) > waveBudget(n));
});

test('formations stay inside the arena and keep a safe distance from the player', () => {
  const rng = new Rng(3);
  const rand = () => rng.next();
  const players = [
    { x: 1000, y: 650 }, { x: 20, y: 20 }, { x: 1980, y: 1280 }, { x: 20, y: 1280 }, { x: 1000, y: 15 },
  ];
  for (let i = 0; i < 40; i++) players.push({ x: rng.range(0, 2000), y: rng.range(0, 1300) });
  for (const player of players) {
    for (const f of [...FORMATIONS, 'top']) {
      for (const count of [1, 3, 8]) {
        const pts = resolveFormation(f, count, player, ARENA, rand);
        assert.equal(pts.length, count);
        for (const [x, y] of pts) {
          assert.ok(x >= 0 && x <= ARENA.W && y >= 0 && y <= ARENA.H, `${f} out of arena: ${x},${y}`);
          assert.ok(Math.hypot(x - player.x, y - player.y) >= SAFE_SPAWN_DIST, `${f} too close to player`);
        }
      }
    }
  }
});
