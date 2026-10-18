// Enemy archetypes. Each one is a small behaviour object: init / update / draw (+ optional onDeath).
// `g` is the Game instance; behaviours only touch it through a handful of well-defined methods.

import { TAU, clamp, angleDiff } from '../engine/math.js';

function steer(e, tx, ty, speed, accel, dt) {
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, accel * dt);
  e.vx += ((dx / d) * speed - e.vx) * k;
  e.vy += ((dy / d) * speed - e.vy) * k;
}

/**
 * A singularity drags ships toward itself (dashing breaks free). Exported so a co-op guest can
 * apply the same pull to its locally predicted ship.
 */
export function singularityPull(e, p, dt) {
  if (!p.alive || p.dashT > 0) return;
  const dx = e.x - p.x;
  const dy = e.y - p.y;
  const d = Math.hypot(dx, dy) || 1;
  if (d >= 560) return;
  const pull = Math.min(240, 8e6 / (d * d));
  p.x += (dx / d) * pull * dt;
  p.y += (dy / d) * pull * dt;
}

/** Distance from point (px, py) to the ray from (x, y) at angle a, or Infinity if behind the start. */
export function rayDistance(x, y, a, px, py, start = 0) {
  const dx = px - x;
  const dy = py - y;
  const along = dx * Math.cos(a) + dy * Math.sin(a);
  if (along < start) return Infinity;
  return Math.abs(dx * Math.sin(a) - dy * Math.cos(a));
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
      const p = g.nearestPlayer(e.x, e.y);
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
      const p = g.nearestPlayer(e.x, e.y);
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
      const p = g.nearestPlayer(e.x, e.y);
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
      const p = g.nearestPlayer(e.x, e.y);
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
    color: '#ffa53d', r: 17, hp: 3, score: 150, sync: ['charge'],
    init(e) {
      e.data.cd = 1.6 + Math.random();
      e.data.charge = 0;
      e.data.side = Math.random() < 0.5 ? 1 : -1;
    },
    update(e, g, dt) {
      const p = g.nearestPlayer(e.x, e.y);
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
    color: '#ff3b5c', r: 24, hp: 16, score: 300, heavy: true, sync: ['pulse'],
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

      for (const p of g.players) if (!p.remote) singularityPull(e, p, dt);
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
        if (o === e || o.dead || o.spawnT > 0 || o.type === 'singularity' || ENEMIES[o.type].boss) continue;
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
      g.localFx.grid.applyForce(e.x, e.y, 260, -700 * dt);
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
    color: '#ffd84d', r: 66, hp: 1, score: 5000, heavy: true, boss: true, title: 'Hydra Core', sync: ['phase'],
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
        const p = g.nearestPlayer(e.x, e.y);
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

  // Boss 2: octagonal sentinel that sweeps the arena with rotating laser beams.
  // Beams are telegraphed as thin lines for ~1 s before they turn lethal.
  warden: {
    color: '#ff5c8a', r: 58, hp: 1, score: 6000, heavy: true, boss: true, title: 'Laser Warden',
    sync: ['phase', 'beamA', 'beamMode', 'beamK'],
    init(e, g) {
      e.maxHp = e.hp = 220 + g.wave * 50;
      e.data = { phase: 1, t: 0, attackT: 2.2, cycle: 0, beamMode: 0, beamT: 0, beamA: 0, beamSpin: 0, beamK: 0, bursts: 0, burstT: 0, burstA: 0 };
    },
    beams(e) {
      const n = e.data.phase === 2 ? 4 : 2;
      return Array.from({ length: n }, (_, k) => e.data.beamA + (k * TAU) / n);
    },
    hits(e, p) {
      if (e.data.beamMode !== 2) return false;
      for (const a of ENEMIES.warden.beams(e)) if (rayDistance(e.x, e.y, a, p.x, p.y, e.r * 0.6) < 13 + p.r * 0.5) return true;
      return false;
    },
    update(e, g, dt) {
      const d = e.data;
      const { W, H } = g.arena;
      const enraged = d.phase === 2;
      d.t += dt;
      steer(e, W / 2 + Math.cos(d.t * 0.21) * W * 0.2, H / 2 + Math.sin(d.t * 0.29) * H * 0.18, enraged ? 85 : 55, 0.8, dt);
      e.angle += dt * (enraged ? 0.9 : 0.4);
      if (d.phase === 1 && e.hp < e.maxHp * 0.5) {
        d.phase = 2;
        g.bossEnrage(e);
      }

      if (d.beamMode === 1) {
        d.beamT -= dt;
        d.beamK = Math.min(1, 1 - d.beamT / 1.1);
        d.beamA += d.beamSpin * 0.2 * dt;
        if (d.beamT <= 0) {
          d.beamMode = 2;
          d.beamT = enraged ? 3.8 : 3;
          g.addTrauma(0.35);
          g.audio.bomb();
        }
      } else if (d.beamMode === 2) {
        d.beamT -= dt;
        d.beamA += d.beamSpin * dt;
        if (d.beamT <= 0) d.beamMode = 0;
      }

      const fire = (a, speed) => g.fireEnemyBullet(e.x + Math.cos(a) * e.r * 0.8, e.y + Math.sin(a) * e.r * 0.8, a, speed);
      if (d.bursts > 0 && (d.burstT -= dt) <= 0) {
        d.bursts--;
        d.burstT = 0.4;
        d.burstA += 0.21;
        const n = enraged ? 18 : 14;
        for (let i = 0; i < n; i++) fire(d.burstA + (i * TAU) / n, 200);
      }
      if (d.beamMode === 0 && (d.attackT -= dt) <= 0) {
        const attack = ['beams', 'burst', 'beams', 'summon'][d.cycle++ % 4];
        if (attack === 'beams') {
          const p = g.nearestPlayer(e.x, e.y);
          d.beamMode = 1;
          d.beamT = 1.1;
          d.beamK = 0;
          // Start the sweep a quarter turn away from the target so it has to be dodged, not tanked.
          d.beamA = Math.atan2(p.y - e.y, p.x - e.x) + Math.PI / 2;
          d.beamSpin = (Math.random() < 0.5 ? -1 : 1) * (enraged ? 0.75 : 0.55);
          d.attackT = 1.2;
        } else if (attack === 'burst') {
          d.bursts = enraged ? 4 : 3;
          d.attackT = enraged ? 2 : 2.6;
        } else {
          const n = enraged ? 4 : 3;
          for (let i = 0; i < n; i++) {
            const a = (i * TAU) / n + e.angle;
            g.spawnEnemy(enraged && i === 0 ? 'sniper' : 'dodger', e.x + Math.cos(a) * (e.r + 80), e.y + Math.sin(a) * (e.r + 80));
          }
          d.attackT = enraged ? 2 : 2.6;
        }
        g.audio.enemyShoot();
      }
    },
    onDeath(e, g) {
      g.bossDefeated(e);
    },
    draw(ctx, e, t, color) {
      const d = e.data;
      const enraged = d.phase === 2;
      const body = color === '#ffffff' ? color : enraged ? '#ff3b5c' : color;
      if (d.beamMode > 0) {
        const L = 2600;
        for (const a of ENEMIES.warden.beams(e)) {
          const x0 = e.x + Math.cos(a) * e.r * 0.6;
          const y0 = e.y + Math.sin(a) * e.r * 0.6;
          const x1 = e.x + Math.cos(a) * L;
          const y1 = e.y + Math.sin(a) * L;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          if (d.beamMode === 1) {
            ctx.globalAlpha = 0.25 + d.beamK * 0.55;
            ctx.setLineDash([14, 12]);
            ctx.strokeStyle = '#ff9ab5';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            const flicker = 0.85 + Math.sin(t * 60) * 0.15;
            ctx.globalAlpha = 0.35 * flicker;
            ctx.strokeStyle = '#ff3b6b';
            ctx.lineWidth = 30;
            ctx.stroke();
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = '#ffd0dc';
            ctx.lineWidth = 7;
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
      }
      ctx.strokeStyle = body;
      ctx.lineWidth = 4;
      ctx.beginPath();
      poly(ctx, e.x, e.y, e.r, 8, e.angle);
      poly(ctx, e.x, e.y, e.r * 0.68, 4, -e.angle * 1.4);
      circle(ctx, e.x, e.y, e.r * (0.22 + (d.beamMode === 1 ? d.beamK * 0.12 : 0)));
      ctx.stroke();
      ctx.lineWidth = 2.5;
    },
  },

  // Boss 3: a pulsing hive that pours out minis and rams the nearest pilot, bursting on impact.
  brood: {
    color: '#9dff3d', r: 54, hp: 1, score: 6000, heavy: true, boss: true, title: 'Brood Mother',
    sync: ['phase', 'mode', 'tx', 'ty'],
    init(e, g) {
      e.maxHp = e.hp = 200 + g.wave * 50;
      e.data = { phase: 1, t: 0, mode: 0, modeT: 3, tx: e.x, ty: e.y, charges: 0, spawnT: 1.5, wx: e.x, wy: e.y };
    },
    update(e, g, dt) {
      const d = e.data;
      const { W, H } = g.arena;
      const enraged = d.phase === 2;
      d.t += dt;
      e.angle += dt * (d.mode === 2 ? 4 : 0.7);
      if (d.phase === 1 && e.hp < e.maxHp * 0.5) {
        d.phase = 2;
        g.bossEnrage(e);
      }
      const impact = () => {
        const n = enraged ? 24 : 16;
        for (let i = 0; i < n; i++) {
          const a = (i * TAU) / n;
          g.fireEnemyBullet(e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r, a, 230);
        }
        g.addTrauma(0.5);
        g.grid.applyForce(e.x, e.y, 420, 1600);
        g.addRing(e.x, e.y, { maxR: 260, life: 0.45, color: '#9dff3d', width: 6 });
        g.audio.explode(2);
        e.vx *= 0.1;
        e.vy *= 0.1;
        if (d.charges > 0) {
          d.charges--;
          const p = g.nearestPlayer(e.x, e.y);
          Object.assign(d, { mode: 1, modeT: 0.55, tx: p.x, ty: p.y });
        } else {
          Object.assign(d, { mode: 0, modeT: enraged ? 2.2 : 3 });
        }
      };

      if (d.mode === 0) {
        if (Math.random() < dt * 0.5) {
          d.wx = 200 + Math.random() * (W - 400);
          d.wy = 200 + Math.random() * (H - 400);
        }
        steer(e, d.wx, d.wy, 70, 0.7, dt);
        if ((d.spawnT -= dt) <= 0) {
          d.spawnT = enraged ? 1.1 : 1.6;
          const n = enraged ? 3 : 2;
          for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU;
            g.spawnEnemy(enraged && i === 0 && Math.random() < 0.35 ? 'splitter' : 'mini', e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r, { telegraph: false, vx: Math.cos(a) * 320, vy: Math.sin(a) * 320 });
          }
        }
        if ((d.modeT -= dt) <= 0) {
          const p = g.nearestPlayer(e.x, e.y);
          Object.assign(d, { mode: 1, modeT: 0.9, tx: p.x, ty: p.y, charges: enraged ? 1 : 0 });
        }
      } else if (d.mode === 1) {
        // Wind-up: brake hard and stare down the target.
        e.vx *= 1 - Math.min(1, 6 * dt);
        e.vy *= 1 - Math.min(1, 6 * dt);
        if ((d.modeT -= dt) <= 0) {
          const a = Math.atan2(d.ty - e.y, d.tx - e.x);
          const v = enraged ? 1150 : 950;
          e.vx = Math.cos(a) * v;
          e.vy = Math.sin(a) * v;
          d.mode = 2;
          d.modeT = 1.4;
          g.audio.dash();
        }
      } else {
        const m = e.r + 3;
        const wall = e.x <= m || e.y <= m || e.x >= W - m || e.y >= H - m;
        if (wall || (d.modeT -= dt) <= 0) impact();
        else if (g.tick % 2 === 0) g.particles.emit(e.x, e.y, { count: 2, color: '#9dff3d', speed: 120, life: 0.4 });
      }
    },
    onDeath(e, g) {
      g.bossDefeated(e);
    },
    draw(ctx, e, t, color) {
      const d = e.data;
      const enraged = d.phase === 2;
      const body = color === '#ffffff' ? color : enraged ? '#e8ff3d' : color;
      if (d.mode === 1) {
        ctx.globalAlpha = 0.5 + Math.sin(t * 30) * 0.3;
        ctx.setLineDash([10, 10]);
        ctx.strokeStyle = '#d9ff9a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(d.tx, d.ty);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        circle(ctx, d.tx, d.ty, 26);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const pulse = 1 + Math.sin(t * (enraged ? 9 : 5)) * 0.06;
      ctx.strokeStyle = body;
      ctx.lineWidth = 4;
      ctx.beginPath();
      const spikes = 9;
      for (let i = 0; i <= spikes * 2; i++) {
        const a = e.angle + (i * Math.PI) / spikes;
        const r = (i % 2 ? e.r * 0.62 : e.r) * pulse;
        if (i) ctx.lineTo(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r);
        else ctx.moveTo(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r);
      }
      ctx.closePath();
      circle(ctx, e.x, e.y, e.r * 0.34 * pulse);
      for (let i = 0; i < 3; i++) {
        const a = -e.angle * 1.3 + (i * TAU) / 3;
        circle(ctx, e.x + Math.cos(a) * e.r * 0.34, e.y + Math.sin(a) * e.r * 0.34, 5);
      }
      ctx.stroke();
      ctx.lineWidth = 2.5;
    },
  },
};

// Prism's mirror copies: fragile, but they keep shooting until cleaned up.
ENEMIES.decoy = {
  color: '#d8b4ff', r: 18, hp: 5, score: 100,
  init(e) {
    e.data.cd = 1 + Math.random() * 1.5;
    e.data.a = Math.random() * TAU;
  },
  update(e, g, dt) {
    const d = e.data;
    d.a += dt * 1.4;
    e.vx = Math.cos(d.a) * 90;
    e.vy = Math.sin(d.a) * 90;
    e.angle += dt * 2;
    if ((d.cd -= dt) <= 0) {
      d.cd = 2.2;
      const p = g.nearestPlayer(e.x, e.y);
      g.fireEnemyBullet(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), 280);
    }
  },
  draw(ctx, e, t, color) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    poly(ctx, e.x, e.y, e.r, 6, e.angle);
    poly(ctx, e.x, e.y, e.r * 0.55, 3, -e.angle);
    ctx.stroke();
    ctx.globalAlpha = 1;
  },
};

const SERPENT_SEGMENTS = 14;
const SERPENT_GAP = 30;

/** Remember where the head has been; the body is laid out along this path. */
function trackTrail(e) {
  const tr = (e.data.trail ??= [e.x, e.y]);
  const dx = e.x - tr[tr.length - 2];
  const dy = e.y - tr[tr.length - 1];
  if (dx * dx + dy * dy < 36) return;
  tr.push(e.x, e.y);
  const keep = ((SERPENT_SEGMENTS + 2) * SERPENT_GAP) / 6;
  if (tr.length > keep * 2) tr.splice(0, tr.length - keep * 2);
}

/** Body segment centres, every SERPENT_GAP px back along the trail from the head. */
export function serpentSegments(e) {
  const tr = e.data.trail ?? [e.x, e.y];
  const out = [];
  let px = e.x;
  let py = e.y;
  let need = SERPENT_GAP;
  for (let i = tr.length - 2; i >= 0 && out.length < SERPENT_SEGMENTS; i -= 2) {
    let x = tr[i];
    let y = tr[i + 1];
    let seg = Math.hypot(x - px, y - py);
    while (seg >= need && out.length < SERPENT_SEGMENTS) {
      const k = need / seg;
      px += (x - px) * k;
      py += (y - py) * k;
      out.push([px, py]);
      seg = Math.hypot(x - px, y - py);
      need = SERPENT_GAP;
    }
    need -= seg;
    px = x;
    py = y;
  }
  return out;
}

// Boss 4: a long serpent. Only the head takes damage; the body is a moving wall that
// fires rib volleys sideways. It hunts the nearest pilot with a sinuous, turn-limited path.
ENEMIES.serpent = {
  color: '#3dffc8', r: 32, hp: 1, score: 7000, heavy: true, boss: true, title: 'Void Serpent',
  sync: ['phase', 'fireT'],
  init(e, g) {
    e.maxHp = e.hp = 240 + g.wave * 45;
    e.angle = Math.PI / 2;
    e.data = { phase: 1, t: 0, volleyT: 3, fireT: 0, trail: [e.x, e.y - 400, e.x, e.y] };
  },
  hits(e, p) {
    const segs = serpentSegments(e);
    for (let i = 1; i < segs.length; i++) {
      const r = 18 - i * 0.5 + p.r * 0.6;
      if ((segs[i][0] - p.x) ** 2 + (segs[i][1] - p.y) ** 2 < r * r) return true;
    }
    return false;
  },
  update(e, g, dt) {
    const d = e.data;
    const enraged = d.phase === 2;
    d.t += dt;
    d.fireT = Math.max(0, d.fireT - dt);
    if (d.phase === 1 && e.hp < e.maxHp * 0.5) {
      d.phase = 2;
      g.bossEnrage(e);
    }
    const p = g.nearestPlayer(e.x, e.y);
    const want = Math.atan2(p.y - e.y, p.x - e.x) + Math.sin(d.t * 2.4) * 0.6;
    const turn = (enraged ? 2.3 : 1.6) * dt;
    e.angle += clamp(angleDiff(e.angle, want), -turn, turn);
    const speed = enraged ? 240 : 175;
    e.vx = Math.cos(e.angle) * speed;
    e.vy = Math.sin(e.angle) * speed;
    trackTrail(e);

    if ((d.volleyT -= dt) <= 0) {
      d.volleyT = enraged ? 2 : 2.8;
      d.fireT = 0.35;
      const segs = serpentSegments(e);
      for (let i = 2; i < segs.length; i += enraged ? 1 : 2) {
        const [x0, y0] = segs[i - 1];
        const [x1, y1] = segs[i];
        const a = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
        g.fireEnemyBullet(x1, y1, a, 190);
        if (enraged) g.fireEnemyBullet(x1, y1, a + Math.PI, 190);
      }
      g.audio.enemyShoot();
    }
  },
  onDeath(e, g) {
    for (const [x, y] of serpentSegments(e)) g.particles.emit(x, y, { count: 18, color: '#3dffc8', speed: 300, life: 0.7 });
    g.bossDefeated(e);
  },
  draw(ctx, e, t, color) {
    trackTrail(e); // the guest builds its own trail from the heads it sees
    const d = e.data;
    const enraged = d.phase === 2;
    const body = color === '#ffffff' ? color : enraged ? '#9dff3d' : color;
    const segs = serpentSegments(e);
    ctx.strokeStyle = body;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    for (const [x, y] of segs) ctx.lineTo(x, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.beginPath();
    segs.forEach(([x, y], i) => circle(ctx, x, y, Math.max(6, 17 - i * 0.6)));
    ctx.stroke();
    if (d.fireT > 0) {
      ctx.globalAlpha = d.fireT / 0.35;
      ctx.fillStyle = '#d6fff4';
      ctx.beginPath();
      segs.forEach(([x, y], i) => circle(ctx, x, y, Math.max(3, 8 - i * 0.3)));
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 4;
    ctx.beginPath();
    const a = e.angle;
    ctx.moveTo(e.x + Math.cos(a) * e.r * 1.3, e.y + Math.sin(a) * e.r * 1.3);
    ctx.lineTo(e.x + Math.cos(a + 2.3) * e.r, e.y + Math.sin(a + 2.3) * e.r);
    ctx.lineTo(e.x + Math.cos(a + Math.PI) * e.r * 0.5, e.y + Math.sin(a + Math.PI) * e.r * 0.5);
    ctx.lineTo(e.x + Math.cos(a - 2.3) * e.r, e.y + Math.sin(a - 2.3) * e.r);
    ctx.closePath();
    for (const s of [-1, 1]) circle(ctx, e.x + Math.cos(a + s * 0.6) * e.r * 0.6, e.y + Math.sin(a + s * 0.6) * e.r * 0.6, 4);
    ctx.stroke();
    ctx.lineWidth = 2.5;
  },
};

// Boss 5: a crystal that blinks around the arena. It shrinks before every teleport (the tell),
// bursts on arrival, fires aimed fans, and when enraged splits off shooting mirror copies.
ENEMIES.prism = {
  color: '#c48bff', r: 46, hp: 1, score: 7000, heavy: true, boss: true, title: 'Prism',
  sync: ['phase', 'charge', 'blink'],
  init(e, g) {
    e.maxHp = e.hp = 230 + g.wave * 45;
    e.data = { phase: 1, t: 0, attackT: 1.8, cycle: 0, charge: 0, blink: 0, fans: 0, fanT: 0 };
  },
  update(e, g, dt) {
    const d = e.data;
    const { W, H } = g.arena;
    const enraged = d.phase === 2;
    d.t += dt;
    d.blink = Math.max(0, d.blink - dt * 2);
    e.angle += dt * (enraged ? 1.6 : 0.8);
    if (d.phase === 1 && e.hp < e.maxHp * 0.5) {
      d.phase = 2;
      g.bossEnrage(e);
    }
    steer(e, W / 2 + Math.cos(d.t * 0.5) * 220, H / 2 + Math.sin(d.t * 0.7) * 160, 40, 0.6, dt);

    if (d.charge > 0) {
      e.vx *= 0.9;
      e.vy *= 0.9;
      if ((d.charge -= dt) <= 0) {
        d.charge = 0;
        // Teleport somewhere at least 350 px from every pilot.
        let best = null;
        for (let i = 0; i < 20; i++) {
          const x = 150 + Math.random() * (W - 300);
          const y = 150 + Math.random() * (H - 300);
          const near = Math.min(...g.players.map((pl) => Math.hypot(x - pl.x, y - pl.y)));
          if (!best || near > best[2]) best = [x, y, near];
          if (near > 350) break;
        }
        g.particles.emit(e.x, e.y, { count: 40, color: '#c48bff', speed: 300, life: 0.5 });
        e.x = best[0];
        e.y = best[1];
        e.vx = 0;
        e.vy = 0;
        d.blink = 1;
        g.addRing(e.x, e.y, { maxR: 160, life: 0.35, color: '#e8d4ff', width: 5 });
        const n = enraged ? 20 : 14;
        for (let i = 0; i < n; i++) g.fireEnemyBullet(e.x, e.y, e.angle + (i * TAU) / n, 210);
        g.audio.dash();
      }
    }
    if (d.fans > 0 && (d.fanT -= dt) <= 0) {
      d.fans--;
      d.fanT = 0.35;
      const p = g.nearestPlayer(e.x, e.y);
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      const n = enraged ? 9 : 7;
      for (let i = 0; i < n; i++) g.fireEnemyBullet(e.x, e.y, a + (i - (n - 1) / 2) * 0.16, 300);
    }
    if (d.charge <= 0 && d.fans <= 0 && (d.attackT -= dt) <= 0) {
      const attack = (enraged ? ['blink', 'fan', 'mirror', 'blink', 'fan'] : ['blink', 'fan', 'blink', 'fan'])[d.cycle++ % (enraged ? 5 : 4)];
      if (attack === 'blink') d.charge = 0.7;
      else if (attack === 'fan') d.fans = 3;
      else {
        for (let i = 0; i < 2; i++) {
          const a = e.angle + i * Math.PI;
          g.spawnEnemy('decoy', e.x + Math.cos(a) * 120, e.y + Math.sin(a) * 120);
        }
      }
      d.attackT = enraged ? 1.5 : 2.1;
    }
  },
  onDeath(e, g) {
    g.bossDefeated(e);
  },
  draw(ctx, e, t, color) {
    const d = e.data;
    const enraged = d.phase === 2;
    const body = color === '#ffffff' ? color : enraged ? '#ff8af0' : color;
    const k = d.charge > 0 ? 0.55 + (d.charge / 0.7) * 0.45 : 1; // shrinks before a blink
    const r = e.r * k;
    if (d.blink > 0) {
      ctx.globalAlpha = d.blink * 0.6;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      circle(ctx, e.x, e.y, e.r * (1.2 + (1 - d.blink) * 1.5));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = body;
    ctx.lineWidth = 4;
    ctx.beginPath();
    poly(ctx, e.x, e.y, r, 6, e.angle);
    poly(ctx, e.x, e.y, r * 0.75, 3, -e.angle * 1.3);
    poly(ctx, e.x, e.y, r * 0.75, 3, -e.angle * 1.3 + Math.PI);
    ctx.stroke();
    if (d.charge > 0) {
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = e.angle + (i * TAU) / 6;
        ctx.moveTo(e.x + Math.cos(a) * e.r * 1.6, e.y + Math.sin(a) * e.r * 1.6);
        ctx.lineTo(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 2.5;
  },
};

/** Boss waves cycle through these, every fifth wave. */
export const BOSS_ORDER = ['boss', 'warden', 'brood', 'serpent', 'prism'];
export const ENEMY_TYPES = Object.keys(ENEMIES);

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
