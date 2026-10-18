import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/engine/math.js';
import { UPGRADES, UPGRADE_BY_ID, RARITY, LEGENDARY_WAVE, rollUpgrades, applyUpgrade, availableUpgrades } from '../src/game/upgrades.js';
import { createPlayer, BASE_STATS } from '../src/game/player.js';

test('every upgrade is well-formed', () => {
  const ids = new Set();
  for (const u of UPGRADES) {
    assert.ok(!ids.has(u.id), `duplicate id ${u.id}`);
    ids.add(u.id);
    assert.ok(RARITY[u.rarity], `${u.id} has unknown rarity`);
    assert.ok(u.max >= 1);
    assert.equal(typeof u.apply, 'function');
    assert.match(u.icon, /^M/);
  }
});

test('a roll offers 3 distinct upgrades', () => {
  const rng = new Rng(11);
  for (let i = 0; i < 500; i++) {
    const roll = rollUpgrades({}, rng);
    assert.equal(roll.length, 3);
    assert.equal(new Set(roll.map((u) => u.id)).size, 3);
  }
});

test('maxed upgrades are never offered', () => {
  const owned = Object.fromEntries(UPGRADES.map((u) => [u.id, u.max]));
  owned.rapid = 0;
  owned.crit = 2;
  const rng = new Rng(3);
  for (let i = 0; i < 100; i++) {
    const ids = rollUpgrades(owned, rng).map((u) => u.id).sort();
    assert.deepEqual(ids, ['crit', 'rapid']);
  }
  const all = Object.fromEntries(UPGRADES.map((u) => [u.id, u.max]));
  assert.deepEqual(rollUpgrades(all, rng), []);
  assert.deepEqual(availableUpgrades(all), []);
});

test('rarity weights shape the distribution', () => {
  const rng = new Rng(8);
  const hits = { common: 0, rare: 0, epic: 0, legendary: 0 };
  for (let i = 0; i < 40000; i++) hits[rollUpgrades({}, rng, 1)[0].rarity]++;
  const per = (r) => hits[r] / UPGRADES.filter((u) => u.rarity === r).length;
  assert.ok(per('common') > per('rare') && per('rare') > per('epic') && per('epic') > per('legendary'), JSON.stringify(hits));
  assert.ok(hits.legendary > 0);
});

test('legendaries are held back until wave 4 and can only be taken once', () => {
  const legendary = UPGRADES.filter((u) => u.rarity === 'legendary');
  assert.ok(legendary.length >= 3);
  for (const u of legendary) assert.equal(u.max, 1);
  const rng = new Rng(4);
  for (let wave = 1; wave < LEGENDARY_WAVE; wave++) {
    for (let i = 0; i < 300; i++) assert.ok(rollUpgrades({}, rng, 3, wave).every((u) => u.rarity !== 'legendary'));
  }
  assert.ok(availableUpgrades({}, LEGENDARY_WAVE).some((u) => u.rarity === 'legendary'));
  const owned = Object.fromEntries(legendary.map((u) => [u.id, 1]));
  assert.ok(availableUpgrades(owned, 99).every((u) => u.rarity !== 'legendary'));
});

test('new augments change the right stats', () => {
  const p = createPlayer(0, 0);
  const owned = {};
  for (const id of ['rear', 'nova', 'shield', 'storm', 'phoenix', 'chronos']) applyUpgrade(p, UPGRADE_BY_ID[id], owned);
  assert.deepEqual(
    { rear: p.stats.rear, nova: p.stats.nova, shield: p.stats.shield, storm: p.stats.storm, phoenix: p.stats.phoenix, chronos: p.stats.chronos },
    { rear: 1, nova: 1, shield: 1, storm: 1, phoenix: 1, chronos: 1 },
  );
  assert.equal(p.shield, 1, 'shield starts charged');
});

test('applyUpgrade mutates the player and tracks stacks', () => {
  const p = createPlayer(0, 0);
  const owned = {};
  const byId = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
  applyUpgrade(p, byId.multishot, owned);
  applyUpgrade(p, byId.multishot, owned);
  applyUpgrade(p, byId.life, owned);
  applyUpgrade(p, byId.rapid, owned);
  assert.equal(p.stats.projectiles, BASE_STATS.projectiles + 2);
  assert.equal(p.lives, 4);
  assert.ok(Math.abs(p.stats.fireRate - BASE_STATS.fireRate * 1.25) < 1e-9);
  assert.deepEqual(owned, { multishot: 2, life: 1, rapid: 1 });
  // Base stats are frozen and shared — they must never be mutated.
  assert.ok(Object.isFrozen(BASE_STATS));
  assert.equal(BASE_STATS.projectiles, 1);
});
