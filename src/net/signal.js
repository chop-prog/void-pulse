// Signalling over public MQTT brokers. Two browsers that know the same room code meet on a
// topic derived from it and swap a WebRTC offer and answer; after that they talk directly.
// If a direct connection is impossible (strict NAT), the same brokers relay the game.
//
// Every message is encrypted with AES-GCM under a key derived from the room code, so the
// brokers (and anyone else subscribed) see only ciphertext and a hashed topic name. We connect
// to several brokers at once and publish to all of them, so one being down doesn't matter, and
// start as soon as the first one answers — slow brokers join in when they're ready.

import { MqttClient } from './mqtt.js';

export const BROKERS = [
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

// No 0/O or 1/I: codes get read out loud and typed on phones.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function newRoomCode(randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return Array.from(randomBytes(CODE_LENGTH), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Accepts "abc-234", " ABC234 ", a full invite URL…; returns the code or null. */
export function parseRoomCode(text) {
  if (!text) return null;
  const fromUrl = /[?&]room=([^&#]+)/i.exec(text);
  const raw = (fromUrl ? decodeURIComponent(fromUrl[1]) : text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!CODE_ALPHABET.includes(ch)) return null;
  return raw;
}

/** First broker (in our order of preference) that both sides are connected to. */
export function pickRelayBroker(mine, theirs) {
  return BROKERS.find((b) => mine.includes(b) && theirs.includes(b)) ?? null;
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function roomSecrets(code) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`void-pulse/key/${code}`));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const topic = `voidpulse/v1/${hex(await crypto.subtle.digest('SHA-256', enc.encode(`void-pulse/topic/${code}`))).slice(0, 24)}`;
  return { key, topic };
}

/** AES-GCM over raw bytes: 12-byte IV followed by ciphertext. */
export async function sealBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** Returns the plaintext bytes, or null for anything that isn't ours (wrong key, garbage). */
export async function openBytes(key, bytes) {
  try {
    if (bytes.length < 28) return null;
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  } catch {
    return null;
  }
}

export async function seal(key, obj) {
  return toBase64(await sealBytes(key, enc.encode(JSON.stringify(obj))));
}

export async function open(key, text) {
  try {
    const pt = await openBytes(key, fromBase64(text));
    return pt && JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

export class Signal {
  /** Resolves as soon as one broker is connected; the others are added as they connect. */
  static async open(code, { brokers = BROKERS, timeout = 7000 } = {}) {
    const secrets = await roomSecrets(code);
    const signal = new Signal(secrets);
    await new Promise((resolve, reject) => {
      let failed = 0;
      for (const url of brokers) {
        MqttClient.connect(url, { timeout }).then((c) => {
          if (signal.closed) return c.close();
          signal._add(url, c);
          resolve();
        }, () => {
          if (++failed === brokers.length) reject(new Error('No signalling server is reachable from this network. Check your internet connection or try another network.'));
        });
      }
    });
    return signal;
  }

  constructor({ key, topic }) {
    this.key = key;
    this.topic = topic;
    this.clients = new Map(); // url → MqttClient
    this.handlers = new Map();
    this.seen = new Set();
    this.closed = false;
  }

  /** URLs of the brokers we're connected to right now. */
  get brokers() {
    return [...this.clients.keys()];
  }

  _add(url, client) {
    this.clients.set(url, client);
    client.onMessage((t, p) => this._receive(t, p.payload));
    for (const t of this.handlers.keys()) client.subscribe(t);
  }

  /** Receive messages addressed to `box` (e.g. "host" or "g-<guest id>"). */
  listen(box, fn) {
    const t = `${this.topic}/${box}`;
    this.handlers.set(t, fn);
    for (const c of this.clients.values()) c.subscribe(t);
  }

  async send(box, msg) {
    const data = await seal(this.key, { ...msg, mid: Math.random().toString(36).slice(2) });
    for (const c of this.clients.values()) c.publish(`${this.topic}/${box}`, data);
  }

  async _receive(topic, payload) {
    const fn = this.handlers.get(topic);
    if (!fn) return;
    const msg = await open(this.key, payload);
    // The same message arrives once per broker; handle it once.
    if (!msg || this.seen.has(msg.mid)) return;
    this.seen.add(msg.mid);
    fn(msg);
  }

  /** Lend one broker connection to a relay link: close() will leave it open (the link owns it). */
  pin(url) {
    const c = this.clients.get(url);
    if (c) c.pinned = true;
    return c ?? null;
  }

  close() {
    this.closed = true;
    for (const c of this.clients.values()) if (!c.pinned) c.close();
    this.clients.clear();
    this.handlers.clear();
  }
}
