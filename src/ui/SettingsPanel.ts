/**
 * Settings panel: tabs generated from a declarative schema. Every control
 * writes straight to the settings store (which persists and broadcasts), so
 * changes apply live. Includes full key rebinding.
 */
import { h, clear, icon } from './dom';
import {
  getSettings,
  ACTION_LABELS,
  type Action,
  type Section,
  type Settings,
  CAMERA_MODES,
  WEATHERS,
  SEASONS,
} from '../core/Settings';
import { CARS } from '../vehicle/Cars';
import { keyLabel, type Input } from '../core/Input';

type Opt = [string | number, string];
type Item =
  | { t: 'group'; label: string }
  | { t: 'seg' | 'select'; s: Section; k: string; label: string; opts: Opt[]; note?: string }
  | { t: 'toggle'; s: Section; k: string; label: string; note?: string }
  | { t: 'range'; s: Section; k: string; label: string; min: number; max: number; step: number; fmt?: (v: number) => string; note?: string }
  | { t: 'button'; label: string; text: string; action: string; note?: string }
  | { t: 'keys' };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const hour = (v: number) => {
  const hh = Math.floor(v) % 24;
  const mm = Math.floor((v % 1) * 60);
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
};

const TABS: { id: string; label: string; items: Item[] }[] = [
  {
    id: 'graphics',
    label: 'Graphics',
    items: [
      { t: 'seg', s: 'graphics', k: 'preset', label: 'Quality preset', opts: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']] },
      { t: 'group', label: 'Display' },
      { t: 'range', s: 'graphics', k: 'resolutionScale', label: 'Resolution scale', min: 0.5, max: 1.5, step: 0.05, fmt: pct, note: 'Relative to your screen (capped at 2× pixel density).' },
      { t: 'toggle', s: 'graphics', k: 'dynamicResolution', label: 'Dynamic resolution', note: 'Lowers resolution briefly to hold the frame rate.' },
      { t: 'seg', s: 'graphics', k: 'antialias', label: 'Anti-aliasing', opts: [['off', 'Off'], ['fxaa', 'FXAA'], ['msaa', 'MSAA']], note: 'MSAA applies after reloading.' },
      { t: 'seg', s: 'graphics', k: 'fpsCap', label: 'Frame-rate cap', opts: [[30, '30'], [45, '45'], [60, '60'], [120, '120'], [0, 'Off']] },
      { t: 'toggle', s: 'graphics', k: 'showFps', label: 'FPS counter' },
      { t: 'group', label: 'World' },
      { t: 'range', s: 'graphics', k: 'renderDistance', label: 'Render distance', min: 300, max: 2500, step: 50, fmt: (v) => `${(v / 1000).toFixed(2)} km` },
      { t: 'range', s: 'graphics', k: 'treeDensity', label: 'Tree density', min: 0, max: 1, step: 0.05, fmt: pct },
      { t: 'range', s: 'graphics', k: 'grassDensity', label: 'Grass density', min: 0, max: 1, step: 0.05, fmt: pct },
      { t: 'seg', s: 'graphics', k: 'shadows', label: 'Shadows', opts: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
      { t: 'toggle', s: 'graphics', k: 'waterReflections', label: 'Water reflections' },
      { t: 'group', label: 'Post-processing' },
      { t: 'toggle', s: 'graphics', k: 'bloom', label: 'Bloom' },
      { t: 'toggle', s: 'graphics', k: 'vignette', label: 'Vignette' },
      { t: 'toggle', s: 'graphics', k: 'dof', label: 'Depth of field' },
      { t: 'toggle', s: 'graphics', k: 'colorGrading', label: 'Colour grading' },
      { t: 'toggle', s: 'graphics', k: 'filmGrain', label: 'Film grain' },
    ],
  },
  {
    id: 'camera',
    label: 'Camera',
    items: [
      { t: 'seg', s: 'camera', k: 'mode', label: 'Camera', opts: CAMERA_MODES.map((m) => [m, { chase: 'Chase', far: 'Far chase', hood: 'Hood', cockpit: 'Cockpit', bumper: 'Bumper', orbit: 'Free orbit' }[m]] as Opt) },
      { t: 'range', s: 'camera', k: 'fov', label: 'Field of view', min: 45, max: 95, step: 1, fmt: (v) => `${v}°` },
      { t: 'toggle', s: 'camera', k: 'speedFov', label: 'Widen FOV with speed' },
      { t: 'range', s: 'camera', k: 'smoothing', label: 'Camera smoothing', min: 0, max: 1, step: 0.05, fmt: pct },
      { t: 'range', s: 'camera', k: 'sway', label: 'Camera sway', min: 0, max: 1, step: 0.05, fmt: pct },
      { t: 'button', label: 'Photo mode', text: 'Open photo mode', action: 'photo', note: 'Hides the UI, freezes the car. Drag or use arrows to orbit, Q/E to zoom, F for filters, Enter to save.' },
    ],
  },
  {
    id: 'world',
    label: 'Time & weather',
    items: [
      { t: 'range', s: 'world', k: 'timeOfDay', label: 'Time of day', min: 0, max: 24, step: 0.05, fmt: hour },
      { t: 'toggle', s: 'world', k: 'dayNightCycle', label: 'Day / night cycle' },
      { t: 'range', s: 'world', k: 'cycleMinutes', label: 'Day length', min: 4, max: 120, step: 1, fmt: (v) => `${v} min` },
      { t: 'seg', s: 'world', k: 'weather', label: 'Weather', opts: WEATHERS.map((w) => [w, { clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', fog: 'Fog', rain: 'Rain', snow: 'Snow', storm: 'Storm' }[w]] as Opt) },
      { t: 'range', s: 'world', k: 'cloudDensity', label: 'Cloud density', min: 0, max: 1, step: 0.05, fmt: pct },
      { t: 'range', s: 'world', k: 'windStrength', label: 'Wind strength', min: 0, max: 1, step: 0.05, fmt: pct },
      { t: 'seg', s: 'world', k: 'season', label: 'Season', opts: SEASONS.map((s) => [s, s[0].toUpperCase() + s.slice(1)] as Opt) },
    ],
  },
  {
    id: 'driving',
    label: 'Driving',
    items: [
      { t: 'select', s: 'driving', k: 'car', label: 'Car', opts: CARS.map((c) => [c.id, c.name] as Opt), note: '' },
      { t: 'seg', s: 'driving', k: 'transmission', label: 'Transmission', opts: [['auto', 'Automatic'], ['manual', 'Manual (Q / E)']] },
      { t: 'range', s: 'driving', k: 'steeringSensitivity', label: 'Steering sensitivity', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
      { t: 'range', s: 'driving', k: 'steeringAssist', label: 'Steering assist', min: 0, max: 1, step: 0.05, fmt: pct, note: 'Gently counter-steers when the car slides.' },
      { t: 'toggle', s: 'driving', k: 'autoDrive', label: 'Lane-keeping auto-drive', note: 'The car steers itself and slows for corners. Any steering input takes over.' },
      { t: 'toggle', s: 'driving', k: 'cruiseControl', label: 'Cruise control', note: 'Holds the current speed. Hold accelerate to raise it, brake to cancel.' },
      { t: 'seg', s: 'driving', k: 'units', label: 'Speed units', opts: [['kmh', 'km/h'], ['mph', 'mph']] },
      { t: 'seg', s: 'driving', k: 'headlights', label: 'Headlights', opts: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']] },
      { t: 'seg', s: 'driving', k: 'wipers', label: 'Wipers', opts: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']] },
    ],
  },
  {
    id: 'road',
    label: 'Road',
    items: [
      { t: 'toggle', s: 'road', k: 'laneMarkings', label: 'Lane markings' },
      { t: 'toggle', s: 'road', k: 'guardrails', label: 'Guardrails' },
      { t: 'group', label: 'Route shape · applies to new journeys' },
      { t: 'range', s: 'road', k: 'curvature', label: 'Road curvature', min: 0.2, max: 2, step: 0.05, fmt: pct },
      { t: 'range', s: 'road', k: 'hilliness', label: 'Hilliness', min: 0.2, max: 2, step: 0.05, fmt: pct },
      { t: 'seg', s: 'road', k: 'width', label: 'Road width', opts: [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']] },
      { t: 'range', s: 'road', k: 'tunnelsBridges', label: 'Tunnels & bridges', min: 0, max: 2, step: 0.1, fmt: pct },
      { t: 'button', label: 'Apply now', text: 'Restart journey with these', action: 'regen' },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    items: [
      { t: 'range', s: 'audio', k: 'master', label: 'Master', min: 0, max: 1, step: 0.01, fmt: pct },
      { t: 'range', s: 'audio', k: 'engine', label: 'Engine & tyres', min: 0, max: 1, step: 0.01, fmt: pct },
      { t: 'range', s: 'audio', k: 'ambient', label: 'Ambience', min: 0, max: 1, step: 0.01, fmt: pct },
      { t: 'range', s: 'audio', k: 'music', label: 'Music', min: 0, max: 1, step: 0.01, fmt: pct },
      { t: 'range', s: 'audio', k: 'ui', label: 'Interface', min: 0, max: 1, step: 0.01, fmt: pct },
      { t: 'seg', s: 'audio', k: 'radio', label: 'Radio', opts: [['off', 'Off'], ['lofi', 'Lucerne Lo-Fi'], ['alpine', 'Alpenglühn Ambient']], note: 'Generated live, never repeats exactly.' },
      { t: 'toggle', s: 'audio', k: 'muted', label: 'Mute all' },
    ],
  },
  {
    id: 'controls',
    label: 'Controls',
    items: [
      { t: 'seg', s: 'controls', k: 'touchControls', label: 'On-screen touch controls', opts: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], note: 'Auto shows them on touch screens until a keyboard is used.' },
      { t: 'group', label: 'Key bindings · click, then press a key (Esc clears)' },
      { t: 'keys' },
      { t: 'button', label: 'Bindings', text: 'Reset key bindings', action: 'resetKeys' },
    ],
  },
  {
    id: 'general',
    label: 'General',
    items: [
      { t: 'toggle', s: 'general', k: 'lowBattery', label: 'Low Battery Mode', note: '30 FPS, lower resolution, no shadows or post-processing, shorter draw distance with soft fog. Key: B.' },
      { t: 'toggle', s: 'general', k: 'batterySuggest', label: 'Suggest Low Battery Mode', note: 'Uses the Battery Status API where supported, otherwise watches for sustained slow frames.' },
      { t: 'toggle', s: 'general', k: 'hudAutoHide', label: 'Fade HUD when idle' },
      { t: 'toggle', s: 'general', k: 'titleCards', label: 'Region title cards' },
      { t: 'toggle', s: 'general', k: 'showCompass', label: 'Compass' },
      { t: 'group', label: 'Data' },
      { t: 'button', label: 'Fullscreen', text: 'Toggle fullscreen', action: 'fullscreen' },
      { t: 'button', label: 'Trip log', text: 'Clear trip log', action: 'clearTrips' },
      { t: 'button', label: 'Everything', text: 'Reset all settings', action: 'resetAll', note: 'Restores defaults. Your trip log is kept.' },
    ],
  },
];

export class SettingsPanel {
  readonly el: HTMLElement;
  private pane: HTMLElement;
  private tabBtns = new Map<string, HTMLButtonElement>();
  private current = 'graphics';
  private refreshers: (() => void)[] = [];
  onAction: ((a: string) => void) | null = null;
  onClose: (() => void) | null = null;
  private foot: HTMLElement;

  constructor(
    private input: Input,
    private uiSound: (k: 'click' | 'tick' | 'toggle') => void,
  ) {
    const tabs = h('div', { class: 'tabs' });
    for (const t of TABS) {
      const b = h('button', { class: 'tab', onclick: () => this.show(t.id) }, t.label);
      this.tabBtns.set(t.id, b);
      tabs.append(b);
    }
    this.pane = h('div', { class: 'tab-pane' });
    this.foot = h('div', { class: 'settings-foot' });
    this.el = h(
      'div',
      { class: 'layer interactive' },
      h('div', { class: 'backdrop', onclick: () => this.onClose?.() }),
      h(
        'div',
        { class: 'panel settings' },
        h('div', { class: 'panel-head' }, h('h2', null, icon('gear'), 'Settings'), h('button', { class: 'icon-btn', onclick: () => this.onClose?.(), 'aria-label': 'Close' }, icon('close'))),
        h('div', { class: 'settings-body' }, tabs, this.pane),
        this.foot,
      ),
    );
    getSettings().onChange(() => this.refresh());
    getSettings().events.on('reset', () => this.show(this.current));
  }

  setFooter(text: string): void {
    this.foot.textContent = text;
  }

  show(id: string): void {
    this.current = id;
    for (const [k, b] of this.tabBtns) b.classList.toggle('on', k === id);
    clear(this.pane);
    this.refreshers = [];
    const tab = TABS.find((t) => t.id === id)!;
    for (const it of tab.items) this.pane.append(this.build(it));
    this.pane.scrollTop = 0;
  }

  private refresh(): void {
    for (const r of this.refreshers) r();
  }

  private row(label: string, note: string | undefined, ctl: HTMLElement): HTMLElement {
    return h('div', { class: 'row' }, h('div', null, h('div', { class: 'lbl' }, label), note ? h('div', { class: 'note' }, note) : null), h('div', { class: 'ctl' }, ctl));
  }

  private build(it: Item): HTMLElement {
    const st = getSettings();
    const get = (s: Section, k: string) => (st.data[s] as unknown as Record<string, unknown>)[k];
    const set = (s: Section, k: string, v: unknown) => {
      if (s === 'graphics' && k === 'preset') {
        if (v !== 'custom') st.applyPreset(v as 'low');
        return;
      }
      st.set(s, k as never, v as never);
    };
    switch (it.t) {
      case 'group':
        return h('div', { class: 'group-title' }, it.label);
      case 'seg':
      case 'select': {
        const seg = h('div', { class: 'seg' });
        const btns: [Opt, HTMLButtonElement][] = [];
        for (const o of it.opts) {
          const b = h('button', {
            onclick: () => {
              set(it.s, it.k, o[0]);
              this.uiSound('tick');
            },
          }, o[1]);
          btns.push([o, b]);
          seg.append(b);
        }
        const upd = () => {
          const v = get(it.s, it.k);
          for (const [o, b] of btns) b.classList.toggle('on', o[0] === v);
        };
        upd();
        this.refreshers.push(upd);
        const note = it.note;
        if (it.s === 'driving' && it.k === 'car') {
          const n = h('div', { class: 'note' });
          const updN = () => (n.textContent = CARS.find((c) => c.id === get('driving', 'car'))?.blurb ?? '');
          updN();
          this.refreshers.push(updN);
          const r = this.row(it.label, undefined, seg);
          r.firstElementChild!.append(n);
          return r;
        }
        return this.row(it.label, note, seg);
      }
      case 'toggle': {
        const b = h('button', {
          class: 'switch',
          role: 'switch',
          onclick: () => {
            set(it.s, it.k, !get(it.s, it.k));
            this.uiSound('toggle');
          },
        });
        const upd = () => {
          const on = !!get(it.s, it.k);
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        };
        upd();
        this.refreshers.push(upd);
        return this.row(it.label, it.note, b);
      }
      case 'range': {
        const r = h('input', { type: 'range', min: it.min, max: it.max, step: it.step }) as HTMLInputElement;
        const val = h('span', { class: 'range-val' });
        const fmt = it.fmt ?? ((v: number) => String(v));
        const upd = () => {
          const v = Number(get(it.s, it.k));
          if (document.activeElement !== r) r.value = String(v);
          val.textContent = fmt(v);
        };
        r.addEventListener('input', () => {
          set(it.s, it.k, Number(r.value));
          val.textContent = fmt(Number(r.value));
        });
        r.addEventListener('change', () => r.blur());
        upd();
        this.refreshers.push(upd);
        const wrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, r, val);
        return this.row(it.label, it.note, wrap);
      }
      case 'button':
        return this.row(it.label, it.note, h('button', { class: 'btn small', onclick: () => { this.uiSound('click'); this.onAction?.(it.action); } }, it.text));
      case 'keys': {
        const wrap = h('div');
        for (const a of Object.keys(ACTION_LABELS) as Action[]) {
          const btns: HTMLButtonElement[] = [];
          for (let slot = 0; slot < 2; slot++) {
            const b = h('button', { class: 'keybind' }) as HTMLButtonElement;
            const upd = () => (b.textContent = keyLabel(st.data.controls.bindings[a][slot] ?? ''));
            upd();
            this.refreshers.push(upd);
            b.addEventListener('click', () => {
              b.classList.add('listening');
              b.textContent = 'Press a key…';
              this.input.captureNext((code) => {
                b.classList.remove('listening');
                const next = { ...st.data.controls.bindings } as Settings['controls']['bindings'];
                for (const k of Object.keys(next) as Action[]) next[k] = next[k].slice();
                // remove this key from any other action to avoid conflicts
                if (code) for (const k of Object.keys(next) as Action[]) next[k] = next[k].map((c) => (c === code ? '' : c));
                const arr = next[a].slice(0, 2);
                while (arr.length < 2) arr.push('');
                arr[slot] = code;
                next[a] = arr;
                st.set('controls', 'bindings', next);
                this.uiSound('tick');
              });
            });
            btns.push(b);
          }
          wrap.append(this.row(ACTION_LABELS[a], undefined, h('div', { style: { display: 'flex', gap: '6px' } }, ...btns)));
        }
        return wrap;
      }
    }
  }
}
