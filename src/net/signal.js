// Signalling over public MQTT brokers. Two browsers that know the same room code meet on a
// topic derived from it and swap a WebRTC offer and answer; after that they talk directly
// and the brokers are no longer involved.
//
// Every message is encrypted with AES-GCM under a key derived from the room code, so the
// brokers (and anyone else subscribed) see only ciphertext and a hashed topic name. We connect
// to several brokers at once and publish to all of them, so one being down doesn't matter.

import { MqttClient } from './mqtt.js';

export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
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

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toBase64(out);
}

/** Returns the decrypted object, or null for anything that isn't ours (wrong key, garbage). */
export async function open(key, text) {
  try {
    const bytes = fromBase64(text);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

export class Signal {
  static async open(code, { brokers = BROKERS, timeout = 7000 } = {}) {
    const [secrets, settled] = await Promise.all([
      roomSecrets(code),
      Promise.allSettled(brokers.map((url) => MqttClient.connect(url, { timeout }))),
    ]);
    const clients = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (!clients.length) throw new Error('No signalling server is reachable from this network.');
    return new Signal(clients, secrets);
  }

  constructor(clients, { key, topic }) {
    this.clients = clients;
    this.key = key;
    this.topic = topic;
    this.handlers = new Map();
    this.seen = new Set();
    for (const c of clients) c.onMessage((t, payload) => this._receive(t, payload));
  }

  /** Receive messages addressed to `box` (e.g. "host" or "g-<guest id>"). */
  listen(box, fn) {
    const t = `${this.topic}/${box}`;
    this.handlers.set(t, fn);
    for (const c of this.clients) c.subscribe(t);
  }

  async send(box, msg) {
    const data = await seal(this.key, { ...msg, mid: Math.random().toString(36).slice(2) });
    for (const c of this.clients) c.publish(`${this.topic}/${box}`, data);
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

  close() {
    for (const c of this.clients) c.close();
    this.handlers.clear();
  }
}
