import { TAU, clamp, damp, dist2, angleDiff, easeOutCubic, Rng, hashString } from '../engine/math.js';
import { SpatialHash } from '../engine/spatial-hash.js';
import { Particles } from '../engine/particles.js';
import { WarpGrid } from '../engine/grid.js';
import { Input } from '../engine/input.js';
import { ENEMIES, drawSpawning, SPAWN_TIME } from './enemies.js';
import { createPlayer, tickPlayer, movePlayer, shootPlayer, trailPlayer, drawPlayer, PLAYER_STYLE } from './player.js';
import { planWave, resolveFormation, UNLOCK_WAVE } from './waves.js';
import { rollUpgrades, applyUpgrade } from './upgrades.js';
import { recordable } from './fx-record.js';

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
// Sounds the co-op guest should hear too (music intensity is derived locally instead).
const AUDIO_EVENTS = ['shoot', 'hit', 'explode', 'pickup', 'spawn', 'enemyShoot', 'dash', 'bomb', 'playerHit', 'death', 'upgrade', 'waveClear', 'waveStart'];
export const CHRONOS_TIME = 1.8;
export const CHRONOS_SCALE = 0.6; // enemy speed while slowed
export const CHRONOS_COOLDOWN = 6;
const NOVA_RADIUS = 190;
const PHOENIX_RADIUS = 600;

/** Co-op difficulty: every extra pilot adds 60% enemy HP (75% for bosses). Wave sizes scale in waves.js. */
export const coopHp = (players, boss = false) => 1 + (boss ? 0.75 : 0.6) * (players - 1);

/** UTC date, so a daily seed is the same for everyone on Earth. */
export const todayKey = () => new Date().toISOString().slice(0, 10);

export class Game {
  constructor({ renderer, input, audio, ui, settings, storage }) {
    Object.assign(this, { renderer, input, ui, settings, storage });
    // Effects the host records for the co-op guest; `localFx` bypasses recording (trails, wakes).
    this.outbox = { active: false, list: [] };
    const grid = new WarpGrid(ARENA.W, ARENA.H, 40);
    const particles = new Particles(4000);
    this.localFx = { grid, particles };
    this.grid = recordable(grid, ['applyForce'], 'g', this.outbox);
    this.particles = recordable(particles, ['emit'], 'p', this.outbox);
    this.rawAudio = audio;
    this.audio = recordable(audio, AUDIO_EVENTS, 'a', this.outbox);
    this.arena = ARENA;
    this.hash = new SpatialHash(96);
    this.camera = { x: ARENA.W / 2, y: ARENA.H / 2 };
    this.view = { zoom: 1, ox: 0, oy: 0, dpr: 1 };
    this.trauma = 0;
    this.time = 0;
    // Steady clock for co-op timing: unlike `time` it is never slowed by hit-stop or paused.
    this.clock = 0;
    this.tick = 0;
    this.ambientT = 0;
    this.debug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
    this.debugT = 0;
    this.state = 'menu';
    this.mode = 'standard';
    this.role = 'solo'; // 'solo' | 'host' | 'guest' — see net/coop.js
    this.net = null;
    this.wave = 0;
    this.score = 0;
    this.mult = 1;
    this.slowT = 0;
    this.chronosReady = 0;
    this._q = [];
    this._qc = [];
    this._chainDepth = 0;
    this._screen = { x: 0, y: 0 };
    this.localSlot = 0;
    this.players = [createPlayer(ARENA.W / 2, ARENA.H / 2)];
    this.players[0].alive = false;
    this.resetWorld();
    this.refreshBest();
    this.ui.showScreen('menu');
  }

  /** The ship this screen controls and follows. */
  get player() {
    return this.players[this.localSlot] ?? this.players[0];
  }

  get coop() {
    return this.players.length > 1;
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
    this.slowT = 0;
    this.chronosReady = 0;
    this.localFx.particles.clear();
  }

  newRun({ daily = false } = {}) {
    const coop = this.role === 'host';
    this.mode = coop ? 'coop' : daily ? 'daily' : 'standard';
    this.seed = this.mode === 'daily' ? hashString(`void-pulse:${todayKey()}`) : (Math.random() * 2 ** 32) >>> 0;
    this.rng = new Rng(this.seed);
    this.resetWorld();
    const n = coop ? 2 : 1;
    this.localSlot = 0;
    this.players = Array.from({ length: n }, (_, i) => createPlayer(ARENA.W / 2 + (n > 1 ? (i ? 90 : -90) : 0), ARENA.H / 2, i));
    this.players[0].input = this.input;
    if (coop) this.net.attachRemote(this.players[1]);
    Object.assign(this, { score: 0, mult: 1, peakMult: 1, kills: 0, runTime: 0, nextId: 1, hitstop: 0, orbAngle: 0, choices: null, picked: null });
    this.camera.x = this.player.x;
    this.camera.y = this.player.y;
    for (const p of this.players) {
      this.grid.applyForce(p.x, p.y, 500, 1500);
      this.addRing(p.x, p.y, { maxR: 400, life: 0.7, color: PLAYER_STYLE[p.slot].glow, width: 5 });
    }
    this.startWave(1);
    this.setState('playing');
    this.audio.startMusic();
  }

  setState(s) {
    this.state = s;
    this.ui.showScreen(s);
  }

  pause() {
    if (this.role === 'guest') this.net.request({ t: 'pause' });
    else if (this.state === 'playing') this.setState('paused');
  }

  resume() {
    if (this.role === 'guest') this.net.request({ t: 'resume' });
    else if (this.state === 'paused') this.setState('playing');
  }

  restart() {
    if (this.role === 'guest') this.net.request({ t: 'restart' });
    else this.newRun({ daily: this.mode === 'daily' });
  }

  toMenu() {
    this.net?.leave();
    this.resetWorld();
    this.players = [this.player];
    this.localSlot = 0;
    this.player.alive = false;
    this.refreshBest();
    this.setState('menu');
    this.audio.setIntensity(0.1);
  }

  refreshBest() {
    this.ui.setBest(this.storage.get('best:standard', 0), this.storage.get(`best:daily:${todayKey()}`, 0), todayKey(), this.storage.get('best:coop', 0));
  }

  bestKey(mode = this.mode) {
    return mode === 'daily' ? `best:daily:${todayKey()}` : mode === 'coop' ? 'best:coop' : 'best:standard';
  }

  /** Run summary for one pilot (their own build), without the local best-score bookkeeping. */
  summaryFor(p) {
    return {
      mode: this.mode, date: todayKey(), score: this.score, wave: this.wave, kills: this.kills,
      time: this.runTime, peakMult: this.peakMult, owned: { ...p.owned }, players: this.players.length,
    };
  }

  /** Compare with and update this device's best score, then show the game-over screen. */
  showSummary(summary) {
    const key = this.bestKey(summary.mode);
    const prev = this.storage.get(key, 0);
    summary.best = Math.max(prev, summary.score);
    summary.isBest = summary.score > prev;
    if (summary.isBest) this.storage.set(key, summary.score);
    this.storage.set('runs', this.storage.get('runs', 0) + 1);
    this.setState('gameover');
    this.ui.showGameOver(summary);
    this.audio.setIntensity(0.1);
  }

  gameOver() {
    for (const e of this.enemies) this.killEnemy(e, { noScore: true, noChain: true });
    this.enemyBullets.length = 0;
    this.bullets.length = 0;
    for (const p of this.players) if (p.remote) this.net.sendGameOver(this.summaryFor(p));
    this.showSummary(this.summaryFor(this.player));
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  update(dt) {
    this.tick++;
    this.clock += dt;
    const input = this.input;
    input.poll();
    if (input.consume('debug')) {
      this.debug = !this.debug;
      if (!this.debug) this.ui.debug(null);
    }
    if (input.consume('mute')) this.ui.handlers.toggleSound();

    if (this.role === 'guest') {
      this.net.guestUpdate(dt);
      input.flush();
      return;
    }
    this.outbox.active = this.role === 'host';

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
    if (this.role === 'host') this.net.hostUpdate(dt);
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
    // Chronos slows everything hostile; pilots keep full speed.
    const edt = this.slowT > 0 ? dt * CHRONOS_SCALE : dt;
    this.slowT = Math.max(0, this.slowT - dt);

    for (const p of this.players) if (p.alive) this.updatePlayer(p, dt);
    this.updateDirector(dt);
    this.updateEnemies(edt);
    this.buildHash();
    this.separateEnemies();
    this.updateBullets(dt);
    this.updateEnemyBullets(edt);
    this.updateOrbitals(dt);
    this.collidePlayers();
    this.updateGeoms(dt);
    this.updateFx(dt);

    let j = 0;
    for (const e of this.enemies) if (!e.dead) this.enemies[j++] = e;
    this.enemies.length = j;

    if (this.state === 'playing') this.checkWaveClear(dt);
    this.audio.setIntensity(this.musicIntensity());
  }

  musicIntensity() {
    if (this.state === 'dying') return 0.1;
    if (this.boss) return 1;
    return clamp(0.3 + this.enemies.length / 35 + this.wave * 0.03, 0, 0.95);
  }

  /** Host/solo: simulate one ship. Remote ships move on the guest's machine; the host only fires for them. */
  updatePlayer(p, dt) {
    tickPlayer(this, p, dt);
    let fire;
    if (p.remote) {
      fire = p.input.applyTo(p, this, dt);
      if (p.input.consume('bomb') && p.bombs > 0) this.detonateBomb(p);
    } else {
      fire = movePlayer(this, p, p.input, dt).fire;
    }
    shootPlayer(this, p, fire);
    trailPlayer(this, p, dt);
  }

  updateAmbient(dt) {
    this.time += dt;
    if ((this.ambientT -= dt) <= 0) {
      this.ambientT = 0.6 + Math.random();
      const x = 150 + Math.random() * (ARENA.W - 300);
      const y = 150 + Math.random() * (ARENA.H - 300);
      const color = NEON[Math.floor(Math.random() * NEON.length)];
      this.localFx.grid.applyForce(x, y, 260, 900);
      this.localFx.particles.emit(x, y, { count: 50, color, speed: 420, speedMin: 60, life: 1.2, lifeMin: 0.4 });
      this.rings.push({ x, y, r: 0, maxR: 160, life: 0.6, max: 0.6, color, width: 3, kill: false, hitBoss: false });
    }
    this.updateFx(dt);
  }

  // ── Waves ────────────────────────────────────────────────────────────────────
  startWave(n) {
    this.wave = n;
    if (n > 1) for (const p of this.players) if (!p.alive) this.respawn(p);
    const plan = planWave(n, this.rng, this.players.length);
    this.director = { t: 0, groups: plan.groups, idx: 0, cleared: false, clearT: 0, boss: plan.boss };
    if (plan.boss) {
      this.banner('Warning', `${ENEMIES[plan.groups[0].type].title} approaching`, 'danger');
    } else {
      const fresh = Object.keys(NEW_THREAT).find((t) => UNLOCK_WAVE[t] === n);
      const total = plan.groups.reduce((s, g) => s + g.count, 0);
      const sub = fresh ? NEW_THREAT[fresh] : `${total} hostiles inbound`;
      this.banner(`Wave ${n}`, n === 1 && this.coop ? 'Co-op · enemies +60% HP, +50% numbers' : sub);
    }
    this.audio.waveStart(plan.boss);
  }

  /** Co-op: a pilot who went down rejoins at the start of the next wave with one life. */
  respawn(p) {
    const mate = this.players.find((o) => o !== p && o.alive);
    Object.assign(p, {
      alive: true, lives: 1, invuln: 2.5, dashT: 0, vx: 0, vy: 0,
      x: clamp((mate ? mate.x : ARENA.W / 2) + (p.slot ? 70 : -70), p.r, ARENA.W - p.r),
      y: mate ? mate.y : ARENA.H / 2,
    });
    if (p.stats.shield > 0) p.shield = 1;
    this.addRing(p.x, p.y, { maxR: 260, life: 0.6, color: PLAYER_STYLE[p.slot].glow, width: 5 });
    this.particles.emit(p.x, p.y, { count: 60, color: PLAYER_STYLE[p.slot].glow, speed: 420, life: 0.8 });
    if (p.remote) this.net.sendRespawn(p);
  }

  updateDirector(dt) {
    const d = this.director;
    if (!d || this.state !== 'playing') return;
    d.t += dt;
    // Arena empty? Pull the next group forward instead of making the pilots wait.
    if (d.idx < d.groups.length && this.enemies.length === 0 && d.t > 0.8 && d.groups[d.idx].at > d.t) d.t = d.groups[d.idx].at;
    const alive = this.players.filter((p) => p.alive);
    while (d.idx < d.groups.length && d.groups[d.idx].at <= d.t) {
      const group = d.groups[d.idx++];
      for (const [x, y] of resolveFormation(group.formation, group.count, alive.length ? alive : this.players, this.arena)) this.spawnEnemy(group.type, x, y);
    }
  }

  checkWaveClear(dt) {
    const d = this.director;
    if (!d || d.idx < d.groups.length || this.enemies.length) return;
    if (!d.cleared) {
      d.cleared = true;
      const bonus = 250 * this.wave * (d.boss ? 4 : 1) * this.players.length;
      this.score += bonus;
      this.vacuum = true;
      this.banner(d.boss ? 'Core destroyed' : 'Wave cleared', `+${bonus.toLocaleString('en-US')} bonus`, 'good');
      this.audio.waveClear();
    }
    if ((d.clearT += dt) > 1.7) {
      this.vacuum = false;
      this.openUpgrade();
    }
  }

  openUpgrade() {
    this.enemyBullets.length = 0;
    this.choices = this.players.map((p) => rollUpgrades(p.owned, this.rng, 3, this.wave));
    this.picked = this.choices.map((c) => c.length === 0);
    if (this.picked.every(Boolean)) {
      this.startWave(this.wave + 1);
      return;
    }
    this.setState('upgrade');
    const me = this.localSlot;
    if (this.picked[me]) this.ui.showUpgradeWaiting(this.wave);
    else this.ui.showUpgrades(this.wave, this.choices[me], this.player.owned, (i) => this.pickUpgrade(me, i));
    for (const p of this.players) if (p.remote && !this.picked[p.slot]) this.net.offerUpgrades(this.wave, this.choices[p.slot], p.owned);
  }

  pickUpgrade(slot, i) {
    if (this.state !== 'upgrade' || !this.picked || this.picked[slot]) return;
    const u = this.choices[slot]?.[i];
    const p = this.players[slot];
    if (!u || !p) return;
    applyUpgrade(p, u, p.owned);
    this.picked[slot] = true;
    this.audio.upgrade();
    this.particles.emit(p.x, p.y, { count: 60, color: '#ffd84d', speed: 400, life: 0.8 });
    this.addRing(p.x, p.y, { maxR: 180, life: 0.5, color: u.rarity === 'legendary' ? '#ff9b3d' : '#ffd84d' });
    if (p.remote) this.net.sendStats(p);
    if (this.picked.every(Boolean)) {
      this.startWave(this.wave + 1);
      this.setState('playing');
    } else if (slot === this.localSlot) {
      this.ui.showUpgradeWaiting(this.wave);
    }
  }

  /** Co-op partner left: carry on alone. */
  dropRemote() {
    const remote = this.players.find((p) => p.remote);
    if (!remote) return;
    if (this.picked) this.picked[remote.slot] = true;
    this.players = this.players.filter((p) => !p.remote);
    this.role = 'solo';
    this.outbox.active = false;
    if (HUD_STATES.has(this.state)) this.banner('Partner disconnected', 'You are on your own now', 'danger');
    if (this.state === 'upgrade' && this.picked?.every(Boolean)) {
      this.startWave(this.wave + 1);
      this.setState('playing');
    }
    if (this.state === 'dying' || (HUD_STATES.has(this.state) && !this.player.alive && this.state !== 'dying')) {
      this.deathTimer = 1.2;
      this.setState('dying');
    }
  }

  // ── Enemies ──────────────────────────────────────────────────────────────────
  /** Closest living pilot, or the first one if everyone is down (enemies still need a target). */
  nearestPlayer(x, y) {
    let best = null;
    let bd = Infinity;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = dist2(x, y, p.x, p.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ?? this.players[0];
  }

  spawnEnemy(type, x, y, { telegraph = true, vx = 0, vy = 0 } = {}) {
    const T = ENEMIES[type];
    const hp = T.hp * (1 + (this.wave - 1) * 0.09);
    const e = {
      id: this.nextId++, type, x, y, vx, vy, r: T.r, hp, maxHp: hp,
      angle: Math.random() * TAU, spawnT: telegraph ? SPAWN_TIME : 0, flash: 0, orbCd: 0, dead: false,
      speedMul: 1 + Math.min(0.45, (this.wave - 1) * 0.025), data: {},
    };
    if (T.init) T.init(e, this);
    e.hp *= coopHp(this.players.length, T.boss);
    e.maxHp = e.hp;
    if (this.nextId > 65000) this.nextId = 1; // ids travel as uint16 in co-op snapshots
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

  damageEnemy(e, dmg, kx, ky, crit, owner = 0) {
    if (e.dead || e.spawnT > 0) return;
    const T = ENEMIES[e.type];
    e.hp -= dmg;
    e.flash = 0.06;
    if (!T.heavy) {
      e.vx += kx * 0.04;
      e.vy += ky * 0.04;
    }
    this.particles.emit(e.x, e.y, { count: crit ? 8 : 4, color: crit ? '#ffe66b' : T.color, speed: 300, life: 0.3 });
    if (e.hp <= 0) this.killEnemy(e, { owner });
    else this.audio.hit();
  }

  killEnemy(e, { noScore = false, noChain = false, bomb = false, owner = 0 } = {}) {
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
    const killer = this.players[owner] ?? this.players[0];
    if (!noChain && killer.stats.chain > 0 && Math.random() < killer.stats.chain) this.chainFrom(e, killer);
  }

  chainFrom(src, killer) {
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
    this.addBolt(jagged(src.x, src.y, best.x, best.y));
    this._chainDepth++;
    this.damageEnemy(best, killer.stats.damage * 1.5 + 1, 0, 0, false, killer.slot);
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
    this.banner('Enraged', `${ENEMIES[e.type].title} overload detected`, 'danger');
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
    // The boss takes its minions with it.
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
          this.damageEnemy(e, b.dmg, b.vx, b.vy, b.crit, b.owner);
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
    this.orbs.length = 0;
    this.orbAngle += dt * 3.2;
    const q = this._q;
    for (const p of this.players) {
      const n = p.stats.orbitals;
      if (!n || !p.alive) continue;
      for (let i = 0; i < n; i++) {
        const a = this.orbAngle + (i * TAU) / n;
        const x = p.x + Math.cos(a) * 62;
        const y = p.y + Math.sin(a) * 62;
        this.orbs.push({ x, y, owner: p.slot });
        q.length = 0;
        this.hash.query(x, y, 10, q);
        for (const e of q) {
          if (e.dead || e.orbCd > 0) continue;
          const rr = e.r + 9;
          if (dist2(x, y, e.x, e.y) > rr * rr) continue;
          e.orbCd = 0.2;
          this.damageEnemy(e, 1.2 * p.stats.damage, -Math.sin(a) * 400, Math.cos(a) * 400, false, p.slot);
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
  }

  // ── Players ──────────────────────────────────────────────────────────────────
  collidePlayers() {
    if (this.state !== 'playing') return;
    const q = this._q;
    for (const p of this.players) {
      // A remote pilot's hits are judged on their own screen (see net/coop.js), not here.
      if (!p.alive || p.remote || p.invuln > 0 || p.dashT > 0) continue;
      if (this.touchesHazard(p, q)) this.hitPlayer(p);
    }
  }

  touchesHazard(p, q) {
    q.length = 0;
    this.hash.query(p.x, p.y, p.r, q);
    for (const e of q) {
      if (e.dead) continue;
      const rr = e.r * 0.8 + p.r;
      if (dist2(e.x, e.y, p.x, p.y) < rr * rr) return true;
    }
    // Bosses with special hitboxes (laser beams).
    const b = this.boss;
    if (b && !b.dead && ENEMIES[b.type].hits?.(b, p)) return true;
    for (const eb of this.enemyBullets) {
      const rr = eb.r * 0.8 + p.r * 0.6;
      if (dist2(eb.x, eb.y, p.x, p.y) < rr * rr) return true;
    }
    return false;
  }

  hitPlayer(p) {
    const style = PLAYER_STYLE[p.slot];
    if (p.shield > 0) {
      p.shield = 0;
      p.shieldT = 0;
      p.invuln = 1;
      this.audio.hit();
      this.addTrauma(0.4);
      this.addRing(p.x, p.y, { maxR: 220, life: 0.4, color: '#9ff7ff', width: 6 });
      this.particles.emit(p.x, p.y, { count: 50, color: '#9ff7ff', speed: 500, life: 0.6 });
      const eb = this.enemyBullets;
      for (let j = eb.length - 1; j >= 0; j--) {
        if (dist2(eb[j].x, eb[j].y, p.x, p.y) < 200 * 200) {
          eb[j] = eb[eb.length - 1];
          eb.pop();
        }
      }
      return;
    }
    p.lives--;
    this.audio.playerHit();
    this.addTrauma(0.9);
    this.hitstop = 0.15;
    if (p === this.player) this.ui.flashHurt();
    else if (p.remote) this.outbox.list.push(['hurt']);
    this.particles.emit(p.x, p.y, { count: 90, color: style.hull, speed: 700, speedMin: 100, life: 1.1, size: 3 });
    this.particles.emit(p.x, p.y, { count: 60, color: style.glow, speed: 500, life: 0.9 });
    this.grid.applyForce(p.x, p.y, 520, 1800);
    this.addRing(p.x, p.y, { maxR: 320, life: 0.5, color: style.glow, width: 6 });
    this.enemyBullets.length = 0;
    // Mercy blast: clear the immediate area so a hit never chains into an instant second hit.
    for (const e of this.enemies) {
      if (!e.dead && !ENEMIES[e.type].boss && dist2(e.x, e.y, p.x, p.y) < 320 * 320) this.killEnemy(e, { noScore: true, noChain: true });
    }
    this.mult = Math.max(1, Math.floor(this.mult / 2));
    if (p.lives > 0) {
      p.invuln = 2.2;
      return;
    }
    if (p.stats.phoenix && !p.phoenixUsed) {
      p.phoenixUsed = true;
      p.lives = 1;
      p.invuln = 2;
      // A small blast, not a free full-screen bomb.
      this.addRing(p.x, p.y, { maxR: PHOENIX_RADIUS, life: 0.6, color: '#ff9b3d', width: 8, kill: true, owner: p.slot });
      this.grid.applyForce(p.x, p.y, PHOENIX_RADIUS, 2000);
      this.addTrauma(0.8);
      this.audio.bomb();
      this.particles.emit(p.x, p.y, { count: 140, color: '#ff9b3d', speed: 900, speedMin: 200, life: 1.3, size: 3, drag: 1.4 });
      this.banner('Phoenix Core', `${this.coop ? `${style.name} ` : ''}reborn from the ashes`, 'good');
      return;
    }
    p.alive = false;
    this.audio.death();
    this.addTrauma(1);
    for (const color of ['#ffffff', style.glow, '#ff4fd8']) this.particles.emit(p.x, p.y, { count: 120, color, speed: 1000, speedMin: 100, life: 2, lifeMin: 0.6, size: 3, drag: 1.2 });
    this.grid.applyForce(p.x, p.y, 900, 3000);
    if (this.players.some((o) => o.alive)) {
      this.banner(`${style.name} down`, 'Back at the start of the next wave', 'danger');
    } else {
      this.camera.x = p.x;
      this.camera.y = p.y;
      this.deathTimer = 1.8;
      this.setState('dying');
    }
  }

  /** Dash effects. `silent` skips particles/sound (a remote guest already played them locally). */
  onDash(p, silent = false) {
    if (!silent) {
      this.audio.dash();
      this.particles.emit(p.x, p.y, { count: 24, color: PLAYER_STYLE[p.slot].glow, speed: 300, life: 0.4, angle: Math.atan2(-p.dashY, -p.dashX), spread: 1.2 });
      this.grid.applyForce(p.x, p.y, 160, 500);
    }
    if (this.role !== 'guest' && p.stats.chronos && this.time >= this.chronosReady) {
      this.addRing(p.x, p.y, { maxR: 700, life: 0.7, color: '#7d9cff', width: 4 });
      this.slowT = CHRONOS_TIME;
      this.chronosReady = this.time + CHRONOS_COOLDOWN;
    }
  }

  requestBomb(p) {
    if (this.role === 'guest') this.net.request({ t: 'bomb' });
    else this.detonateBomb(p);
  }

  detonateBomb(p, { free = false } = {}) {
    if (!free) p.bombs--;
    this.addRing(p.x, p.y, { maxR: 1500, life: 1, color: '#ffffff', width: 10, kill: true, owner: p.slot });
    this.addRing(p.x, p.y, { maxR: 1100, life: 0.8, color: PLAYER_STYLE[p.slot].glow, width: 6 });
    this.grid.applyForce(p.x, p.y, 1000, 2600);
    this.particles.emit(p.x, p.y, { count: 200, color: '#eaffff', speed: 1200, speedMin: 300, life: 0.9, size: 3, drag: 2 });
    this.addTrauma(1);
    this.hitstop = 0.06;
    this.audio.bomb();
  }

  /** Nova Pulse augment: a short-range shockwave that damages enemies and erases bullets. */
  novaBlast(p) {
    if (!p.alive || this.state !== 'playing') return;
    const color = PLAYER_STYLE[p.slot].glow;
    this.addRing(p.x, p.y, { maxR: NOVA_RADIUS, life: 0.35, color, width: 5 });
    this.grid.applyForce(p.x, p.y, NOVA_RADIUS, 900);
    const dmg = 2 + p.stats.damage;
    for (const e of this.enemies) {
      if (e.dead || dist2(e.x, e.y, p.x, p.y) > NOVA_RADIUS * NOVA_RADIUS) continue;
      this.damageEnemy(e, dmg, (e.x - p.x) * 6, (e.y - p.y) * 6, false, p.slot);
    }
    const eb = this.enemyBullets;
    for (let j = eb.length - 1; j >= 0; j--) {
      if (dist2(eb[j].x, eb[j].y, p.x, p.y) < NOVA_RADIUS * NOVA_RADIUS) {
        eb[j] = eb[eb.length - 1];
        eb.pop();
      }
    }
    this.audio.hit();
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
    const list = this.geoms;
    const { W, H } = this.arena;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.life -= dt;
      s.a += dt * 4;
      let collected = false;
      const p = this.nearestPlayer(s.x, s.y);
      if (p.alive) {
        const mag = this.vacuum ? Infinity : p.stats.magnet;
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

  addRing(x, y, { maxR = 200, life = 0.5, color = '#ffffff', width = 4, kill = false, owner = 0 } = {}) {
    if (this.outbox.active) this.outbox.list.push(['ring', x, y, { maxR, life, color, width }]);
    this.rings.push({ x, y, r: 0, maxR, life, max: life, color, width, kill, owner, hitBoss: false });
  }

  addBolt(pts) {
    if (this.outbox.active) this.outbox.list.push(['bolt', pts]);
    this.bolts.push({ pts, life: 0.22 });
  }

  banner(title, sub = '', kind = '') {
    if (this.outbox.active) this.outbox.list.push(['banner', title, sub, kind]);
    this.ui.banner(title, sub, kind);
  }

  popup(x, y, text, color) {
    if (this.outbox.active) this.outbox.list.push(['pop', x, y, text, color]);
    this.popups.push({ x, y, text, color, life: 1 });
  }

  addTrauma(v) {
    if (this.outbox.active) this.outbox.list.push(['trauma', v]);
    this.trauma = Math.min(1, this.trauma + v);
  }

  updateFx(dt) {
    this.localFx.grid.update(dt);
    this.localFx.particles.update(dt);

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.life -= dt;
      ring.r = ring.maxR * easeOutCubic(clamp(1 - ring.life / ring.max, 0, 1));
      if (ring.kill && this.role !== 'guest') this.ringKill(ring);
      if (ring.life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) if ((this.bolts[i].life -= dt) <= 0) this.bolts.splice(i, 1);
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.y -= 40 * dt;
      if ((p.life -= dt) <= 0) this.popups.splice(i, 1);
    }
  }

  ringKill(ring) {
    const r2 = ring.r * ring.r;
    for (const e of this.enemies) {
      if (e.dead || dist2(e.x, e.y, ring.x, ring.y) > r2) continue;
      if (ENEMIES[e.type].boss) {
        if (!ring.hitBoss) {
          ring.hitBoss = true;
          this.damageEnemy(e, 35, 0, 0, false, ring.owner);
        }
      } else if (e.spawnT > 0) {
        e.dead = true;
      } else {
        this.killEnemy(e, { bomb: true, noChain: true, owner: ring.owner });
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
    const inRun = HUD_STATES.has(this.state);

    let tx;
    let ty;
    if (this.state === 'dying') {
      tx = this.camera.x;
      ty = this.camera.y;
    } else if (inRun && (p.alive || this.coop)) {
      // A downed co-op pilot spectates their partner.
      const f = p.alive ? p : this.players.find((o) => o.alive) ?? p;
      tx = f.x + Math.cos(f.aim) * 40;
      ty = f.y + Math.sin(f.aim) * 40;
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
    ctx.fillStyle = this.slowT > 0 ? '#050816' : '#04050b';
    ctx.fillRect(0, 0, W, H);

    ctx.setTransform(zoom, 0, 0, zoom, v.ox, v.oy);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.localFx.grid.draw(ctx);
    this.drawArena(ctx);
    this.drawGeoms(ctx);
    this.localFx.particles.draw(ctx);
    this.drawEnemies(ctx);
    this.drawBullets(ctx);
    this.drawOrbitals(ctx);
    if (inRun) for (const pl of this.players) drawPlayer(ctx, pl, this.time, { label: this.coop });
    this.drawRings(ctx);
    this.drawBolts(ctx);
    this.drawPopups(ctx);
    if (this.debug) this.drawDebug(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    r.bloomPass();
    if (inRun && this.coop) this.drawPartnerArrows(ctx, r);
    this.drawTouchSticks(ctx, r.dpr);

    if (inRun) this.ui.updateHud(this);
    if (this.debug && (this.debugT -= frameDt) <= 0) {
      this.debugT = 0.25;
      const l = this.loop;
      this.ui.debug([
        `fps        ${l ? l.fps.toFixed(0) : '-'}`,
        `cpu ms     ${l ? l.workMs.toFixed(2) : '-'}`,
        `quality    L${r.level}  dpr ${r.dpr.toFixed(2)}  bloom ${r.bloom}`,
        `enemies    ${this.enemies.length}`,
        `bullets    ${this.bullets.length} / ${this.enemyBullets.length}`,
        `particles  ${this.localFx.particles.n}`,
        `shards     ${this.geoms.length}`,
        `hash cells ${this.hash.cellCount}`,
        `seed       ${this.seed ?? '-'}`,
        `net        ${this.role}${this.net?.link ? `  rtt ${Math.round(this.net.link.rtt)} ms  ${(this.net.bytesPerSec / 1024).toFixed(1)} KB/s` : ''}`,
      ].join('\n'));
    }
  }

  /** Edge-of-screen arrows pointing at an off-screen partner. */
  drawPartnerArrows(ctx, r) {
    const W = r.width;
    const H = r.height;
    const pad = 34 * r.dpr;
    for (const o of this.players) {
      if (o === this.player || !o.alive) continue;
      const v = this.view;
      const x = o.x * v.zoom + v.ox;
      const y = o.y * v.zoom + v.oy;
      if (x > 0 && x < W && y > 0 && y < H) continue;
      const cx = W / 2;
      const cy = H / 2;
      const a = Math.atan2(y - cy, x - cx);
      const k = Math.min((W / 2 - pad) / Math.abs(Math.cos(a) || 1e-6), (H / 2 - pad) / Math.abs(Math.sin(a) || 1e-6));
      const ax = cx + Math.cos(a) * k;
      const ay = cy + Math.sin(a) * k;
      const s = 12 * r.dpr;
      ctx.fillStyle = PLAYER_STYLE[o.slot].glow;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(ax + Math.cos(a) * s, ay + Math.sin(a) * s);
      ctx.lineTo(ax + Math.cos(a + 2.4) * s, ay + Math.sin(a + 2.4) * s);
      ctx.lineTo(ax + Math.cos(a - 2.4) * s, ay + Math.sin(a - 2.4) * s);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  drawArena(ctx) {
    ctx.strokeStyle = 'rgba(80, 100, 255, 0.25)';
    ctx.lineWidth = 16;
    ctx.strokeRect(0, 0, ARENA.W, ARENA.H);
    ctx.strokeStyle = this.slowT > 0 ? '#9db0ff' : '#5a6bff';
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
    for (let owner = 0; owner < PLAYER_STYLE.length; owner++) {
      for (const crit of [false, true]) {
        const color = crit ? '#ffd84d' : PLAYER_STYLE[owner].bullet;
        const width = crit ? 6 : 4;
        ctx.beginPath();
        let any = false;
        for (const b of this.bullets) {
          if (b.crit !== crit || (b.owner ?? 0) !== owner) continue;
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
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = '#7df9ff';
    ctx.lineWidth = 1;
    for (const p of this.players) {
      if (!p.alive || !p.stats.orbitals) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 62, 0, TAU);
      ctx.stroke();
    }
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
    for (const p of this.players) {
      if (!p.alive) continue;
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
