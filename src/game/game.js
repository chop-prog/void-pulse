import { TAU, clamp, damp, dist2, angleDiff, easeOutCubic, Rng, hashString } from '../engine/math.js';
import { SpatialHash } from '../engine/spatial-hash.js';
import { Particles } from '../engine/particles.js';
import { WarpGrid } from '../engine/grid.js';
import { Input } from '../engine/input.js';
import { ENEMIES, drawSpawning, SPAWN_TIME } from './enemies.js';
import { createPlayer, updatePlayer, drawPlayer } from './player.js';
import { planWave, resolveFormation, UNLOCK_WAVE } from './waves.js';
import { rollUpgrades, applyUpgrade } from './upgrades.js';

export const ARENA = Object.freeze({ W: 2000, H: 1300 });
const VIEW_SIZE = 820; // world units visible along the shorter screen axis
const VIEW_MAX = 1500;
const MAX_GEOMS = 350;
const MAX_ENEMY_BULLETS = 600;
const NEON = ['#3df2ff', '#ff4fd8', '#b46bff', '#4dff88', '#ffd84d', '#ffa53d'];
const HUD_STATES = new Set(['playing', 'paused', 'upgrade', 'dying']);
const NEW_THREAT = {
  dodger: 'New threat · Dodgers read your bullets',
  splitter: 'New threat · Splitters burst into fragments',
  sniper: 'New threat · Snipers keep their distance',
  singularity: 'New threat · Singularities bend space',
};

/** UTC date, so a daily seed is the same for everyone on Earth. */
export const todayKey = () => new Date().toISOString().slice(0, 10);

export class Game {
  constructor({ renderer, input, audio, ui, settings, storage }) {
    Object.assign(this, { renderer, input, audio, ui, settings, storage });
    this.arena = ARENA;
    this.grid = new WarpGrid(ARENA.W, ARENA.H, 40);
    this.particles = new Particles(4000);
    this.hash = new SpatialHash(96);
    this.camera = { x: ARENA.W / 2, y: ARENA.H / 2 };
    this.view = { zoom: 1, ox: 0, oy: 0, dpr: 1 };
    this.trauma = 0;
    this.time = 0;
    this.tick = 0;
    this.ambientT = 0;
    this.debug = new URLSearchParams(location.search).has('debug');
    this.debugT = 0;
    this.state = 'menu';
    this.mode = 'standard';
    this.wave = 0;
    this.score = 0;
    this.mult = 1;
    this._q = [];
    this._qc = [];
    this._chainDepth = 0;
    this._screen = { x: 0, y: 0 };
    this.player = createPlayer(ARENA.W / 2, ARENA.H / 2);
    this.player.alive = false;
    this.resetWorld();
    this.refreshBest();
    this.ui.showScreen('menu');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  resetWorld() {
    this.enemies = [];
    this.bullets = [];
    this.enemyBullets = [];
    this.geoms = [];
    this.rings = [];
    this.bolts = [];
    this.popups = [];
    this.orbs = [];
    this.singularities = [];
    this.boss = null;
    this.director = null;
    this.vacuum = false;
    this.particles.clear();
  }

  newRun({ daily = false } = {}) {
    this.mode = daily ? 'daily' : 'standard';
    this.seed = daily ? hashString(`void-pulse:${todayKey()}`) : (Math.random() * 2 ** 32) >>> 0;
    this.rng = new Rng(this.seed);
    this.resetWorld();
    this.player = createPlayer(ARENA.W / 2, ARENA.H / 2);
    Object.assign(this, { score: 0, mult: 1, peakMult: 1, kills: 0, runTime: 0, owned: {}, nextId: 1, hitstop: 0, orbAngle: 0 });
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
    this.grid.applyForce(this.player.x, this.player.y, 500, 1500);
    this.addRing(this.player.x, this.player.y, { maxR: 400, life: 0.7, color: '#3df2ff', width: 5 });
    this.startWave(1);
    this.setState('playing');
    this.audio.startMusic();
  }

  setState(s) {
    this.state = s;
    this.ui.showScreen(s);
  }

  pause() {
    if (this.state === 'playing') this.setState('paused');
  }

  resume() {
    if (this.state === 'paused') this.setState('playing');
  }

  toMenu() {
    this.resetWorld();
    this.player.alive = false;
    this.refreshBest();
    this.setState('menu');
    this.audio.setIntensity(0.1);
  }

  refreshBest() {
    this.ui.setBest(this.storage.get('best:standard', 0), this.storage.get(`best:daily:${todayKey()}`, 0), todayKey());
  }

  gameOver() {
    const daily = this.mode === 'daily';
    const key = daily ? `best:daily:${todayKey()}` : 'best:standard';
    const prev = this.storage.get(key, 0);
    const summary = {
      mode: this.mode, date: todayKey(), score: this.score, wave: this.wave, kills: this.kills,
      time: this.runTime, peakMult: this.peakMult, owned: { ...this.owned },
      best: Math.max(prev, this.score), isBest: this.score > prev,
    };
    if (summary.isBest) this.storage.set(key, this.score);
    this.storage.set('runs', this.storage.get('runs', 0) + 1);
    for (const e of this.enemies) this.killEnemy(e, { noScore: true, noChain: true });
    this.enemyBullets.length = 0;
    this.bullets.length = 0;
    this.setState('gameover');
    this.ui.showGameOver(summary);
    this.audio.setIntensity(0.1);
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  update(dt) {
    this.tick++;
    const input = this.input;
    input.poll();
    if (input.consume('debug')) {
      this.debug = !this.debug;
      if (!this.debug) this.ui.debug(null);
    }
    if (input.consume('mute')) this.ui.handlers.toggleSound();

    switch (this.state) {
      case 'playing':
        if (input.consume('pause')) this.pause();
        else this.step(dt);
        break;
      case 'dying':
        this.step(dt * 0.35);
        if ((this.deathTimer -= dt) <= 0) this.gameOver();
        break;
      case 'paused':
        if (input.consume('pause')) this.resume();
        this.menuNav();
        break;
      case 'upgrade':
        this.updateFx(dt);
        this.menuNav();
        break;
      default:
        this.updateAmbient(dt);
        this.menuNav();
    }
    input.flush();
  }

  menuNav() {
    const i = this.input;
    if (i.consume('navLeft') || i.consume('navUp')) this.ui.navigate(-1);
    if (i.consume('navRight') || i.consume('navDown')) this.ui.navigate(1);
    if (i.consume('confirm')) this.ui.confirm();
  }

  step(dt) {
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      dt *= 0.1;
    }
    this.time += dt;
    if (this.state === 'playing') this.runTime += dt;

    if (this.player.alive) updatePlayer(this, dt);
    this.updateDirector(dt);
    this.updateEnemies(dt);
    this.buildHash();
    this.separateEnemies();
    this.updateBullets(dt);
    this.updateEnemyBullets(dt);
    this.updateOrbitals(dt);
    this.collidePlayer();
    this.updateGeoms(dt);
    this.updateFx(dt);

    let j = 0;
    for (const e of this.enemies) if (!e.dead) this.enemies[j++] = e;
    this.enemies.length = j;

    if (this.state === 'playing') this.checkWaveClear(dt);

    const intensity = this.state === 'dying' ? 0.1
      : this.boss ? 1
      : clamp(0.3 + this.enemies.length / 35 + this.wave * 0.03, 0, 0.95);
    this.audio.setIntensity(intensity);
  }

  updateAmbient(dt) {
    this.time += dt;
    if ((this.ambientT -= dt) <= 0) {
      this.ambientT = 0.6 + Math.random();
      const x = 150 + Math.random() * (ARENA.W - 300);
      const y = 150 + Math.random() * (ARENA.H - 300);
      const color = NEON[Math.floor(Math.random() * NEON.length)];
      this.grid.applyForce(x, y, 260, 900);
      this.particles.emit(x, y, { count: 50, color, speed: 420, speedMin: 60, life: 1.2, lifeMin: 0.4 });
      this.addRing(x, y, { maxR: 160, life: 0.6, color, width: 3 });
    }
    this.updateFx(dt);
  }

  // ── Waves ────────────────────────────────────────────────────────────────────
  startWave(n) {
    this.wave = n;
    const plan = planWave(n, this.rng);
    this.director = { t: 0, groups: plan.groups, idx: 0, cleared: false, clearT: 0, boss: plan.boss };
    if (plan.boss) {
      this.ui.banner('Warning', 'Hydra core approaching', 'danger');
    } else {
      const fresh = Object.keys(NEW_THREAT).find((t) => UNLOCK_WAVE[t] === n);
      const total = plan.groups.reduce((s, g) => s + g.count, 0);
      this.ui.banner(`Wave ${n}`, fresh ? NEW_THREAT[fresh] : `${total} hostiles inbound`);
    }
    this.audio.waveStart(plan.boss);
  }

  updateDirector(dt) {
    const d = this.director;
    if (!d || this.state !== 'playing') return;
    d.t += dt;
    // Arena empty? Pull the next group forward instead of making the player wait.
    if (d.idx < d.groups.length && this.enemies.length === 0 && d.t > 0.8 && d.groups[d.idx].at > d.t) d.t = d.groups[d.idx].at;
    while (d.idx < d.groups.length && d.groups[d.idx].at <= d.t) {
      const group = d.groups[d.idx++];
      for (const [x, y] of resolveFormation(group.formation, group.count, this.player, this.arena)) this.spawnEnemy(group.type, x, y);
    }
  }

  checkWaveClear(dt) {
    const d = this.director;
    if (!d || d.idx < d.groups.length || this.enemies.length) return;
    if (!d.cleared) {
      d.cleared = true;
      const bonus = 250 * this.wave * (d.boss ? 4 : 1);
      this.score += bonus;
      this.vacuum = true;
      this.ui.banner(d.boss ? 'Core destroyed' : 'Wave cleared', `+${bonus.toLocaleString('en-US')} bonus`, 'good');
      this.audio.waveClear();
    }
    if ((d.clearT += dt) > 1.7) {
      this.vacuum = false;
      this.openUpgrade();
    }
  }

  openUpgrade() {
    this.enemyBullets.length = 0;
    this.choices = rollUpgrades(this.owned, this.rng, 3);
    if (!this.choices.length) {
      this.startWave(this.wave + 1);
      return;
    }
    this.setState('upgrade');
    this.ui.showUpgrades(this.wave, this.choices, this.owned, (i) => this.pickUpgrade(i));
  }

  pickUpgrade(i) {
    const u = this.choices && this.choices[i];
    if (this.state !== 'upgrade' || !u) return;
    applyUpgrade(this.player, u, this.owned);
    this.audio.upgrade();
    const p = this.player;
    this.particles.emit(p.x, p.y, { count: 60, color: '#ffd84d', speed: 400, life: 0.8 });
    this.addRing(p.x, p.y, { maxR: 180, life: 0.5, color: '#ffd84d' });
    this.startWave(this.wave + 1);
    this.setState('playing');
  }

  // ── Enemies ──────────────────────────────────────────────────────────────────
  spawnEnemy(type, x, y, { telegraph = true, vx = 0, vy = 0 } = {}) {
    const T = ENEMIES[type];
    const hp = T.hp * (1 + (this.wave - 1) * 0.09);
    const e = {
      id: this.nextId++, type, x, y, vx, vy, r: T.r, hp, maxHp: hp,
      angle: Math.random() * TAU, spawnT: telegraph ? SPAWN_TIME : 0, flash: 0, orbCd: 0, dead: false,
      speedMul: 1 + Math.min(0.45, (this.wave - 1) * 0.025), data: {},
    };
    if (T.init) T.init(e, this);
    this.enemies.push(e);
    if (telegraph) this.audio.spawn();
    return e;
  }

  updateEnemies(dt) {
    this.singularities.length = 0;
    this.boss = null;
    const { W, H } = this.arena;
    // Index loop: behaviours may spawn enemies mid-iteration.
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) continue;
      const T = ENEMIES[e.type];
      if (e.spawnT > 0) {
        e.spawnT -= dt;
        if (e.spawnT <= 0) {
          this.particles.emit(e.x, e.y, { count: 12, color: T.color, speed: 220, life: 0.4 });
          this.grid.applyForce(e.x, e.y, 120, 300);
        }
        continue;
      }
      if (e.flash > 0) e.flash -= dt;
      if (e.orbCd > 0) e.orbCd -= dt;
      T.update(e, this, dt);
      if (e.dead) continue;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.x < e.r) { e.x = e.r; e.vx = Math.abs(e.vx); } else if (e.x > W - e.r) { e.x = W - e.r; e.vx = -Math.abs(e.vx); }
      if (e.y < e.r) { e.y = e.r; e.vy = Math.abs(e.vy); } else if (e.y > H - e.r) { e.y = H - e.r; e.vy = -Math.abs(e.vy); }
      if (e.type === 'singularity') this.singularities.push(e);
      if (T.boss) this.boss = e;
    }
  }

  buildHash() {
    this.hash.clear();
    for (const e of this.enemies) if (!e.dead && e.spawnT <= 0) this.hash.insert(e);
  }

  /** Soft separation so swarms spread into readable shapes instead of stacking. */
  separateEnemies() {
    const q = this._q;
    for (const e of this.enemies) {
      if (e.dead || e.spawnT > 0 || ENEMIES[e.type].heavy) continue;
      q.length = 0;
      this.hash.query(e.x, e.y, e.r, q);
      for (const o of q) {
        if (o === e || o.dead) continue;
        const dx = e.x - o.x;
        const dy = e.y - o.y;
        const min = e.r + o.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 1e-4) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.25;
        e.x += (dx / d) * push;
        e.y += (dy / d) * push;
      }
    }
  }

  damageEnemy(e, dmg, kx, ky, crit) {
    if (e.dead || e.spawnT > 0) return;
    const T = ENEMIES[e.type];
    e.hp -= dmg;
    e.flash = 0.06;
    if (!T.heavy) {
      e.vx += kx * 0.04;
      e.vy += ky * 0.04;
    }
    this.particles.emit(e.x, e.y, { count: crit ? 8 : 4, color: crit ? '#ffe66b' : T.color, speed: 300, life: 0.3 });
    if (e.hp <= 0) this.killEnemy(e);
    else this.audio.hit();
  }

  killEnemy(e, { noScore = false, noChain = false, bomb = false } = {}) {
    if (e.dead) return;
    e.dead = true;
    const T = ENEMIES[e.type];
    const size = e.r / 16;
    this.particles.emit(e.x, e.y, {
      count: Math.min(160, Math.round(26 * size)), color: T.color, speed: 380 * Math.sqrt(size) + 120, speedMin: 40,
      life: 1, lifeMin: 0.35, size: size > 1.5 ? 3 : 2,
    });
    this.particles.emit(e.x, e.y, { count: 8, color: '#ffffff', speed: 240, life: 0.25 });
    this.grid.applyForce(e.x, e.y, 150 * size, 650 * size);
    this.addTrauma(0.08 * size);
    this.audio.explode(size);
    if (!noScore) {
      const pts = T.score * this.mult;
      this.score += pts;
      this.kills++;
      if (T.score >= 100) this.popup(e.x, e.y, pts.toLocaleString('en-US'), T.color);
      const shards = clamp(Math.round(T.score / 25), 1, 6);
      this.dropGeoms(e.x, e.y, bomb ? Math.ceil(shards / 2) : shards);
    }
    if (T.onDeath) T.onDeath(e, this);
    const chain = this.player.stats.chain;
    if (!noChain && chain > 0 && Math.random() < chain) this.chainFrom(e);
  }

  chainFrom(src) {
    if (this._chainDepth >= 4) return;
    const q = this._qc;
    q.length = 0;
    this.hash.query(src.x, src.y, 260, q);
    let best = null;
    let bd = 260 * 260;
    for (const e of q) {
      if (e.dead || e === src) continue;
      const d2 = dist2(e.x, e.y, src.x, src.y);
      if (d2 < bd) { bd = d2; best = e; }
    }
    if (!best) return;
    this.bolts.push({ pts: jagged(src.x, src.y, best.x, best.y), life: 0.22 });
    this._chainDepth++;
    this.damageEnemy(best, this.player.stats.damage * 2 + 1, 0, 0, false);
    this._chainDepth--;
  }

  fireEnemyBullet(x, y, a, speed) {
    if (this.enemyBullets.length >= MAX_ENEMY_BULLETS) return;
    this.enemyBullets.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 7, life: 6 });
    this.audio.enemyShoot();
  }

  bossEnrage(e) {
    this.addTrauma(0.8);
    this.addRing(e.x, e.y, { maxR: 500, life: 0.8, color: '#ff7a3d', width: 8 });
    this.grid.applyForce(e.x, e.y, 600, 1800);
    this.ui.banner('Enraged', 'Core overload detected', 'danger');
    this.audio.waveStart(true);
    for (let i = 0; i < 4; i++) {
      const a = (i * TAU) / 4 + Math.PI / 4;
      this.spawnEnemy('seeker', e.x + Math.cos(a) * 140, e.y + Math.sin(a) * 140);
    }
  }

  bossDefeated(e) {
    this.hitstop = 0.35;
    this.addTrauma(1);
    for (const color of NEON) this.particles.emit(e.x, e.y, { count: 70, color, speed: 950, speedMin: 120, life: 1.6, lifeMin: 0.5, size: 3, drag: 1.5 });
    for (let i = 0; i < 3; i++) this.addRing(e.x, e.y, { maxR: 300 + i * 300, life: 0.7 + i * 0.25, color: NEON[i], width: 10 - i * 2 });
    this.grid.applyForce(e.x, e.y, 900, 3200);
    this.enemyBullets.length = 0;
    this.dropGeoms(e.x, e.y, 40);
    this.audio.bomb();
    // The core takes its minions with it.
    if (this.director) this.director.idx = this.director.groups.length;
    for (const o of this.enemies) if (o !== e) this.killEnemy(o, { noChain: true });
  }

  // ── Projectiles ──────────────────────────────────────────────────────────────
  updateBullets(dt) {
    const { W, H } = this.arena;
    const bullets = this.bullets;
    const q = this._q;
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.life -= dt;
      if (b.homing > 0) {
        q.length = 0;
        this.hash.query(b.x, b.y, 320, q);
        let best = null;
        let bd = 320 * 320;
        for (const e of q) {
          if (e.dead) continue;
          const d2 = dist2(e.x, e.y, b.x, b.y);
          if (d2 < bd) { bd = d2; best = e; }
        }
        if (best) {
          const cur = Math.atan2(b.vy, b.vx);
          const turn = clamp(angleDiff(cur, Math.atan2(best.y - b.y, best.x - b.x)), -b.homing * dt, b.homing * dt);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(cur + turn) * sp;
          b.vy = Math.sin(cur + turn) * sp;
        }
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      let wall = false;
      if (b.x < 0) { b.x = 0; b.vx = -b.vx; wall = true; } else if (b.x > W) { b.x = W; b.vx = -b.vx; wall = true; }
      if (b.y < 0) { b.y = 0; b.vy = -b.vy; wall = true; } else if (b.y > H) { b.y = H; b.vy = -b.vy; wall = true; }
      if (wall) {
        if (b.bounces > 0) {
          b.bounces--;
          b.hits.length = 0;
          this.particles.emit(b.x, b.y, { count: 4, color: '#9ff7ff', speed: 220, life: 0.2 });
        } else {
          b.life = 0;
          this.particles.emit(b.x, b.y, { count: 5, color: '#9ff7ff', speed: 200, life: 0.25 });
          this.grid.applyForce(b.x, b.y, 60, 120);
        }
      }

      if (b.life > 0) {
        q.length = 0;
        this.hash.query(b.x, b.y, b.r, q);
        for (const e of q) {
          if (e.dead || b.hits.includes(e.id)) continue;
          const rr = e.r + b.r;
          if (dist2(b.x, b.y, e.x, e.y) > rr * rr) continue;
          b.hits.push(e.id);
          this.damageEnemy(e, b.dmg, b.vx, b.vy, b.crit);
          if (b.pierce > 0) b.pierce--;
          else { b.life = 0; break; }
        }
      }
      if (b.life <= 0) {
        bullets[i] = bullets[bullets.length - 1];
        bullets.pop();
      }
    }
  }

  updateEnemyBullets(dt) {
    const { W, H } = this.arena;
    const list = this.enemyBullets;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0 || b.x < -20 || b.y < -20 || b.x > W + 20 || b.y > H + 20) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }

  updateOrbitals(dt) {
    const p = this.player;
    const n = p.stats.orbitals;
    this.orbs.length = 0;
    if (!n || !p.alive) return;
    this.orbAngle += dt * 3.2;
    const q = this._q;
    for (let i = 0; i < n; i++) {
      const a = this.orbAngle + (i * TAU) / n;
      const x = p.x + Math.cos(a) * 62;
      const y = p.y + Math.sin(a) * 62;
      this.orbs.push({ x, y });
      q.length = 0;
      this.hash.query(x, y, 10, q);
      for (const e of q) {
        if (e.dead || e.orbCd > 0) continue;
        const rr = e.r + 9;
        if (dist2(x, y, e.x, e.y) > rr * rr) continue;
        e.orbCd = 0.2;
        this.damageEnemy(e, 1.5 * p.stats.damage, -Math.sin(a) * 400, Math.cos(a) * 400, false);
      }
      const eb = this.enemyBullets;
      for (let j = eb.length - 1; j >= 0; j--) {
        if (dist2(eb[j].x, eb[j].y, x, y) < 18 * 18) {
          this.particles.emit(eb[j].x, eb[j].y, { count: 5, color: '#ff5d73', speed: 180, life: 0.25 });
          eb[j] = eb[eb.length - 1];
          eb.pop();
        }
      }
    }
  }

  // ── Player ───────────────────────────────────────────────────────────────────
  collidePlayer() {
    const p = this.player;
    if (!p.alive || p.invuln > 0 || p.dashT > 0 || this.state !== 'playing') return;
    const q = this._q;
    q.length = 0;
    this.hash.query(p.x, p.y, p.r, q);
    for (const e of q) {
      if (e.dead) continue;
      const rr = e.r * 0.8 + p.r;
      if (dist2(e.x, e.y, p.x, p.y) < rr * rr) return this.hitPlayer();
    }
    for (const b of this.enemyBullets) {
      const rr = b.r * 0.8 + p.r * 0.6;
      if (dist2(b.x, b.y, p.x, p.y) < rr * rr) return this.hitPlayer();
    }
  }

  hitPlayer() {
    const p = this.player;
    p.lives--;
    this.audio.playerHit();
    this.addTrauma(0.9);
    this.hitstop = 0.15;
    this.ui.flashHurt();
    this.particles.emit(p.x, p.y, { count: 90, color: '#eaffff', speed: 700, speedMin: 100, life: 1.1, size: 3 });
    this.particles.emit(p.x, p.y, { count: 60, color: '#3df2ff', speed: 500, life: 0.9 });
    this.grid.applyForce(p.x, p.y, 520, 1800);
    this.addRing(p.x, p.y, { maxR: 320, life: 0.5, color: '#3df2ff', width: 6 });
    this.enemyBullets.length = 0;
    // Mercy blast: clear the immediate area so a hit never chains into an instant second hit.
    for (const e of this.enemies) {
      if (!e.dead && !ENEMIES[e.type].boss && dist2(e.x, e.y, p.x, p.y) < 320 * 320) this.killEnemy(e, { noScore: true, noChain: true });
    }
    this.mult = Math.max(1, Math.floor(this.mult / 2));
    if (p.lives <= 0) {
      p.alive = false;
      this.deathTimer = 1.8;
      this.setState('dying');
      this.audio.death();
      this.addTrauma(1);
      for (const color of ['#ffffff', '#3df2ff', '#ff4fd8']) this.particles.emit(p.x, p.y, { count: 120, color, speed: 1000, speedMin: 100, life: 2, lifeMin: 0.6, size: 3, drag: 1.2 });
      this.grid.applyForce(p.x, p.y, 900, 3000);
    } else {
      p.invuln = 2.2;
    }
  }

  onDash() {
    const p = this.player;
    this.audio.dash();
    this.particles.emit(p.x, p.y, { count: 24, color: '#3df2ff', speed: 300, life: 0.4, angle: Math.atan2(-p.dashY, -p.dashX), spread: 1.2 });
    this.grid.applyForce(p.x, p.y, 160, 500);
  }

  detonateBomb() {
    const p = this.player;
    p.bombs--;
    this.addRing(p.x, p.y, { maxR: 1500, life: 1, color: '#ffffff', width: 10, kill: true });
    this.addRing(p.x, p.y, { maxR: 1100, life: 0.8, color: '#3df2ff', width: 6 });
    this.grid.applyForce(p.x, p.y, 1000, 2600);
    this.particles.emit(p.x, p.y, { count: 200, color: '#eaffff', speed: 1200, speedMin: 300, life: 0.9, size: 3, drag: 2 });
    this.addTrauma(1);
    this.hitstop = 0.06;
    this.audio.bomb();
  }

  // ── Pickups & effects ────────────────────────────────────────────────────────
  dropGeoms(x, y, n) {
    for (let i = 0; i < n && this.geoms.length < MAX_GEOMS; i++) {
      const a = Math.random() * TAU;
      const s = 80 + Math.random() * 180;
      this.geoms.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 9, a });
    }
  }

  updateGeoms(dt) {
    const p = this.player;
    const list = this.geoms;
    const mag = this.vacuum ? Infinity : p.stats.magnet;
    const { W, H } = this.arena;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.life -= dt;
      s.a += dt * 4;
      let collected = false;
      if (p.alive) {
        const dx = p.x - s.x;
        const dy = p.y - s.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < p.r + 12) {
          collected = true;
          this.mult++;
          this.peakMult = Math.max(this.peakMult, this.mult);
          this.audio.pickup(this.mult);
          this.particles.emit(s.x, s.y, { count: 3, color: '#d6ff5c', speed: 120, life: 0.2 });
        } else if (d < mag) {
          const sp = 260 + 900 * (1 - Math.min(1, d / Math.min(mag, 2000)));
          s.vx = (dx / d) * sp;
          s.vy = (dy / d) * sp;
        } else {
          s.vx *= 1 - 3 * dt;
          s.vy *= 1 - 3 * dt;
        }
      }
      s.x = clamp(s.x + s.vx * dt, 0, W);
      s.y = clamp(s.y + s.vy * dt, 0, H);
      if (collected || s.life <= 0) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }

  addRing(x, y, { maxR = 200, life = 0.5, color = '#ffffff', width = 4, kill = false } = {}) {
    this.rings.push({ x, y, r: 0, maxR, life, max: life, color, width, kill, hitBoss: false });
  }

  popup(x, y, text, color) {
    this.popups.push({ x, y, text, color, life: 1 });
  }

  addTrauma(v) {
    this.trauma = Math.min(1, this.trauma + v);
  }

  updateFx(dt) {
    this.grid.update(dt);
    this.particles.update(dt);

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life -= dt;
      ring.r = ring.maxR * easeOutCubic(clamp(1 - ring.life / ring.max, 0, 1));
      if (ring.kill) {
        const r2 = ring.r * ring.r;
        for (const e of this.enemies) {
          if (e.dead || dist2(e.x, e.y, ring.x, ring.y) > r2) continue;
          if (ENEMIES[e.type].boss) {
            if (!ring.hitBoss) {
              ring.hitBoss = true;
              this.damageEnemy(e, 35, 0, 0, false);
            }
          } else if (e.spawnT > 0) {
            e.dead = true;
          } else {
            this.killEnemy(e, { bomb: true, noChain: true });
          }
        }
        const eb = this.enemyBullets;
        for (let j = eb.length - 1; j >= 0; j--) {
          if (dist2(eb[j].x, eb[j].y, ring.x, ring.y) < r2) {
            eb[j] = eb[eb.length - 1];
            eb.pop();
          }
        }
      }
      if (ring.life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) if ((this.bolts[i].life -= dt) <= 0) this.bolts.splice(i, 1);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.y -= 40 * dt;
      if ((p.life -= dt) <= 0) this.popups.splice(i, 1);
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  worldToScreen(x, y) {
    const v = this.view;
    this._screen.x = (x * v.zoom + v.ox) / v.dpr;
    this._screen.y = (y * v.zoom + v.oy) / v.dpr;
    return this._screen;
  }

  render(frameDt) {
    const r = this.renderer;
    const ctx = r.ctx;
    const W = r.width;
    const H = r.height;
    // Fit VIEW_SIZE on the short axis, but never show more than VIEW_MAX on the long one (portrait phones).
    const zoom = Math.max(Math.min(r.cssW, r.cssH) / VIEW_SIZE, Math.max(r.cssW, r.cssH) / VIEW_MAX) * r.dpr;
    const p = this.player;

    let tx;
    let ty;
    if (this.state === 'dying') {
      tx = this.camera.x;
      ty = this.camera.y;
    } else if (p.alive && HUD_STATES.has(this.state)) {
      tx = p.x + Math.cos(p.aim) * 40;
      ty = p.y + Math.sin(p.aim) * 40;
    } else {
      tx = ARENA.W / 2 + Math.sin(this.time * 0.15) * 150;
      ty = ARENA.H / 2 + Math.cos(this.time * 0.11) * 90;
    }
    const halfW = W / zoom / 2;
    const halfH = H / zoom / 2;
    const M = 140;
    const cam = this.camera;
    cam.x = damp(cam.x, tx, 5, frameDt);
    cam.y = damp(cam.y, ty, 5, frameDt);
    cam.x = halfW * 2 > ARENA.W + 2 * M ? ARENA.W / 2 : clamp(cam.x, halfW - M, ARENA.W + M - halfW);
    cam.y = halfH * 2 > ARENA.H + 2 * M ? ARENA.H / 2 : clamp(cam.y, halfH - M, ARENA.H + M - halfH);

    // Trauma-based screen shake: offset ∝ trauma², trauma decays linearly.
    this.trauma = Math.max(0, this.trauma - frameDt * 1.4);
    const shake = this.settings.shake ? this.trauma * this.trauma * 26 : 0;
    const sx = (Math.random() * 2 - 1) * shake;
    const sy = (Math.random() * 2 - 1) * shake;
    const v = this.view;
    v.zoom = zoom;
    v.dpr = r.dpr;
    v.ox = W / 2 - (cam.x + sx) * zoom;
    v.oy = H / 2 - (cam.y + sy) * zoom;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#04050b';
    ctx.fillRect(0, 0, W, H);

    ctx.setTransform(zoom, 0, 0, zoom, v.ox, v.oy);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.grid.draw(ctx);
    this.drawArena(ctx);
    this.drawGeoms(ctx);
    this.particles.draw(ctx);
    this.drawEnemies(ctx);
    this.drawBullets(ctx);
    this.drawOrbitals(ctx);
    if (HUD_STATES.has(this.state)) drawPlayer(ctx, p, this.time);
    this.drawRings(ctx);
    this.drawBolts(ctx);
    this.drawPopups(ctx);
    if (this.debug) this.drawDebug(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    r.bloomPass();
    this.drawTouchSticks(ctx, r.dpr);

    if (HUD_STATES.has(this.state)) this.ui.updateHud(this);
    if (this.debug && (this.debugT -= frameDt) <= 0) {
      this.debugT = 0.25;
      const l = this.loop;
      this.ui.debug([
        `fps        ${l ? l.fps.toFixed(0) : '-'}`,
        `cpu ms     ${l ? l.workMs.toFixed(2) : '-'}`,
        `quality    L${r.level}  dpr ${r.dpr.toFixed(2)}  bloom ${r.bloom}`,
        `enemies    ${this.enemies.length}`,
        `bullets    ${this.bullets.length} / ${this.enemyBullets.length}`,
        `particles  ${this.particles.n}`,
        `shards     ${this.geoms.length}`,
        `hash cells ${this.hash.cellCount}`,
        `seed       ${this.seed ?? '-'}`,
      ].join('\n'));
    }
  }

  drawArena(ctx) {
    ctx.strokeStyle = 'rgba(80, 100, 255, 0.25)';
    ctx.lineWidth = 16;
    ctx.strokeRect(0, 0, ARENA.W, ARENA.H);
    ctx.strokeStyle = '#5a6bff';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, ARENA.W, ARENA.H);
  }

  drawGeoms(ctx) {
    if (!this.geoms.length) return;
    ctx.strokeStyle = '#d6ff5c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const s of this.geoms) {
      if (s.life < 2 && Math.floor(s.life * 10) % 2) continue;
      const c = Math.cos(s.a) * 6;
      const n = Math.sin(s.a) * 6;
      ctx.moveTo(s.x + c, s.y + n);
      ctx.lineTo(s.x - n, s.y + c);
      ctx.lineTo(s.x - c, s.y - n);
      ctx.lineTo(s.x + n, s.y - c);
      ctx.closePath();
    }
    ctx.stroke();
  }

  drawEnemies(ctx) {
    const t = this.time;
    for (const e of this.enemies) {
      if (e.dead) continue;
      ctx.lineWidth = 2.5;
      if (e.spawnT > 0) drawSpawning(ctx, e, t);
      else {
        const T = ENEMIES[e.type];
        T.draw(ctx, e, t, e.flash > 0 ? '#ffffff' : T.color);
      }
    }
  }

  drawBullets(ctx) {
    const groups = [[false, '#5ff3ff', 4], [true, '#ffd84d', 6]];
    for (const [crit, color, width] of groups) {
      ctx.beginPath();
      let any = false;
      for (const b of this.bullets) {
        if (b.crit !== crit) continue;
        any = true;
        ctx.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02);
        ctx.lineTo(b.x, b.y);
      }
      if (!any) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = width * 0.35;
      ctx.stroke();
    }

    if (!this.enemyBullets.length) return;
    ctx.beginPath();
    for (const b of this.enemyBullets) {
      ctx.moveTo(b.x + b.r, b.y);
      ctx.arc(b.x, b.y, b.r, 0, TAU);
    }
    ctx.fillStyle = 'rgba(255, 70, 100, 0.55)';
    ctx.fill();
    ctx.strokeStyle = '#ff5d73';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    for (const b of this.enemyBullets) {
      ctx.moveTo(b.x + 2.5, b.y);
      ctx.arc(b.x, b.y, 2.5, 0, TAU);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  drawOrbitals(ctx) {
    if (!this.orbs.length) return;
    const p = this.player;
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = '#7df9ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 62, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (const o of this.orbs) {
      ctx.moveTo(o.x + 7, o.y);
      ctx.arc(o.x, o.y, 7, 0, TAU);
    }
    ctx.fillStyle = 'rgba(125, 249, 255, 0.35)';
    ctx.fill();
    ctx.strokeStyle = '#bffcff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawRings(ctx) {
    for (const ring of this.rings) {
      const k = Math.max(0, ring.life / ring.max);
      ctx.globalAlpha = k;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.width * k + 1;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(0.1, ring.r), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawBolts(ctx) {
    for (const b of this.bolts) {
      ctx.globalAlpha = Math.min(1, b.life / 0.15);
      ctx.beginPath();
      ctx.moveTo(b.pts[0], b.pts[1]);
      for (let i = 2; i < b.pts.length; i += 2) ctx.lineTo(b.pts[i], b.pts[i + 1]);
      ctx.strokeStyle = '#b89cff';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawPopups(ctx) {
    if (!this.popups.length) return;
    ctx.font = '700 22px Rajdhani, system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  drawDebug(ctx) {
    const cs = this.hash.cellSize;
    ctx.strokeStyle = 'rgba(255, 230, 80, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const key of this.hash.cells.keys()) {
      const cx = Math.floor(key / 65536) - 32768;
      const cy = (key % 65536) - 32768;
      ctx.rect(cx * cs, cy * cs, cs, cs);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.8)';
    ctx.beginPath();
    for (const e of this.enemies) {
      ctx.moveTo(e.x + e.r, e.y);
      ctx.arc(e.x, e.y, e.r, 0, TAU);
    }
    const p = this.player;
    if (p.alive) {
      ctx.moveTo(p.x + p.r, p.y);
      ctx.arc(p.x, p.y, p.r, 0, TAU);
    }
    ctx.stroke();
  }

  drawTouchSticks(ctx, dpr) {
    const R = Input.stickRadius * dpr;
    for (const s of [this.input.sticks.move, this.input.sticks.aim]) {
      if (!s || this.state !== 'playing') continue;
      const ox = s.ox * dpr;
      const oy = s.oy * dpr;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(ox, oy, R, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = '#3df2ff';
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(ox + clamp(s.dx, -1, 1) * R, oy + clamp(s.dy, -1, 1) * R, R * 0.42, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function jagged(x0, y0, x1, y1) {
  const pts = [x0, y0];
  const segs = 7;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const off = (Math.random() - 0.5) * 36;
    pts.push(x0 + dx * t + nx * off, y0 + dy * t + ny * off);
  }
  pts.push(x1, y1);
  return pts;
}
