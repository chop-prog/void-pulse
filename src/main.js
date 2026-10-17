import { FixedLoop } from './engine/loop.js';
import { Renderer } from './engine/renderer.js';
import { Input } from './engine/input.js';
import { AudioEngine } from './engine/audio.js';
import { Game } from './game/game.js';
import { UI } from './ui.js';
import { storage } from './storage.js';

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
const ui = new UI({
  click: () => audio.ui(),
  play: (daily) => {
    audio.unlock();
    game.newRun({ daily });
  },
  pause: () => game.pause(),
  resume: () => game.resume(),
  restart: () => game.newRun({ daily: game.mode === 'daily' }),
  quit: () => game.toMenu(),
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
addEventListener('blur', () => game.pause());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    game.pause();
    audio.suspend();
  } else {
    audio.resume();
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Handy for poking around from the devtools console.
window.voidPulse = game;
