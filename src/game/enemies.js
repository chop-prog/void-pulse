// Enemy archetypes. Each one is a small behaviour object: init / update / draw (+ optional onDeath).
// `g` is the Game instance; behaviours only touch it through a handful of well-defined methods.

import { TAU, clamp } from '../engine/math.js';

function steer(e, tx, ty, speed, accel, dt) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, accel * dt);
  e.vx += ((dx / d) * speed - e.vx) * k;
  e.vy += ((dy / d) * speed - e.vy) * k;
}

function poly(ctx, x, y, r, sides, rot) {
  ctx.moveTo(x + Math.cos(rot) * r, y + Math.sin(rot) * r);
  for (let i = 1; i < sides; i++) {
    const a = rot + (i * TAU) / sides;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

function circle(ctx, x, y, r) {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, TAU);
}

export const ENEMIES = {
  // Lazy wanderer. Harmless alone, dangerous in a crowd.
  drifter: {
    color: '#b46bff', r: 16, hp: 1, score: 25,
    init(e) { e.data.dir = Math.random() * TAU; },
    update(e, g, dt) {
      e.data.dir += (Math.random() - 0.5) * 6 * dt;
      const s = 95 * e.speedMul;
      const k = Math.min(1, 2 * dt);
      e.vx += (Math.cos(e.data.dir) * s - e.vx) * k;
      e.vy += (Math.sin(e.data.dir) * s - e.vy) * k;
      e.angle += dt * 2.6;
    },
    draw(ctx, e, t, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = e.angle + (i * TAU) / 4;
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r);
        ctx.lineTo(e.x + Math.cos(a + 0.9) * e.r * 0.6, e.y + Math.sin(a + 0.9) * e.r * 0.6);
        ctx.closePath();
      }
      ctx.stroke();
    },
  },

  // Homes straight in. The bread and butter of every wave.
  seeker: {
    color: '#3df2ff', r: 15, hp: 1, score: 50,
    update(e, g, dt) {
      const p = g.player;
      steer(e, p.x, p.y, 235 * e.speedMul, 3.2, dt);
      e.angle = Math.atan2(e.vy, e.vx);
    },
    draw(ctx, e, t, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r, 4, e.angle);
      const pulse = 0.35 + Math.sin(t * 10 + e.id) * 0.1;
      poly(ctx, e.x, e.y, e.r * pulse, 4, e.angle);
      ctx.stroke();
    },
  },

  // Reads incoming bullets and side-steps them.
  dodger: {
    color: '#4dff88', r: 16, hp: 2, score: 100,
    update(e, g, dt) {
      const p = g.player;
      steer(e, p.x, p.y, 190 * e.speedMul, 2.4, dt);
      for (const b of g.bullets) {
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 170 * 170) continue;
        const bl = Math.hypot(b.vx, b.vy) || 1;
        const d = Math.sqrt(d2) || 1;
        // Is the bullet heading at us?
        if ((dx * b.vx + dy * b.vy) / (bl * d) < 0.8) continue;
        const side = b.vx * dy - b.vy * dx > 0 ? 1 : -1;
        e.vx += (-b.vy / bl) * side * 2600 * dt;
        e.vy += (b.vx / bl) * side * 2600 * dt;
      }
      const sp = Math.hypot(e.vx, e.vy);
      if (sp > 460) { e.vx *= 460 / sp; e.vy *= 460 / sp; }
      e.angle += dt * 1.5;
    },
    draw(ctx, e, t, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r * 1.2, 4, Math.PI / 4);
      poly(ctx, e.x, e.y, e.r * 0.7, 4, e.angle);
      ctx.stroke();
    },
  },

  // Bursts into three fast fragments.
  splitter: {
    color: '#ff4fd8', r: 20, hp: 3, score: 75,
    update(e, g, dt) {
      const p = g.player;
      steer(e, p.x, p.y, 120 * e.speedMul, 1.5, dt);
      e.angle += dt * 1.2;
    },
    onDeath(e, g) {
      for (let i = 0; i < 3; i++) {
        const a = e.angle + (i * TAU) / 3;
        g.spawnEnemy('mini', e.x + Math.cos(a) * 14, e.y + Math.sin(a) * 14, { telegraph: false, vx: Math.cos(a) * 380, vy: Math.sin(a) * 380 });
      }
    },
    draw(ctx, e, t, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r, 4, e.angle);
      for (let i = 0; i < 3; i++) {
        const a = e.angle + (i * TAU) / 3;
        poly(ctx, e.x + Math.cos(a) * e.r * 0.42, e.y + Math.sin(a) * e.r * 0.42, e.r * 0.3, 3, a);
      }
      ctx.stroke();
    },
  },

  mini: {
    color: '#ff9bf0', r: 9, hp: 1, score: 25,
    update(e, g, dt) {
      const p = g.player;
      steer(e, p.x, p.y, 310 * e.speedMul, 2.2, dt);
      const w = Math.sin(g.time * 9 + e.id) * 260 * dt;
      e.vx += -e.vy * w * 0.01;
      e.vy += e.vx * w * 0.01;
      e.angle = Math.atan2(e.vy, e.vx);
    },
    draw(ctx, e, t, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r, 3, e.angle);
      ctx.stroke();
    },
  },

  // Keeps its distance, strafes, and fires telegraphed shots.
  sniper: {
    color: '#ffa53d', r: 17, hp: 3, score: 150,
    init(e) {
      e.data.cd = 1.6 + Math.random();
      e.data.charge = 0;
      e.data.side = Math.random() < 0.5 ? 1 : -1;
    },
    update(e, g, dt) {
      const p = g.player;
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const radial = clamp((d - 420) * 2, -200, 200);
      const tx = ux * radial - uy * 130 * e.data.side;
      const ty = uy * radial + ux * 130 * e.data.side;
      const k = Math.min(1, 2.5 * dt);
      e.vx += (tx * e.speedMul - e.vx) * k;
      e.vy += (ty * e.speedMul - e.vy) * k;
      e.angle = Math.atan2(dy, dx);
      if (Math.random() < dt * 0.3) e.data.side *= -1;

      const d0 = e.data;
      if (d0.charge > 0) {
        d0.charge -= dt;
        if (d0.charge <= 0) {
          g.fireEnemyBullet(e.x + ux * e.r, e.y + uy * e.r, e.angle, 400);
          d0.cd = 1.8 + Math.random() * 0.9;
        }
      } else if ((d0.cd -= dt) <= 0) {
        d0.charge = 0.55;
      }
    },
    draw(ctx, e, t, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r, 3, e.angle);
      poly(ctx, e.x, e.y, e.r * 0.4, 3, e.angle + Math.PI);
      ctx.stroke();
      if (e.data.charge > 0) {
        const k = 1 - e.data.charge / 0.55;
        ctx.strokeStyle = '#ffe2b0';
        ctx.beginPath();
        circle(ctx, e.x + Math.cos(e.angle) * e.r, e.y + Math.sin(e.angle) * e.r, 2 + k * 9);
        ctx.stroke();
      }
    },
  },

  // Gravity well: bends bullets, drags the player, eats other enemies and grows.
  singularity: {
    color: '#ff3b5c', r: 24, hp: 16, score: 300, heavy: true,
    init(e, g) {
      e.data.pulse = 0;
      e.data.absorbed = 0;
      e.data.tx = e.x;
      e.data.ty = e.y;
    },
    update(e, g, dt) {
      const d0 = e.data;
      if (Math.random() < dt * 0.4) {
        d0.tx = 200 + Math.random() * (g.arena.W - 400);
        d0.ty = 200 + Math.random() * (g.arena.H - 400);
      }
      steer(e, d0.tx, d0.ty, 45, 0.6, dt);
      d0.pulse += dt * (2.5 + d0.absorbed * 0.5);
      e.angle += dt * 0.8;

      const p = g.player;
      if (p.alive && p.dashT <= 0) {
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 560) {
          const pull = Math.min(240, 8e6 / (d * d));
          p.x += (dx / d) * pull * dt;
          p.y += (dy / d) * pull * dt;
        }
      }
      for (const b of g.bullets) {
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 340 * 340) continue;
        const d = Math.sqrt(d2) || 1;
        const a = Math.min(3000, 1.2e8 / d2);
        b.vx += (dx / d) * a * dt;
        b.vy += (dy / d) * a * dt;
      }
      for (const o of g.enemies) {
        if (o === e || o.dead || o.spawnT > 0 || o.type === 'singularity' || o.type === 'boss') continue;
        const dx = e.x - o.x;
        const dy = e.y - o.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > 380) continue;
        o.vx += (dx / d) * 900 * dt;
        o.vy += (dy / d) * 900 * dt;
        if (d < e.r + o.r * 0.5) {
          o.dead = true;
          e.hp += 3;
          d0.absorbed++;
          e.r = Math.min(44, e.r + 1.6);
          g.particles.emit(o.x, o.y, { count: 14, color: ENEMIES[o.type].color, speed: 160, life: 0.5 });
        }
      }
      g.grid.applyForce(e.x, e.y, 260, -700 * dt);
      if (d0.absorbed >= 10) {
        // Overload: collapses and spews fragments.
        g.killEnemy(e, { noScore: true });
        for (let i = 0; i < 8; i++) {
          const a = (i * TAU) / 8;
          g.spawnEnemy('mini', e.x, e.y, { telegraph: false, vx: Math.cos(a) * 420, vy: Math.sin(a) * 420 });
        }
      }
    },
    draw(ctx, e, t, color) {
      const pulse = Math.sin(e.data.pulse * 3) * 0.12;
      ctx.strokeStyle = color;
      ctx.beginPath();
      circle(ctx, e.x, e.y, e.r * (1 + pulse * 0.4));
      circle(ctx, e.x, e.y, e.r * (0.55 - pulse));
      ctx.stroke();
      ctx.setLineDash([6, 10]);
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * 1.6, e.angle, e.angle + TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    },
  },

  // Boss: rotating hex core with four attack patterns and an enraged second phase.
  boss: {
    color: '#ffd84d', r: 66, hp: 1, score: 5000, heavy: true, boss: true,
    init(e, g) {
      e.maxHp = e.hp = 180 + g.wave * 55;
      e.data = { phase: 1, t: 0, attackT: 2.5, cycle: 0, spiral: 0, spiralCd: 0, spiralA: 0, volleys: 0, volleyT: 0 };
    },
    update(e, g, dt) {
      const d = e.data;
      const { W, H } = g.arena;
      d.t += dt;
      const tx = W / 2 + Math.cos(d.t * 0.33) * W * 0.3;
      const ty = H / 2 + Math.sin(d.t * 0.47) * H * 0.26;
      steer(e, tx, ty, d.phase === 2 ? 150 : 95, 1.2, dt);
      e.angle += dt * (d.phase === 2 ? 1.3 : 0.6);

      if (d.phase === 1 && e.hp < e.maxHp * 0.5) {
        d.phase = 2;
        g.bossEnrage(e);
      }

      const fire = (a, speed) => g.fireEnemyBullet(e.x + Math.cos(a) * e.r * 0.7, e.y + Math.sin(a) * e.r * 0.7, a, speed);
      if ((d.attackT -= dt) <= 0) {
        const attack = ['burst', 'spiral', 'summon', 'volley'][d.cycle++ % 4];
        if (attack === 'burst') {
          const n = d.phase === 2 ? 30 : 20;
          for (let i = 0; i < n; i++) fire(e.angle + (i * TAU) / n, 210);
          if (d.phase === 2) for (let i = 0; i < n; i++) fire(e.angle + ((i + 0.5) * TAU) / n, 150);
        } else if (attack === 'spiral') {
          d.spiral = 2.6;
        } else if (attack === 'summon') {
          const n = 3 + d.phase;
          for (let i = 0; i < n; i++) {
            const a = (i * TAU) / n;
            g.spawnEnemy('seeker', e.x + Math.cos(a) * (e.r + 70), e.y + Math.sin(a) * (e.r + 70));
          }
        } else {
          d.volleys = 3 + d.phase;
        }
        d.attackT = d.phase === 2 ? 2.4 : 3.4;
        g.audio.enemyShoot();
      }
      if (d.spiral > 0) {
        d.spiral -= dt;
        if ((d.spiralCd -= dt) <= 0) {
          d.spiralCd = 0.055;
          d.spiralA += 0.33;
          const arms = d.phase === 2 ? 3 : 2;
          for (let k = 0; k < arms; k++) fire(d.spiralA + (k * TAU) / arms, 240);
        }
      }
      if (d.volleys > 0 && (d.volleyT -= dt) <= 0) {
        d.volleys--;
        d.volleyT = 0.32;
        const p = g.player;
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        for (let k = -2; k <= 2; k++) fire(a + k * 0.13, 330);
      }
    },
    onDeath(e, g) {
      g.bossDefeated(e);
    },
    draw(ctx, e, t, color) {
      const enraged = e.data.phase === 2;
      ctx.strokeStyle = color === '#ffffff' ? color : enraged ? '#ff7a3d' : color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r, 6, e.angle);
      poly(ctx, e.x, e.y, e.r * 0.62, 3, -e.angle * 1.6);
      poly(ctx, e.x, e.y, e.r * 0.62, 3, -e.angle * 1.6 + Math.PI);
      circle(ctx, e.x, e.y, e.r * (0.2 + Math.sin(t * (enraged ? 14 : 7)) * 0.04));
      for (let i = 0; i < 6; i++) {
        const a = -e.angle * 0.7 + (i * TAU) / 6;
        circle(ctx, e.x + Math.cos(a) * e.r * 1.22, e.y + Math.sin(a) * e.r * 1.22, 5);
      }
      ctx.stroke();
      ctx.lineWidth = 2.5;
    },
  },
};

export const SPAWN_TIME = 0.75;

export function drawSpawning(ctx, e, t) {
  const T = ENEMIES[e.type];
  const k = e.spawnT / SPAWN_TIME; // 1 → 0
  ctx.globalAlpha = 1 - k;
  ctx.strokeStyle = T.color;
  ctx.beginPath();
  circle(ctx, e.x, e.y, e.r * (1 + k * 2.6));
  ctx.stroke();
  ctx.globalAlpha = (1 - k) * 0.5;
  T.draw(ctx, e, t, T.color);
  ctx.globalAlpha = 1;
}
