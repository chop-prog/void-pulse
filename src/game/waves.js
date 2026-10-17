// Wave director: pure functions that turn (wave number, seeded RNG) into a spawn plan.
// Kept free of DOM/canvas so it can be unit-tested and replayed deterministically (daily runs).

import { TAU, clamp, weightedSample } from '../engine/math.js';

export const ENEMY_COST = { drifter: 1, seeker: 2, dodger: 4, splitter: 4, sniper: 5, singularity: 12 };
export const UNLOCK_WAVE = { drifter: 1, seeker: 1, dodger: 3, splitter: 4, sniper: 6, singularity: 7 };
export const FORMATIONS = ['ring', 'corner', 'edge', 'scatter', 'pincer'];
export const SAFE_SPAWN_DIST = 260;

export const isBossWave = (n) => n > 0 && n % 5 === 0;
export const waveBudget = (n) => Math.round(8 + n * 5 + Math.pow(n, 1.35));

function pickType(types, n, rng) {
  const weight = (t) => {
    if (t === 'singularity') return 0.35;
    return UNLOCK_WAVE[t] === n ? 2.5 : 1; // feature the newly unlocked enemy
  };
  return weightedSample(types, weight, 1, rng)[0];
}

/**
 * @returns {{ n: number, boss: boolean, budget: number, groups: {at:number,type:string,count:number,formation:string}[] }}
 */
export function planWave(n, rng) {
  const groups = [];
  if (isBossWave(n)) {
    groups.push({ at: 2, type: 'boss', count: 1, formation: 'top' });
    let budget = Math.round(waveBudget(n) * 0.4);
    const total = budget;
    let t = 9;
    while (budget >= ENEMY_COST.seeker) {
      const type = rng.chance(0.5) ? 'seeker' : 'drifter';
      const count = Math.min(Math.floor(budget / ENEMY_COST[type]), rng.int(3, 6));
      budget -= count * ENEMY_COST[type];
      groups.push({ at: t, type, count, formation: rng.pick(FORMATIONS) });
      t += rng.range(6, 9);
    }
    return { n, boss: true, budget: total, groups };
  }

  const total = waveBudget(n);
  let budget = total;
  const types = Object.keys(UNLOCK_WAVE).filter((t) => UNLOCK_WAVE[t] <= n);
  const gap = Math.max(0.9, 3.2 - n * 0.12);
  let t = 0.6;
  while (budget > 0) {
    const affordable = types.filter((ty) => ENEMY_COST[ty] <= budget);
    if (!affordable.length) break;
    const type = pickType(affordable, n, rng);
    const cost = ENEMY_COST[type];
    const solo = type === 'singularity';
    const maxCount = Math.min(solo ? 2 : 10, Math.floor(budget / cost));
    const count = Math.max(1, Math.min(maxCount, solo ? rng.int(1, 2) : rng.int(3, 3 + Math.floor(n / 2))));
    budget -= count * cost;
    groups.push({ at: Math.round(t * 100) / 100, type, count, formation: solo ? 'scatter' : rng.pick(FORMATIONS) });
    t += gap * rng.range(0.7, 1.3);
  }
  return { n, boss: false, budget: total, groups };
}

/**
 * Concrete spawn points for a formation. Guarantees every point is inside the arena
 * (with margin) and at least SAFE_SPAWN_DIST from the player.
 */
export function resolveFormation(formation, count, player, arena, rand = Math.random) {
  const { W, H } = arena;
  const M = 60;
  const pts = [];
  const cl = (x, y) => [clamp(x, M, W - M), clamp(y, M, H - M)];
  const far = (x, y) => Math.hypot(x - player.x, y - player.y) >= SAFE_SPAWN_DIST;
  const scatterPoint = () => {
    let best = null;
    let bestD = -1;
    for (let i = 0; i < 30; i++) {
      const x = M + rand() * (W - 2 * M);
      const y = M + rand() * (H - 2 * M);
      const d = Math.hypot(x - player.x, y - player.y);
      if (d >= 380) return [x, y];
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    return best;
  };

  switch (formation) {
    case 'ring': {
      const a0 = rand() * TAU;
      for (let i = 0; i < count; i++) {
        const a = a0 + (i * TAU) / count;
        pts.push(cl(player.x + Math.cos(a) * 430, player.y + Math.sin(a) * 430));
      }
      break;
    }
    case 'corner': {
      const corners = [[M, M], [W - M, M], [M, H - M], [W - M, H - M]];
      corners.sort((a, b) => Math.hypot(b[0] - player.x, b[1] - player.y) - Math.hypot(a[0] - player.x, a[1] - player.y));
      const [cx, cy] = corners[Math.floor(rand() * 2)];
      for (let i = 0; i < count; i++) pts.push(cl(cx + (rand() - 0.5) * 220, cy + (rand() - 0.5) * 220));
      break;
    }
    case 'edge': {
      const side = Math.floor(rand() * 4);
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        if (side === 0) pts.push(cl(t * W, M));
        else if (side === 1) pts.push(cl(t * W, H - M));
        else if (side === 2) pts.push(cl(M, t * H));
        else pts.push(cl(W - M, t * H));
      }
      break;
    }
    case 'pincer': {
      const a = rand() * TAU;
      for (let i = 0; i < count; i++) {
        const side = i % 2 ? 1 : -1;
        const jx = (rand() - 0.5) * 120;
        const jy = (rand() - 0.5) * 120;
        pts.push(cl(player.x + Math.cos(a) * 520 * side + jx, player.y + Math.sin(a) * 520 * side + jy));
      }
      break;
    }
    case 'top':
      for (let i = 0; i < count; i++) pts.push([W / 2, 200]);
      break;
    default:
      for (let i = 0; i < count; i++) pts.push(scatterPoint());
  }

  // Clamping to the arena can pull points back toward a player hugging a wall — reroll those.
  return pts.map(([x, y]) => (far(x, y) ? [x, y] : scatterPoint()));
}
