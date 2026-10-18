// Roguelite augments offered between waves. Pure data + pure functions → unit-testable.

import { weightedSample } from '../engine/math.js';

export const RARITY = {
  common: { weight: 10, label: 'Common' },
  rare: { weight: 4.5, label: 'Rare' },
  epic: { weight: 0.75, label: 'Epic' },
  legendary: { weight: 0.2, label: 'Legendary' },
};

/** Legendaries only enter the pool once a run has proven itself. */
export const LEGENDARY_WAVE = 6;

/** Epic and legendary cards are the exciting ones; an offer never shows more than one of them. */
const PREMIUM = new Set(['epic', 'legendary']);

// Icons are 24×24 stroke paths rendered as inline SVG.
export const UPGRADES = [
  { id: 'rapid', name: 'Rapid Fire', desc: '+25% fire rate', rarity: 'common', max: 6,
    icon: 'M4 6l6 6-6 6M12 6l6 6-6 6', apply: (p) => { p.stats.fireRate *= 1.25; } },
  { id: 'multishot', name: 'Split Barrel', desc: '+1 projectile per shot', rarity: 'rare', max: 4,
    icon: 'M3 12h6M9 12l11-7M9 12h12M9 12l11 7', apply: (p) => { p.stats.projectiles += 1; } },
  { id: 'heavy', name: 'Heavy Rounds', desc: '+1 damage, −8% fire rate', rarity: 'common', max: 5,
    icon: 'M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0M12 9v6M9 12h6', apply: (p) => { p.stats.damage += 1; p.stats.fireRate *= 0.92; } },
  { id: 'pierce', name: 'Railgun Core', desc: 'Bullets pierce +1 enemy', rarity: 'rare', max: 4,
    icon: 'M3 12h18M15 6l6 6-6 6M8 7v10', apply: (p) => { p.stats.pierce += 1; } },
  { id: 'ricochet', name: 'Ricochet', desc: 'Bullets bounce off walls +1', rarity: 'common', max: 3,
    icon: 'M4 17l8-11 8 11M2 20h20', apply: (p) => { p.stats.bounces += 1; } },
  { id: 'homing', name: 'Seeker Rounds', desc: 'Bullets curve toward enemies', rarity: 'rare', max: 3,
    icon: 'M4 19c5 0 6-13 15-13M15 3l4 3-3 4', apply: (p) => { p.stats.homing += 2.6; } },
  { id: 'velocity', name: 'Mag Accelerator', desc: '+25% bullet speed, +5% crit', rarity: 'common', max: 3,
    icon: 'M3 8h10M5 12h12M3 16h10M17 8l4 4-4 4', apply: (p) => { p.stats.bulletSpeed *= 1.25; p.stats.crit += 0.05; } },
  { id: 'crit', name: 'Overcharge', desc: '+10% chance to crit for ×2.5', rarity: 'common', max: 5,
    icon: 'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z', apply: (p) => { p.stats.crit += 0.1; } },
  { id: 'thrusters', name: 'Ion Thrusters', desc: '+12% move speed', rarity: 'common', max: 4,
    icon: 'M12 3l5 9H7zM9 15l-1 5M12 15v6M15 15l1 5', apply: (p) => { p.stats.moveSpeed *= 1.12; } },
  { id: 'dash', name: 'Phase Drive', desc: 'Dash cooldown −25%', rarity: 'common', max: 3,
    icon: 'M3 12h9M5 8h6M5 16h6M14 6l6 6-6 6', apply: (p) => { p.stats.dashCooldown *= 0.75; } },
  { id: 'orbital', name: 'Orbital Drone', desc: '+1 drone that shreds enemies and bullets', rarity: 'epic', max: 4,
    icon: 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 12a9 9 0 0 1 18 0M19 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0', apply: (p) => { p.stats.orbitals += 1; } },
  { id: 'chain', name: 'Arc Conductor', desc: 'Kills have +20% chance to arc lightning', rarity: 'epic', max: 4,
    icon: 'M13 2L5 14h6l-2 8 8-12h-6z', apply: (p) => { p.stats.chain += 0.2; } },
  { id: 'rear', name: 'Rear Guns', desc: 'Every volley also fires +1 shot behind you', rarity: 'epic', max: 2,
    icon: 'M12 3v18M12 3l-4 4M12 3l4 4M12 21l-4-4M12 21l4-4', apply: (p) => { p.stats.rear += 1; } },
  { id: 'nova', name: 'Nova Pulse', desc: 'Emit a damaging shockwave every few seconds', rarity: 'epic', max: 3,
    icon: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M5 12a7 7 0 0 1 14 0M2 12a10 10 0 0 1 20 0', apply: (p) => { p.stats.nova += 1; } },
  { id: 'shield', name: 'Aegis Shield', desc: 'A shield absorbs one hit, then recharges', rarity: 'epic', max: 2,
    icon: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z', apply: (p) => { p.stats.shield += 1; p.shield = 1; p.shieldT = 0; } },
  { id: 'storm', name: 'Bullet Storm', desc: 'Every 4th volley erupts in a ring of 16 shots', rarity: 'legendary', max: 1,
    icon: 'M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    apply: (p) => { p.stats.storm = 1; } },
  { id: 'phoenix', name: 'Phoenix Core', desc: 'Once per run, a fatal hit revives you in a blast', rarity: 'legendary', max: 1,
    icon: 'M12 21c-4-2-6-5-6-8 0-2 1-4 3-5-.5 2 .5 3 1.5 3C10 8 11 5 14 3c-.5 3 1 4.5 2.5 6 1 1 1.5 2.5 1.5 4 0 3-2 6-6 8z',
    apply: (p) => { p.stats.phoenix = 1; } },
  { id: 'chronos', name: 'Chronos', desc: 'Dashing slows every enemy for 2.5 s', rarity: 'legendary', max: 1,
    icon: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2M5 3L2 6M19 3l3 3', apply: (p) => { p.stats.chronos = 1; } },
  { id: 'magnet', name: 'Gravity Well', desc: '+50% shard pickup radius', rarity: 'common', max: 3,
    icon: 'M6 4v8a6 6 0 0 0 12 0V4M6 8h4M14 8h4', apply: (p) => { p.stats.magnet *= 1.5; } },
  { id: 'life', name: 'Reinforced Hull', desc: '+1 life', rarity: 'rare', max: 5,
    icon: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z', apply: (p) => { p.lives += 1; } },
  { id: 'bomb', name: 'Nova Charge', desc: '+1 bomb', rarity: 'common', max: 6,
    icon: 'M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0M12 1v3M12 20v3M1 12h3M20 12h3', apply: (p) => { p.bombs += 1; } },
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

/** Upgrades still on offer. Pass `wave` to hold legendaries back until LEGENDARY_WAVE. */
export function availableUpgrades(owned, wave = Infinity) {
  return UPGRADES.filter((u) => (owned[u.id] || 0) < u.max && (u.rarity !== 'legendary' || wave >= LEGENDARY_WAVE));
}

/**
 * Offer `count` distinct, non-maxed upgrades, weighted by rarity, with at most one epic or
 * legendary among them. Measured with these weights: an epic shows up in about 1 offer in 10,
 * a legendary in about 1 in 60 once it is unlocked (see tests/upgrades.test.js).
 */
export function rollUpgrades(owned, rng, count = 3, wave = Infinity) {
  let pool = availableUpgrades(owned, wave);
  const out = [];
  while (out.length < count && pool.length) {
    const [u] = weightedSample(pool, (x) => RARITY[x.rarity].weight, 1, rng);
    out.push(u);
    pool = pool.filter((x) => x !== u && !(PREMIUM.has(u.rarity) && PREMIUM.has(x.rarity)));
  }
  return out;
}

export function applyUpgrade(player, upgrade, owned) {
  upgrade.apply(player);
  owned[upgrade.id] = (owned[upgrade.id] || 0) + 1;
}
