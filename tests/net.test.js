import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, messageKind, KIND_SNAPSHOT, KIND_INPUT } from '../src/net/codec.js';
import { connectPacket, subscribePacket, publishPacket, parsePackets } from '../src/net/mqtt.js';
import { newRoomCode, parseRoomCode, roomSecrets, seal, open, CODE_ALPHABET, CODE_LENGTH } from '../src/net/signal.js';
import { createPlayer } from '../src/game/player.js';
import { ENEMIES } from '../src/game/enemies.js';

function world() {
  const p1 = createPlayer(512.4, 300.6, 0);
  const p2 = createPlayer(1490, 1020, 1);
  Object.assign(p2, { alive: false, shield: 1, lives: 0, bombs: 4, invuln: 1.5, aim: -3.1 });
  p1.stats.orbitals = 2;
  const boss = { id: 7, type: 'warden', x: 1000, y: 400, vx: -40, vy: 22.5, angle: 7.1, r: 58, spawnT: 0, flash: 0.05, hp: 300, maxHp: 400, dead: false,
    data: { phase: 2, beamA: 1.25, beamMode: 2, beamK: 0.5 } };
  return {
    tick: 123456, time: 98.5, state: 'playing', wave: 10, score: 1234567, mult: 42, kills: 999, slowT: 1.2, orbAngle: 3.3,
    players: [p1, p2],
    boss,
    enemies: [
      boss,
      { id: 65000, type: 'sniper', x: 20, y: 1280, vx: 300, vy: -300, angle: -1, r: 17, spawnT: 0.3, flash: 0, dead: false, data: { charge: 0.25, cd: 9 } },
      { id: 3, type: 'seeker', x: 5, y: 6, vx: 0, vy: 0, angle: 0, r: 15, spawnT: 0, flash: 0, dead: true, data: {} },
    ],
    bullets: [{ x: 10, y: 20, vx: 2150, vy: -2150, crit: true, owner: 1 }, { x: -5, y: 1305, vx: 0, vy: 1100, crit: false, owner: 0 }],
    enemyBullets: [{ x: 100, y: 200, vx: -230, vy: 230 }],
    geoms: [{ x: 50, y: 60, vx: 300, vy: -10, life: 8.5 }],
  };
}

test('snapshot round-trips the world within quantisation error', () => {
  const g = world();
  const buf = encodeSnapshot(g);
  assert.equal(messageKind(buf), KIND_SNAPSHOT);
  const s = decodeSnapshot(buf);
  assert.equal(s.tick, g.tick);
  assert.equal(s.state, 'playing');
  assert.equal(s.wave, 10);
  assert.equal(s.score, 1234567);
  assert.equal(s.mult, 42);
  assert.ok(Math.abs(s.slowT - 1.2) < 1e-6);
  assert.equal(s.bossId, 7);
  assert.ok(Math.abs(s.bossHp - 0.75) < 1e-4);

  const [a, b] = s.players;
  assert.deepEqual([a.slot, a.alive, a.x, a.y, a.orbitals], [0, true, 512, 301, 2]);
  assert.deepEqual([b.slot, b.alive, b.shield, b.lives, b.bombs], [1, false, 1, 0, 4]);
  assert.ok(Math.abs(b.aim + 3.1) < 1e-3 && Math.abs(b.invuln - 1.5) < 0.03);

  assert.equal(s.enemies.length, 2, 'dead enemies are not sent');
  const w = s.enemies[0];
  assert.equal(w.type, 'warden');
  assert.deepEqual(w.data, { phase: 2, beamA: Math.fround(1.25), beamMode: 2, beamK: 0.5 });
  assert.ok(Math.abs(w.angle - Math.atan2(Math.sin(7.1), Math.cos(7.1))) < 1e-3, 'angles are wrapped');
  assert.ok(w.flash > 0);
  const sn = s.enemies[1];
  assert.equal(sn.id, 65000);
  assert.deepEqual(Object.keys(sn.data), ENEMIES.sniper.sync, 'only synced fields travel');
  assert.ok(Math.abs(sn.spawnT - 0.3) < 0.01);

  assert.deepEqual(s.bullets.map((x) => [x.x, x.y, x.vx, x.vy, x.crit, x.owner]), [[10, 20, 2150, -2150, true, 1], [-5, 1305, 0, 1100, false, 0]]);
  assert.deepEqual(s.enemyBullets.map((x) => [x.x, x.y, x.vx, x.vy]), [[100, 200, -230, 230]]);
  assert.ok(Math.abs(s.geoms[0].life - 8.5) < 0.05);
});

test('a busy late-game snapshot stays small', () => {
  const g = world();
  g.enemies = Array.from({ length: 150 }, (_, i) => ({ ...g.enemies[1], id: i + 1, dead: false }));
  g.bullets = Array.from({ length: 400 }, () => g.bullets[0]);
  g.enemyBullets = Array.from({ length: 600 }, () => g.enemyBullets[0]);
  g.geoms = Array.from({ length: 350 }, () => g.geoms[0]);
  const bytes = encodeSnapshot(g).byteLength;
  assert.ok(bytes < 20000, `${bytes} bytes`);
});

test('guest input round-trips', () => {
  const i = { seq: 4000000000, x: 12.5, y: 99, vx: -380, vy: 0, aim: 1.5, dashT: 0.1, dashX: 1, dashY: 0, dashSeq: 7, fire: true, alive: true };
  const buf = encodeInput(i);
  assert.equal(buf.byteLength, 44);
  assert.equal(messageKind(buf), KIND_INPUT);
  const d = decodeInput(buf);
  assert.equal(d.seq, i.seq);
  assert.equal(d.fire, true);
  assert.equal(d.alive, true);
  for (const k of ['x', 'y', 'vx', 'vy', 'aim', 'dashT', 'dashX', 'dashY', 'dashSeq']) assert.ok(Math.abs(d[k] - i[k]) < 1e-5, k);
  assert.throws(() => decodeInput(encodeSnapshot(world())));
});

test('MQTT packets encode and parse, including across split chunks', () => {
  const big = 'x'.repeat(5000); // remaining length needs a 2-byte varint
  const stream = new Uint8Array([
    0x20, 0x02, 0x00, 0x00, // CONNACK, accepted
    ...publishPacket('voidpulse/a', 'hello'),
    ...publishPacket('voidpulse/b', big),
    0xd0, 0x00, // PINGRESP
  ]);
  const all = parsePackets(stream);
  assert.equal(all.rest.length, 0);
  assert.deepEqual(all.packets.map((p) => p.type), [2, 3, 3, 13]);
  assert.equal(all.packets[0].returnCode, 0);
  assert.deepEqual([all.packets[1].topic, all.packets[1].payload], ['voidpulse/a', 'hello']);
  assert.equal(all.packets[2].payload, big);

  // Feed the same bytes in awkward pieces, as WebSocket frames might arrive.
  const got = [];
  let buf = new Uint8Array(0);
  for (let i = 0; i < stream.length; i += 7) {
    const next = new Uint8Array(buf.length + Math.min(7, stream.length - i));
    next.set(buf);
    next.set(stream.subarray(i, i + 7), buf.length);
    const r = parsePackets(next);
    got.push(...r.packets);
    buf = r.rest;
  }
  assert.deepEqual(got.map((p) => p.payload ?? p.type), [2, 'hello', big, 13]);

  const c = connectPacket('vp-test', 30);
  assert.equal(c[0], 0x10);
  assert.deepEqual([...c.subarray(2, 8)], [0, 4, 77, 81, 84, 84]); // "MQTT"
  const s = subscribePacket(1, 't');
  assert.deepEqual([...s], [0x82, 6, 0, 1, 0, 1, 116, 0]);
});

test('room codes: generated codes parse back, typos and URLs are handled', () => {
  for (let i = 0; i < 200; i++) {
    const code = newRoomCode();
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch));
    assert.equal(parseRoomCode(code), code);
  }
  assert.equal(parseRoomCode(' k7q-x2m '), 'K7QX2M');
  assert.equal(parseRoomCode('https://chop-prog.github.io/void-pulse/?room=K7QX2M'), 'K7QX2M');
  assert.equal(parseRoomCode('K7QX2'), null);
  assert.equal(parseRoomCode('K7QX2O'), null, 'O is not in the alphabet');
  assert.equal(parseRoomCode(''), null);
});

test('signalling messages are encrypted with the room key', async () => {
  const a = await roomSecrets('K7QX2M');
  const b = await roomSecrets('K7QX2M');
  const other = await roomSecrets('ZZZZZZ');
  assert.equal(a.topic, b.topic);
  assert.notEqual(a.topic, other.topic);
  assert.ok(!a.topic.includes('K7QX2M'), 'the topic does not leak the code');
  const msg = { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0 '.repeat(500) } };
  const sealed = await seal(a.key, msg);
  assert.ok(!sealed.includes('offer'));
  assert.deepEqual(await open(b.key, sealed), msg);
  assert.equal(await open(other.key, sealed), null);
  assert.equal(await open(a.key, 'not base64 at all!'), null);
});
