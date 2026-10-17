// DOM layer: menus, HUD, banners. Text stays crisp and accessible in HTML while the
// playfield lives on the canvas. HUD writes are diffed so the DOM is only touched on change.

import { RARITY, UPGRADE_BY_ID } from './game/upgrades.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.floor(n).toLocaleString('en-US');
const SCREENS = { menu: 'screen-menu', paused: 'screen-pause', upgrade: 'screen-upgrade', gameover: 'screen-over' };
const HUD_STATES = new Set(['playing', 'paused', 'upgrade', 'dying']);
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

export class UI {
  constructor(handlers) {
    this.handlers = handlers;
    this.screen = 'menu';
    this.cache = Object.create(null);
    this.touchMode = false;
    this.pickArmedAt = 0;
    this.el = {
      hud: $('hud'), score: $('score'), mult: $('mult'), wave: $('wave'), lives: $('lives'), bombs: $('bombs'),
      dash: $('dash-fill'), dashWrap: $('dash'), boss: $('boss'), bossFill: $('boss-fill'),
      banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
      hurt: $('hurt'), cards: $('cards'), upWave: $('up-wave'), touch: $('touch'), debug: $('debug'),
    };

    const on = (id, fn) => $(id).addEventListener('click', () => {
      handlers.click();
      fn();
    });
    on('btn-play', () => handlers.play(false));
    on('btn-daily', () => handlers.play(true));
    on('btn-resume', handlers.resume);
    on('btn-restart', handlers.restart);
    on('btn-quit', handlers.quit);
    on('btn-retry', handlers.restart);
    on('btn-menu', handlers.quit);
    on('btn-copy', () => this.copyResult());
    on('btn-sound', handlers.toggleSound);
    on('btn-shake', handlers.toggleShake);
    on('btn-quality', handlers.toggleQuality);
    $('btn-pause-hud').addEventListener('click', handlers.pause);

    for (const btn of document.querySelectorAll('[data-action]')) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handlers.action(btn.dataset.action);
      });
    }

    this.el.cards.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) this.pick(Number(card.dataset.i));
    });
    addEventListener('keydown', (e) => {
      if (this.screen === 'upgrade' && /^(Digit|Numpad)[1-3]$/.test(e.code)) this.pick(Number(e.code.slice(-1)) - 1);
    });
    const enableTouch = () => {
      if (this.touchMode) return;
      this.touchMode = true;
      document.body.classList.add('touch');
      this.el.touch.hidden = this.screen !== 'playing';
    };
    if (matchMedia('(pointer: coarse)').matches) enableTouch();
    addEventListener('touchstart', enableTouch, { passive: true });
  }

  showScreen(state) {
    this.screen = state;
    for (const [s, id] of Object.entries(SCREENS)) $(id).classList.toggle('active', s === state);
    this.el.hud.classList.toggle('active', HUD_STATES.has(state));
    this.el.touch.hidden = !(this.touchMode && state === 'playing');
    const screen = SCREENS[state] && $(SCREENS[state]);
    if (screen) {
      const first = screen.querySelector('button');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 60);
    } else if (document.activeElement instanceof HTMLElement) {
      // Never leave a focused button around while playing — Space would "click" it.
      document.activeElement.blur();
    }
  }

  _buttons() {
    const screen = SCREENS[this.screen] && $(SCREENS[this.screen]);
    return screen ? [...screen.querySelectorAll('button')].filter((b) => b.offsetParent !== null) : [];
  }

  navigate(dir) {
    const list = this._buttons();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    list[(i + dir + list.length) % list.length].focus();
  }

  confirm() {
    const el = document.activeElement;
    if (el instanceof HTMLButtonElement && this._buttons().includes(el)) el.click();
  }

  // ── HUD ──────────────────────────────────────────────────────────────────────
  _set(key, text) {
    if (this.cache[key] === text) return false;
    this.cache[key] = text;
    this.el[key].textContent = text;
    return true;
  }

  _pips(key, n, cls) {
    if (this.cache[key] === n) return;
    this.cache[key] = n;
    const shown = Math.min(n, 6);
    this.el[key].innerHTML = `<i class="pip ${cls}"></i>`.repeat(shown) + (n > shown ? `<span>+${n - shown}</span>` : '');
  }

  updateHud(g) {
    const p = g.player;
    this._set('score', fmt(g.score));
    if (this._set('mult', `×${g.mult}`)) {
      this.el.mult.classList.remove('bump');
      void this.el.mult.offsetWidth;
      this.el.mult.classList.add('bump');
    }
    this._set('wave', `Wave ${g.wave}`);
    this._pips('lives', Math.max(0, p.lives), 'life');
    this._pips('bombs', p.bombs, 'bomb');

    const k = Math.round((1 - p.dashCd / p.stats.dashCooldown) * 50) / 50;
    if (this.cache.dashK !== k) {
      this.cache.dashK = k;
      this.el.dash.style.transform = `scaleX(${k})`;
      this.el.dashWrap.classList.toggle('ready', k >= 1);
    }

    const boss = g.boss;
    const bossK = boss ? Math.max(0, boss.hp / boss.maxHp) : -1;
    if (this.cache.bossK !== bossK) {
      this.cache.bossK = bossK;
      this.el.boss.hidden = !boss;
      if (boss) {
        this.el.bossFill.style.transform = `scaleX(${bossK})`;
        this.el.boss.classList.toggle('enraged', boss.data.phase === 2);
      }
    }
  }

  banner(title, sub = '', kind = '') {
    const b = this.el.banner;
    b.className = '';
    void b.offsetWidth; // restart CSS animation
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub;
    b.className = `show ${kind}`;
  }

  flashHurt() {
    const h = this.el.hurt;
    h.classList.remove('on');
    void h.offsetWidth;
    h.classList.add('on');
  }

  debug(text) {
    this.el.debug.hidden = text == null;
    if (text != null) this.el.debug.textContent = text;
  }

  // ── Screens ──────────────────────────────────────────────────────────────────
  setBest(standard, daily, date) {
    $('best-standard').textContent = fmt(standard);
    $('best-daily').textContent = fmt(daily);
    $('daily-tag').textContent = date;
  }

  setToggles(s) {
    $('btn-sound').textContent = `Sound: ${s.muted ? 'Off' : 'On'}`;
    $('btn-shake').textContent = `Screen shake: ${s.shake ? 'On' : 'Off'}`;
    $('btn-quality').textContent = `Effects: ${s.quality === 'low' ? 'Low' : 'High'}`;
  }

  showUpgrades(wave, choices, owned, onPick) {
    this.onPick = onPick;
    this.pickArmedAt = performance.now() + 450; // ignore clicks from a held fire button
    this.el.upWave.textContent = wave;
    this.el.cards.innerHTML = choices.map((u, i) => `
      <button class="card" data-rarity="${u.rarity}" data-i="${i}" style="--d:${i * 80}ms">
        <span class="card-key">${i + 1}</span>
        <span class="card-icon">${icon(u.icon)}</span>
        <span class="card-name">${u.name}</span>
        <span class="card-desc">${u.desc}</span>
        <span class="card-meta">${RARITY[u.rarity].label} · ${owned[u.id] || 0}/${u.max}</span>
      </button>`).join('');
  }

  pick(i) {
    if (this.screen !== 'upgrade' || performance.now() < this.pickArmedAt) return;
    this.onPick?.(i);
  }

  showGameOver(s) {
    this.summary = s;
    $('over-mode').textContent = s.mode === 'daily' ? `Daily run · ${s.date}` : 'Standard run';
    $('over-score').textContent = fmt(s.score);
    $('over-best').hidden = !s.isBest;
    const mins = Math.floor(s.time / 60);
    const secs = String(Math.floor(s.time % 60)).padStart(2, '0');
    $('over-stats').innerHTML = [
      ['Wave', s.wave], ['Kills', fmt(s.kills)], ['Peak mult', `×${fmt(s.peakMult)}`], ['Time', `${mins}:${secs}`], ['Best', fmt(s.best)],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    const build = Object.entries(s.owned);
    $('over-build').innerHTML = build.length
      ? build.map(([id, n]) => {
        const u = UPGRADE_BY_ID[id];
        return `<span class="chip" data-rarity="${u.rarity}" title="${u.name}">${icon(u.icon)}${n > 1 ? `<b>${n}</b>` : ''}</span>`;
      }).join('')
      : '<span class="muted">No augments taken</span>';
    $('btn-copy').textContent = 'Copy result';
  }

  async copyResult() {
    const s = this.summary;
    if (!s) return;
    const mode = s.mode === 'daily' ? `Daily ${s.date}` : 'Standard';
    const text = `VOID PULSE · ${mode}\n${fmt(s.score)} pts · wave ${s.wave} · ${fmt(s.kills)} kills · peak ×${s.peakMult}\n${location.origin}${location.pathname}`;
    const btn = $('btn-copy');
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
    } catch {
      btn.textContent = 'Copy failed';
    }
  }
}
