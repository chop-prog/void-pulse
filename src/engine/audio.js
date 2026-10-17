// Every sound in the game is synthesised at runtime with the Web Audio API — no audio files.
// Music is a 4-bar step sequencer scheduled ahead of time on the audio clock
// ("A Tale of Two Clocks"), with layers that fade in as the action intensifies.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const BPM = 128;
// A minor → F → C → G. [root midi, chord quality]
const PROGRESSION = [[57, 'm'], [53, 'M'], [48, 'M'], [55, 'M']];
const BASS_STEPS = new Set([0, 3, 6, 8, 10, 11, 14]);
const PENTATONIC = [0, 2, 4, 7, 9];

export class AudioEngine {
  constructor({ muted = false } = {}) {
    this.ctx = null;
    this.muted = muted;
    this.intensity = 0;
    this.targetIntensity = 0.1;
    this.musicOn = false;
    this.step = 0;
    this.nextT = 0;
    this.gates = Object.create(null);
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = (this.ctx = new AC());

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 5;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(comp).connect(ctx.destination);

      this.sfx = ctx.createGain();
      this.sfx.gain.value = 0.55;
      this.sfx.connect(this.master);

      this.musicFilter = ctx.createBiquadFilter();
      this.musicFilter.type = 'lowpass';
      this.musicFilter.frequency.value = 600;
      this.musicFilter.Q.value = 0.8;
      this.music = ctx.createGain();
      this.music.gain.value = 0.3;
      this.music.connect(this.musicFilter).connect(this.master);

      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      setInterval(() => this._schedule(), 25);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  setIntensity(v) {
    this.targetIntensity = Math.max(0, Math.min(1, v));
  }

  get _live() {
    return this.ctx && !this.muted && this.ctx.state === 'running';
  }

  _gate(name, ms) {
    const now = performance.now();
    if (now - (this.gates[name] || 0) < ms) return false;
    this.gates[name] = now;
    return true;
  }

  _tone(freq, { type = 'square', to = 0, dur = 0.1, vol = 0.2, attack = 0.004, bus = this.sfx, at = 0 } = {}) {
    const c = this.ctx;
    const t = Math.max(at, c.currentTime);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _noise({ dur = 0.2, vol = 0.3, type = 'lowpass', freq = 2000, to = 0, q = 0.8, bus = this.sfx, at = 0 } = {}) {
    const c = this.ctx;
    const t = Math.max(at, c.currentTime);
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  // ── Sound effects ────────────────────────────────────────────────────────────
  shoot() {
    if (!this._live || !this._gate('shoot', 45)) return;
    this._tone(1300 + Math.random() * 250, { type: 'square', to: 360, dur: 0.06, vol: 0.035 });
  }
  hit() {
    if (!this._live || !this._gate('hit', 35)) return;
    this._tone(520, { type: 'triangle', to: 200, dur: 0.05, vol: 0.07 });
  }
  explode(size = 1) {
    if (!this._live || !this._gate('explode', 28)) return;
    const s = Math.min(size, 2.5);
    this._noise({ dur: 0.22 + 0.18 * s, vol: 0.2 * s, freq: 2600, to: 110 });
    this._tone(150, { type: 'sine', to: 38, dur: 0.28, vol: 0.22 * Math.min(s, 2) });
  }
  pickup(mult) {
    if (!this._live || !this._gate('pickup', 30)) return;
    const step = mult % 15;
    const midi = 76 + 12 * Math.floor(step / 5) + PENTATONIC[step % 5];
    this._tone(mtof(midi), { type: 'sine', dur: 0.09, vol: 0.05 });
  }
  spawn() {
    if (!this._live || !this._gate('spawn', 140)) return;
    this._tone(200, { type: 'sine', to: 520, dur: 0.3, vol: 0.03, attack: 0.08 });
  }
  enemyShoot() {
    if (!this._live || !this._gate('eshoot', 70)) return;
    this._tone(760, { type: 'sawtooth', to: 260, dur: 0.09, vol: 0.025 });
  }
  dash() {
    if (!this._live) return;
    this._noise({ dur: 0.2, vol: 0.18, type: 'highpass', freq: 500, to: 5000 });
  }
  bomb() {
    if (!this._live) return;
    this._noise({ dur: 1.5, vol: 0.55, freq: 5000, to: 50 });
    this._tone(95, { type: 'sawtooth', to: 28, dur: 1.1, vol: 0.28 });
  }
  playerHit() {
    if (!this._live) return;
    this._noise({ dur: 0.6, vol: 0.45, freq: 3200, to: 160 });
    this._tone(320, { type: 'sawtooth', to: 55, dur: 0.5, vol: 0.22 });
  }
  death() {
    if (!this._live) return;
    this._tone(440, { type: 'sawtooth', to: 30, dur: 1.8, vol: 0.2 });
    this._noise({ dur: 2, vol: 0.4, freq: 1800, to: 40 });
  }
  upgrade() {
    if (!this._live) return;
    const t = this.ctx.currentTime;
    [72, 76, 79, 84].forEach((m, i) => this._tone(mtof(m), { type: 'square', dur: 0.16, vol: 0.05, at: t + i * 0.06 }));
  }
  waveClear() {
    if (!this._live) return;
    const t = this.ctx.currentTime;
    [67, 71, 74, 79, 83].forEach((m, i) => this._tone(mtof(m), { type: 'triangle', dur: 0.25, vol: 0.08, at: t + i * 0.07 }));
  }
  waveStart(boss) {
    if (!this._live) return;
    if (boss) {
      const t = this.ctx.currentTime;
      for (let i = 0; i < 3; i++) this._tone(55, { type: 'sawtooth', to: 50, dur: 0.5, vol: 0.22, at: t + i * 0.6 });
    } else {
      this._tone(330, { type: 'sine', to: 880, dur: 0.35, vol: 0.06, attack: 0.05 });
    }
  }
  ui() {
    if (!this._live || !this._gate('ui', 40)) return;
    this._tone(980, { type: 'square', dur: 0.03, vol: 0.025 });
  }

  // ── Music sequencer ──────────────────────────────────────────────────────────
  startMusic() {
    if (!this.ctx || this.musicOn) return;
    this.musicOn = true;
    this.step = 0;
    this.nextT = this.ctx.currentTime + 0.05;
  }

  stopMusic() {
    this.musicOn = false;
  }

  _schedule() {
    const c = this.ctx;
    if (!c || !this.musicOn || c.state !== 'running') return;
    this.intensity += (this.targetIntensity - this.intensity) * 0.04;
    this.musicFilter.frequency.setTargetAtTime(450 + Math.pow(this.intensity, 1.5) * 9000, c.currentTime, 0.4);
    const stepDur = 60 / BPM / 4;
    // Re-sync if the tab was throttled and we fell behind.
    if (this.nextT < c.currentTime - 0.2) this.nextT = c.currentTime + 0.02;
    while (this.nextT < c.currentTime + 0.12) {
      if (!this.muted) this._playStep(this.step, this.nextT);
      this.nextT += stepDur;
      this.step = (this.step + 1) % 64;
    }
  }

  _playStep(step, t) {
    const bar = step >> 4;
    const s = step & 15;
    const I = this.intensity;
    const bus = this.music;
    const [root, quality] = PROGRESSION[bar];
    const chord = quality === 'm' ? [0, 3, 7, 12] : [0, 4, 7, 12];

    if (s % 4 === 0) this._tone(150, { type: 'sine', to: 42, dur: 0.28, vol: 0.9, at: t, bus });
    if (BASS_STEPS.has(s)) this._tone(mtof(root - 24 + (s === 10 ? 12 : 0)), { type: 'sawtooth', dur: 0.16, vol: 0.22, at: t, bus });
    if (s === 0) {
      this._tone(mtof(root + chord[1]), { type: 'sawtooth', dur: 1.8, vol: 0.035, attack: 0.4, at: t, bus });
      this._tone(mtof(root + chord[2]), { type: 'sawtooth', dur: 1.8, vol: 0.035, attack: 0.4, at: t, bus });
    }
    if (I > 0.25 && s % 2 === 1) this._noise({ dur: 0.035, vol: 0.06 + I * 0.06, type: 'highpass', freq: 8000, at: t, bus });
    if (I > 0.5 && (s === 4 || s === 12)) {
      this._noise({ dur: 0.16, vol: 0.3, type: 'bandpass', freq: 1800, at: t, bus });
      this._tone(210, { type: 'triangle', to: 120, dur: 0.08, vol: 0.14, at: t, bus });
    }
    if (I > 0.72) this._tone(mtof(root + 12 + chord[s % 4]), { type: 'square', dur: 0.1, vol: 0.04, at: t, bus });
  }
}
