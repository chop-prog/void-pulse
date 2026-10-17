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
});

export const DASH_TIME = 0.16;

export function createPlayer(x, y) {
  return {
    x, y, vx: 0, vy: 0, r: 12,
    aim: -Math.PI / 2,
    lives: 3, bombs: 2,
    invuln: 1.5, dashT: 0, dashCd: 0, dashX: 0, dashY: 0, fireCd: 0,
    alive: true,
    stats: { ...BASE_STATS },
    ghosts: [],
  };
}

export function updatePlayer(g, dt) {
  const p = g.player;
  const s = p.stats;
  const input = g.input;
  p.invuln = Math.max(0, p.invuln - dt);
  p.dashCd = Math.max(0, p.dashCd - dt);
  p.fireCd -= dt;

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
    g.onDash();
  }
  if (input.consume('bomb') && p.bombs > 0) g.detonateBomb();

  if (p.dashT > 0) {
    p.dashT -= dt;
    const v = s.moveSpeed * 3.4;
    p.vx = p.dashX * v;
    p.vy = p.dashY * v;
    if (g.tick % 3 === 0) p.ghosts.push({ x: p.x, y: p.y, a: p.aim, life: 0.25 });
  } else {
    const k = 1 - Math.exp(-14 * dt);
    p.vx += (mv.x * s.moveSpeed - p.vx) * k;
    p.vy += (mv.y * s.moveSpeed - p.vy) * k;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const { W, H } = g.arena;
  if (p.x < p.r) { p.x = p.r; p.vx = 0; }
  if (p.x > W - p.r) { p.x = W - p.r; p.vx = 0; }
  if (p.y < p.r) { p.y = p.r; p.vy = 0; }
  if (p.y > H - p.r) { p.y = H - p.r; p.vy = 0; }

  if (aim.fire && p.fireCd <= 0) {
    fire(g, p);
    p.fireCd = 1 / s.fireRate;
  }

  const speed = Math.hypot(p.vx, p.vy);
  if (speed > 60 && Math.random() < 0.7) {
    const back = Math.atan2(-p.vy, -p.vx);
    g.particles.emit(p.x + Math.cos(back) * 10, p.y + Math.sin(back) * 10, {
      count: 1, color: Math.random() < 0.5 ? '#ff9b3d' : '#ffd27a', speed: 160, speedMin: 60, life: 0.35, lifeMin: 0.15, angle: back, spread: 0.6,
    });
  }
  g.grid.applyForce(p.x, p.y, 80, 400 * dt);

  for (let i = p.ghosts.length - 1; i >= 0; i--) {
    if ((p.ghosts[i].life -= dt) <= 0) p.ghosts.splice(i, 1);
  }
}

function fire(g, p) {
  const s = p.stats;
  const n = s.projectiles;
  const spread = n > 1 ? Math.min(0.14, 0.5 / n) : 0;
  for (let i = 0; i < n; i++) {
    const a = p.aim + (i - (n - 1) / 2) * spread + (Math.random() - 0.5) * 0.03;
    const crit = Math.random() < s.crit;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    g.bullets.push({
      x: p.x + cos * 16, y: p.y + sin * 16,
      vx: cos * s.bulletSpeed, vy: sin * s.bulletSpeed,
      r: crit ? 6 : 4,
      dmg: s.damage * (crit ? 2.5 : 1),
      crit,
      pierce: s.pierce,
      bounces: s.bounces,
      homing: s.homing,
      life: 1.4 + s.bounces * 0.6,
      hits: [],
    });
  }
  g.particles.emit(p.x + Math.cos(p.aim) * 18, p.y + Math.sin(p.aim) * 18, {
    count: 2, color: '#9ff7ff', speed: 260, speedMin: 80, life: 0.12, lifeMin: 0.05, angle: p.aim, spread: 0.7,
  });
  p.vx -= Math.cos(p.aim) * 10;
  p.vy -= Math.sin(p.aim) * 10;
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

export function drawPlayer(ctx, p, time) {
  for (const gh of p.ghosts) {
    ctx.globalAlpha = gh.life * 2;
    ctx.strokeStyle = '#3df2ff';
    ctx.lineWidth = 2;
    shipPath(ctx, gh.x, gh.y, gh.a);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (!p.alive) return;
  if (p.invuln > 0 && p.dashT <= 0 && Math.floor(time * 18) % 2 === 0) ctx.globalAlpha = 0.25;

  shipPath(ctx, p.x, p.y, p.aim);
  ctx.fillStyle = 'rgba(80, 220, 255, 0.25)';
  ctx.fill();
  ctx.strokeStyle = '#eaffff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.x, p.y, 2.5, 0, TAU);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  if (p.invuln > 0 && p.dashT <= 0) {
    ctx.globalAlpha = Math.min(1, p.invuln) * 0.5;
    ctx.strokeStyle = '#3df2ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26 + Math.sin(time * 8) * 2, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
