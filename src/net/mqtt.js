// Minimal MQTT 3.1.1 client over WebSocket: CONNECT, SUBSCRIBE, PUBLISH (QoS 0) and keep-alive.
// It is only used for signalling (exchanging the WebRTC offer/answer through a public broker),
// so QoS 0 and a clean session are all we need. No dependencies; works in browsers and Node 22+.

const enc = new TextEncoder();
const dec = new TextDecoder();

function str(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}

function varint(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    out.push(byte);
  } while (n > 0);
  return out;
}

function packet(type, body) {
  return new Uint8Array([type, ...varint(body.length), ...body]);
}

export function connectPacket(clientId, keepAlive = 30) {
  return packet(0x10, [...str('MQTT'), 4, 0x02, keepAlive >> 8, keepAlive & 255, ...str(clientId)]);
}

export function subscribePacket(id, topic) {
  return packet(0x82, [id >> 8, id & 255, ...str(topic), 0]);
}

export function publishPacket(topic, payload) {
  const body = typeof payload === 'string' ? enc.encode(payload) : payload;
  return packet(0x30, [...str(topic), ...body]);
}

/**
 * Split a byte stream into MQTT packets. Returns the parsed packets and the unconsumed tail
 * (WebSocket frames may carry several packets or, rarely, part of one).
 */
export function parsePackets(buf) {
  const packets = [];
  let i = 0;
  while (i < buf.length) {
    const type = buf[i];
    let len = 0;
    let mul = 1;
    let j = i + 1;
    for (;;) {
      if (j >= buf.length) return { packets, rest: buf.slice(i) };
      const byte = buf[j++];
      len += (byte & 127) * mul;
      mul *= 128;
      if (!(byte & 128)) break;
    }
    if (j + len > buf.length) return { packets, rest: buf.slice(i) };
    const body = buf.subarray(j, j + len);
    const p = { type: type >> 4, flags: type & 15, body };
    if (p.type === 3) {
      const tl = (body[0] << 8) | body[1];
      p.topic = dec.decode(body.subarray(2, 2 + tl));
      const qos = (type >> 1) & 3;
      p.payload = dec.decode(body.subarray(2 + tl + (qos ? 2 : 0)));
    } else if (p.type === 2) {
      p.returnCode = body[1];
    }
    packets.push(p);
    i = j + len;
  }
  return { packets, rest: new Uint8Array(0) };
}

export class MqttClient {
  /** Resolves once the broker accepted the connection; rejects on error or timeout. */
  static connect(url, { timeout = 6000 } = {}) {
    return new Promise((resolve, reject) => {
      const client = new MqttClient(url);
      const timer = setTimeout(() => {
        client.close();
        reject(new Error(`${url}: timeout`));
      }, timeout);
      client._onConnack = (ok) => {
        clearTimeout(timer);
        if (ok) resolve(client);
        else {
          client.close();
          reject(new Error(`${url}: refused`));
        }
      };
      client.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`${url}: socket error`));
      };
    });
  }

  constructor(url) {
    this.url = url;
    this.handlers = new Set();
    this.closed = false;
    this._buf = new Uint8Array(0);
    this._id = 1;
    this.ws = new WebSocket(url, 'mqtt');
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this._send(connectPacket(`vp-${Math.random().toString(36).slice(2, 12)}`));
    this.ws.onmessage = (e) => this._receive(new Uint8Array(e.data));
    this.ws.onclose = () => {
      this.closed = true;
      clearInterval(this._ping);
    };
  }

  subscribe(topic) {
    this._send(subscribePacket(this._id++, topic));
  }

  publish(topic, payload) {
    this._send(publishPacket(topic, payload));
  }

  onMessage(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close() {
    clearInterval(this._ping);
    if (this.ws.readyState === 1) this._send(new Uint8Array([0xe0, 0]));
    this.ws.close();
    this.closed = true;
  }

  _send(bytes) {
    if (this.ws.readyState === 1) this.ws.send(bytes);
  }

  _receive(chunk) {
    const buf = new Uint8Array(this._buf.length + chunk.length);
    buf.set(this._buf);
    buf.set(chunk, this._buf.length);
    const { packets, rest } = parsePackets(buf);
    this._buf = rest;
    for (const p of packets) {
      if (p.type === 2) {
        this._onConnack?.(p.returnCode === 0);
        this._onConnack = null;
        this._ping = setInterval(() => this._send(new Uint8Array([0xc0, 0])), 20000);
      } else if (p.type === 3) {
        for (const fn of this.handlers) fn(p.topic, p.payload);
      }
    }
  }
}
