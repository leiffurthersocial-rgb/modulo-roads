/**
 * All DOM UI: start screen with map picker, loading screen, minimal HUD that
 * fades when idle, region title cards, toasts, pause menu over a blurred
 * scene, settings, keyboard-shortcut overlay, trip log, photo-mode bar,
 * optional touch controls and a landscape hint.
 */
import { h, icon, clear, ICONS } from './dom';
import { SettingsPanel } from './SettingsPanel';
import { paintPreview } from './Previews';
import { BIOMES } from '../world/Biomes';
import { getSettings, ACTION_LABELS, type Action, isTouchDevice } from '../core/Settings';
import { keyLabel, type Input } from '../core/Input';
import { saves, type JourneySave } from '../core/Save';
import { formatDuration } from '../core/math';
import type { AudioEngine } from '../audio/AudioEngine';
import { PHOTO_FILTERS, type PhotoFilter } from '../perf/PostFX';

const SEED_WORDS = ['edelweiss', 'alpenglow', 'rösti', 'föhn', 'gotthard', 'matterhorn', 'lavaux', 'enzian', 'nebelmeer', 'arvenwald', 'bergsee', 'säntis', 'rigi', 'pilatus', 'aletsch', 'jungfrau', 'bernina', 'chasseral', 'murmeli', 'zopf'];

export function randomSeed(): string {
  const w = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
  return `${w}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export interface HudData {
  speed: number; // m/s
  gear: string;
  rpm01: number;
  distance: number; // m
  time: number; // s
  heading: number; // radians (0 = north, increasing = turning left / west)
  region: string;
  lowBattery: boolean;
  saving: number;
  headlights: boolean;
  cruise: boolean;
  cruiseSpeed: number;
  autoDrive: boolean;
  manual: boolean;
  fpsText: string | null;
}

export class UI {
  readonly settings: SettingsPanel;
  private start: HTMLElement;
  private loading: HTMLElement;
  private loadBar: HTMLElement;
  private loadMsg: HTMLElement;
  private hud: HTMLElement;
  private pause: HTMLElement;
  private help: HTMLElement;
  private triplog: HTMLElement;
  private photo: HTMLElement;
  private titleEl: HTMLElement;
  private toastEl: HTMLElement;
  private fadeEl: HTMLElement;
  private touch: HTMLElement;
  private rotate: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private selectedMap = -1;
  private seedInput!: HTMLInputElement;
  private continueBtn!: HTMLButtonElement;
  private continueMeta!: HTMLElement;
  private toastTimer = 0;
  private titleTimer = 0;
  private pauseStats!: HTMLElement;
  private pauseMeta!: HTMLElement;
  private photoFilterSeg!: HTMLElement;
  private compassStrip!: HTMLElement;
  private radioEl!: HTMLElement;
  private radioTimer = 0;
  private lastSpeedText = '';
  // callbacks
  onStart: ((seed: string, map: number) => void) | null = null;
  onContinue: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onMainMenu: (() => void) | null = null;
  onPhoto: (() => void) | null = null;
  onPhotoFilter: ((f: PhotoFilter) => void) | null = null;
  onPhotoSave: (() => void) | null = null;
  onPhotoExit: (() => void) | null = null;
  onSettingsOpen: (() => void) | null = null;
  onSettingsClose: (() => void) | null = null;
  onHelpClose: (() => void) | null = null;
  onTripLogClose: (() => void) | null = null;
  onLowBattery: (() => void) | null = null;
  onCamera: (() => void) | null = null;
  onPauseKey: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private input: Input,
    private audio: AudioEngine,
  ) {
    const snd = (k: 'click' | 'tick' | 'toggle') => this.audio.ui(k);
    this.settings = new SettingsPanel(input, snd);
    this.settings.onClose = () => this.onSettingsClose?.();
    this.hud = this.buildHud();
    this.titleEl = h('div', { class: 'title-card' });
    this.toastEl = h('div', { class: 'toast interactive' });
    this.fadeEl = h('div', { class: 'fade' });
    this.start = this.buildStart();
    this.loading = this.buildLoading();
    this.loadBar = this.loading.querySelector('.bar i') as HTMLElement;
    this.loadMsg = this.loading.querySelector('.msg') as HTMLElement;
    this.pause = this.buildPause();
    this.help = this.buildHelp();
    this.triplog = this.buildTripLog();
    this.photo = this.buildPhoto();
    this.touch = this.buildTouch();
    this.rotate = h(
      'div',
      { class: 'rotate enabled' },
      h('div', { class: 'inner' }, h('div', { class: 'phone' }), h('div', { style: { fontSize: '18px', marginBottom: '8px' } }, 'Rotate to landscape'), h('div', { style: { color: 'rgba(255,255,255,0.6)', fontSize: '13px', lineHeight: '1.5' } }, 'Modulo Roads is made for a wide view. Turn your iPad sideways – and add it to your Home Screen for full-screen driving.')),
    );
    root.append(this.hud, this.titleEl, this.photo, this.touch, this.fadeEl, this.toastEl, this.pause, this.settings.el, this.help, this.triplog, this.start, this.loading, this.rotate);
    this.updateTouchVisibility();
    getSettings().onChange((s, k) => {
      if (s === 'controls' && k === 'touchControls') this.updateTouchVisibility();
      if (s === 'controls' && k === 'bindings') this.refreshHelp();
    });
    window.addEventListener('keydown', () => this.updateTouchVisibility(), { passive: true });
  }

  // ----------------------------------------------------------------- start
  private buildStart(): HTMLElement {
    const grid = h('div', { class: 'map-grid' });
    const cards: HTMLElement[] = [];
    const mk = (idx: number, name: string, sub: string, num: string) => {
      const cv = h('canvas');
      paintPreview(cv, idx);
      const card = h(
        'div',
        {
          class: 'map-card',
          tabindex: 0,
          onclick: () => {
            this.selectMap(idx);
            this.audio.ui('tick');
          },
          ondblclick: () => this.onStart?.(this.seed(), idx),
        },
        cv,
        h('span', { class: 'num' }, num),
        h('div', { class: 'cap' }, h('b', null, name), h('small', null, sub)),
      );
      card.dataset.map = String(idx);
      cards.push(card);
      grid.append(card);
    };
    mk(-1, 'Auto journey', 'Drift across all of Switzerland', '0');
    BIOMES.forEach((b, i) => mk(i, b.name, b.region, String(i + 1)));
    this.els.cards = grid;
    this.seedInput = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Seed', maxlength: 48 }) as HTMLInputElement;
    this.seedInput.value = randomSeed();
    const dice = h('button', { class: 'icon-btn', title: 'Random seed', onclick: () => { this.seedInput.value = randomSeed(); this.audio.ui('tick'); } }, icon('dice'));
    this.continueBtn = h('button', { class: 'btn', onclick: () => this.onContinue?.() }, icon('play'), 'Continue') as HTMLButtonElement;
    this.continueMeta = h('span', { class: 'continue-meta' });
    const newBtn = h('button', { class: 'btn primary', onclick: () => this.onStart?.(this.seed(), this.selectedMap) }, 'New journey', h('kbd', { style: { background: 'rgba(255,255,255,0.15)', borderColor: 'transparent' } }, 'Enter'));
    const el = h(
      'div',
      { class: 'layer interactive' },
      h(
        'div',
        { class: 'start' },
        h(
          'div',
          { class: 'start-top' },
          h('div', null, h('div', { class: 'brand' }, h('span', { class: 'logo', html: ICONS.flag }), h('h1', null, 'Modulo ', h('span', null, 'Roads'))), h('p', { class: 'tagline' }, 'An endless, quiet drive through Switzerland. No goals, no traffic, no hurry — just the road, the weather and the light.')),
          h(
            'div',
            { class: 'tools' },
            h('button', { class: 'icon-btn', title: 'Trip log', onclick: () => this.showTripLog(true) }, icon('log')),
            h('button', { class: 'icon-btn', title: 'Keyboard shortcuts (?)', onclick: () => this.showHelp(true) }, icon('keyboard')),
            h('button', { class: 'icon-btn', title: 'Settings (Tab)', onclick: () => this.onSettingsOpen?.() }, icon('gear')),
            h('button', { class: 'icon-btn', title: 'Fullscreen', onclick: () => toggleFullscreen() }, icon('full')),
          ),
        ),
        h(
          'div',
          { class: 'maps' },
          h('div', { class: 'maps-title' }, h('span', null, 'Choose a region'), h('span', null, 'Keys 0–8')),
          grid,
          h(
            'div',
            { class: 'start-actions' },
            h('div', { class: 'seed-box' }, h('label', null, 'Seed'), h('div', { class: 'seed-row' }, this.seedInput, dice)),
            h('div', { class: 'spacer' }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, this.continueMeta, this.continueBtn),
            newBtn,
          ),
          h('div', { class: 'kbd-hint' }, h('span', null, h('kbd', null, 'W'), h('kbd', null, 'A'), h('kbd', null, 'S'), h('kbd', null, 'D'), 'drive'), h('span', null, h('kbd', null, 'C'), 'camera'), h('span', null, h('kbd', null, 'B'), 'low battery'), h('span', null, h('kbd', null, '?'), 'all shortcuts'), h('span', null, h('kbd', null, 'Esc'), 'or', h('kbd', null, '`'), 'pause')),
        ),
      ),
    );
    this.selectMap(-1);
    return el;
  }

  private seed(): string {
    const v = this.seedInput.value.trim();
    return v.length ? v : randomSeed();
  }

  selectMap(idx: number): void {
    this.selectedMap = idx;
    for (const c of this.els.cards.children) (c as HTMLElement).classList.toggle('sel', (c as HTMLElement).dataset.map === String(idx));
  }
  get mapSelection(): number {
    return this.selectedMap;
  }
  get seedValue(): string {
    return this.seed();
  }
  get startVisible(): boolean {
    return this.start.classList.contains('show');
  }

  showStart(on: boolean, save: JourneySave | null = null): void {
    this.start.classList.toggle('show', on);
    if (on) {
      this.continueBtn.disabled = !save;
      this.continueMeta.textContent = save ? `${save.seed} · ${(save.odometer / 1000).toFixed(1)} km · ${save.map < 0 ? 'Auto journey' : BIOMES[save.map].name}` : '';
      if (save) this.selectMap(save.map);
    }
  }

  // --------------------------------------------------------------- loading
  private buildLoading(): HTMLElement {
    return h('div', { class: 'layer loading' }, h('div', { class: 'inner' }, h('div', { class: 'logo', html: ICONS.flag }), h('div', { style: { fontSize: '22px', fontWeight: '300', letterSpacing: '-0.3px' } }, 'Modulo Roads'), h('div', { class: 'bar' }, h('i')), h('div', { class: 'msg' }, 'Preparing the road')));
  }
  showLoading(on: boolean, p = 0, msg = ''): void {
    this.loading.classList.toggle('show', on);
    this.loadBar.style.width = `${Math.round(p * 100)}%`;
    if (msg) this.loadMsg.textContent = msg;
  }

  // ------------------------------------------------------------------- hud
  private buildHud(): HTMLElement {
    const strip = h('div', { class: 'strip' });
    // 0..360 repeated thrice for wrap-around; 40 px per 15°
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let rep = 0; rep < 3; rep++) {
      for (let d = 0; d < 360; d += 15) {
        const l = labels[d];
        strip.append(h('span', { class: l ? (d === 0 ? 'card n' : 'card') : '' }, l ?? '·'));
      }
    }
    this.compassStrip = strip;
    this.els.compass = h('div', { class: 'compass' }, strip);
    this.els.region = h('div', { class: 'region-line' });
    this.els.speed = h('span', { class: 'num' }, '0');
    this.els.gear = h('span', { class: 'gear' }, 'D');
    this.els.unit = h('div', { class: 'unit' }, 'km/h');
    this.els.rpm = h('div', { class: 'hud-rpm' }, h('i'));
    this.els.dist = h('div', { class: 'val' }, '0.0 km');
    this.els.time = h('div', { class: 'val' }, '0:00');
    const pill = (cls: string, ic: keyof typeof ICONS, text: string) => h('span', { class: 'pill ' + cls }, icon(ic), h('span', null, text));
    this.els.pLeaf = pill('leaf', 'leaf', 'Low battery');
    this.els.pLights = pill('lights', 'headlight', 'Lights');
    this.els.pCruise = pill('cruise', 'cruise', 'Cruise');
    this.els.pAuto = pill('auto', 'auto', 'Auto-drive');
    this.els.fps = h('div', { class: 'fps' });
    this.radioEl = h('div', { class: 'hud-radio' }, icon('music'), h('span'));
    return h(
      'div',
      { class: 'layer hud' },
      this.els.fps,
      h('div', { class: 'hud-top' }, this.els.compass, this.els.region),
      this.radioEl,
      h('div', { class: 'hud-left' }, h('div', { class: 'label' }, 'Distance'), this.els.dist, h('div', { class: 'label' }, 'Time'), this.els.time, h('div', { class: 'hud-icons' }, this.els.pLeaf, this.els.pLights, this.els.pCruise, this.els.pAuto)),
      h('div', { class: 'hud-speed' }, h('div', null, this.els.speed), h('div', { class: 'unit' }, this.els.unit, this.els.gear), this.els.rpm),
    );
  }

  showHud(on: boolean): void {
    this.hud.classList.toggle('show', on);
  }
  setHudHidden(hidden: boolean): void {
    this.hud.classList.toggle('hidden', hidden);
  }
  setHudIdle(idle: boolean): void {
    this.hud.classList.toggle('idle', idle);
  }

  updateHud(d: HudData): void {
    const s = getSettings().data;
    const mph = s.driving.units === 'mph';
    const v = Math.abs(d.speed) * (mph ? 2.23694 : 3.6);
    const txt = String(Math.round(v));
    if (txt !== this.lastSpeedText) {
      this.els.speed.textContent = txt;
      this.lastSpeedText = txt;
    }
    this.els.unit.firstChild!.textContent = mph ? 'mph' : 'km/h';
    this.els.gear.textContent = d.gear;
    (this.els.rpm.firstChild as HTMLElement).style.width = `${Math.round(d.rpm01 * 100)}%`;
    this.els.rpm.classList.toggle('redline', d.rpm01 > 0.92);
    const dist = mph ? d.distance / 1609.34 : d.distance / 1000;
    this.els.dist.textContent = `${dist.toFixed(1)} ${mph ? 'mi' : 'km'}`;
    this.els.time.textContent = formatDuration(d.time);
    // compass: bearing clockwise from north. Heading increases to the left (west).
    let bearing = ((-d.heading * 180) / Math.PI) % 360;
    if (bearing < 0) bearing += 360;
    const px = (bearing / 15) * 40;
    this.compassStrip.style.transform = `translateX(${130 - 20 - 360 / 15 * 40 - px}px)`;
    this.els.compass.style.display = s.general.showCompass ? '' : 'none';
    this.els.region.textContent = d.region;
    this.els.pLeaf.classList.toggle('on', d.lowBattery);
    (this.els.pLeaf.lastChild as HTMLElement).textContent = d.lowBattery ? `Low battery · saves ~${d.saving}%` : '';
    this.els.pLights.classList.toggle('on', d.headlights);
    this.els.pCruise.classList.toggle('on', d.cruise);
    (this.els.pCruise.lastChild as HTMLElement).textContent = d.cruise ? `Cruise ${Math.round(d.cruiseSpeed * (mph ? 2.23694 : 3.6))}` : '';
    this.els.pAuto.classList.toggle('on', d.autoDrive);
    this.els.fps.classList.toggle('show', d.fpsText !== null);
    if (d.fpsText !== null) this.els.fps.textContent = d.fpsText;
  }

  nowPlaying(title: string, station: string): void {
    if (station === 'off') {
      this.radioEl.classList.remove('show');
      return;
    }
    (this.radioEl.lastChild as HTMLElement).textContent = `${station === 'lofi' ? 'Lucerne Lo-Fi' : 'Alpenglühn'} — ${title}`;
    this.radioEl.classList.add('show');
    clearTimeout(this.radioTimer);
    this.radioTimer = window.setTimeout(() => this.radioEl.classList.remove('show'), 6000);
  }

  titleCard(name: string, sub: string): void {
    clear(this.titleEl);
    this.titleEl.append(h('div', { class: 'kicker' }, icon('flag'), 'Entering'), h('h1', null, name), h('div', { class: 'sub' }, sub), h('div', { class: 'rule' }));
    this.titleEl.classList.add('show');
    clearTimeout(this.titleTimer);
    this.titleTimer = window.setTimeout(() => this.titleEl.classList.remove('show'), 5200);
  }

  toast(msg: string, actions: { label: string; primary?: boolean; fn: () => void }[] = [], ms = 3200): void {
    clear(this.toastEl);
    this.toastEl.append(h('span', null, msg));
    for (const a of actions) {
      this.toastEl.append(
        h('button', { class: a.primary ? '' : 'ghost', onclick: () => { a.fn(); this.toastEl.classList.remove('show'); } }, a.label),
      );
    }
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), actions.length ? 9000 : ms);
  }

  fade(on: boolean): void {
    this.fadeEl.classList.toggle('show', on);
  }

  // ---------------------------------------------------------------- pause
  private buildPause(): HTMLElement {
    this.pauseStats = h('div', { class: 'pause-stats' });
    this.pauseMeta = h('div', { class: 'pause-meta' });
    const b = (ic: keyof typeof ICONS, label: string, fn: () => void, primary = false, key = '') =>
      h('button', { class: 'btn' + (primary ? ' primary' : ''), onclick: () => { this.audio.ui('click'); fn(); } }, icon(ic), label, key ? h('kbd', { style: { marginLeft: 'auto' } }, key) : null);
    return h(
      'div',
      { class: 'layer interactive' },
      h('div', { class: 'backdrop', onclick: () => this.onResume?.() }),
      h(
        'div',
        { class: 'panel pause-menu' },
        h('div', { class: 'panel-head' }, h('h2', null, icon('pause'), 'Paused'), h('button', { class: 'icon-btn', onclick: () => this.onResume?.() }, icon('close'))),
        h(
          'div',
          { class: 'pause-body' },
          this.pauseStats,
          this.pauseMeta,
          b('play', 'Resume', () => this.onResume?.(), true, 'Esc'),
          b('gear', 'Settings', () => this.onSettingsOpen?.(), false, 'Tab'),
          b('camera', 'Photo mode', () => this.onPhoto?.(), false, 'P'),
          b('leaf', 'Toggle Low Battery Mode', () => this.onLowBattery?.(), false, 'B'),
          b('keyboard', 'Keyboard shortcuts', () => this.showHelp(true), false, '?'),
          b('log', 'Trip log', () => this.showTripLog(true)),
          b('flag', 'Main menu', () => this.onMainMenu?.()),
        ),
      ),
    );
  }

  showPause(on: boolean, stats?: { distance: number; time: number; top: number; regions: string[]; seed: string; map: string }): void {
    this.pause.classList.toggle('show', on);
    if (on && stats) {
      const mph = getSettings().data.driving.units === 'mph';
      clear(this.pauseStats);
      const st = (k: string, v: string) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
      this.pauseStats.append(
        st('Distance', mph ? `${(stats.distance / 1609.34).toFixed(1)} mi` : `${(stats.distance / 1000).toFixed(1)} km`),
        st('Time', formatDuration(stats.time)),
        st('Top speed', `${Math.round(stats.top * (mph ? 2.23694 : 3.6))} ${mph ? 'mph' : 'km/h'}`),
      );
      this.pauseMeta.innerHTML = '';
      this.pauseMeta.append(`Seed ${stats.seed} · ${stats.map}`, h('br'), `Regions: ${stats.regions.join(' → ') || '—'}`);
    }
  }
  get pauseVisible(): boolean {
    return this.pause.classList.contains('show');
  }

  showSettings(on: boolean): void {
    if (on) this.settings.show('graphics');
    this.settings.el.classList.toggle('show', on);
  }
  get settingsVisible(): boolean {
    return this.settings.el.classList.contains('show');
  }

  // ----------------------------------------------------------------- help
  private helpGrid!: HTMLElement;
  private buildHelp(): HTMLElement {
    this.helpGrid = h('div', { class: 'help-grid' });
    const el = h(
      'div',
      { class: 'layer interactive' },
      h('div', { class: 'backdrop', onclick: () => this.showHelp(false) }),
      h('div', { class: 'panel help' }, h('div', { class: 'panel-head' }, h('h2', null, icon('keyboard'), 'Keyboard shortcuts'), h('button', { class: 'icon-btn', onclick: () => this.showHelp(false) }, icon('close'))), this.helpGrid),
    );
    this.refreshHelp();
    return el;
  }
  private refreshHelp(): void {
    if (!this.helpGrid) return;
    clear(this.helpGrid);
    const b = getSettings().data.controls.bindings;
    for (const a of Object.keys(ACTION_LABELS) as Action[]) {
      const keys = b[a].filter(Boolean).map(keyLabel);
      this.helpGrid.append(h('div', { class: 'item' }, h('span', null, ACTION_LABELS[a]), h('span', null, ...keys.map((k) => h('kbd', null, k)))));
    }
    this.helpGrid.append(h('div', { class: 'item' }, h('span', null, 'Photo: orbit / zoom / filter / save'), h('span', null, h('kbd', null, '←→↑↓'), h('kbd', null, 'Q/E'), h('kbd', null, 'F'), h('kbd', null, 'Enter'))));
    this.helpGrid.append(h('div', { class: 'item' }, h('span', null, 'iPad: pause without Esc'), h('span', null, h('kbd', null, '⌘ .'), h('kbd', null, '`'))));
  }
  showHelp(on: boolean): void {
    this.help.classList.toggle('show', on);
    if (!on) this.onHelpClose?.();
  }
  get helpVisible(): boolean {
    return this.help.classList.contains('show');
  }

  // -------------------------------------------------------------- trip log
  private tripList!: HTMLElement;
  private buildTripLog(): HTMLElement {
    this.tripList = h('div', { class: 'trip-list' });
    return h(
      'div',
      { class: 'layer interactive' },
      h('div', { class: 'backdrop', onclick: () => this.showTripLog(false) }),
      h('div', { class: 'panel triplog' }, h('div', { class: 'panel-head' }, h('h2', null, icon('log'), 'Trip log'), h('button', { class: 'icon-btn', onclick: () => this.showTripLog(false) }, icon('close'))), this.tripList),
    );
  }
  showTripLog(on: boolean): void {
    this.triplog.classList.toggle('show', on);
    if (!on) {
      this.onTripLogClose?.();
      return;
    }
    clear(this.tripList);
    const trips = saves.trips();
    if (!trips.length) {
      this.tripList.append(h('div', { class: 'empty' }, 'No journeys yet. The road is waiting.'));
      return;
    }
    const mph = getSettings().data.driving.units === 'mph';
    this.tripList.append(h('div', { class: 'trip head' }, h('span', null, 'Date · seed'), h('span', null, 'Region'), h('span', null, 'Distance'), h('span', null, 'Time'), h('span', null, 'Top speed')));
    for (const t of trips) {
      const d = new Date(t.date);
      this.tripList.append(
        h(
          'div',
          { class: 'trip' },
          h('span', null, `${d.toLocaleDateString()} · ${t.seed}`),
          h('span', null, t.map < 0 ? 'Auto journey' : BIOMES[t.map]?.name ?? '—'),
          h('span', null, mph ? `${(t.distance / 1609.34).toFixed(1)} mi` : `${(t.distance / 1000).toFixed(1)} km`),
          h('span', null, formatDuration(t.time)),
          h('span', null, `${Math.round(t.topSpeed * (mph ? 2.23694 : 3.6))} ${mph ? 'mph' : 'km/h'}`),
          h('span', { class: 'regions' }, t.regions.join(' → ')),
        ),
      );
    }
  }
  get tripLogVisible(): boolean {
    return this.triplog.classList.contains('show');
  }

  // ------------------------------------------------------------ photo mode
  private photoHint!: HTMLElement;
  private photoBar!: HTMLElement;
  private photoFadeTimer = 0;
  private buildPhoto(): HTMLElement {
    this.photoFilterSeg = h('div', { class: 'seg' });
    for (const f of PHOTO_FILTERS) {
      const b = h('button', { onclick: () => { this.onPhotoFilter?.(f); this.audio.ui('tick'); } }, f === 'none' ? 'Natural' : f[0].toUpperCase() + f.slice(1));
      b.dataset.f = f;
      this.photoFilterSeg.append(b);
    }
    this.photoHint = h('div', { class: 'photo-hint' }, 'Photo mode — drag or arrows to orbit · Q/E zoom · F filter · Enter save · P exit');
    this.photoBar = h(
      'div',
      { class: 'photo-bar interactive' },
      this.photoFilterSeg,
      h('button', { class: 'btn small primary', onclick: () => this.onPhotoSave?.() }, icon('camera'), 'Save'),
      h('button', { class: 'icon-btn', onclick: () => this.onPhotoExit?.() }, icon('close')),
    );
    return h('div', { class: 'layer' }, this.photoHint, this.photoBar);
  }
  showPhoto(on: boolean, filter: PhotoFilter = 'none'): void {
    this.photo.classList.toggle('show', on);
    this.titleEl.style.visibility = on ? 'hidden' : '';
    if (on) this.toastEl.classList.remove('show');
    this.setPhotoFilter(filter);
    this.photoActivity();
  }
  setPhotoFilter(f: PhotoFilter): void {
    for (const b of this.photoFilterSeg.children) (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.f === f);
  }
  /** Fade the photo UI away after a moment of inactivity for clean shots. */
  photoActivity(): void {
    this.photoHint.classList.remove('faded');
    this.photoBar.classList.remove('faded');
    clearTimeout(this.photoFadeTimer);
    this.photoFadeTimer = window.setTimeout(() => {
      this.photoHint.classList.add('faded');
      this.photoBar.classList.add('faded');
    }, 3500);
  }
  /** Hide everything for a screenshot frame. */
  photoChrome(visible: boolean): void {
    this.photo.style.visibility = visible ? '' : 'hidden';
  }

  // ---------------------------------------------------------------- touch
  private buildTouch(): HTMLElement {
    const mk = (cls: string, label: string | HTMLElement, action: Action) => {
      const b = h('div', { class: 'tbtn ' + cls }, label);
      const on = (e: PointerEvent) => {
        e.preventDefault();
        b.classList.add('active');
        b.setPointerCapture(e.pointerId);
        this.input.setVirtual(action, true);
      };
      const off = (e: PointerEvent) => {
        e.preventDefault();
        b.classList.remove('active');
        this.input.setVirtual(action, false);
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('lostpointercapture', off);
      return b;
    };
    return h(
      'div',
      { class: 'touch' },
      mk('left', '◀', 'left'),
      mk('right', '▶', 'right'),
      mk('gas', 'GO', 'accelerate'),
      mk('brk', 'BRAKE', 'brake'),
      mk('menu', icon('pause'), 'pause'),
      mk('cam', icon('camera'), 'camera'),
    );
  }
  private touchWanted = false;
  setTouchContext(driving: boolean): void {
    this.touchWanted = driving;
    this.updateTouchVisibility();
  }
  private updateTouchVisibility(): void {
    const mode = getSettings().data.controls.touchControls;
    const show = this.touchWanted && (mode === 'on' || (mode === 'auto' && isTouchDevice() && !this.input.keyboardSeen));
    this.touch.classList.toggle('show', show);
  }
}

export function toggleFullscreen(): void {
  const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (document.fullscreenElement || d.webkitFullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen();
      else d.webkitExitFullscreen?.();
    } else if (el.requestFullscreen) {
      void el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
        const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        o.lock?.('landscape').catch(() => {});
      }).catch(() => {});
    } else el.webkitRequestFullscreen?.();
  } catch {
    /* not supported (iPhone Safari) – Add to Home Screen gives full screen instead */
  }
}
