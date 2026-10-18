// The relay fallback over an in-memory MQTT broker: ordering, compression, encryption, goodbye.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayLink } from '../src/net/relay.js';
import { roomSecrets, pickRelayBroker, BROKERS } from '../src/net/signal.js';

function memoryBroker({ jitter = true } = {}) {
  const clients = new Set();
  const make = (url = 'mem://broker') => {
    const c = {
      url, closed: false, ws: { bufferedAmount: 0 }, subs: new Set(), handlers: new Set(),
      subscribe(t) { c.subs.add(t); },
      onMessage(fn) { c.handlers.add(fn); return () => c.handlers.delete(fn); },
      publish(t, bytes) {
        const copy = Uint8Array.from(bytes);
        for (const o of clients) {
          if (o.closed || !o.subs.has(t)) continue;
          setTimeout(() => { for (const fn of o.handlers) fn(t, { bytes: copy }); }, jitter ? Math.random() * 3 : 0);
        }
      },
      close() { c.closed = true; },
    };
    clients.add(c);
    return c;
  };
  return make;
}

const until = async (cond, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function pair(opts) {
  const client = memoryBroker(opts);
  const { key, topic } = await roomSecrets('K7QX2M');
  const host = new RelayLink(client(), key, topic, 'host', 'g1');
  const guest = new RelayLink(client(), key, topic, 'guest', 'g1');
  return { host, guest, client, key, topic };
}

test('ctl messages keep their order through async encryption', async () => {
  // An in-order broker, like a real one delivering one publisher's messages over one connection.
  const { host, guest } = await pair({ jitter: false });
  const got = [];
  guest.onCtl = (m) => got.push(m.n);
  for (let n = 0; n < 60; n++) host.sendCtl({ t: 'x', n });
  await until(() => got.length === 60);
  assert.deepEqual(got, Array.from({ length: 60 }, (_, i) => i));
  host.close();
  guest.close(false);
});

test('snapshots round-trip, compressed when large', async () => {
  const { host, guest } = await pair();
  const got = [];
  guest.onState = (buf) => got.push(new Uint8Array(buf));
  const big = new Uint8Array(4000).map((_, i) => (i % 50 < 25 ? 7 : i & 255));
  const small = new Uint8Array([1, 2, 3]);
  host.sendState(big.buffer);
  host.sendState(small.buffer);
  await until(() => got.length === 2);
  got.sort((a, b) => a.length - b.length);
  assert.deepEqual(got[0], small);
  assert.deepEqual(got[1], big);
  host.close();
  guest.close(false);
});

test('a backed-up broker connection skips snapshots instead of queueing them', async () => {
  const { host, guest } = await pair();
  host.client.ws.bufferedAmount = 1e6;
  assert.equal(host.sendState(new ArrayBuffer(100)), false);
  host.client.ws.bufferedAmount = 0;
  assert.equal(host.sendState(new ArrayBuffer(100)), true);
  host.close();
  guest.close(false);
});

test('messages under another room key are ignored', async () => {
  const client = memoryBroker();
  const a = await roomSecrets('K7QX2M');
  const b = await roomSecrets('ZZZZZZ');
  const host = new RelayLink(client(), a.key, a.topic, 'host', 'g1');
  const intruder = new RelayLink(client(), b.key, a.topic, 'guest', 'g1'); // right topic, wrong key
  let got = 0;
  host.onCtl = () => got++;
  intruder.sendCtl({ t: 'pause' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got, 0);
  host.close();
  intruder.close(false);
});

test('closing one side tells the other right away', async () => {
  const { host, guest } = await pair();
  let closed = false;
  host.onClose = () => { closed = true; };
  guest.close();
  await until(() => closed);
  assert.ok(host.closed);
});

test('both sides agree on the relay broker', () => {
  const [a, b, c] = BROKERS;
  assert.equal(pickRelayBroker([c, b, a], [b, a]), a, 'our preference order wins, not connection order');
  assert.equal(pickRelayBroker([b, c], [c, b]), b);
  assert.equal(pickRelayBroker([a], [b]), null);
});
