// Online co-op session: glue between a Game and a Link.
//
// The host runs the real simulation (enemies, bullets, scoring, upgrades) and streams it to the
// guest: a binary world snapshot (30 Hz direct, 12 Hz over the relay) plus batches of recorded
// effects (explosions, sounds, rings, banners), all stamped with the host's simulation clock.
//
// The guest flies its own ship locally (no input lag) and reports its position, aim and trigger;
// the host fires the guest's guns from those reports and smooths the ship between them. The guest
// also fires visual copies of its own shots the moment the trigger is pulled, so shooting never
// feels late; the host's copies do the damage and are left out of the guest's picture.
//
// Everything else on the guest is shown slightly in the past, interpolated between two buffered
// snapshots — the standard netcode answer to jitter. Packets over the internet arrive unevenly
// (in bursts, with gaps); drawing the newest one as it lands makes enemies stutter, drawing a
// buffered moment that both neighbouring snapshots bracket keeps motion smooth. The buffer delay
// adapts to the measured jitter. Effects are replayed at the same buffered moment, so an
// explosion lines up with the enemy that caused it. The guest also judges hits on its own ship
// against what it sees, so a bullet that visibly missed never counts.

import { encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, messageKind, KIND_SNAPSHOT, KIND_INPUT } from './codec.js';
import { createPlayer, movePlayer, trailPlayer, clampToArena, shootPlayer } from '../game/player.js';
import { singularityPull } from '../game/enemies.js';
import { UPGRADE_BY_ID } from '../game/upgrades.js';
import { clamp, damp, lerp, angleDiff } from '../engine/math.js';
import { CHRONOS_SCALE } from '../game/game.js';

// Over the relay (public MQTT broker) we send less, to stay well inside its rate limits.
const RATES = { direct: { snapshot: 30, input: 60 }, relay: { snapshot: 12, input: 20 } };
const RUN_STATES = new Set(['playing', 'paused', 'upgrade', 'dying']);
const BUFFER_SECONDS = 2;
const MAX_EXTRAPOLATION = 0.15; // s past the newest snapshot before we just hold still
const RESYNC = 0.5; // s of clock error that makes us snap the clock instead of easing it
const HIT_INVULN = 2.2;

const wallClock = () => performance.now() / 1000;

/** Host-side stand-in for the guest's controller, fed by the guest's reports. */
export class RemoteInput {
  constructor(now = wallClock) {
    this.now = now;
    this.actions = new Set();
    this.reset();
  }

  reset() {
    this.state = null;
    this.recvAt = 0;
    this.lastSeq = -1;
    this.lastDashSeq = null;
    this.placed = false;
    this.actions.clear();
  }

  update(report) {
    if (report.seq <= this.lastSeq) return; // unordered channel: drop stale reports
    this.lastSeq = report.seq;
    this.state = report;
    this.recvAt = this.now();
  }

  push(action) {
    this.actions.add(action);
  }

  consume(action) {
    return this.actions.delete(action);
  }

  /**
   * Move the guest's ship toward where the guest says it is, extrapolated by its velocity since
   * the report arrived (velocity feed-forward + gentle correction: smooth at 20–60 Hz reports).
   * Returns whether the guest is firing.
   */
  applyTo(p, g, dt) {
    const s = this.state;
    // Reports sent while the guest still thought it was dead (respawn in flight) are ignored.
    if (!s || !s.alive) return false;
    if (this.lastDashSeq !== null && s.dashSeq !== this.lastDashSeq) {
      p.dashX = s.dashX;
      p.dashY = s.dashY;
      g.onDash(p, true);
    }
    this.lastDashSeq = s.dashSeq;
    const age = Math.min(0.2, Math.max(0, this.now() - this.recvAt));
    const tx = s.x + s.vx * age;
    const ty = s.y + s.vy * age;
    if (!this.placed || Math.hypot(tx - p.x, ty - p.y) > 200) {
      p.x = tx;
      p.y = ty;
      this.placed = true;
    } else {
      p.x = damp(p.x + s.vx * dt, tx, 12, dt);
      p.y = damp(p.y + s.vy * dt, ty, 12, dt);
    }
    Object.assign(p, { vx: s.vx, vy: s.vy, aim: s.aim, dashT: s.dashT });
    clampToArena(g, p);
    return s.fire;
  }
}

export class CoopSession {
  constructor(game, link, role, { onEnd, now = wallClock } = {}) {
    Object.assign(this, { g: game, link, role, onEnd, now });
    this.rates = RATES[link.kind] ?? RATES.direct;
    this.remoteInput = new RemoteInput(now);
    this.sendT = 0;
    this.inputT = 0;
    this.seq = 0;
    this.dashSeq = 0;
    this.fire = false;
    this.snap = null;
    this.offer = null;
    this.enemyById = new Map();
    this.buffer = []; // decoded snapshots, oldest first
    this.fxQueue = []; // [hostTime, events] waiting for the buffered moment
    this.offset = null; // host clock − local clock, smoothed
    this.jitter = 0;
    this.renderTime = 0;
    this.ownBullets = []; // guest: our shots, drawn the moment we fire
    this.partnerBullets = []; // guest: the host's bullets from the snapshot, minus our own
    // Where firePlayer puts the guest's shots: our list, unrecorded effects and sound.
    this.shooter = { bullets: this.ownBullets, particles: game.localFx.particles, audio: game.rawAudio };
    this.respawnTick = 0; // snapshots older than this can't tell us whether we're alive
    this.bytes = 0;
    this.bytesPerSec = 0;
    this.meterT = 0;
    this.leaving = false;
    game.net = this;
    game.role = role;
    link.onCtl = (m) => (role === 'host' ? this.hostCtl(m) : this.guestCtl(m));
    link.onState = (buf) => (role === 'host' ? this.hostState(buf) : this.guestState(buf));
    link.onClose = () => this.ended();
  }

  /** Guest → host requests (pause, pick, bomb, …). */
  request(msg) {
    this.link.sendCtl(msg);
  }

  leave() {
    this.leaving = true;
    this.link.close();
  }

  ended() {
    const g = this.g;
    if (g.net !== this) return;
    g.net = null;
    g.outbox.active = false;
    g.outbox.list = [];
    if (this.role === 'host') {
      if (RUN_STATES.has(g.state)) g.dropRemote();
      else {
        g.role = 'solo';
        g.players = g.players.filter((p) => !p.remote);
      }
    } else {
      g.role = 'solo';
      if (!this.leaving) g.toMenu();
    }
    if (!this.leaving) this.onEnd?.(this.role === 'host' ? 'Your partner left the game.' : 'Connection to the host was lost.');
  }

  meter(dt) {
    if ((this.meterT += dt) >= 1) {
      this.bytesPerSec = this.bytes / this.meterT;
      this.bytes = 0;
      this.meterT = 0;
    }
  }

  // ── Host ─────────────────────────────────────────────────────────────────────
  attachRemote(p) {
    const g = this.g;
    p.remote = true;
    p.input = this.remoteInput;
    this.remoteInput.reset();
    const host = g.players[0];
    this.link.sendCtl({ t: 'start', tick: g.tick, slot: p.slot, x: p.x, y: p.y, host: { x: host.x, y: host.y }, stats: p.stats, owned: p.owned });
  }

  hostUpdate(dt) {
    const g = this.g;
    this.meter(dt);
    if ((this.sendT += dt) < 1 / this.rates.snapshot) return;
    this.sendT = 0;
    if (g.outbox.list.length) {
      const msg = JSON.stringify({ t: 'fx', time: g.clock, list: g.outbox.list });
      g.outbox.list = [];
      if (this.link.ctl.readyState === 'open') {
        this.link.ctl.send(msg);
        this.bytes += msg.length;
      }
    }
    if (RUN_STATES.has(g.state) || g.state === 'gameover') {
      const buf = encodeSnapshot(g);
      if (this.link.sendState(buf)) this.bytes += buf.byteLength;
    }
  }

  hostCtl(m) {
    const g = this.g;
    const remote = g.players.find((p) => p.remote);
    switch (m.t) {
      case 'pause': g.pause(); break;
      case 'resume': g.resume(); break;
      case 'restart': if (g.state === 'paused' || g.state === 'gameover') g.newRun(); break;
      case 'bomb': this.remoteInput.push('bomb'); break;
      case 'pick': if (remote) g.pickUpgrade(remote.slot, m.i); break;
      // The guest judged a hit against what it saw; the host applies it if the ship is hittable.
      case 'hit':
        if (remote && remote.alive && remote.invuln <= 0 && remote.dashT <= 0 && g.state === 'playing') g.hitPlayer(remote);
        break;
      default:
    }
  }

  hostState(buf) {
    if (messageKind(buf) === KIND_INPUT) this.remoteInput.update(decodeInput(buf));
  }

  offerUpgrades(wave, choices, owned) {
    this.link.sendCtl({ t: 'upgrade', wave, ids: choices.map((u) => u.id), owned });
  }

  sendStats(p) {
    this.link.sendCtl({ t: 'stats', stats: p.stats, owned: p.owned });
  }

  sendRespawn(p) {
    this.remoteInput.state = null;
    this.remoteInput.placed = false;
    this.link.sendCtl({ t: 'respawn', tick: this.g.tick, x: p.x, y: p.y });
  }

  sendGameOver(summary) {
    this.link.sendCtl({ t: 'over', summary });
  }

  // ── Guest: control messages ──────────────────────────────────────────────────
  guestCtl(m) {
    const g = this.g;
    const me = g.player;
    switch (m.t) {
      case 'start': this.startRun(m); break;
      case 'fx':
        // Older hosts send no time: play at once. Otherwise wait for the buffered moment.
        if (m.time === undefined) for (const ev of m.list) this.applyFx(ev);
        else this.fxQueue.push([m.time, m.list]);
        break;
      case 'upgrade':
        this.offer = m;
        this.showOffer();
        break;
      case 'stats':
        me.stats = m.stats;
        me.owned = m.owned;
        break;
      case 'respawn':
        Object.assign(me, { x: m.x, y: m.y, vx: 0, vy: 0, alive: true, dashT: 0, invuln: 2.5 });
        this.respawnTick = m.tick;
        break;
      case 'over':
        this.offer = null;
        this.flushFx();
        g.showSummary(m.summary);
        break;
      default:
    }
  }

  startRun(m) {
    const g = this.g;
    g.resetWorld();
    g.mode = 'coop';
    g.players = [createPlayer(m.host.x, m.host.y, 0), createPlayer(m.x, m.y, m.slot)];
    g.localSlot = m.slot;
    const me = g.player;
    me.input = g.input;
    me.stats = m.stats;
    me.owned = m.owned;
    Object.assign(g, { score: 0, mult: 1, kills: 0, wave: 1, runTime: 0, orbAngle: 0, slowT: 0 });
    this.ownBullets.length = 0;
    this.partnerBullets = [];
    this.snap = null;
    this.offer = null;
    this.enemyById.clear();
    this.buffer = [];
    this.fxQueue = [];
    this.offset = null;
    this.rtStarted = false;
    this.respawnTick = m.tick;
    g.camera.x = me.x;
    g.camera.y = me.y;
    g.setState('playing');
    g.audio.startMusic();
  }

  showOffer() {
    const g = this.g;
    const m = this.offer;
    if (!m) return;
    g.setState('upgrade');
    g.ui.showUpgrades(m.wave, m.ids.map((id) => UPGRADE_BY_ID[id]).filter(Boolean), m.owned, (i) => {
      this.request({ t: 'pick', i });
      this.offer = null;
      g.ui.showUpgradeWaiting(m.wave);
    });
  }

  /** Follow the host's game state; the upgrade screen and game over are driven by ctl messages. */
  syncState(s) {
    const g = this.g;
    if (s === g.state || s === 'gameover' || s === 'menu') return;
    if (s === 'upgrade') {
      if (this.offer) this.showOffer();
      else {
        g.setState('upgrade');
        g.ui.showUpgradeWaiting(g.wave);
      }
      return;
    }
    if (g.state === 'gameover' && s !== 'playing') return;
    g.setState(s);
  }

  applyFx([tag, a, ...rest]) {
    const g = this.g;
    switch (tag) {
      case 'p': g.localFx.particles.emit(...rest); break;
      case 'g': g.localFx.grid.applyForce(...rest); break;
      case 'a': g.rawAudio[a]?.(...rest); break;
      case 'ring': g.addRing(a, rest[0], rest[1]); break;
      case 'bolt': g.bolts.push({ pts: a, life: 0.22 }); break;
      case 'banner': g.ui.banner(a, rest[0], rest[1]); break;
      case 'pop': g.popups.push({ x: a, y: rest[0], text: rest[1], color: rest[2], life: 1 }); break;
      case 'trauma': g.trauma = Math.min(1, g.trauma + a); break;
      case 'hurt': g.ui.flashHurt(); break;
      default:
    }
  }

  flushFx(upTo = Infinity) {
    while (this.fxQueue.length && this.fxQueue[0][0] <= upTo) {
      for (const ev of this.fxQueue.shift()[1]) this.applyFx(ev);
    }
  }

  // ── Guest: snapshots ─────────────────────────────────────────────────────────
  guestState(buf) {
    if (messageKind(buf) !== KIND_SNAPSHOT) return;
    const s = decodeSnapshot(buf);
    if (this.snap && s.tick <= this.snap.tick) return; // unordered channel: drop stale snapshots
    this.snap = s;
    this.bytes += buf.byteLength;
    const g = this.g;
    if (!RUN_STATES.has(g.state) && g.state !== 'gameover') return; // still in the lobby

    // Clock: estimate host time − local time, and how much it wobbles (jitter).
    const sample = s.time - this.now();
    if (this.offset === null || Math.abs(sample - this.offset) > RESYNC) {
      this.offset = sample;
      this.jitter = 0;
    } else {
      const err = sample - this.offset;
      this.jitter += (Math.abs(err) - this.jitter) * 0.1;
      this.offset += err * 0.05;
    }

    // Keep the snapshot for interpolation, with base positions for linear movers.
    s.byId = new Map(s.enemies.map((e) => [e.id, e]));
    for (const list of [s.bullets, s.enemyBullets, s.geoms]) {
      for (const o of list) {
        o.x0 = o.x;
        o.y0 = o.y;
      }
    }
    this.buffer.push(s);
    while (this.buffer.length > 2 && this.buffer[0].time < s.time - BUFFER_SECONDS) this.buffer.shift();

    // Score, wave, state and our own status are shown as soon as they arrive.
    Object.assign(g, { wave: s.wave, score: s.score, mult: s.mult, kills: s.kills, slowT: s.slowT });
    this.syncState(s.state);
    for (const sp of s.players) {
      let p = g.players[sp.slot];
      if (!p) p = g.players[sp.slot] = createPlayer(sp.x, sp.y, sp.slot);
      Object.assign(p, { lives: sp.lives, bombs: sp.bombs, shield: sp.shield });
      p.stats.orbitals = sp.orbitals;
      if (p === g.player) {
        if (s.tick >= this.respawnTick) p.alive = sp.alive;
        p.invuln = Math.max(p.invuln, sp.invuln); // keep our own post-hit grace until the host's arrives
      } else {
        p.invuln = sp.invuln;
      }
    }
  }

  /** The buffered moment we draw: a little behind the host, more when the network is jittery. */
  targetDelay() {
    return 1.5 / this.rates.snapshot + Math.min(0.25, this.jitter * 2.5) + 0.02;
  }

  /** Lay out enemies, bullets and the partner at `rt` (host time), between two snapshots. */
  interpolate(rt) {
    const g = this.g;
    const buf = this.buffer;
    if (!buf.length) return;
    let a = buf[0];
    let b = null;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i].time <= rt) a = buf[i];
      else {
        b = buf[i];
        break;
      }
    }
    if (a.time > rt) b = null; // older than anything we have: hold the oldest
    const span = b ? b.time - a.time : 0;
    const k = b && span > 1e-6 ? clamp((rt - a.time) / span, 0, 1) : 0;
    const since = clamp(rt - a.time, 0, b ? span : MAX_EXTRAPOLATION);
    const slow = a.slowT > 0 ? CHRONOS_SCALE : 1;

    // Enemies: matched by id across the two snapshots.
    const byId = this.enemyById;
    const list = g.enemies;
    list.length = 0;
    for (const se of a.enemies) {
      let e = byId.get(se.id);
      if (!e || e.type !== se.type) {
        e = { ...se, data: { ...se.data }, dead: false, hp: 1, maxHp: 1 };
        byId.set(se.id, e);
      }
      const nb = b?.byId.get(se.id);
      if (nb) {
        e.x = lerp(se.x, nb.x, k);
        e.y = lerp(se.y, nb.y, k);
        e.angle = se.angle + angleDiff(se.angle, nb.angle) * k;
        e.spawnT = lerp(se.spawnT, nb.spawnT, k);
      } else {
        e.x = se.x + se.vx * since * slow;
        e.y = se.y + se.vy * since * slow;
        e.angle = se.angle;
        e.spawnT = Math.max(0, se.spawnT - since);
      }
      Object.assign(e, { vx: se.vx, vy: se.vy, r: se.r, flash: se.flash });
      Object.assign(e.data, se.data); // merge: the serpent keeps its locally built trail
      list.push(e);
    }
    if (byId.size > list.length * 2 + 32) {
      const live = new Set(a.enemies.map((e) => e.id));
      for (const id of byId.keys()) if (!live.has(id)) byId.delete(id);
    }
    g.singularities = list.filter((e) => e.type === 'singularity');
    g.boss = a.bossId ? byId.get(a.bossId) ?? null : null;
    if (g.boss) {
      g.boss.hp = a.bossHp;
      g.boss.maxHp = 1;
    }

    // Bullets and shards move in straight lines: the older snapshot, advanced by velocity.
    for (const o of a.bullets) {
      o.x = o.x0 + o.vx * since;
      o.y = o.y0 + o.vy * since;
    }
    for (const o of a.enemyBullets) {
      o.x = o.x0 + o.vx * since * slow;
      o.y = o.y0 + o.vy * since * slow;
    }
    for (const o of a.geoms) {
      o.x = o.x0 + o.vx * since;
      o.y = o.y0 + o.vy * since;
      o.a = (o.x0 + o.y0) * 0.01 + rt * 4;
    }
    this.partnerBullets = a.bullets.filter((o) => o.owner !== g.localSlot); // ours are drawn locally
    g.enemyBullets = a.enemyBullets;
    g.geoms = a.geoms;

    // Partner ship.
    for (const sp of a.players) {
      const p = g.players[sp.slot];
      if (!p || p === g.player) continue;
      const np = b?.players.find((o) => o.slot === sp.slot);
      if (np && np.alive === sp.alive) {
        p.x = lerp(sp.x, np.x, k);
        p.y = lerp(sp.y, np.y, k);
        p.aim = sp.aim + angleDiff(sp.aim, np.aim) * k;
      } else {
        p.x = sp.x + sp.vx * since;
        p.y = sp.y + sp.vy * since;
        p.aim = sp.aim;
      }
      Object.assign(p, { vx: sp.vx, vy: sp.vy, alive: sp.alive, dashT: sp.dashing ? 0.05 : 0 });
    }
  }

  /**
   * Fly our own shots as we see the world: straight lines, walls, homing and enemy contact. Purely
   * visual — the host's copies, fired from our reports, deal the damage and send the explosions.
   */
  updateOwnBullets(dt) {
    const g = this.g;
    const { W, H } = g.arena;
    const list = this.ownBullets;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.life -= dt;
      if (b.homing > 0) {
        let best = null;
        let bd = 320 * 320;
        for (const e of g.enemies) {
          const d2 = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
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
        } else b.life = 0;
      }
      if (b.life > 0) {
        for (const e of g.enemies) {
          const rr = e.r + b.r;
          if (b.hits.includes(e.id) || (e.x - b.x) ** 2 + (e.y - b.y) ** 2 > rr * rr) continue;
          b.hits.push(e.id);
          if (b.pierce > 0) b.pierce--;
          else { b.life = 0; break; }
        }
      }
      if (b.life <= 0) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }

  guestUpdate(dt) {
    const g = this.g;
    const input = g.input;
    this.meter(dt);
    if (input.consume('pause')) {
      if (g.state === 'playing') this.request({ t: 'pause' });
      else if (g.state === 'paused') this.request({ t: 'resume' });
    }
    if (!RUN_STATES.has(g.state)) {
      this.ownBullets.length = 0;
      this.flushFx();
      if (g.state === 'gameover') g.updateFx(dt);
      else g.updateAmbient(dt);
      g.menuNav();
      return;
    }
    if (g.state !== 'playing') g.menuNav();
    g.time += dt;

    // The world, a little in the past.
    if (this.offset !== null) {
      const target = this.now() + this.offset - this.targetDelay();
      // Play the buffered timeline at real speed and absorb clock-estimate wobble by running up to
      // 15% faster or slower: never freezes, never runs backwards. Big errors (pause, hitch) snap.
      if (!this.rtStarted || Math.abs(target - this.renderTime) > RESYNC) {
        this.renderTime = target;
        this.rtStarted = true;
      } else {
        this.renderTime += dt * (1 + clamp((target - this.renderTime) * 2, -0.15, 0.15));
      }
      this.interpolate(this.renderTime);
      this.flushFx(this.renderTime);
      // Effects stamped far behind (after a pause or hitch) play now rather than never.
      if (this.fxQueue.length && this.snap && this.fxQueue[0][0] < this.snap.time - 1) this.flushFx(this.snap.time - 1);
    }

    // Our own ship: simulated here, reported to the host.
    const me = g.player;
    this.fire = false;
    if (me.alive && g.state === 'playing') {
      me.invuln = Math.max(0, me.invuln - dt);
      me.dashCd = Math.max(0, me.dashCd - dt);
      me.fireCd -= dt;
      const cd = me.dashCd;
      const aim = movePlayer(g, me, input, dt);
      if (me.dashCd > cd) this.dashSeq++;
      for (const e of g.singularities) singularityPull(e, me, dt);
      clampToArena(g, me);
      this.fire = aim.fire;
      shootPlayer(this.shooter, me, this.fire);
      // Hits on our ship are judged against what we see, then confirmed by the host.
      if (me.invuln <= 0 && me.dashT <= 0) {
        g.buildHash();
        if (g.touchesHazard(me, g._q)) {
          me.invuln = HIT_INVULN;
          this.request({ t: 'hit' });
        }
      }
    }
    if (g.state === 'playing' || g.state === 'dying') this.updateOwnBullets(dt);
    g.bullets = this.partnerBullets.concat(this.ownBullets);
    for (const p of g.players) if (p.alive) trailPlayer(g, p, dt);
    for (const e of g.singularities) g.localFx.grid.applyForce(e.x, e.y, 260, -700 * dt);

    g.orbAngle += dt * 3.2;
    g.orbs.length = 0;
    for (const p of g.players) {
      const n = p.stats.orbitals;
      if (!n || !p.alive) continue;
      for (let i = 0; i < n; i++) {
        const a = g.orbAngle + (i * Math.PI * 2) / n;
        g.orbs.push({ x: p.x + Math.cos(a) * 62, y: p.y + Math.sin(a) * 62, owner: p.slot });
      }
    }
    g.updateFx(dt);
    g.audio.setIntensity(g.state === 'dying' ? 0.1 : g.boss ? 1 : clamp(0.3 + g.enemies.length / 35 + g.wave * 0.03, 0, 0.95));

    if ((this.inputT += dt) >= 1 / this.rates.input) {
      this.inputT = 0;
      const buf = encodeInput({
        seq: ++this.seq, x: me.x, y: me.y, vx: me.vx, vy: me.vy, aim: me.aim, dashT: me.dashT, dashX: me.dashX, dashY: me.dashY,
        dashSeq: this.dashSeq, fire: this.fire, alive: me.alive && g.state === 'playing',
      });
      if (this.link.sendState(buf)) this.bytes += buf.byteLength;
    }
  }
}
