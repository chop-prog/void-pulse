// Binary wire format for co-op. Pure functions, no DOM — round-trip tested in tests/codec.test.js.
//
// Snapshot (host → guest, ~30 Hz, unreliable channel): the whole simulated world, quantised.
// Positions and velocities fit int16 (the arena is 2000×1300 and nothing moves faster than
// 32 767 px/s), angles are stored as round(angle × 10⁴) in int16, and each enemy type lists
// the extra behaviour fields its draw() needs in `ENEMIES[type].sync` (sent as float32).
//
// Input (guest → host, ~60 Hz, unreliable channel): the guest's ship state. The guest moves
// its own ship locally (no input lag) and the host trusts it — fine for a friendly co-op.

import { ENEMIES, ENEMY_TYPES, SPAWN_TIME } from '../game/enemies.js';

export const VERSION = 1;
export const KIND_SNAPSHOT = 1;
export const KIND_INPUT = 2;
export const STATES = ['menu', 'playing', 'paused', 'upgrade', 'dying', 'gameover'];

const TYPE_INDEX = Object.fromEntries(ENEMY_TYPES.map((t, i) => [t, i]));
const ANGLE = 10000;
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const HEADER = 2 + 4 + 4 + 1 + 2 + 8 + 4 + 4 + 4 + 4 + 2 + 2 + 1;
const PLAYER = 1 + 1 + 2 * 5 + 1 + 1 + 1 + 1;

function enemySize(e) {
  return 2 + 1 + 1 + 2 * 5 + 1 + 1 + 4 * (ENEMIES[e.type].sync?.length ?? 0);
}

/** Encode the host's world for the guest. `g` is a Game (or any object with the same fields). */
export function encodeSnapshot(g) {
  const enemies = g.enemies.filter((e) => !e.dead);
  let size = HEADER + PLAYER * g.players.length + 2 + 2 + 2 + 2;
  for (const e of enemies) size += enemySize(e);
  size += g.bullets.length * 10 + g.enemyBullets.length * 8 + g.geoms.length * 9;

  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  const w8 = (x) => { v.setUint8(o, x); o += 1; };
  const w16 = (x) => { v.setInt16(o, i16(x), true); o += 2; };
  const wu16 = (x) => { v.setUint16(o, x, true); o += 2; };
  const w32 = (x) => { v.setUint32(o, x >>> 0, true); o += 4; };
  const wf = (x) => { v.setFloat32(o, x, true); o += 4; };

  w8(VERSION);
  w8(KIND_SNAPSHOT);
  w32(g.tick);
  wf(g.time);
  w8(Math.max(0, STATES.indexOf(g.state)));
  wu16(g.wave);
  v.setFloat64(o, g.score, true);
  o += 8;
  w32(g.mult);
  w32(g.kills ?? 0);
  wf(g.slowT ?? 0);
  wf(g.orbAngle ?? 0);
  const boss = g.boss && !g.boss.dead ? g.boss : null;
  wu16(boss ? boss.id : 0);
  wu16(boss ? Math.round(Math.max(0, Math.min(1, boss.hp / boss.maxHp)) * 65535) : 0);
  w8(g.players.length);

  for (const p of g.players) {
    w8(p.slot);
    w8((p.alive ? 1 : 0) | (p.shield > 0 ? 2 : 0) | (p.dashT > 0 ? 4 : 0));
    w16(p.x); w16(p.y); w16(p.vx); w16(p.vy); w16(wrapAngle(p.aim) * ANGLE);
    w8(u8(p.lives)); w8(u8(p.bombs)); w8(u8(p.invuln * 40)); w8(u8(p.stats.orbitals));
  }

  wu16(enemies.length);
  for (const e of enemies) {
    wu16(e.id);
    w8(TYPE_INDEX[e.type]);
    w8(e.flash > 0 ? 1 : 0);
    w16(e.x); w16(e.y); w16(e.vx); w16(e.vy); w16(wrapAngle(e.angle) * ANGLE);
    w8(u8(e.r));
    w8(u8((Math.max(0, e.spawnT) / SPAWN_TIME) * 255));
    for (const key of ENEMIES[e.type].sync ?? []) wf(Number(e.data[key]) || 0);
  }

  wu16(g.bullets.length);
  for (const b of g.bullets) {
    w16(b.x); w16(b.y); w16(b.vx); w16(b.vy);
    w8(b.crit ? 1 : 0);
    w8(b.owner ?? 0);
  }
  wu16(g.enemyBullets.length);
  for (const b of g.enemyBullets) {
    w16(b.x); w16(b.y); w16(b.vx); w16(b.vy);
  }
  wu16(g.geoms.length);
  for (const s of g.geoms) {
    w16(s.x); w16(s.y); w16(s.vx); w16(s.vy);
    w8(u8(s.life * 20));
  }
  if (o !== size) throw new Error(`snapshot size mismatch: wrote ${o}, expected ${size}`);
  return buf;
}

export function decodeSnapshot(buf) {
  const v = new DataView(buf);
  let o = 0;
  const r8 = () => v.getUint8(o++);
  const r16 = () => { const x = v.getInt16(o, true); o += 2; return x; };
  const ru16 = () => { const x = v.getUint16(o, true); o += 2; return x; };
  const r32 = () => { const x = v.getUint32(o, true); o += 4; return x; };
  const rf = () => { const x = v.getFloat32(o, true); o += 4; return x; };

  if (r8() !== VERSION) throw new Error('snapshot version mismatch');
  if (r8() !== KIND_SNAPSHOT) throw new Error('not a snapshot');
  const s = { tick: r32(), time: rf(), state: STATES[r8()], wave: ru16() };
  s.score = v.getFloat64(o, true);
  o += 8;
  s.mult = r32();
  s.kills = r32();
  s.slowT = rf();
  s.orbAngle = rf();
  s.bossId = ru16();
  s.bossHp = ru16() / 65535;

  s.players = [];
  for (let n = r8(); n > 0; n--) {
    const slot = r8();
    const flags = r8();
    s.players.push({
      slot, alive: !!(flags & 1), shield: flags & 2 ? 1 : 0, dashing: !!(flags & 4),
      x: r16(), y: r16(), vx: r16(), vy: r16(), aim: r16() / ANGLE,
      lives: r8(), bombs: r8(), invuln: r8() / 40, orbitals: r8(),
    });
  }

  s.enemies = [];
  for (let n = ru16(); n > 0; n--) {
    const id = ru16();
    const type = ENEMY_TYPES[r8()];
    const e = {
      id, type, flash: r8() & 1 ? 0.06 : 0,
      x: r16(), y: r16(), vx: r16(), vy: r16(), angle: r16() / ANGLE,
      r: r8(), spawnT: (r8() / 255) * SPAWN_TIME, data: {},
    };
    for (const key of ENEMIES[type].sync ?? []) e.data[key] = rf();
    s.enemies.push(e);
  }

  s.bullets = [];
  for (let n = ru16(); n > 0; n--) {
    const b = { x: r16(), y: r16(), vx: r16(), vy: r16() };
    b.crit = !!(r8() & 1);
    b.owner = r8();
    b.r = b.crit ? 6 : 4;
    s.bullets.push(b);
  }
  s.enemyBullets = [];
  for (let n = ru16(); n > 0; n--) s.enemyBullets.push({ x: r16(), y: r16(), vx: r16(), vy: r16(), r: 7 });
  s.geoms = [];
  for (let n = ru16(); n > 0; n--) {
    const g = { x: r16(), y: r16(), vx: r16(), vy: r16(), life: r8() / 20 };
    g.a = (g.x + g.y) * 0.01;
    s.geoms.push(g);
  }
  return s;
}

/** Guest ship state → 44-byte message. */
export function encodeInput(i) {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  v.setUint8(0, VERSION);
  v.setUint8(1, KIND_INPUT);
  v.setUint8(2, (i.fire ? 1 : 0) | (i.alive ? 2 : 0));
  v.setUint8(3, 0);
  v.setUint32(4, i.seq >>> 0, true);
  const f = [i.x, i.y, i.vx, i.vy, i.aim, i.dashT, i.dashX, i.dashY, i.dashSeq];
  f.forEach((x, k) => v.setFloat32(8 + k * 4, x, true));
  return buf;
}

export function decodeInput(buf) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== VERSION || v.getUint8(1) !== KIND_INPUT) throw new Error('not an input message');
  const flags = v.getUint8(2);
  const f = (k) => v.getFloat32(8 + k * 4, true);
  return {
    fire: !!(flags & 1), alive: !!(flags & 2), seq: v.getUint32(4, true),
    x: f(0), y: f(1), vx: f(2), vy: f(3), aim: f(4), dashT: f(5), dashX: f(6), dashY: f(7), dashSeq: f(8),
  };
}

/** First two bytes tell the message kind (binary messages only). */
export function messageKind(buf) {
  return buf.byteLength >= 2 ? new DataView(buf).getUint8(1) : 0;
}
