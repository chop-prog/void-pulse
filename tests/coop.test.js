// Co-op end to end, without a network: two real Game instances (host and guest) joined by an
// in-memory link that carries the same JSON and binary messages WebRTC would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, coopHp, CHRONOS_SCALE, CHRONOS_COOLDOWN } from '../src/game/game.js';
import { CoopSession } from '../src/net/coop.js';
import { ENEMIES, BOSS_ORDER, serpentSegments } from '../src/game/enemies.js';
import { shootPlayer, STORM_EVERY, STORM_SHOTS } from '../src/game/player.js';

const noop = () => {};
const silentAudio = new Proxy({}, { get: () => noop });

function stubInput() {
  return {
    actions: new Set(),
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0, fire: false },
    sticks: { move: null, aim: null },
    poll() {},
    push(a) { this.actions.add(a); },
    consume(a) { return this.actions.delete(a); },
    flush() { this.actions.clear(); },
    getMove() { return this.move; },
    getAim() { return this.aim; },
  };
}

function stubUI() {
  const ui = {
    handlers: { toggleSound: noop },
    banners: [],
    banner(title) { this.banners.push(title); },
    showUpgrades(wave, choices, owned, onPick) { this.choices = choices; this.onPick = onPick; this.waiting = false; },
    showUpgradeWaiting() { this.waiting = true; this.onPick = null; },
    showGameOver(s) { this.over = s; },
  };
  return new Proxy(ui, { get: (t, p) => (p in t ? t[p] : noop) });
}

function memoryStorage() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
}

const makeGame = () => new Game({ renderer: null, input: stubInput(), audio: silentAudio, ui: stubUI(), settings: { shake: false }, storage: memoryStorage() });

/**
 * Two connected fake links over a simulated network. Messages are serialised like the real
 * thing. With `lag(kind)` returning seconds, delivery is delayed: snapshots/inputs ('state')
 * independently (they may reorder), control messages in order, like a reliable channel.
 */
function linkPair(clock, lag = () => 0) {
  const queue = [];
  let lastCtl = 0;
  const make = () => {
    const link = {
      rtt: 5, closed: false, closeHooks: [], onCtl: null, onState: null, onClose: null,
      sendCtl(m) { link.ctl.send(JSON.stringify(m)); },
      sendState(buf) {
        const copy = buf.slice(0);
        queue.push({ at: clock.t + lag('state'), go: () => !link.closed && link.peer.onState?.(copy) });
        return true;
      },
      close() {
        if (link.closed) return;
        link.closed = true;
        link.onClose?.();
        link.peer.close();
      },
    };
    link.ctl = {
      readyState: 'open',
      send: (text) => {
        lastCtl = Math.max(lastCtl, clock.t + lag('ctl'));
        queue.push({ at: lastCtl, go: () => !link.closed && link.peer.onCtl?.(JSON.parse(text)) });
      },
    };
    return link;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  const deliver = () => {
    queue.sort((x, y) => x.at - y.at);
    while (queue.length && queue[0].at <= clock.t) queue.shift().go();
  };
  return [a, b, deliver];
}

function coop({ lag } = {}) {
  const host = makeGame();
  const guest = makeGame();
  const clock = { t: 0 };
  const now = () => clock.t;
  const [a, b, deliver] = linkPair(clock, lag);
  new CoopSession(host, a, 'host', { now });
  new CoopSession(guest, b, 'guest', { now });
  host.newRun();
  deliver();
  const run = (seconds, each) => {
    for (let i = 0; i < Math.round(seconds * 120); i++) {
      clock.t += 1 / 120;
      host.update(1 / 120);
      deliver();
      guest.update(1 / 120);
      each?.();
    }
  };
  return { host, guest, a, b, run, clock };
}
test('starting a co-op run puts both pilots in the same world', () => {
  const { host, guest } = coop();
  assert.equal(host.mode, 'coop');
  assert.equal(host.players.length, 2);
  assert.ok(host.players[1].remote);
  assert.equal(guest.state, 'playing');
  assert.equal(guest.localSlot, 1);
  assert.equal(guest.players.length, 2);
  assert.equal(guest.player.x, host.players[1].x);
});

test('the guest sees the host\'s enemies, and enemies are tougher in co-op', () => {
  const { host, guest, run } = coop();
  for (const p of host.players) p.invuln = 100; // idle pilots would get hit and mercy-blast the wave
  run(6);
  const live = host.enemies.filter((e) => !e.dead && e.spawnT <= 0);
  assert.ok(live.length >= 5, `wave 1 has spawned (${live.length} alive)`);
  for (const e of live) {
    const T = ENEMIES[e.type];
    assert.ok(Math.abs(e.maxHp - T.hp * coopHp(2)) < 1e-9, `${e.type} hp ${e.maxHp}`);
  }
  const seen = new Map(guest.enemies.map((e) => [e.id, e]));
  let matched = 0;
  for (const e of live) {
    const g = seen.get(e.id);
    if (!g) continue;
    matched++;
    assert.equal(g.type, e.type);
    assert.ok(Math.hypot(g.x - e.x, g.y - e.y) < 60, `${e.type} drifted ${Math.hypot(g.x - e.x, g.y - e.y).toFixed(1)}px`);
  }
  assert.ok(matched >= live.length * 0.8, `guest sees ${matched}/${live.length}`);
  assert.equal(guest.wave, 1);
});

test('the guest flies its own ship and the host fires its guns', () => {
  const { host, guest, run } = coop();
  for (const e of host.enemies) e.dead = true;
  host.director.groups = [];
  const x0 = guest.player.x;
  guest.input.move = { x: 1, y: 0 };
  guest.input.aim = { x: 0, y: -1, fire: true };
  run(0.5);
  assert.ok(guest.player.x > x0 + 120, 'guest ship moved locally');
  assert.ok(Math.abs(host.players[1].x - guest.player.x) < 15, 'host follows the guest\'s reports');
  assert.ok(host.bullets.some((b) => b.owner === 1), 'host spawned the guest\'s bullets');
  assert.ok(guest.bullets.some((b) => b.owner === 1), 'and they come back in snapshots');
});

test('a downed pilot returns next wave; upgrades wait for both; game over needs both down', () => {
  const { host, guest, run } = coop();
  const p2 = host.players[1];
  for (let i = 0; i < 3; i++) {
    p2.invuln = 0;
    host.hitPlayer(p2);
  }
  assert.equal(p2.alive, false);
  assert.equal(host.state, 'playing', 'one pilot down is not game over');
  assert.ok(host.ui.banners.includes('P2 down'));
  run(0.2);
  assert.equal(guest.player.alive, false);

  // Clear the wave.
  host.director.idx = host.director.groups.length;
  for (const e of host.enemies) host.killEnemy(e);
  run(2.2);
  assert.equal(host.state, 'upgrade');
  assert.equal(guest.state, 'upgrade');
  assert.equal(guest.ui.choices.length, 3, 'guest got its own offer');

  host.ui.onPick(0);
  assert.equal(host.state, 'upgrade', 'host waits for the guest');
  assert.ok(host.ui.waiting);
  guest.ui.onPick(1);
  run(1 / 30); // the pick travels to the host
  assert.equal(host.state, 'playing');
  assert.equal(host.wave, 2);
  assert.ok(p2.alive && p2.lives === 1, 'P2 respawned with one life');
  assert.ok(Object.values(p2.owned).reduce((s, n) => s + n, 0) === 1);
  run(0.3);
  assert.equal(guest.state, 'playing');
  assert.ok(guest.player.alive);

  for (const p of host.players) {
    while (p.alive) {
      p.invuln = 0;
      p.shield = 0;
      p.phoenixUsed = true;
      host.hitPlayer(p);
    }
  }
  assert.equal(host.state, 'dying');
  run(2.5);
  assert.equal(host.state, 'gameover');
  assert.equal(guest.state, 'gameover');
  assert.equal(guest.ui.over.mode, 'coop');
  assert.equal(guest.ui.over.score, host.ui.over.score);
});

test('on a jittery network enemies still move smoothly on the guest\'s screen', () => {
  // 40–190 ms latency per snapshot, independently: packets bunch up, leave gaps and reorder.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const { host, guest, run } = coop({ lag: (kind) => (kind === 'state' ? 0.04 + rand() * 0.15 : 0.06) });
  for (const p of host.players) p.invuln = 1000;
  run(4);
  const tracked = guest.enemies.find((e) => e.spawnT <= 0);
  assert.ok(tracked, 'an enemy is on screen');
  const session = guest.net;
  const steps = [];
  const pace = []; // how far the guest's view of time moved per tick, in ticks
  let last = [tracked.x, tracked.y];
  let lastRt = session.renderTime;
  let tick = 0;
  run(3, () => {
    // Kills and hits cause hit-stop on the host every so often; the guest must not freeze over it.
    if (++tick % 70 === 0) host.hitstop = 0.15;
    pace.push((session.renderTime - lastRt) * 120);
    lastRt = session.renderTime;
    if (!guest.enemies.includes(tracked)) return;
    steps.push(Math.hypot(tracked.x - last[0], tracked.y - last[1]));
    last = [tracked.x, tracked.y];
  });
  // The guest's timeline never stalls (frozen picture) and never leaps (skipped motion)…
  const slowest = Math.min(...pace);
  const fastest = Math.max(...pace);
  assert.ok(slowest > 0.8 && fastest < 1.2, `timeline pace ${slowest.toFixed(2)}–${fastest.toFixed(2)}× real time`);
  // …so enemies glide: wave-1 enemies move ≤ ~400 px/s, ≤ ~3.5 px per 1/120 s tick.
  assert.ok(steps.length > 60, 'tracked long enough');
  const max = Math.max(...steps);
  assert.ok(max < 8, `largest per-frame jump ${max.toFixed(1)} px`);
});

test('hits on the guest are judged on the guest\'s screen and confirmed by the host', () => {
  const { host, guest, run } = coop({ lag: () => 0.05 });
  for (const e of host.enemies) e.dead = true;
  host.director.groups = [];
  run(0.5);
  const p2 = host.players[1];
  p2.invuln = 0;
  run(0.2); // let snapshots without the spawn grace reach the guest
  guest.player.invuln = 0;
  const me = guest.player;
  // A slow enemy bullet parked on the guest's ship, in the host's world.
  host.enemyBullets.push({ x: me.x, y: me.y, vx: 0, vy: 0, r: 7, life: 6 });
  const lives = p2.lives;
  run(0.6);
  assert.equal(p2.lives, lives - 1, 'host applied the hit the guest reported');
  assert.ok(guest.player.invuln > 0, 'guest is invulnerable right after');
});

test('if the guest disconnects, the host carries on alone', () => {
  const { host, guest, b, run } = coop();
  run(1);
  b.close();
  assert.equal(host.role, 'solo');
  assert.equal(host.players.length, 1);
  assert.equal(host.state, 'playing');
  assert.ok(host.ui.banners.includes('Partner disconnected'));
  assert.equal(guest.state, 'menu');
  run(1); // and nothing throws afterwards
});

// ── New augments and bosses (solo world) ───────────────────────────────────────
function solo() {
  const g = makeGame();
  g.newRun();
  g.director = null;
  g.enemies = [];
  return g;
}

test('Aegis Shield absorbs a hit; Phoenix Core revives once', () => {
  const g = solo();
  const p = g.player;
  Object.assign(p, { invuln: 0, shield: 1 });
  p.stats.shield = 1;
  g.hitPlayer(p);
  assert.equal(p.lives, 3);
  assert.equal(p.shield, 0);

  Object.assign(p, { lives: 1, invuln: 0 });
  p.stats.phoenix = 1;
  g.hitPlayer(p);
  assert.ok(p.alive && p.lives === 1 && p.phoenixUsed);
  p.invuln = 0;
  g.hitPlayer(p);
  assert.equal(p.alive, false);
  assert.equal(g.state, 'dying');
});

test('Chronos slows enemy fire (with a cooldown); Bullet Storm rings every few volleys', () => {
  const g = solo();
  const p = g.player;
  p.stats.chronos = 1;
  g.onDash(p);
  g.enemyBullets.push({ x: 1000, y: 100, vx: 100, vy: 0, r: 7, life: 6 });
  g.step(0.1);
  assert.ok(Math.abs(g.enemyBullets[0].x - (1000 + 10 * CHRONOS_SCALE)) < 1e-6);
  g.slowT = 0;
  g.onDash(p);
  assert.equal(g.slowT, 0, 'Chronos is on cooldown');
  g.time += CHRONOS_COOLDOWN;
  g.onDash(p);
  assert.ok(g.slowT > 0, 'and ready again after it');

  p.stats.storm = 1;
  const before = g.bullets.length;
  p.volleys = 0;
  for (let i = 0; i < STORM_EVERY; i++) {
    p.fireCd = 0;
    shootPlayer(g, p, true);
  }
  assert.equal(g.bullets.length - before, STORM_EVERY + STORM_SHOTS);
});

test('Laser Warden beams hit only while active, along every beam', () => {
  const e = { x: 1000, y: 600, r: 58, data: { phase: 1, beamMode: 2, beamA: 0 } };
  const at = (x, y) => ENEMIES.warden.hits(e, { x, y, r: 12 });
  assert.ok(at(1400, 600) && at(600, 600), 'two opposite beams');
  assert.ok(!at(1400, 700) && !at(1000, 900));
  e.data.phase = 2;
  assert.ok(at(1000, 900), 'enraged: four beams');
  e.data.beamMode = 1;
  assert.ok(!at(1400, 600), 'telegraph is harmless');
});

test('Void Serpent: only its body hurts on contact, laid out behind the head', () => {
  const g = solo();
  g.wave = 20;
  const s = g.spawnEnemy('serpent', 1000, 600, { telegraph: false });
  const p = g.player;
  p.x = 300;
  p.y = 1100;
  for (let i = 0; i < 120 * 3; i++) {
    p.invuln = 10;
    g.step(1 / 120);
  }
  const segs = serpentSegments(s);
  assert.equal(segs.length, 14);
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(Math.hypot(segs[i][0] - segs[i - 1][0], segs[i][1] - segs[i - 1][1]) - 30) < 1);
  assert.ok(ENEMIES.serpent.hits(s, { x: segs[6][0], y: segs[6][1], r: 12 }));
  assert.ok(!ENEMIES.serpent.hits(s, { x: s.x + 400, y: s.y + 400, r: 12 }));
});

for (const type of BOSS_ORDER) {
  test(`${ENEMIES[type].title}: survives 25 s of its own pattern, then dies cleanly`, () => {
    const g = solo();
    g.wave = 10;
    const p = g.player;
    const boss = g.spawnEnemy(type, 1000, 400, { telegraph: false });
    const modes = new Set();
    let maxJump = 0;
    let last = [boss.x, boss.y];
    for (let i = 0; i < 25 * 120; i++) {
      p.invuln = 10; // watch the pattern, don't die
      g.step(1 / 120);
      modes.add(`${boss.data.mode ?? ''}${boss.data.beamMode ?? ''}`);
      maxJump = Math.max(maxJump, Math.hypot(boss.x - last[0], boss.y - last[1]));
      last = [boss.x, boss.y];
      if (i === 12 * 120) g.damageEnemy(boss, boss.maxHp * 0.6, 0, 0, false); // trigger phase 2
    }
    assert.equal(boss.data.phase, 2, 'enraged at half health');
    assert.ok(g.enemyBullets.length + g.enemies.length > 1, 'it attacks');
    if (type === 'warden') assert.ok(modes.has('2'), 'beams fired');
    if (type === 'brood') assert.ok(modes.has('1') && modes.has('2'), 'it winds up and charges');
    if (type === 'prism') {
      assert.ok(maxJump > 150, 'it teleports');
      assert.ok(g.enemies.some((o) => o.type === 'decoy' && !o.dead), 'enraged: mirror copies');
    }
    g.damageEnemy(boss, 1e9, 0, 0, false);
    assert.ok(boss.dead);
    g.step(1 / 120);
    assert.equal(g.enemies.filter((o) => !o.dead).length, 0, 'minions die with it');
  });
}
