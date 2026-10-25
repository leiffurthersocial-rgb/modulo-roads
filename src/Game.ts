/**
 * Game orchestrator: owns the engine, world, car, camera, audio, UI and
 * quality systems and runs the per-frame update. States:
 *   menu    – start screen over a live "attract mode" drive
 *   loading – generating a new journey
 *   driving – normal play
 *   paused  – blurred pause menu (world frozen)
 *   photo   – photo mode (car frozen, free orbit, filters)
 */
import * as THREE from 'three';
import { Engine, type FrameInfo } from './core/Engine';
import { Input } from './core/Input';
import { getSettings, CAMERA_MODES, type Action, type Section, isTouchDevice } from './core/Settings';
import { saves, type JourneySave } from './core/Save';
import { World, type WorldOptions, type Ground } from './world/World';
import { BIOMES, BIOME_COUNT } from './world/Biomes';
import { F_BRIDGE, F_TUNNEL, DS } from './world/Road';
import { installShaderChunks, Shared } from './world/Materials';
import { Vehicle, type DriveInput } from './vehicle/Vehicle';
import { carById } from './vehicle/Cars';
import { CameraRig } from './vehicle/CameraRig';
import { AudioEngine } from './audio/AudioEngine';
import { UI, randomSeed, toggleFullscreen } from './ui/UI';
import { PostFX, PHOTO_FILTERS, type PhotoFilter } from './perf/PostFX';
import { effectiveSettings, savingPercent, DynamicResolution, type Effective } from './perf/Quality';
import { BatteryWatcher } from './perf/LowBattery';
import { clamp, dampTo, lerp } from './core/math';

type State = 'menu' | 'loading' | 'driving' | 'paused' | 'photo';

const PHYS_DT = 1 / 120;

export class Game {
  readonly settings = getSettings();
  readonly input = new Input();
  readonly engine: Engine;
  readonly audio = new AudioEngine();
  readonly ui: UI;
  readonly post: PostFX;
  readonly rig: CameraRig;
  private battery = new BatteryWatcher();
  private dynres = new DynamicResolution();
  world: World | null = null;
  car: Vehicle | null = null;
  state: State = 'loading';
  private eff!: Effective;
  private hour = 16.5;
  private acc = 0;
  private drive: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
  private steerS = 0;
  private journey: JourneySave | null = null;
  private lastRegionKey = '';
  private saveT = 0;
  private tunnel = 0;
  private headlight: THREE.SpotLight;
  private headGlow: THREE.PointLight;
  private envT = 0;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envDome: THREE.Mesh | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private photoFilter: PhotoFilter = 'none';
  private hudHidden = false;
  private hudT = 0;
  private fadeT = 0;
  private regionName = '';
  private lastFrameMs = 16;
  private busy = false;
  private w = new Float32Array(BIOME_COUNT);
  private tmpV = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    installShaderChunks();
    const s = this.settings.data;
    this.engine = new Engine(canvas, s.graphics.antialias === 'msaa');
    this.ui = new UI(uiRoot, this.input, this.audio);
    this.post = new PostFX(this.engine.renderer, this.engine.scene, this.engine.camera);
    this.rig = new CameraRig(this.engine.camera, canvas);
    this.pmrem = new THREE.PMREMGenerator(this.engine.renderer);

    // headlights: a spot light that is always present (intensity animates),
    // so toggling lights never forces a shader recompile.
    this.headlight = new THREE.SpotLight(0xfff1d6, 0, 90, 0.52, 0.55, 1.4);
    this.headlight.castShadow = false;
    this.headGlow = new THREE.PointLight(0xfff1d6, 0, 9, 2);
    this.engine.scene.add(this.headlight, this.headlight.target, this.headGlow);

    this.hour = s.world.timeOfDay;
    this.wireUI();
    this.wireInput();
    this.settings.onChange((sec, key) => this.onSetting(sec, key));
    this.settings.events.on('reset', () => this.onSettingsReset());
    this.engine.onFrame = (f) => this.frame(f);
    this.engine.onResize = (w, h) => this.post.setSize(w, h);
    this.engine.onVisibility = (v) => {
      if (v) this.audio.resume();
      else {
        this.audio.suspend();
        this.saveJourney();
      }
    };
    window.addEventListener('pagehide', () => this.saveJourney());

    this.battery.onSuggest = (why) => {
      if (!this.settings.data.general.batterySuggest || this.settings.data.general.lowBattery) return;
      this.ui.toast(`${why} — switch to Low Battery Mode?`, [
        { label: 'Enable', primary: true, fn: () => this.settings.set('general', 'lowBattery', true) },
        { label: 'Not now', fn: () => {} },
      ]);
    };
    void this.battery.init();

    // unlock audio on the first gesture (iOS requires this)
    const unlock = () => {
      this.audio.unlock();
      this.applyAudio();
      this.audio.radio.ensureRunning();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('touchend', unlock, { passive: true });
    this.audio.radio.onTitle = (t, st) => this.ui.nowPlaying(t, st);

    this.applyQuality();
    this.applyCamera();
  }

  /** Boot: build an attract-mode world behind the start screen. */
  async boot(): Promise<void> {
    const save = saves.loadJourney();
    this.ui.showLoading(true, 0, 'Preparing the road');
    this.engine.run();
    const seed = save?.seed ?? randomSeed();
    const map = save?.map ?? -1;
    await this.buildWorld(seed, map, save ? save.distance : 0, true);
    if (save) this.hour = save.timeOfDay;
    this.state = 'menu';
    this.ui.showLoading(false);
    this.ui.showStart(true, save);
    this.ui.showHud(false);
    this.ui.setTouchContext(false);
    this.rig.mode = 'orbit';
    this.rig.orbitDist = 11;
    this.rig.orbitPitch = 0.18;
    if (this.car) {
      this.car.autoDrive = true;
      this.car.cruise = true;
      this.car.cruiseSpeed = 17;
    }
  }

  // ----------------------------------------------------------------- world
  private worldOptions(seed: string, map: number): WorldOptions {
    const s = this.settings.data;
    const e = this.eff;
    return {
      seed,
      map,
      curvature: s.road.curvature,
      hilliness: s.road.hilliness,
      tunnels: s.road.tunnelsBridges,
      roadWidth: s.road.width,
      season: s.world.season,
      renderDistance: e.renderDistance,
      treeDensity: e.treeDensity,
      grassDensity: e.grassDensity,
      guardrails: s.road.guardrails,
      laneMarkings: s.road.laneMarkings,
      shadows: e.shadows,
      waterReflections: e.waterReflections,
      lowBattery: e.lowBattery,
      cloudOctaves: e.cloudOctaves,
    };
  }

  private async buildWorld(seed: string, map: number, startS: number, attract = false): Promise<void> {
    this.busy = true;
    if (this.world) {
      if (this.car) this.engine.scene.remove(this.car.model.root);
      this.world.dispose();
      this.world = null;
    }
    const world = new World(this.engine.scene, this.worldOptions(seed, map));
    this.world = world;
    this.applyShadowSettings();
    await world.prepare(startS, (p) => this.ui.showLoading(true, p, p < 0.15 ? 'Surveying the route' : p < 0.85 ? 'Raising the mountains' : 'Planting the forests'));
    const def = carById(this.settings.data.driving.car);
    if (!this.car) this.car = new Vehicle(def, world);
    else {
      this.car.setWorld(world);
      if (this.car.def.id !== def.id) this.car.setCar(def);
    }
    this.engine.scene.add(this.car.model.root);
    this.car.placeAt(startS + 8, attract ? 14 : 0);
    this.applyDriving();
    this.rig.reset();
    this.lastRegionKey = '';
    this.envT = 0;
    this.busy = false;
  }

  async startJourney(seed: string, map: number, resume: JourneySave | null = null): Promise<void> {
    if (this.busy) return;
    this.saveJourney();
    this.state = 'loading';
    this.ui.showStart(false);
    this.ui.showPause(false);
    this.ui.showSettings(false);
    this.ui.showLoading(true, 0, 'Preparing the road');
    this.audio.ui('open');
    const startS = resume ? resume.distance : 0;
    const same = this.world && this.world.options.seed === seed && this.world.options.map === map && !this.routeOptionsChanged();
    if (same && resume) {
      // world already built around this spot (attract mode) – just take over
      this.ui.showLoading(true, 1);
    } else {
      await this.buildWorld(seed, map, startS);
    }
    const now = Date.now();
    this.journey = resume
      ? { ...resume }
      : { seed, map, distance: startS, odometer: 0, time: 0, topSpeed: 0, regions: [], timeOfDay: this.hour, startedAt: now };
    if (resume) this.hour = resume.timeOfDay;
    else if (map >= 0 && BIOMES[map].startHour !== undefined && this.settings.data.world.dayNightCycle) this.hour = BIOMES[map].startHour!;
    if (this.car) {
      if (!same || !resume) this.car.placeAt(startS + 8, 0);
      this.car.autoDrive = this.settings.data.driving.autoDrive;
      this.car.cruise = false;
    }
    this.applyCamera();
    this.rig.reset();
    this.lastRegionKey = '';
    this.state = 'driving';
    this.ui.showLoading(false);
    this.ui.showHud(true);
    this.ui.setTouchContext(true);
    this.engine.canvas.focus();
  }

  private routeOptionsChanged(): boolean {
    if (!this.world) return true;
    const o = this.world.options;
    const r = this.settings.data.road;
    return o.curvature !== r.curvature || o.hilliness !== r.hilliness || o.tunnels !== r.tunnelsBridges || o.roadWidth !== r.width;
  }

  private saveJourney(): void {
    if (!this.journey || !this.car || this.state === 'menu' || this.state === 'loading') return;
    this.journey.distance = this.car.roadS;
    this.journey.timeOfDay = this.hour;
    saves.saveJourney(this.journey);
    saves.logTrip(
      { date: this.journey.startedAt, seed: this.journey.seed, map: this.journey.map, distance: this.journey.odometer, time: this.journey.time, topSpeed: this.journey.topSpeed, regions: this.journey.regions },
      this.journey.startedAt,
    );
  }

  // ------------------------------------------------------------ settings
  private onSetting(sec: Section, key: string): void {
    if (sec === 'graphics' || (sec === 'general' && key === 'lowBattery')) {
      this.applyQuality();
      if (sec === 'general') {
        const on = this.settings.data.general.lowBattery;
        this.ui.toast(on ? `Low Battery Mode on · saves ~${savingPercent(this.settings.data, this.engine.msaa)}% power` : 'Low Battery Mode off');
      }
      if (key === 'antialias') this.ui.toast('Anti-aliasing changes fully apply after reloading.');
    }
    if (sec === 'camera') this.applyCamera();
    if (sec === 'world') {
      if (key === 'timeOfDay') this.hour = this.settings.data.world.timeOfDay;
      if (key === 'season') this.world?.applyOptions({ season: this.settings.data.world.season });
    }
    if (sec === 'driving') this.applyDriving(key);
    if (sec === 'road' && (key === 'laneMarkings' || key === 'guardrails')) {
      this.world?.applyOptions({ laneMarkings: this.settings.data.road.laneMarkings, guardrails: this.settings.data.road.guardrails });
    }
    if (sec === 'audio') this.applyAudio();
  }

  private onSettingsReset(): void {
    this.input.rebuildMap();
    this.applyQuality();
    this.applyCamera();
    this.applyDriving('car');
    this.applyAudio();
    this.world?.applyOptions({ season: this.settings.data.world.season, laneMarkings: true, guardrails: true });
  }

  private applyQuality(): void {
    const s = this.settings.data;
    this.eff = effectiveSettings(s, s.general.lowBattery, this.engine.msaa);
    const e = this.eff;
    this.engine.fpsCap = e.fpsCap;
    if (!e.dynamicResolution) this.dynres.scale = 1;
    this.engine.setPixelRatio(e.pixelRatio * this.dynres.scale);
    this.post.configure({ bloom: e.bloom, dof: e.dof, grade: e.grade, vignette: e.vignette, grain: e.grain, fxaa: e.fxaa, msaa: e.msaa }, this.state === 'photo');
    const cam = this.engine.camera;
    cam.far = e.renderDistance * 1.25 + 900;
    cam.updateProjectionMatrix();
    this.audio.lowPower = e.lowBattery;
    if (this.world) {
      this.world.applyOptions({
        renderDistance: e.renderDistance,
        treeDensity: e.treeDensity,
        grassDensity: e.grassDensity,
        shadows: e.shadows,
        waterReflections: e.waterReflections,
        lowBattery: e.lowBattery,
        cloudOctaves: e.cloudOctaves,
      });
      this.applyShadowSettings();
    }
    this.ui.settings.setFooter(
      s.general.lowBattery
        ? `Low Battery Mode is active (saves ~${savingPercent(s, this.engine.msaa)}%) — some graphics options are overridden.`
        : 'Changes apply instantly and are saved on this device.',
    );
  }

  private applyShadowSettings(): void {
    if (!this.world) return;
    const e = this.eff;
    const sun = this.world.atmos.sun;
    const cast = e.shadows !== 'off';
    sun.castShadow = cast;
    if (cast && sun.shadow.mapSize.x !== e.shadowMap) {
      sun.shadow.mapSize.set(e.shadowMap, e.shadowMap);
      sun.shadow.map?.dispose();
      sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.world.atmos.shadowRange = e.shadowRange;
    if (this.car) this.car.model.root.traverse((o) => ((o as THREE.Mesh).castShadow = cast && (o as THREE.Mesh).isMesh));
  }

  private applyCamera(): void {
    const c = this.settings.data.camera;
    if (this.state !== 'menu') this.rig.mode = c.mode;
    this.rig.baseFov = c.fov;
    this.rig.smoothing = c.smoothing;
    this.rig.sway = c.sway;
    this.rig.speedFov = c.speedFov;
  }

  private applyDriving(key?: string): void {
    const d = this.settings.data.driving;
    if (!this.car) return;
    if (key === 'car' && this.car.def.id !== d.car) {
      const root = this.car.setCar(carById(d.car));
      if (!root.parent) this.engine.scene.add(root);
      this.applyShadowSettings();
      this.ui.toast(this.car.def.name);
    }
    this.car.manual = d.transmission === 'manual';
    this.car.steeringSensitivity = d.steeringSensitivity;
    this.car.steeringAssist = d.steeringAssist;
    if (this.state !== 'menu') {
      if (key === 'autoDrive' || key === undefined) this.car.autoDrive = d.autoDrive;
      if (key === 'cruiseControl') {
        this.car.cruise = d.cruiseControl;
        this.car.cruiseSpeed = Math.max(8, this.car.speed);
      }
    }
  }

  private applyAudio(): void {
    const a = this.settings.data.audio;
    this.audio.setVolumes({ master: a.master, engine: a.engine, ambient: a.ambient, music: a.music, ui: a.ui, muted: a.muted });
    this.audio.radio.setStation(a.radio);
  }

  // ----------------------------------------------------------------- input
  private wireUI(): void {
    const ui = this.ui;
    ui.onStart = (seed, map) => void this.startJourney(seed, map);
    ui.onContinue = () => {
      const s = saves.loadJourney();
      if (s) void this.startJourney(s.seed, s.map, s);
    };
    ui.onResume = () => this.setPaused(false);
    ui.onMainMenu = () => this.toMenu();
    ui.onPhoto = () => this.setPhoto(true);
    ui.onPhotoExit = () => this.setPhoto(false);
    ui.onPhotoFilter = (f) => this.setFilter(f);
    ui.onPhotoSave = () => this.savePhoto();
    ui.onSettingsOpen = () => this.openSettings(true);
    ui.onSettingsClose = () => this.openSettings(false);
    ui.onLowBattery = () => this.settings.set('general', 'lowBattery', !this.settings.data.general.lowBattery);
    ui.settings.onAction = (a) => {
      switch (a) {
        case 'photo':
          this.openSettings(false);
          this.setPhoto(true);
          break;
        case 'regen':
          if (this.journey) void this.startJourney(this.journey.seed, this.journey.map);
          else if (this.world) void this.startJourney(this.world.options.seed, this.world.options.map);
          break;
        case 'resetKeys':
          this.settings.resetBindings();
          break;
        case 'resetAll':
          this.settings.resetAll();
          break;
        case 'clearTrips':
          saves.clearTrips();
          this.ui.toast('Trip log cleared');
          break;
        case 'fullscreen':
          toggleFullscreen();
          break;
      }
    };
  }

  private wireInput(): void {
    this.input.onAction((a, e) => this.onAction(a, e));
    // keys that are not bindable actions: Enter/digits on the start screen,
    // photo-mode filter & save
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type === 'text') {
        if (e.key === 'Enter' && this.state === 'menu') void this.startJourney(this.ui.seedValue, this.ui.mapSelection);
        return;
      }
      if (this.state === 'menu' && this.ui.startVisible) {
        if (e.key === 'Enter') void this.startJourney(this.ui.seedValue, this.ui.mapSelection);
        if (e.code === 'Digit0') this.ui.selectMap(-1);
      }
      if (this.state === 'photo') {
        if (e.code === 'KeyF') {
          const i = PHOTO_FILTERS.indexOf(this.photoFilter);
          this.setFilter(PHOTO_FILTERS[(i + 1) % PHOTO_FILTERS.length]);
        }
        if (e.key === 'Enter') this.savePhoto();
        this.ui.photoActivity();
      }
    });
  }

  private onAction(a: Action, _e: KeyboardEvent | null): void {
    const st = this.state;
    const s = this.settings;
    if (st === 'loading') return;
    // overlays first
    if (a === 'pause') {
      if (this.ui.settingsVisible) return this.openSettings(false);
      if (this.ui.helpVisible) return this.ui.showHelp(false);
      if (this.ui.tripLogVisible) return this.ui.showTripLog(false);
      if (st === 'photo') return this.setPhoto(false);
      if (st === 'driving') return this.setPaused(true);
      if (st === 'paused') return this.setPaused(false);
      return;
    }
    if (a === 'settings') return this.openSettings(!this.ui.settingsVisible);
    if (a === 'help') return this.ui.showHelp(!this.ui.helpVisible);
    if (a === 'lowBattery') return s.set('general', 'lowBattery', !s.data.general.lowBattery);
    if (a === 'mute') {
      s.set('audio', 'muted', !s.data.audio.muted);
      this.ui.toast(s.data.audio.muted ? 'Sound muted' : 'Sound on');
      return;
    }
    if (a === 'fullscreen') return toggleFullscreen();
    if (a === 'radio') {
      const order = ['off', 'lofi', 'alpine'] as const;
      const next = order[(order.indexOf(s.data.audio.radio) + 1) % order.length];
      s.set('audio', 'radio', next);
      if (next === 'off') this.ui.toast('Radio off');
      return;
    }
    if (a.startsWith('map')) {
      const idx = Number(a.slice(3)) - 1;
      if (st === 'menu') this.ui.selectMap(idx);
      else if (st === 'driving' || st === 'paused') {
        const seed = this.journey?.seed ?? randomSeed();
        void this.startJourney(seed, idx);
      }
      return;
    }
    if (this.ui.settingsVisible || this.ui.helpVisible) return;
    if (a === 'photo') {
      if (st === 'driving' || st === 'paused') this.setPhoto(true);
      else if (st === 'photo') this.setPhoto(false);
      return;
    }
    if (st !== 'driving') return;
    const car = this.car;
    if (!car) return;
    switch (a) {
      case 'camera': {
        const modes = CAMERA_MODES;
        const next = modes[(modes.indexOf(s.data.camera.mode) + 1) % modes.length];
        s.set('camera', 'mode', next);
        this.ui.toast({ chase: 'Chase camera', far: 'Far chase', hood: 'Hood camera', cockpit: 'Cockpit', bumper: 'Bumper camera', orbit: 'Free orbit — drag to look around' }[next], [], 1400);
        break;
      }
      case 'headlights': {
        const order = ['auto', 'on', 'off'] as const;
        const next = order[(order.indexOf(s.data.driving.headlights) + 1) % 3];
        s.set('driving', 'headlights', next);
        this.ui.toast(`Headlights: ${next}`, [], 1200);
        break;
      }
      case 'reset':
        car.recover();
        break;
      case 'cruise':
        car.cruise = !car.cruise;
        car.cruiseSpeed = Math.max(8, car.speed);
        this.ui.toast(car.cruise ? 'Cruise control on' : 'Cruise control off', [], 1200);
        break;
      case 'autoDrive':
        s.set('driving', 'autoDrive', !s.data.driving.autoDrive);
        this.ui.toast(s.data.driving.autoDrive ? 'Auto-drive on — relax' : 'Auto-drive off', [], 1400);
        break;
      case 'hideHud':
        this.hudHidden = !this.hudHidden;
        this.ui.setHudHidden(this.hudHidden);
        break;
      case 'shiftUp':
        if (car.manual) car.shiftUp();
        break;
      case 'shiftDown':
        if (car.manual) car.shiftDown();
        break;
    }
  }

  private openSettings(on: boolean): void {
    if (on === this.ui.settingsVisible) return;
    this.audio.ui(on ? 'open' : 'close');
    if (on && this.state === 'driving') this.setPaused(true, false);
    this.ui.showSettings(on);
  }

  private setPaused(on: boolean, showMenu = true): void {
    if (on && this.state === 'driving') {
      this.state = 'paused';
      this.audio.ui('open');
      if (showMenu) this.ui.showPause(true, this.pauseStats());
      this.ui.setTouchContext(false);
      this.saveJourney();
    } else if (!on && this.state === 'paused') {
      this.state = 'driving';
      this.audio.ui('close');
      this.ui.showPause(false);
      this.ui.showSettings(false);
      this.ui.setTouchContext(true);
      this.engine.canvas.focus();
    }
  }

  private pauseStats() {
    const j = this.journey;
    return {
      distance: j?.odometer ?? 0,
      time: j?.time ?? 0,
      top: j?.topSpeed ?? 0,
      regions: j?.regions ?? [],
      seed: j?.seed ?? '',
      map: j ? (j.map < 0 ? 'Auto journey' : BIOMES[j.map].name) : '',
    };
  }

  private toMenu(): void {
    this.saveJourney();
    this.state = 'menu';
    this.ui.showPause(false);
    this.ui.showSettings(false);
    this.ui.showHud(false);
    this.ui.setTouchContext(false);
    this.ui.showStart(true, saves.loadJourney());
    this.rig.mode = 'orbit';
    if (this.car) {
      this.car.autoDrive = true;
      this.car.cruise = true;
      this.car.cruiseSpeed = 17;
    }
  }

  private setPhoto(on: boolean): void {
    if (on && (this.state === 'driving' || this.state === 'paused')) {
      this.state = 'photo';
      this.ui.showPause(false);
      this.ui.showHud(false);
      this.ui.setTouchContext(false);
      this.rig.photo = true;
      this.rig.orbitDist = 8;
      this.rig.orbitPitch = 0.15;
      this.rig.orbitYaw = 0.7;
      this.ui.showPhoto(true, this.photoFilter);
      this.post.filter = this.photoFilter;
      this.applyQuality();
      this.audio.ui('open');
    } else if (!on && this.state === 'photo') {
      this.state = 'driving';
      this.rig.photo = false;
      this.ui.showPhoto(false);
      this.ui.showHud(true);
      this.ui.setTouchContext(true);
      this.post.filter = 'none';
      this.applyQuality();
      this.rig.reset();
      this.audio.ui('close');
    }
  }

  private setFilter(f: PhotoFilter): void {
    this.photoFilter = f;
    this.post.filter = f;
    this.ui.setPhotoFilter(f);
    this.applyQuality();
  }

  private savePhoto(): void {
    this.ui.photoChrome(false);
    this.post.render(0, this.engine.time, 0);
    this.engine.canvas.toBlob((blob) => {
      this.ui.photoChrome(true);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const place = this.regionName.replace(/[^\w-]+/g, '-').toLowerCase();
      a.href = url;
      a.download = `modulo-roads-${place || 'photo'}-${Date.now()}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.ui.toast('Photo saved');
    }, 'image/png');
    this.audio.ui('click');
  }

  // ----------------------------------------------------------------- frame
  private frame(f: FrameInfo): void {
    const world = this.world;
    const car = this.car;
    const dt = f.dt;
    Shared.uTime.value = f.time;
    if (!world || !car || this.busy) {
      this.engine.renderer.render(this.engine.scene, this.engine.camera);
      return;
    }
    const s = this.settings.data;
    const st = this.state;
    const simulate = st === 'driving' || st === 'menu';

    // ---- time of day
    if (s.world.dayNightCycle && st !== 'paused' && st !== 'photo') {
      this.hour = (this.hour + (dt * 24) / (s.world.cycleMinutes * 60)) % 24;
    }

    // ---- driver input
    this.readInput(dt, st === 'driving');

    // ---- physics
    if (simulate) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= PHYS_DT && n < 10) {
        car.step(PHYS_DT, this.stepInput());
        this.acc -= PHYS_DT;
        n++;
      }
      if (n >= 10) this.acc = 0;
    }

    // ---- streaming
    if (st !== 'photo') world.update(dt, car.roadS, car.pos, st === 'paused' ? 1 : this.eff.buildBudgetMs);

    // ---- road state at the car
    const ri = Math.floor(car.roadS / DS);
    const flags = world.road.hasSample(ri) ? world.road.flags(ri) : 0;
    const inTunnel = (flags & F_TUNNEL) !== 0 && Math.abs(car.roadU) < world.road.halfWidth + 3;
    this.tunnel = dampTo(this.tunnel, inTunnel ? 1 : 0, 3, dt);

    // ---- atmosphere
    world.road.schedule.weights(car.roadS, this.w);
    world.atmos.update(dt, {
      camera: this.engine.camera,
      carPos: car.pos,
      biomeW: this.w,
      hour: this.hour,
      weather: s.world.weather,
      cloudDensity: s.world.cloudDensity,
      wind: s.world.windStrength,
      season: s.world.season,
      renderDistance: this.eff.renderDistance,
      lowBattery: this.eff.lowBattery,
      precipQuality: this.eff.precipQuality,
    });
    const atm = world.atmos;
    this.engine.renderer.toneMappingExposure = atm.exposure() * lerp(1, 1.25, this.tunnel);

    // wet road look
    const rm = world.chunks.roadMat;
    rm.roughness = lerp(0.88, 0.32, atm.wetness);
    rm.color.setScalar(lerp(1, 0.62, atm.wetness));

    // ---- lights & wipers
    const hl = s.driving.headlights;
    car.headlights = hl === 'on' || (hl === 'auto' && (atm.darkness > 0.5 || this.tunnel > 0.3 || s.world.weather === 'fog' || atm.precipIntensity > 0.5));
    const wp = s.driving.wipers;
    const rainOnGlass = atm.precipKind > 0 ? atm.precipIntensity : 0;
    car.wipers = wp === 'on' ? 1 : wp === 'off' ? 0 : rainOnGlass > 0.6 ? 2 : rainOnGlass > 0.08 ? 1 : 0;
    car.updateModel(dt, f.time, rainOnGlass);
    const anchor = car.model.headlightAnchor;
    anchor.getWorldPosition(this.headlight.position);
    this.tmpV.set(0, -0.6, 22).applyMatrix4(anchor.matrixWorld);
    this.headlight.target.position.copy(this.tmpV);
    this.headlight.target.updateMatrixWorld();
    this.headlight.intensity = dampTo(this.headlight.intensity, car.headlights ? 260 : 0, 10, dt);
    this.headGlow.position.copy(this.headlight.position);
    this.headGlow.intensity = this.headlight.intensity * 0.012;

    // ---- camera
    if (st === 'photo') this.photoKeys(dt);
    this.rig.update(dt, car, car.def.topSpeed);
    const camGround = this.tmpGround;
    world.ground(this.engine.camera.position.x, this.engine.camera.position.z, car.hint, camGround);
    if (!inTunnel) this.rig.clampAbove(camGround.y);
    if (this.post.enabled && (this.state === 'photo' || this.eff.dof)) this.post.focus = this.engine.camera.position.distanceTo(car.pos);

    // ---- world animation
    world.animate(f.time, this.engine.camera);

    // ---- environment reflections for car paint
    this.envT -= dt;
    if (this.envT <= 0 && (this.eff.envUpdates || !this.envRT)) {
      this.envT = 6;
      this.updateEnvironment();
    }

    // ---- recovery fade
    if (car.recovered > 0) {
      car.recovered = 0;
      this.fadeT = 0.45;
      this.ui.fade(true);
    }
    if (this.fadeT > 0) {
      this.fadeT -= dt;
      if (this.fadeT <= 0) this.ui.fade(false);
    }

    // ---- journey stats, regions, autosave
    if (st === 'driving' && this.journey) {
      const j = this.journey;
      j.odometer += Math.abs(car.speed) * dt;
      j.time += dt;
      j.topSpeed = Math.max(j.topSpeed, Math.abs(car.speed));
      this.saveT += dt;
      if (this.saveT > 5) {
        this.saveT = 0;
        this.saveJourney();
      }
    }
    this.checkRegion(car.roadS);

    // ---- audio
    this.updateAudio(dt, flags);

    // ---- HUD
    this.hudT -= dt;
    if (this.hudT <= 0 && (st === 'driving' || st === 'paused')) {
      this.hudT = 1 / 20;
      this.updateHud();
    }

    // ---- render
    this.post.flash = 0;
    this.post.render(dt, f.time, 0);

    // ---- performance management
    this.lastFrameMs = f.frameMs;
    this.battery.reportFrame(f.frameMs + (dt * 1000 > 40 ? 20 : 0), isTouchDevice());
    if (this.eff.dynamicResolution && st === 'driving') {
      const target = this.eff.fpsCap > 0 ? Math.min(this.eff.fpsCap, 60) : 60;
      if (this.dynres.update(dt, dt * 1000, target)) this.engine.setPixelRatio(this.eff.pixelRatio * this.dynres.scale);
    }
  }
  private tmpGround: Ground = { y: 0, surface: 'asphalt', wall: 0 };

  private readInput(dt: number, active: boolean): void {
    const inp = this.input;
    const d = this.drive;
    if (!active) {
      d.throttle = d.brake = 0;
      d.steer = 0;
      d.handbrake = d.boost = false;
      this.steerS = 0;
      return;
    }
    const left = inp.isDown('left');
    const right = inp.isDown('right');
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    // keyboard steering: ramp in smoothly, return faster; slower at speed
    const speed = this.car ? Math.abs(this.car.speed) : 0;
    const rate = target === 0 ? 7 : lerp(5.5, 2.6, clamp(speed / 40, 0, 1));
    this.steerS = dampTo(this.steerS, target, rate, dt);
    d.steer = this.steerS;
    d.throttle = dampTo(d.throttle, inp.isDown('accelerate') ? 1 : 0, 8, dt);
    d.brake = dampTo(d.brake, inp.isDown('brake') ? 1 : 0, 12, dt);
    d.handbrake = inp.isDown('handbrake');
    d.boost = inp.isDown('boost');
  }

  /** Copy of the drive input for one physics step (autopilot may overwrite it). */
  private stepBuf: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };
  private stepInput(): DriveInput {
    const b = this.stepBuf;
    const d = this.drive;
    b.throttle = d.throttle;
    b.brake = d.brake;
    b.steer = d.steer;
    b.handbrake = d.handbrake;
    b.boost = d.boost;
    return b;
  }

  private photoKeys(dt: number): void {
    const inp = this.input;
    const yaw = (inp.isDown('left') ? 1 : 0) - (inp.isDown('right') ? 1 : 0);
    const pitch = (inp.isDown('accelerate') ? 1 : 0) - (inp.isDown('brake') ? 1 : 0);
    const zoom = (inp.isDown('shiftDown') ? -1 : 0) + (inp.isDown('shiftUp') ? 1 : 0);
    if (yaw || pitch || zoom) {
      this.rig.nudgeOrbit(yaw * dt * 1.2, pitch * dt * 0.8, zoom * dt * 0.9);
      this.ui.photoActivity();
    }
  }

  private checkRegion(s: number): void {
    const world = this.world!;
    const r = world.road.schedule.region(s);
    const key = `${r.biome}:${r.place}`;
    if (key === this.lastRegionKey) return;
    this.lastRegionKey = key;
    const b = BIOMES[r.biome];
    this.regionName = `${b.name} · ${r.place}`;
    if (this.state === 'driving' || this.state === 'loading') {
      if (this.settings.data.general.titleCards) this.ui.titleCard(b.name, `${r.place} · ${b.region}`);
      if (this.journey && this.journey.regions[this.journey.regions.length - 1] !== b.name) this.journey.regions.push(b.name);
    }
  }

  private updateAudio(dt: number, flags: number): void {
    const car = this.car!;
    const world = this.world!;
    const s = this.settings.data;
    let birds = 0;
    let bells = 0;
    let crickets = 0;
    let water = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const w = this.w[b];
      if (w <= 0) continue;
      const a = BIOMES[b].ambient;
      birds += w * a.birds;
      bells += w * a.cowbells;
      crickets += w * a.crickets;
      water += w * a.water;
    }
    const st = this.state;
    const silent = st === 'paused' || st === 'photo';
    const atm = world.atmos;
    this.audio.update({
      rpm: car.rpm,
      maxRpm: car.def.maxRpm,
      idleRpm: car.def.idleRpm,
      throttle: st === 'driving' || st === 'menu' ? car.throttleOut : 0,
      speed: silent ? 0 : Math.abs(car.speed),
      slip: car.slip,
      surface: car.surface,
      inTunnel: this.tunnel,
      onBridge: (flags & F_BRIDGE) !== 0,
      wind: s.world.windStrength,
      rain: atm.precipIntensity * (atm.precipKind > 0 ? 1 : 0),
      snow: atm.precipKind === 2,
      night: atm.night,
      birds,
      cowbells: bells,
      crickets,
      water: water * (world.water.mesh.visible ? 1 : 0),
      trainDist: world.railway.nearestDist,
      shift: car.shift > 0,
      engine: car.def.engine,
      boost: this.drive.boost,
      dt,
      cameraInside: this.rig.mode === 'cockpit' && st === 'driving',
    });
  }

  private updateHud(): void {
    const car = this.car!;
    const j = this.journey;
    const s = this.settings.data;
    const gear = car.gear === 0 ? 'R' : car.manual ? String(car.gear) : Math.abs(car.speed) < 0.3 && this.drive.throttle < 0.05 ? 'N' : `D${car.gear}`;
    const rpm01 = clamp((car.rpm - car.def.idleRpm) / (car.def.maxRpm - car.def.idleRpm), 0, 1);
    const idle = s.general.hudAutoHide && performance.now() - this.input.lastInputTime > 7000 && !this.input.anyDriving();
    this.ui.setHudIdle(idle);
    let fpsText: string | null = null;
    if (s.graphics.showFps) {
      const info = this.engine.renderer.info;
      fpsText = `${this.engine.fps.toFixed(0)} fps · ${this.lastFrameMs.toFixed(1)} ms\n${info.render.calls} calls · ${(info.render.triangles / 1000).toFixed(0)}k tris\npx ${this.engine.pixelRatio.toFixed(2)} · tiles ${this.world!.tiles.count}`;
    }
    this.ui.updateHud({
      speed: car.speed,
      gear,
      rpm01,
      distance: j?.odometer ?? 0,
      time: j?.time ?? 0,
      heading: car.heading,
      region: this.regionName,
      lowBattery: s.general.lowBattery,
      saving: savingPercent(s, this.engine.msaa),
      headlights: car.headlights,
      cruise: car.cruise,
      cruiseSpeed: car.cruiseSpeed,
      autoDrive: car.autoDrive,
      manual: car.manual,
      fpsText,
    });
  }

  /** Render the current sky into a PMREM environment map (car paint, glass, wet road). */
  private updateEnvironment(): void {
    const world = this.world!;
    if (!this.envDome) {
      this.envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), world.atmos.sky.material);
      this.envScene.add(this.envDome);
      const ground = new THREE.Mesh(new THREE.CircleGeometry(49, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a4436 }));
      ground.position.y = -1.6;
      this.envScene.add(ground);
    }
    this.envDome.material = world.atmos.sky.material;
    const rt = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 100);
    this.envRT?.dispose();
    this.envRT = rt;
    this.engine.scene.environment = rt.texture;
    this.engine.scene.environmentIntensity = lerp(0.9, 0.25, world.atmos.night);
  }
}
