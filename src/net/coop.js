// Online co-op session: glue between a Game and a Link.
//
// The host runs the real simulation (enemies, bullets, scoring, upgrades) and streams it to
// the guest: a binary world snapshot at 30 Hz plus a batch of recorded effects (explosions,
// sounds, rings, banners). The guest flies its own ship locally, with no input lag, and reports its
// position, aim and trigger at 60 Hz; the host spawns the guest's bullets from that report.
// Between snapshots the guest extrapolates everything along its velocity and eases
// toward the newest data, so 30 Hz updates still look smooth at 120 fps.

import { encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, messageKind, KIND_SNAPSHOT, KIND_INPUT } from './codec.js';
import { createPlayer, movePlayer, trailPlayer, clampToArena } from '../game/player.js';
import { singularityPull } from '../game/enemies.js';
import { UPGRADE_BY_ID } from '../game/upgrades.js';
import { clamp, damp } from '../engine/math.js';

// Over the relay (public MQTT broker) we send less, to stay well inside its rate limits.
const RATES = { direct: { snapshot: 30, input: 60 }, relay: { snapshot: 12, input: 20 } };
const RUN_STATES = new Set(['playing', 'paused', 'upgrade', 'dying']);

/** Host-side stand-in for the guest's controller, fed by the guest's 60 Hz reports. */
export class RemoteInput {
  constructor() {
    this.actions = new Set();
    this.reset();
  }

  reset() {
    this.state = null;
    this.lastSeq = -1;
    this.lastDashSeq = null;
    this.actions.clear();
  }

  update(report) {
    if (report.seq <= this.lastSeq) return; // unordered channel: drop stale reports
    this.lastSeq = report.seq;
    this.state = report;
  }

  push(action) {
    this.actions.add(action);
  }

  consume(action) {
    return this.actions.delete(action);
  }

  /** Move the guest's ship to where the guest says it is. Returns whether it is firing. */
  applyTo(p, g) {
    const s = this.state;
    // Reports sent while the guest still thought it was dead (respawn in flight) are ignored.
    if (!s || !s.alive) return false;
    if (this.lastDashSeq !== null && s.dashSeq !== this.lastDashSeq) {
      p.dashX = s.dashX;
      p.dashY = s.dashY;
      g.onDash(p, true);
    }
    this.lastDashSeq = s.dashSeq;
    Object.assign(p, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, aim: s.aim, dashT: s.dashT });
    clampToArena(g, p);
    return s.fire;
  }
}

export class CoopSession {
  constructor(game, link, role, { onEnd } = {}) {
    Object.assign(this, { g: game, link, role, onEnd });
    this.rates = RATES[link.kind] ?? RATES.direct;
    this.remoteInput = new RemoteInput();
    this.sendT = 0;
    this.inputT = 0;
    this.seq = 0;
    this.dashSeq = 0;
    this.fire = false;
    this.snap = null;
    this.offer = null;
    this.enemyById = new Map();
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
      const msg = JSON.stringify({ t: 'fx', list: g.outbox.list });
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
    this.link.sendCtl({ t: 'respawn', tick: this.g.tick, x: p.x, y: p.y });
  }

  sendGameOver(summary) {
    this.link.sendCtl({ t: 'over', summary });
  }

  // ── Guest ────────────────────────────────────────────────────────────────────
  guestCtl(m) {
    const g = this.g;
    const me = g.player;
    switch (m.t) {
      case 'start': this.startRun(m); break;
      case 'fx': for (const ev of m.list) this.applyFx(ev); break;
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
    this.snap = null;
    this.offer = null;
    this.enemyById.clear();
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

  guestState(buf) {
    if (messageKind(buf) !== KIND_SNAPSHOT) return;
    const s = decodeSnapshot(buf);
    if (this.snap && s.tick <= this.snap.tick) return; // unordered channel: drop stale snapshots
    this.snap = s;
    this.bytes += buf.byteLength;
    const g = this.g;
    if (!RUN_STATES.has(g.state) && g.state !== 'gameover') return; // still in the lobby
    Object.assign(g, { wave: s.wave, score: s.score, mult: s.mult, kills: s.kills, slowT: s.slowT, orbAngle: s.orbAngle });
    this.syncState(s.state);

    for (const sp of s.players) {
      let p = g.players[sp.slot];
      if (!p) p = g.players[sp.slot] = createPlayer(sp.x, sp.y, sp.slot);
      Object.assign(p, { lives: sp.lives, bombs: sp.bombs, invuln: sp.invuln, shield: sp.shield });
      p.stats.orbitals = sp.orbitals;
      if (p === g.player) {
        if (s.tick >= this.respawnTick) p.alive = sp.alive;
      } else {
        if (!p.alive && sp.alive) {
          p.x = sp.x;
          p.y = sp.y;
        }
        Object.assign(p, { tx: sp.x, ty: sp.y, vx: sp.vx, vy: sp.vy, aim: sp.aim, alive: sp.alive, dashT: sp.dashing ? 0.05 : 0 });
      }
    }

    const byId = this.enemyById;
    const seen = new Set();
    for (const se of s.enemies) {
      let e = byId.get(se.id);
      if (!e || e.type !== se.type) {
        e = { ...se, dead: false, hp: 1, maxHp: 1 };
        byId.set(se.id, e);
      } else {
        Object.assign(e, { vx: se.vx, vy: se.vy, angle: se.angle, r: se.r, spawnT: se.spawnT, flash: se.flash, data: se.data });
      }
      e.sx = se.x;
      e.sy = se.y;
      seen.add(se.id);
    }
    for (const id of byId.keys()) if (!seen.has(id)) byId.delete(id);
    g.enemies = [...byId.values()];
    g.singularities = g.enemies.filter((e) => e.type === 'singularity');
    g.boss = s.bossId ? byId.get(s.bossId) ?? null : null;
    if (g.boss) {
      g.boss.hp = s.bossHp;
      g.boss.maxHp = 1;
    }
    g.bullets = s.bullets;
    g.enemyBullets = s.enemyBullets;
    g.geoms = s.geoms;
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

  guestUpdate(dt) {
    const g = this.g;
    const input = g.input;
    this.meter(dt);
    if (input.consume('pause')) {
      if (g.state === 'playing') this.request({ t: 'pause' });
      else if (g.state === 'paused') this.request({ t: 'resume' });
    }
    if (!RUN_STATES.has(g.state)) {
      if (g.state === 'gameover') g.updateFx(dt);
      else g.updateAmbient(dt);
      g.menuNav();
      return;
    }
    if (g.state !== 'playing') g.menuNav();
    const slow = g.slowT > 0 ? 0.45 : 1;
    g.time += dt;

    // Our own ship: simulated here, reported to the host.
    const me = g.player;
    this.fire = false;
    if (me.alive && g.state === 'playing') {
      me.invuln = Math.max(0, me.invuln - dt);
      me.dashCd = Math.max(0, me.dashCd - dt);
      const cd = me.dashCd;
      const aim = movePlayer(g, me, input, dt);
      if (me.dashCd > cd) this.dashSeq++;
      for (const e of g.singularities) singularityPull(e, me, dt);
      clampToArena(g, me);
      this.fire = aim.fire;
    }

    // Partner: extrapolate the last snapshot and ease toward it.
    for (const p of g.players) {
      if (p === me || p.tx === undefined) continue;
      p.tx += p.vx * dt;
      p.ty += p.vy * dt;
      p.x = damp(p.x, p.tx, 18, dt);
      p.y = damp(p.y, p.ty, 18, dt);
    }
    for (const p of g.players) if (p.alive) trailPlayer(g, p, dt);

    for (const e of g.enemies) {
      if (e.spawnT > 0) e.spawnT -= dt * slow;
      if (e.flash > 0) e.flash -= dt;
      e.sx += e.vx * dt * slow;
      e.sy += e.vy * dt * slow;
      e.x = damp(e.x, e.sx, 20, dt);
      e.y = damp(e.y, e.sy, 20, dt);
      if (e.type === 'singularity') {
        e.data.pulse = (e.data.pulse ?? 0) + dt * 2.5;
        g.localFx.grid.applyForce(e.x, e.y, 260, -700 * dt);
      }
    }
    for (const b of g.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    for (const b of g.enemyBullets) {
      b.x += b.vx * dt * slow;
      b.y += b.vy * dt * slow;
    }
    for (const s of g.geoms) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.a += dt * 4;
      s.life -= dt;
    }
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
