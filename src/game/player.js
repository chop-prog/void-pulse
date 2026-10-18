import { TAU } from '../engine/math.js';

export const BASE_STATS = Object.freeze({
  moveSpeed: 380,
  fireRate: 9, // shots per second
  bulletSpeed: 1100,
  damage: 1,
  projectiles: 1,
  pierce: 0,
  bounces: 0,
  homing: 0, // max turn rate, rad/s
  crit: 0.05,
  orbitals: 0,
  chain: 0,
  magnet: 140,
  dashCooldown: 1.1,
  rear: 0, // extra shots fired backwards
  nova: 0, // shockwave level
  shield: 0, // shield level (recharge speed)
  storm: 0, // legendary: ring volley
  phoenix: 0, // legendary: revive once
  chronos: 0, // legendary: dash slows enemies
});

export const DASH_TIME = 0.16;
export const SHIELD_RECHARGE = 12; // seconds at shield level 1
export const PLAYER_STYLE = [
  { name: 'P1', hull: '#eaffff', glow: '#3df2ff', fill: 'rgba(80, 220, 255, 0.25)', trail: ['#ff9b3d', '#ffd27a'], bullet: '#5ff3ff' },
  { name: 'P2', hull: '#fff0fb', glow: '#ff4fd8', fill: 'rgba(255, 79, 216, 0.22)', trail: ['#b46bff', '#ff9bf0'], bullet: '#ff8af0' },
];

export function createPlayer(x, y, slot = 0) {
  return {
    slot,
    x, y, vx: 0, vy: 0, r: 12,
    aim: -Math.PI / 2,
    lives: 3, bombs: 2,
    invuln: 1.5, dashT: 0, dashCd: 0, dashX: 0, dashY: 0, fireCd: 0,
    alive: true,
    stats: { ...BASE_STATS },
    owned: {},
    shield: 0, shieldT: 0, novaT: 4, volleys: 0, phoenixUsed: false,
    ghosts: [],
  };
}

/** Cooldowns, recharges and passive effects. Runs wherever the ship is simulated authoritatively. */
export function tickPlayer(g, p, dt) {
  const s = p.stats;
  p.invuln = Math.max(0, p.invuln - dt);
  p.dashCd = Math.max(0, p.dashCd - dt);
  p.fireCd -= dt;
  if (s.shield > 0 && p.shield < 1 && (p.shieldT += dt) >= SHIELD_RECHARGE / s.shield) {
    p.shield = 1;
    p.shieldT = 0;
    g.addRing(p.x, p.y, { maxR: 60, life: 0.35, color: PLAYER_STYLE[p.slot].glow, width: 3 });
  }
  if (s.nova > 0 && (p.novaT -= dt) <= 0) {
    p.novaT = Math.max(2.5, 7 - s.nova * 1.5);
    g.novaBlast(p);
  }
}

/**
 * Aim, dash and movement from an input source (keyboard/mouse/pad/touch). Returns the aim
 * state so the caller decides whether this machine also fires (host) or only predicts (guest).
 */
export function movePlayer(g, p, input, dt) {
  const s = p.stats;
  const mv = input.getMove();
  const sp = g.worldToScreen(p.x, p.y);
  const aim = input.getAim(sp.x, sp.y);
  if (aim.x || aim.y) p.aim = Math.atan2(aim.y, aim.x);

  if (input.consume('dash') && p.dashCd <= 0) {
    const m = Math.hypot(mv.x, mv.y);
    p.dashX = m > 0.2 ? mv.x / m : Math.cos(p.aim);
    p.dashY = m > 0.2 ? mv.y / m : Math.sin(p.aim);
    p.dashT = DASH_TIME;
    p.dashCd = s.dashCooldown;
    g.onDash(p);
  }
  if (input.consume('bomb') && p.bombs > 0) g.requestBomb(p);

  if (p.dashT > 0) {
    p.dashT -= dt;
    const v = s.moveSpeed * 3.4;
    p.vx = p.dashX * v;
    p.vy = p.dashY * v;
  } else {
    const k = 1 - Math.exp(-14 * dt);
    p.vx += (mv.x * s.moveSpeed - p.vx) * k;
    p.vy += (mv.y * s.moveSpeed - p.vy) * k;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  clampToArena(g, p);
  return aim;
}

export function clampToArena(g, p) {
  const { W, H } = g.arena;
  if (p.x < p.r) { p.x = p.r; p.vx = 0; }
  if (p.x > W - p.r) { p.x = W - p.r; p.vx = 0; }
  if (p.y < p.r) { p.y = p.r; p.vy = 0; }
  if (p.y > H - p.r) { p.y = H - p.r; p.vy = 0; }
}

export function shootPlayer(g, p, fire) {
  if (fire && p.fireCd <= 0) {
    firePlayer(g, p);
    p.fireCd = 1 / p.stats.fireRate;
  }
}

/** Purely visual per-tick effects: engine trail, dash ghosts, grid wake. Never sent over the network. */
export function trailPlayer(g, p, dt) {
  const fx = g.localFx;
  const speed = Math.hypot(p.vx, p.vy);
  if (p.dashT > 0 && g.tick % 3 === 0) p.ghosts.push({ x: p.x, y: p.y, a: p.aim, life: 0.25 });
  if (speed > 60 && Math.random() < 0.7) {
    const back = Math.atan2(-p.vy, -p.vx);
    const [a, b] = PLAYER_STYLE[p.slot].trail;
    fx.particles.emit(p.x + Math.cos(back) * 10, p.y + Math.sin(back) * 10, {
      count: 1, color: Math.random() < 0.5 ? a : b, speed: 160, speedMin: 60, life: 0.35, lifeMin: 0.15, angle: back, spread: 0.6,
    });
  }
  fx.grid.applyForce(p.x, p.y, 80, 400 * dt);
  for (let i = p.ghosts.length - 1; i >= 0; i--) {
    if ((p.ghosts[i].life -= dt) <= 0) p.ghosts.splice(i, 1);
  }
}

function bullet(g, p, a, crit) {
  const s = p.stats;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  g.bullets.push({
    x: p.x + cos * 16, y: p.y + sin * 16,
    vx: cos * s.bulletSpeed, vy: sin * s.bulletSpeed,
    r: crit ? 6 : 4,
    dmg: s.damage * (crit ? 2.5 : 1),
    crit,
    owner: p.slot,
    pierce: s.pierce,
    bounces: s.bounces,
    homing: s.homing,
    life: 1.4 + s.bounces * 0.6,
    hits: [],
  });
}

function firePlayer(g, p) {
  const s = p.stats;
  const n = s.projectiles;
  const spread = n > 1 ? Math.min(0.14, 0.5 / n) : 0;
  for (let i = 0; i < n; i++) bullet(g, p, p.aim + (i - (n - 1) / 2) * spread + (Math.random() - 0.5) * 0.03, Math.random() < s.crit);
  for (let i = 0; i < s.rear; i++) bullet(g, p, p.aim + Math.PI + (i - (s.rear - 1) / 2) * 0.16, Math.random() < s.crit);
  p.volleys++;
  if (s.storm && p.volleys % 4 === 0) {
    for (let i = 0; i < 16; i++) bullet(g, p, p.aim + (i * TAU) / 16, Math.random() < s.crit);
    g.particles.emit(p.x, p.y, { count: 16, color: '#ffd84d', speed: 320, life: 0.3 });
  }
  g.particles.emit(p.x + Math.cos(p.aim) * 18, p.y + Math.sin(p.aim) * 18, {
    count: 2, color: '#9ff7ff', speed: 260, speedMin: 80, life: 0.12, lifeMin: 0.05, angle: p.aim, spread: 0.7,
  });
  if (!p.remote) {
    p.vx -= Math.cos(p.aim) * 10;
    p.vy -= Math.sin(p.aim) * 10;
  }
  g.audio.shoot();
}

const SHIP = [[18, 0], [-10, -12], [-4, 0], [-10, 12]];

function shipPath(ctx, x, y, a, scale = 1) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  ctx.beginPath();
  SHIP.forEach(([px, py], i) => {
    const X = x + (px * c - py * s) * scale;
    const Y = y + (px * s + py * c) * scale;
    if (i) ctx.lineTo(X, Y);
    else ctx.moveTo(X, Y);
  });
  ctx.closePath();
}

export function drawPlayer(ctx, p, time, { label = false } = {}) {
  const st = PLAYER_STYLE[p.slot];
  for (const gh of p.ghosts) {
    ctx.globalAlpha = gh.life * 2;
    ctx.strokeStyle = st.glow;
    ctx.lineWidth = 2;
    shipPath(ctx, gh.x, gh.y, gh.a);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (!p.alive) return;
  if (p.invuln > 0 && p.dashT <= 0 && Math.floor(time * 18) % 2 === 0) ctx.globalAlpha = 0.25;

  shipPath(ctx, p.x, p.y, p.aim);
  ctx.fillStyle = st.fill;
  ctx.fill();
  ctx.strokeStyle = st.hull;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 2.5, 0, TAU);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  if (p.invuln > 0 && p.dashT <= 0) {
    ctx.globalAlpha = Math.min(1, p.invuln) * 0.5;
    ctx.strokeStyle = st.glow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26 + Math.sin(time * 8) * 2, 0, TAU);
    ctx.stroke();
  }
  if (p.shield > 0) {
    ctx.globalAlpha = 0.55 + Math.sin(time * 5) * 0.15;
    ctx.strokeStyle = '#9ff7ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = time * 0.8 + (i * TAU) / 6;
      const x = p.x + Math.cos(a) * 30;
      const y = p.y + Math.sin(a) * 30;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (label) {
    ctx.font = '700 16px Rajdhani, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = st.glow;
    ctx.fillText(st.name, p.x, p.y - 34);
  }
}
