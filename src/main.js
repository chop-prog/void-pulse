import { FixedLoop } from './engine/loop.js';
import { Renderer } from './engine/renderer.js';
import { Input } from './engine/input.js';
import { AudioEngine } from './engine/audio.js';
import { Game } from './game/game.js';
import { UI } from './ui.js';
import { storage } from './storage.js';
import { hostRoom, joinRoom } from './net/link.js';
import { CoopSession } from './net/coop.js';
import { newRoomCode, parseRoomCode } from './net/signal.js';

const settings = {
  muted: false,
  shake: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  quality: 'high',
  ...storage.get('settings', {}),
};
const saveSettings = () => storage.set('settings', settings);

const canvas = document.getElementById('game');
const renderer = new Renderer(canvas, settings.quality === 'low' ? 3 : 0);
const input = new Input(canvas);
const audio = new AudioEngine(settings);

let game;

// ── Online co-op lobby ────────────────────────────────────────────────────────
const lobby = {
  code: null,
  room: null,

  inviteUrl(code) {
    return `${location.origin}${location.pathname}?room=${code}`;
  },

  open() {
    ui.coopReset();
    ui.showScreen('coop');
  },

  close() {
    this.code = null;
    this.room?.close();
    this.room = null;
    game.net?.leave();
    game.role = 'solo';
  },

  async host() {
    this.close();
    const code = newRoomCode();
    this.code = code;
    ui.coopRoom(code);
    ui.coopStatus('Opening the room…', 'wait');
    try {
      const room = await hostRoom(code, {
        onGuest: (link) => {
          new CoopSession(game, link, 'host', { onEnd: (msg) => this.partnerGone(msg) });
          ui.coopStatus('Your friend is here. Press Start when you are both ready.', 'good');
          ui.coopReady(true);
          audio.ui();
        },
        onError: () => ui.coopStatus('Someone tried to join, but a direct connection failed. Ask them to try again.', 'bad'),
      });
      if (this.code !== code) return room.close(); // went back while connecting
      this.room = room;
      ui.coopStatus('Waiting for your friend. Send them the invite link or the code.', 'wait');
    } catch (err) {
      ui.coopStatus(err.message, 'bad');
    }
  },

  async join(text) {
    const code = parseRoomCode(text);
    if (!code) {
      ui.coopStatus('A room code is 6 characters, like K7QX2M.', 'bad');
      return;
    }
    this.close();
    this.code = code;
    ui.coopBusy(true);
    ui.coopStatus('Connecting…', 'wait');
    try {
      const link = await joinRoom(code);
      if (this.code !== code) return link.close();
      new CoopSession(game, link, 'guest', { onEnd: (msg) => this.partnerGone(msg) });
      ui.coopStatus('Connected! Waiting for the host to press Start…', 'good');
    } catch (err) {
      ui.coopStatus(err.message, 'bad');
    } finally {
      ui.coopBusy(false);
    }
  },

  start() {
    if (game.role !== 'host') return;
    audio.unlock();
    // The run is for these two pilots; stop accepting new guests.
    this.room?.close();
    this.room = null;
    game.newRun();
  },

  async copyLink() {
    if (!this.code) return;
    const url = this.inviteUrl(this.code);
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'VOID PULSE co-op', url });
      else await navigator.clipboard.writeText(url);
      ui.coopStatus('Invite link copied. Send it to your friend.', 'good');
    } catch {
      ui.coopStatus(`Copy this link: ${url}`, '');
    }
  },

  /** The other side disconnected. In a run the game carries on (host) or returns to the menu (guest). */
  partnerGone(message) {
    if (game.state === 'menu') {
      ui.showScreen('coop');
      if (this.room) {
        ui.coopReady(false);
        ui.coopStatus(`${message} The room is still open.`, 'wait');
      } else {
        ui.coopReset(this.code ?? '');
        ui.coopStatus(message, 'bad');
      }
    }
  },
};

const ui = new UI({
  click: () => audio.ui(),
  play: (daily) => {
    audio.unlock();
    lobby.close();
    game.newRun({ daily });
  },
  coop: () => lobby.open(),
  host: () => lobby.host(),
  join: (text) => lobby.join(text),
  copyLink: () => lobby.copyLink(),
  startCoop: () => lobby.start(),
  coopBack: () => {
    lobby.close();
    ui.showScreen('menu');
  },
  pause: () => game.pause(),
  resume: () => game.resume(),
  restart: () => game.restart(),
  quit: () => {
    lobby.close();
    game.toMenu();
  },
  action: (a) => input.push(a),
  toggleSound: () => {
    settings.muted = !settings.muted;
    audio.setMuted(settings.muted);
    saveSettings();
    ui.setToggles(settings);
  },
  toggleShake: () => {
    settings.shake = !settings.shake;
    saveSettings();
    ui.setToggles(settings);
  },
  toggleQuality: () => {
    settings.quality = settings.quality === 'low' ? 'high' : 'low';
    renderer.setLevel(settings.quality === 'low' ? 3 : 0);
    saveSettings();
    ui.setToggles(settings);
  },
});
ui.setToggles(settings);

game = new Game({ renderer, input, audio, ui, settings, storage });

const loop = new FixedLoop({
  step: 1 / 120,
  update: (dt) => game.update(dt),
  render: (frameDt) => game.render(frameDt),
});
game.loop = loop;
loop.start();

// Adaptive quality: if frames stay slow for a few seconds, step the renderer down a level.
let slowSeconds = 0;
setInterval(() => {
  if (game.state !== 'playing' || settings.quality === 'low') {
    slowSeconds = 0;
    return;
  }
  slowSeconds = loop.workMs > 10 || loop.fps < 45 ? slowSeconds + 1 : 0;
  if (slowSeconds >= 3 && renderer.level < renderer.maxLevel - 1) {
    renderer.setLevel(renderer.level + 1);
    slowSeconds = 0;
    console.info(`[void-pulse] adaptive quality → level ${renderer.level}`);
  }
}, 1000);

// Browsers only allow audio after a user gesture.
const unlockAudio = () => {
  audio.unlock();
  audio.startMusic();
};
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });

addEventListener('resize', () => renderer.resize());
// Solo pauses whenever focus leaves. In co-op the host's tab runs the simulation, so only the
// host hiding the tab pauses the game (for both); a guest tabbing out just stops steering.
addEventListener('blur', () => {
  if (game.role === 'solo') game.pause();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (game.role !== 'guest') game.pause();
    audio.suspend();
  } else {
    audio.resume();
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Invite links: ?room=CODE opens the co-op screen and joins straight away.
const invited = parseRoomCode(location.search);
if (invited) {
  ui.coopReset(invited);
  ui.showScreen('coop');
  lobby.join(invited);
}

// Handy for poking around from the devtools console.
window.voidPulse = game;
