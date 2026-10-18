// Direct browser-to-browser connection (WebRTC data channels) for online co-op.
//
//   ctl   — reliable, ordered JSON: lobby, effects, upgrades, pause, pings
//   state — unreliable, unordered binary: world snapshots (host → guest) and ship state
//           (guest → host). A late snapshot is useless, so lost ones are never re-sent.
//
// The guest makes the offer; both sides wait for ICE gathering to finish and send one complete
// SDP each way through the signalling channel (no trickle ICE: fewer messages, simpler code).

import { Signal } from './signal.js';

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const CONNECT_TIMEOUT = 20000;

const timeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

function iceGathered(pc, ms = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, ms); // good enough: host + STUN candidates arrive well before this
  });
}

function channelOpen(ch) {
  return ch.readyState === 'open' ? Promise.resolve() : new Promise((resolve) => ch.addEventListener('open', resolve, { once: true }));
}

export class Link {
  constructor(pc, ctl, state) {
    Object.assign(this, { pc, ctl, state });
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
 * Open a room and wait for guests. Calls `onGuest(link)` for each connected guest; while one is
 * connected, other join attempts are told the room is busy. Returns `{ close() }`.
 */
export async function hostRoom(code, { onGuest, onError } = {}) {
  const signal = await Signal.open(code);
  let current = null; // guest id being connected or connected
  signal.listen('host', async (msg) => {
    if (msg.kind !== 'offer' || msg.from === current) return; // guests re-send their offer until answered
    if (current) {
      signal.send(`g-${msg.from}`, { kind: 'busy' });
      return;
    }
    current = msg.from;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    try {
      const channels = {};
      const arrived = new Promise((resolve) => {
        pc.ondatachannel = (e) => {
          channels[e.channel.label] = e.channel;
          if (channels.ctl && channels.state) resolve();
        };
      });
      await pc.setRemoteDescription(msg.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc);
      await signal.send(`g-${msg.from}`, { kind: 'answer', sdp: pc.localDescription.toJSON() });
      await timeout(arrived.then(() => Promise.all([channelOpen(channels.ctl), channelOpen(channels.state)])), CONNECT_TIMEOUT, 'Direct connection failed');
      const link = new Link(pc, channels.ctl, channels.state);
      link.closeHooks.push(() => {
        current = null;
      });
      onGuest?.(link);
    } catch (err) {
      pc.close();
      current = null;
      onError?.(err);
    }
  });
  return { close: () => signal.close() };
}

/** Join a room by code. Resolves with an open Link, or rejects with a readable reason. */
export async function joinRoom(code) {
  const signal = await Signal.open(code);
  const me = Math.random().toString(36).slice(2, 12);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ctl = pc.createDataChannel('ctl', { ordered: true });
  const state = pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
  let resend = 0;
  try {
    const answer = new Promise((resolve, reject) => {
      signal.listen(`g-${me}`, (m) => {
        if (m.kind === 'answer') resolve(m.sdp);
        else if (m.kind === 'busy') reject(new Error('That room already has two players.'));
      });
    });
    await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc);
    const offer = { kind: 'offer', from: me, sdp: pc.localDescription.toJSON() };
    signal.send('host', offer);
    resend = setInterval(() => signal.send('host', offer), 2500);
    const sdp = await timeout(answer, CONNECT_TIMEOUT, 'Room not found. Check the code, and that your friend still has the room open.');
    clearInterval(resend);
    await pc.setRemoteDescription(sdp);
    await timeout(Promise.all([channelOpen(ctl), channelOpen(state)]), CONNECT_TIMEOUT,
      'Found the room, but a direct connection could not be made. Strict networks (some mobile carriers, office Wi-Fi) can block it; try another network.');
    return new Link(pc, ctl, state);
  } catch (err) {
    pc.close();
    throw err;
  } finally {
    clearInterval(resend);
    signal.close();
  }
}
