// Browser-to-browser connection for online co-op.
//
// 1. Signalling (signal.js): the guest sends a WebRTC offer, the host answers.
// 2. Direct link (WebRTC data channels), tried first:
//      ctl   — reliable, ordered JSON: lobby, effects, upgrades, pause, pings
//      state — unreliable, unordered binary: world snapshots and ship state; a late
//              snapshot is useless, so lost ones are never re-sent
// 3. If no direct path opens within a few seconds (symmetric NAT / CGNAT, common on mobile
//    carriers), both sides fall back to a relay through a shared MQTT broker (relay.js).
//
// No trickle ICE: each side waits briefly for its candidates and sends one complete SDP.

import { Signal, pickRelayBroker } from './signal.js';
import { RelayLink } from './relay.js';

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
/** Bumped whenever the two sides could misunderstand each other; both must match to connect. */
export const PROTOCOL = 5;
export const OLD_VERSION_HINT = 'Reload the page (on a phone: close the tab and open the link again).';
const ANSWER_TIMEOUT = 15000;
const DIRECT_TIMEOUT = 6000;
const RELAY_TIMEOUT = 12000;
const RESEND_EVERY = 1500;

const timeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

/** Wait for ICE candidates, but not for long: once a public (srflx) one is in, more rarely helps. */
function iceGathered(pc, max = 1500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let early = 0;
    const cap = setTimeout(() => done(), max);
    const done = () => {
      clearTimeout(cap);
      clearTimeout(early);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && done());
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate && / typ (srflx|relay)/.test(e.candidate.candidate) && !early) early = setTimeout(done, 250);
    });
  });
}

/** Resolves when every channel is open; rejects on timeout or when ICE gives up. */
function channelsOpen(pc, channels, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('direct timeout')), ms);
    const check = () => {
      if (channels.every((c) => c && c.readyState === 'open')) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const c of channels) c?.addEventListener('open', check);
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') {
        clearTimeout(timer);
        reject(new Error('ice failed'));
      }
    });
    check();
  });
}

export class Link {
  constructor(pc, ctl, state) {
    Object.assign(this, { pc, ctl, state });
    this.kind = 'direct';
    this.rtt = 0;
    this.closed = false;
    this.onCtl = null;
    this.onState = null;
    this.onClose = null;
    this.closeHooks = []; // internal listeners that survive onClose being reassigned
    this.sent = 0;
    state.binaryType = 'arraybuffer';
    ctl.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'ping') this.sendCtl({ t: 'pong', ts: m.ts });
      else if (m.t === 'pong') {
        const sample = performance.now() - m.ts;
        this.rtt = this.rtt ? this.rtt * 0.7 + sample * 0.3 : sample;
      } else this.onCtl?.(m);
    };
    state.onmessage = (e) => this.onState?.(e.data);
    const lost = () => this.close();
    ctl.onclose = lost;
    state.onclose = lost;
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') lost();
      // "disconnected" can recover on its own (Wi-Fi hiccup); give it a few seconds.
      if (s === 'disconnected') setTimeout(() => pc.connectionState === 'disconnected' && lost(), 5000);
    };
    this._ping = setInterval(() => this.sendCtl({ t: 'ping', ts: performance.now() }), 1000);
  }

  sendCtl(msg) {
    if (this.ctl.readyState === 'open') this.ctl.send(JSON.stringify(msg));
  }

  /** Unreliable send; dropped if the channel is congested (the next snapshot supersedes it). */
  sendState(buf) {
    if (this.state.readyState !== 'open' || this.state.bufferedAmount > 256 * 1024) return false;
    this.state.send(buf);
    this.sent += buf.byteLength;
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._ping);
    try {
      this.ctl.close();
      this.state.close();
      this.pc.close();
    } catch {
      /* already closing */
    }
    for (const fn of this.closeHooks) fn();
    this.onClose?.();
  }
}

/**
 * Open a room and wait for a guest. `onGuest(link)` fires when one is connected (directly or
 * via the relay); `onStatus(kind)` reports 'connecting' | 'relay' | 'failed' for the lobby.
 * While a guest is connected, other join attempts are told the room is full. A new attempt
 * replaces one that is still connecting, so a friend who retries is never locked out.
 */
export async function hostRoom(code, { onGuest, onStatus } = {}) {
  const signal = await Signal.open(code);
  let connected = null;
  let attempt = null;
  const mismatched = new Set();

  const run = async (msg) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const me = { from: msg.from, cancelled: false, relay: null };
    me.cancel = () => {
      me.cancelled = true;
      pc.close();
    };
    const relayRequest = new Promise((resolve) => {
      me.relay = resolve;
    });
    attempt = me;
    onStatus?.('connecting');
    try {
      const channels = {};
      pc.ondatachannel = (e) => {
        channels[e.channel.label] = e.channel;
      };
      const deadline = performance.now() + DIRECT_TIMEOUT + RELAY_TIMEOUT;
      const direct = new Promise((resolve) => {
        const wait = () => {
          if (me.cancelled || performance.now() > deadline) return; // the relay or the timeout decides instead
          if (channels.ctl && channels.state) channelsOpen(pc, [channels.ctl, channels.state], deadline - performance.now()).then(() => resolve('direct'), () => {});
          else setTimeout(wait, 50);
        };
        wait();
      });
      await pc.setRemoteDescription(msg.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc);
      if (me.cancelled) return;
      await signal.send(`g-${msg.from}`, { kind: 'answer', v: PROTOCOL, sdp: pc.localDescription.toJSON(), brokers: signal.brokers });
      const winner = await timeout(Promise.race([direct, relayRequest]), DIRECT_TIMEOUT + RELAY_TIMEOUT, 'no-relay-request');
      if (me.cancelled) return;
      let link;
      if (winner === 'direct') {
        link = new Link(pc, channels.ctl, channels.state);
      } else {
        pc.close();
        onStatus?.('relay');
        const client = signal.pin(winner.broker);
        if (!client) throw new Error('relay broker not available');
        link = new RelayLink(client, signal.key, signal.topic, 'host', msg.from);
        link.sendCtl({ t: 'hello' });
      }
      attempt = null;
      connected = link;
      link.closeHooks.push(() => {
        connected = null;
      });
      onGuest?.(link);
    } catch (err) {
      if (me.cancelled) return;
      pc.close();
      if (attempt === me) attempt = null;
      onStatus?.('failed', err);
    }
  };

  signal.listen('host', (msg) => {
    if (msg.kind === 'relay') {
      if (attempt?.from === msg.from) attempt.relay(msg);
      return;
    }
    if (msg.kind !== 'offer') return;
    if (msg.v !== PROTOCOL) {
      // An older (or newer) build: tell the guest, once per guest, and tell the host's lobby.
      signal.send(`g-${msg.from}`, { kind: 'version', v: PROTOCOL });
      if (!mismatched.has(msg.from)) onStatus?.('version', msg.v);
      mismatched.add(msg.from);
      return;
    }
    if (connected && !connected.closed) {
      signal.send(`g-${msg.from}`, { kind: 'busy' });
      return;
    }
    if (attempt?.from === msg.from) return; // guests re-send their offer until answered
    attempt?.cancel();
    run(msg);
  });
  return { close: () => signal.close() };
}

/**
 * Join a room by code. Resolves with an open link (direct or relay), or rejects with a
 * readable reason. `onStatus(text)` narrates progress for the lobby.
 */
export async function joinRoom(code, { onStatus } = {}) {
  onStatus?.('Reaching the lobby servers…');
  const signal = await Signal.open(code);
  const me = Math.random().toString(36).slice(2, 12);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ctl = pc.createDataChannel('ctl', { ordered: true });
  const state = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
  let resend = 0;
  let relay = null;
  try {
    const answer = new Promise((resolve, reject) => {
      signal.listen(`g-${me}`, (m) => {
        if (m.kind === 'answer') resolve(m);
        else if (m.kind === 'busy') reject(new Error('That room already has two players.'));
        else if (m.kind === 'version') reject(new Error(`Your friend has a different version of the game. Both of you: ${OLD_VERSION_HINT}`));
      });
    });
    await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc);
    onStatus?.('Looking for the room…');
    const offer = () => ({ kind: 'offer', v: PROTOCOL, from: me, sdp: pc.localDescription.toJSON(), brokers: signal.brokers });
    signal.send('host', offer());
    resend = setInterval(() => signal.send('host', offer()), RESEND_EVERY);
    const ans = await timeout(answer, ANSWER_TIMEOUT, 'Room not found. Check the code, and that your friend still has the room open.');
    clearInterval(resend);
    if (ans.v !== PROTOCOL) throw new Error(`Your friend has an older version of the game. Ask them to reload the page, then try again.`);

    onStatus?.('Room found. Connecting…');
    await pc.setRemoteDescription(ans.sdp);
    const direct = await channelsOpen(pc, [ctl, state], DIRECT_TIMEOUT).then(() => true, () => false);
    if (direct) return new Link(pc, ctl, state);

    // No direct path: relay through a broker we both reach.
    pc.close();
    const broker = pickRelayBroker(signal.brokers, ans.brokers ?? []);
    if (!broker) throw new Error('Could not connect: your network blocks direct connections and no relay is reachable. Try another network.');
    onStatus?.('Direct connection blocked by the network. Switching to the relay…');
    relay = new RelayLink(signal.pin(broker), signal.key, signal.topic, 'guest', me);
    const hello = new Promise((resolve) => {
      relay.onCtl = (m) => m.t === 'hello' && resolve();
    });
    const request = { kind: 'relay', from: me, broker };
    signal.send('host', request);
    resend = setInterval(() => signal.send('host', request), RESEND_EVERY);
    await timeout(hello, RELAY_TIMEOUT, 'Could not connect through the relay either. Try again, or try another network.');
    relay.onCtl = null;
    return relay;
  } catch (err) {
    pc.close();
    relay?.close(false);
    throw err;
  } finally {
    clearInterval(resend);
    signal.close();
  }
}
