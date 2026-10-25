/**
 * Central, typed settings store.
 *
 * Every user-facing option lives here with its default. Changes are persisted
 * to localStorage immediately and broadcast to listeners so systems can react
 * live (no "apply" button needed).
 */
import { Emitter } from './Events';
import { storage } from './Save';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';
export type AntiAlias = 'off' | 'fxaa' | 'msaa';
export type CameraMode = 'chase' | 'far' | 'hood' | 'cockpit' | 'bumper' | 'orbit';
export type Weather = 'clear' | 'partly' | 'overcast' | 'fog' | 'rain' | 'snow' | 'storm';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Units = 'kmh' | 'mph';
export type Tri = 'auto' | 'on' | 'off';
export type RoadWidth = 'narrow' | 'normal' | 'wide';
export type RadioStation = 'off' | 'lofi' | 'alpine';

export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'hood', 'cockpit', 'bumper', 'orbit'];
export const WEATHERS: Weather[] = ['clear', 'partly', 'overcast', 'fog', 'rain', 'snow', 'storm'];
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

/** Every bindable action. */
export type Action =
  | 'accelerate'
  | 'brake'
  | 'left'
  | 'right'
  | 'handbrake'
  | 'boost'
  | 'shiftUp'
  | 'shiftDown'
  | 'camera'
  | 'headlights'
  | 'reset'
  | 'photo'
  | 'lowBattery'
  | 'mute'
  | 'pause'
  | 'settings'
  | 'help'
  | 'cruise'
  | 'autoDrive'
  | 'radio'
  | 'hideHud'
  | 'fullscreen'
  | 'map1'
  | 'map2'
  | 'map3'
  | 'map4'
  | 'map5'
  | 'map6'
  | 'map7'
  | 'map8';

export const ACTION_LABELS: Record<Action, string> = {
  accelerate: 'Accelerate',
  brake: 'Brake / reverse',
  left: 'Steer left',
  right: 'Steer right',
  handbrake: 'Handbrake',
  boost: 'Boost',
  shiftUp: 'Shift up (manual)',
  shiftDown: 'Shift down (manual)',
  camera: 'Cycle camera',
  headlights: 'Headlights',
  reset: 'Reset car on road',
  photo: 'Photo mode',
  lowBattery: 'Low Battery Mode',
  mute: 'Mute',
  pause: 'Pause / menu',
  settings: 'Settings',
  help: 'Keyboard shortcuts',
  cruise: 'Cruise control',
  autoDrive: 'Lane-keeping auto-drive',
  radio: 'Next radio station',
  hideHud: 'Hide HUD',
  fullscreen: 'Fullscreen',
  map1: 'Jump to Mittelland',
  map2: 'Jump to Alpine Pass',
  map3: 'Jump to Lake District',
  map4: 'Jump to Ticino',
  map5: 'Jump to Engadin',
  map6: 'Jump to Jura',
  map7: 'Jump to Valais',
  map8: 'Jump to Zurich Outskirts',
};

/** Default key bindings, using KeyboardEvent.code (layout independent). */
export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  accelerate: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  shiftUp: ['KeyE'],
  shiftDown: ['KeyQ'],
  camera: ['KeyC'],
  headlights: ['KeyH'],
  reset: ['KeyR'],
  photo: ['KeyP'],
  lowBattery: ['KeyB'],
  mute: ['KeyM'],
  // The iPad Magic Keyboard has no Escape key, so the backtick key (and Cmd+.) also pauses.
  pause: ['Escape', 'Backquote'],
  settings: ['Tab'],
  help: ['Slash'],
  cruise: ['KeyK'],
  autoDrive: ['KeyL'],
  radio: ['KeyN'],
  hideHud: ['KeyU'],
  fullscreen: ['KeyF'],
  map1: ['Digit1'],
  map2: ['Digit2'],
  map3: ['Digit3'],
  map4: ['Digit4'],
  map5: ['Digit5'],
  map6: ['Digit6'],
  map7: ['Digit7'],
  map8: ['Digit8'],
};

export interface GraphicsSettings {
  preset: QualityPreset;
  renderDistance: number; // metres
  shadows: ShadowQuality;
  antialias: AntiAlias; // msaa requires reload
  resolutionScale: number; // multiplier of device pixel ratio (capped)
  dynamicResolution: boolean;
  bloom: boolean;
  vignette: boolean;
  dof: boolean;
  colorGrading: boolean;
  filmGrain: boolean;
  waterReflections: boolean;
  grassDensity: number; // 0..1
  treeDensity: number; // 0..1
  fpsCap: number; // 0 = uncapped (display rate)
  showFps: boolean;
}

export interface Settings {
  graphics: GraphicsSettings;
  camera: {
    mode: CameraMode;
    fov: number;
    smoothing: number; // 0..1
    sway: number; // 0..1
    speedFov: boolean;
  };
  world: {
    timeOfDay: number; // hours 0..24
    dayNightCycle: boolean;
    cycleMinutes: number; // real minutes per in-game day
    weather: Weather;
    cloudDensity: number; // 0..1
    windStrength: number; // 0..1
    season: Season;
  };
  driving: {
    car: string;
    transmission: 'auto' | 'manual';
    steeringSensitivity: number; // 0.5..1.5
    steeringAssist: number; // 0..1
    autoDrive: boolean;
    cruiseControl: boolean;
    units: Units;
    headlights: Tri;
    wipers: Tri;
  };
  road: {
    laneMarkings: boolean;
    curvature: number; // 0..2
    hilliness: number; // 0..2
    width: RoadWidth;
    guardrails: boolean;
    tunnelsBridges: number; // 0..2
  };
  audio: {
    master: number;
    music: number;
    engine: number;
    ambient: number;
    ui: number;
    radio: RadioStation;
    muted: boolean;
  };
  controls: {
    bindings: Record<Action, string[]>;
    touchControls: Tri;
  };
  general: {
    lowBattery: boolean;
    batterySuggest: boolean;
    hudAutoHide: boolean;
    titleCards: boolean;
    showCompass: boolean;
  };
}

export type Section = keyof Settings;

export function defaultSettings(): Settings {
  const ipad = isTouchDevice();
  return {
    graphics: { ...QUALITY_PRESETS[ipad ? 'medium' : 'high'], preset: ipad ? 'medium' : 'high', fpsCap: 60, showFps: false, dynamicResolution: ipad },
    camera: { mode: 'chase', fov: 62, smoothing: 0.6, sway: 0.5, speedFov: true },
    world: { timeOfDay: 16.5, dayNightCycle: true, cycleMinutes: 24, weather: 'partly', cloudDensity: 0.45, windStrength: 0.35, season: 'summer' },
    driving: {
      car: 'hatch',
      transmission: 'auto',
      steeringSensitivity: 1,
      steeringAssist: 0.5,
      autoDrive: false,
      cruiseControl: false,
      units: 'kmh',
      headlights: 'auto',
      wipers: 'auto',
    },
    road: { laneMarkings: true, curvature: 1, hilliness: 1, width: 'normal', guardrails: true, tunnelsBridges: 1 },
    audio: { master: 0.8, music: 0.5, engine: 0.7, ambient: 0.7, ui: 0.5, radio: 'alpine', muted: false },
    controls: { bindings: cloneBindings(DEFAULT_BINDINGS), touchControls: 'auto' },
    general: { lowBattery: false, batterySuggest: true, hudAutoHide: true, titleCards: true, showCompass: true },
  };
}

type PresetValues = Omit<GraphicsSettings, 'preset' | 'fpsCap' | 'showFps' | 'dynamicResolution'>;

/** Graphics presets. "custom" is set automatically when a single value is changed. */
export const QUALITY_PRESETS: Record<Exclude<QualityPreset, 'custom'>, PresetValues> = {
  low: {
    renderDistance: 600,
    shadows: 'off',
    antialias: 'fxaa',
    resolutionScale: 0.6,
    bloom: false,
    vignette: true,
    dof: false,
    colorGrading: true,
    filmGrain: false,
    waterReflections: false,
    grassDensity: 0.2,
    treeDensity: 0.5,
  },
  medium: {
    renderDistance: 950,
    shadows: 'low',
    antialias: 'fxaa',
    resolutionScale: 0.75,
    bloom: true,
    vignette: true,
    dof: false,
    colorGrading: true,
    filmGrain: false,
    waterReflections: false,
    grassDensity: 0.45,
    treeDensity: 0.75,
  },
  high: {
    renderDistance: 1400,
    shadows: 'medium',
    antialias: 'msaa',
    resolutionScale: 1,
    bloom: true,
    vignette: true,
    dof: false,
    colorGrading: true,
    filmGrain: true,
    waterReflections: true,
    grassDensity: 0.7,
    treeDensity: 1,
  },
  ultra: {
    renderDistance: 2000,
    shadows: 'high',
    antialias: 'msaa',
    resolutionScale: 1.25,
    bloom: true,
    vignette: true,
    dof: true,
    colorGrading: true,
    filmGrain: true,
    waterReflections: true,
    grassDensity: 1,
    treeDensity: 1,
  },
};

function cloneBindings(b: Record<Action, string[]>): Record<Action, string[]> {
  const out = {} as Record<Action, string[]>;
  for (const k of Object.keys(b) as Action[]) out[k] = b[k].slice();
  return out;
}

export function isTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  // iPadOS reports itself as "Macintosh" but has touch points.
  return navigator.maxTouchPoints > 1 || 'ontouchstart' in window;
}

const KEY = 'settings.v1';

interface SettingsEvents extends Record<string, unknown> {
  change: { section: Section; key: string; value: unknown };
  reset: Settings;
}

/** The live settings store (singleton, see `settings` export). */
export class SettingsStore {
  data: Settings;
  readonly events = new Emitter<SettingsEvents>();

  constructor() {
    this.data = defaultSettings();
    const saved = storage.get<Partial<Settings>>(KEY);
    if (saved) this.merge(saved);
  }

  /** Deep-merge saved values over defaults so new options get sane defaults. */
  private merge(saved: Partial<Settings>): void {
    for (const section of Object.keys(this.data) as Section[]) {
      const src = saved[section] as Record<string, unknown> | undefined;
      if (!src || typeof src !== 'object') continue;
      const dst = this.data[section] as unknown as Record<string, unknown>;
      for (const k of Object.keys(dst)) {
        if (!(k in src)) continue;
        if (k === 'bindings') {
          const b = src[k] as Record<string, string[]>;
          const db = dst[k] as Record<string, string[]>;
          for (const a of Object.keys(db)) if (Array.isArray(b[a])) db[a] = b[a].slice(0, 2);
        } else if (typeof src[k] === typeof dst[k]) {
          dst[k] = src[k];
        }
      }
    }
  }

  get<S extends Section, K extends keyof Settings[S]>(section: S, key: K): Settings[S][K] {
    return this.data[section][key];
  }

  set<S extends Section, K extends keyof Settings[S]>(section: S, key: K, value: Settings[S][K]): void {
    if (this.data[section][key] === value && typeof value !== 'object') return;
    this.data[section][key] = value;
    // Touching any graphics value (other than these meta ones) makes the preset "custom".
    if (section === 'graphics' && key !== 'preset' && key !== 'fpsCap' && key !== 'showFps' && key !== 'dynamicResolution') {
      if (this.data.graphics.preset !== 'custom' && !this.applyingPreset) {
        this.data.graphics.preset = 'custom';
        this.events.emit('change', { section: 'graphics', key: 'preset', value: 'custom' });
      }
    }
    this.save();
    this.events.emit('change', { section, key: key as string, value });
  }

  private applyingPreset = false;

  applyPreset(p: Exclude<QualityPreset, 'custom'>): void {
    this.applyingPreset = true;
    const values = QUALITY_PRESETS[p];
    for (const k of Object.keys(values) as (keyof PresetValues)[]) {
      this.set('graphics', k, values[k] as never);
    }
    this.applyingPreset = false;
    this.set('graphics', 'preset', p);
  }

  onChange(fn: (section: Section, key: string, value: unknown) => void): () => void {
    return this.events.on('change', (e) => fn(e.section, e.key, e.value));
  }

  save(): void {
    storage.set(KEY, this.data);
  }

  resetAll(): void {
    this.data = defaultSettings();
    this.save();
    this.events.emit('reset', this.data);
  }

  resetBindings(): void {
    this.data.controls.bindings = cloneBindings(DEFAULT_BINDINGS);
    this.save();
    this.events.emit('change', { section: 'controls', key: 'bindings', value: this.data.controls.bindings });
  }
}

let instance: SettingsStore | null = null;
export function getSettings(): SettingsStore {
  if (!instance) instance = new SettingsStore();
  return instance;
}
