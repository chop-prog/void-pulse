// Relay fallback for networks that block direct WebRTC (symmetric NAT / CGNAT, common on mobile
// carriers). Game traffic goes through one public MQTT broker instead, encrypted with the room
// key. Higher latency than a direct link, so the co-op session sends fewer snapshots over it.
//
// Exposes the same interface as Link (sendCtl / sendState / onCtl / onState / onClose / rtt),
// so the rest of the game doesn't care which one it got.

import { sealBytes, openBytes } from './signal.js';

const KIND_CTL = 1;
const KIND_STATE = 2;
const KIND_BYE = 3;
const KIND_STATE_Z = 4; // deflate-compressed snapshot
const BACKLOG_LIMIT = 32 * 1024; // bytes queued on the socket before we start skipping snapshots
const SILENCE_LIMIT = 10000; // ms without a message before we call the partner gone

const enc = new TextEncoder();
const dec = new TextDecoder();
const canZip = typeof CompressionStream === 'function';

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export class RelayLink {
  /**
   * @param client  connected MqttClient (owned by this link from now on)
   * @param key     AES-GCM room key
   * @param base    room topic; messages go to `${base}/r/${pair}/host|guest`
   * @param role    'host' | 'guest'
   * @param pair    id shared by the two peers (the guest id)
   */
  constructor(client, key, base, role, pair) {
    Object.assign(this, { client, key, role });
    this.kind = 'relay';
    this.broker = client.url;
    this.rtt = 0;
    this.closed = false;
    this.onCtl = null;
    this.onState = null;
    this.onClose = null;
    this.closeHooks = [];
    this.sent = 0;
    this.lastHeard = performance.now();
    this.inbox = `${base}/r/${pair}/${role}`;
    this.outbox = `${base}/r/${pair}/${role === 'host' ? 'guest' : 'host'}`;
    // AES-GCM is async: chain sends and receives so ctl messages keep their order.
    this._sendChain = Promise.resolve();
    this._recvChain = Promise.resolve();
    this.ctl = { readyState: 'open', send: (text) => this._send(KIND_CTL, enc.encode(text)) };
    this._off = client.onMessage((topic, p) => {
      if (topic !== this.inbox) return;
      const bytes = p.bytes;
      this._recvChain = this._recvChain.then(() => this._receive(bytes));
    });
    client.subscribe(this.inbox);
    this._ping = setInterval(() => {
      if (performance.now() - this.lastHeard > SILENCE_LIMIT || client.closed) this.close();
      else this.sendCtl({ t: 'ping', ts: performance.now() });
    }, 1000);
  }

  sendCtl(msg) {
    this.ctl.send(JSON.stringify(msg));
  }

  /** Skipped while the broker connection is backed up: a newer snapshot will follow anyway. */
  sendState(buf) {
    if (this.closed || this.client.ws.bufferedAmount > BACKLOG_LIMIT) return false;
    this._send(KIND_STATE, new Uint8Array(buf));
    this.sent += buf.byteLength;
    return true;
  }

  _send(kind, bytes) {
    if (this.closed && kind !== KIND_BYE) return;
    const framed = new Uint8Array(bytes.length + 1);
    framed[0] = kind;
    framed.set(bytes, 1);
    this._sendChain = this._sendChain.then(async () => {
      let out = framed;
      if (kind === KIND_STATE && canZip && bytes.length > 256) {
        const z = await pipe(bytes, new CompressionStream('deflate-raw'));
        out = new Uint8Array(z.length + 1);
        out[0] = KIND_STATE_Z;
        out.set(z, 1);
      }
      this.client.publish(this.outbox, await sealBytes(this.key, out));
    }).catch(() => {});
  }

  async _receive(bytes) {
    const plain = await openBytes(this.key, bytes);
    if (!plain || this.closed) return;
    this.lastHeard = performance.now();
    const kind = plain[0];
    const body = plain.subarray(1);
    if (kind === KIND_STATE) {
      this.onState?.(body.slice().buffer);
    } else if (kind === KIND_STATE_Z) {
      this.onState?.((await pipe(body, new DecompressionStream('deflate-raw'))).buffer);
    } else if (kind === KIND_CTL) {
      const m = JSON.parse(dec.decode(body));
      if (m.t === 'ping') this.sendCtl({ t: 'pong', ts: m.ts });
      else if (m.t === 'pong') {
        const sample = performance.now() - m.ts;
        this.rtt = this.rtt ? this.rtt * 0.7 + sample * 0.3 : sample;
      } else this.onCtl?.(m);
    } else if (kind === KIND_BYE) {
      this.close(false);
    }
  }

  close(notify = true) {
    if (this.closed) return;
    if (notify) this._send(KIND_BYE, new Uint8Array(0));
    this.closed = true;
    clearInterval(this._ping);
    this._off();
    // Give the goodbye a moment to leave before dropping the broker connection.
    this._sendChain.finally(() => setTimeout(() => this.client.close(), 300));
    for (const fn of this.closeHooks) fn();
    this.onClose?.();
  }
}
