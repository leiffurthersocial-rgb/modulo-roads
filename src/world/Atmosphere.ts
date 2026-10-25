/**
 * Time of day, weather and lighting.
 *
 * The sun follows a real solar path for Switzerland's latitude (46.8°N) with
 * seasonal declination, so winter days are short and summer evenings long.
 * Sky/fog/light colours are keyframed on solar elevation, then modified by
 * weather (smoothly blended) and the current biome (Ticino is warmer, the
 * Engadin sky deeper blue, the Jura mistier).
 */
import * as THREE from 'three';
import { Sky } from './Sky';
import { Backdrop } from './Backdrop';
import { Precipitation } from './Weather';
import { Shared } from './Materials';
import { BIOMES, BIOME_COUNT } from './Biomes';
import type { Season, Weather } from '../core/Settings';
import { clamp, damp, lerp, smoothstep } from '../core/math';
import { Emitter } from '../core/Events';

interface Key {
  e: number; // elevation in degrees
  zenith: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  sunI: number;
  hemiI: number;
}
const k = (e: number, zenith: number, horizon: number, sun: number, sunI: number, hemiI: number): Key => ({
  e,
  zenith: new THREE.Color(zenith),
  horizon: new THREE.Color(horizon),
  sun: new THREE.Color(sun),
  sunI,
  hemiI,
});
const KEYS: Key[] = [
  k(-90, 0x040814, 0x0d162c, 0x000000, 0, 0.22),
  k(-14, 0x07102a, 0x15223f, 0x000000, 0, 0.24),
  k(-6, 0x14264c, 0x6b5d7c, 0x3a2030, 0, 0.3),
  k(-2, 0x223e78, 0xd9825a, 0xff6a30, 0.15, 0.42),
  k(2, 0x2f5ba2, 0xf3a062, 0xff8a40, 0.9, 0.55),
  k(7, 0x4278c6, 0xf4c58e, 0xffb878, 1.8, 0.68),
  k(16, 0x4a84d6, 0xe2e6e2, 0xffe2b8, 2.5, 0.82),
  k(35, 0x3d7ad4, 0xcfe2f2, 0xfff4e6, 2.9, 0.92),
  k(90, 0x3570d0, 0xc6dcf0, 0xfff8f0, 3.0, 0.95),
];

interface WeatherParams {
  cover: number;
  dim: number;
  desat: number;
  fog: number;
  mist: number;
  precip: number; // 0 none 1 rain 2 snow
  intensity: number;
  lightning: number;
}
function weatherParams(w: Weather, density: number): WeatherParams {
  switch (w) {
    case 'clear':
      return { cover: 0.05 + 0.15 * density, dim: 1, desat: 0, fog: 0.8, mist: 0, precip: 0, intensity: 0, lightning: 0 };
    case 'partly':
      return { cover: 0.25 + 0.5 * density, dim: 0.95, desat: 0.05, fog: 1, mist: 0, precip: 0, intensity: 0, lightning: 0 };
    case 'overcast':
      return { cover: 0.9 + 0.1 * density, dim: 0.38, desat: 0.6, fog: 1.4, mist: 0.2, precip: 0, intensity: 0, lightning: 0 };
    case 'fog':
      return { cover: 0.8, dim: 0.45, desat: 0.7, fog: 6.5, mist: 1.6, precip: 0, intensity: 0, lightning: 0 };
    case 'rain':
      return { cover: 0.96, dim: 0.3, desat: 0.65, fog: 1.9, mist: 0.3, precip: 1, intensity: 0.7, lightning: 0 };
    case 'snow':
      return { cover: 0.92, dim: 0.42, desat: 0.6, fog: 2.3, mist: 0.3, precip: 2, intensity: 0.65, lightning: 0 };
    case 'storm':
      return { cover: 1, dim: 0.16, desat: 0.75, fog: 2.2, mist: 0.2, precip: 1, intensity: 1, lightning: 1 };
  }
}

const GREY = new THREE.Color(0x9aa2aa);
const NIGHT_GREY = new THREE.Color(0x1a1f28);
const WARM = new THREE.Color(0xffb070);

export interface AtmosphereContext {
  camera: THREE.PerspectiveCamera;
  carPos: THREE.Vector3;
  biomeW: Float32Array;
  hour: number;
  weather: Weather;
  cloudDensity: number;
  wind: number;
  season: Season;
  renderDistance: number;
  lowBattery: boolean;
  precipQuality: number;
}

export class Atmosphere {
  readonly sky: Sky;
  readonly backdrop: Backdrop;
  readonly precip = new Precipitation();
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.5);
  readonly hemi = new THREE.HemisphereLight(0xbfd8ff, 0x55603f, 0.8);
  readonly fog = new THREE.FogExp2(0xcfe3f2, 0.0012);
  readonly events = new Emitter<{ thunder: { delay: number; strength: number } }>();
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, -1, 0);
  night = 0;
  /** 0 bright day → 1 dark: drives automatic headlights. */
  darkness = 0;
  wetness = 0;
  windDir = 0.6;
  private cur: WeatherParams = weatherParams('partly', 0.45);
  private flash = 0;
  private nextLightning = 8;
  private flashT = -1;
  private cloudOff = new THREE.Vector2();
  private time = 0;
  shadowRange = 60;
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();
  private zen = new THREE.Color();
  private hor = new THREE.Color();
  private sunC = new THREE.Color();
  private ambient = new THREE.Color();
  private haze = new THREE.Color();

  constructor(scene: THREE.Scene, seed: number, cloudOctaves: number) {
    this.sky = new Sky(cloudOctaves);
    this.backdrop = new Backdrop(seed);
    scene.add(this.sky.dome, this.sky.stars, this.backdrop.group, this.precip.mesh);
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
  }

  /** Solar position for latitude 46.8°N. Returns elevation in radians. */
  private solar(hour: number, season: Season): void {
    const lat = (46.8 * Math.PI) / 180;
    const decl = ((season === 'summer' ? 21 : season === 'winter' ? -21 : season === 'spring' ? 4 : -4) * Math.PI) / 180;
    const H = ((hour - 12.6) / 24) * Math.PI * 2; // solar noon ≈ 12:36 in CEST-ish
    const sinE = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
    const E = Math.asin(clamp(sinE, -1, 1));
    const A = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
    // world: north = +z, east = −x
    this.sunDir.set(-Math.sin(A) * Math.cos(E), Math.sin(E), Math.cos(A) * Math.cos(E)).normalize();
    // moon roughly opposite, a little higher so it is visible most nights
    this.moonDir.set(-this.sunDir.x + 0.25, Math.max(0.25, -this.sunDir.y) + 0.15, -this.sunDir.z - 0.2).normalize();
  }

  update(dt: number, ctx: AtmosphereContext): void {
    this.time += dt;
    this.solar(ctx.hour, ctx.season);
    const elevDeg = (Math.asin(this.sunDir.y) * 180) / Math.PI;

    // ---- keyframe interpolation
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].e < elevDeg) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = clamp((elevDeg - a.e) / (b.e - a.e), 0, 1);
    this.zen.copy(a.zenith).lerp(b.zenith, t);
    this.hor.copy(a.horizon).lerp(b.horizon, t);
    this.sunC.copy(a.sun).lerp(b.sun, t);
    let sunI = lerp(a.sunI, b.sunI, t);
    let hemiI = lerp(a.hemiI, b.hemiI, t);

    // ---- weather (smoothly blended)
    const target = weatherParams(ctx.weather, ctx.cloudDensity);
    const r = damp(0.25, dt);
    const c = this.cur;
    c.cover += (target.cover - c.cover) * r;
    c.dim += (target.dim - c.dim) * r;
    c.desat += (target.desat - c.desat) * r;
    c.fog += (target.fog - c.fog) * r;
    c.mist += (target.mist - c.mist) * r;
    c.intensity += ((target.precip ? target.intensity : 0) - c.intensity) * damp(0.5, dt);
    c.precip = target.precip || (c.intensity > 0.02 ? c.precip : 0);
    c.lightning = target.lightning;

    // ---- biome blend
    let warmth = 0;
    let deep = 0;
    let fogB = 0;
    let mistB = 0;
    let mH = 0;
    let mS = 0;
    let skyline = 0;
    for (let bI = 0; bI < BIOME_COUNT; bI++) {
      const w = ctx.biomeW[bI];
      if (w <= 0) continue;
      const d = BIOMES[bI];
      warmth += w * d.sunWarmth;
      deep += w * d.skyDeep;
      fogB += w * d.fog;
      mistB += w * d.mist;
      mH += w * d.mountains.height;
      mS += w * d.mountains.snow;
      if (d.skyline) skyline += w;
    }
    const dayish = smoothstep(-4, 12, elevDeg);
    // deeper blue zenith in high clear air
    this.tmpC.setRGB(0.05, 0.22, 0.75);
    this.zen.lerp(this.tmpC, (deep - 0.5) * 0.25 * dayish);
    // warm light
    this.sunC.lerp(WARM, clamp(warmth, 0, 1) * 0.18);
    this.hor.lerp(WARM, clamp(warmth, 0, 1) * 0.06 * dayish);

    // desaturate to grey with overcast
    const night = 1 - smoothstep(-8, 2, elevDeg);
    this.night = night;
    const grey = this.tmpC2.copy(GREY).lerp(NIGHT_GREY, night).multiplyScalar(lerp(1, 0.35, c.desat * (1 - c.dim)));
    this.zen.lerp(grey, c.desat * 0.85);
    this.hor.lerp(grey, c.desat * 0.75);
    sunI *= c.dim;
    hemiI *= lerp(1, 0.8, c.desat);

    // lightning
    if (c.lightning > 0.5) {
      this.nextLightning -= dt;
      if (this.nextLightning <= 0) {
        this.flashT = 0;
        this.nextLightning = 6 + Math.random() * 14;
        this.events.emit('thunder', { delay: 0.6 + Math.random() * 3, strength: 0.5 + Math.random() * 0.5 });
      }
    }
    if (this.flashT >= 0) {
      this.flashT += dt;
      const ft = this.flashT;
      this.flash = ft < 0.08 ? 1 : ft < 0.15 ? 0.2 : ft < 0.24 ? 0.8 : ft < 0.5 ? Math.max(0, 0.6 - (ft - 0.24) * 2.5) : 0;
      if (ft > 0.6) this.flashT = -1;
    } else this.flash = 0;

    // ---- sky uniforms
    const su = this.sky.uniforms;
    su.uSunDir.value.copy(this.sunDir);
    su.uMoonDir.value.copy(this.moonDir);
    su.uZenith.value.copy(this.zen);
    su.uHorizon.value.copy(this.hor);
    su.uGround.value.copy(this.hor).multiplyScalar(0.55);
    su.uSunColor.value.copy(this.sunC).multiplyScalar(lerp(1, 0.25, c.desat));
    su.uSunVisible.value = (1 - c.cover * 0.7) * smoothstep(-3, 0, elevDeg);
    su.uCover.value = c.cover;
    su.uNight.value = night * (1 - c.cover * 0.85);
    su.uFlash.value = this.flash * 0.6;
    // cloud colours: lit side picks up sunset tones
    const cl = su.uCloudLit.value;
    cl.setRGB(1, 1, 1).lerp(this.sunC, 0.35 + (1 - dayish) * 0.4).multiplyScalar(lerp(0.12, 1, smoothstep(-10, 6, elevDeg)) * lerp(1, 0.75, c.desat));
    su.uCloudShade.value.copy(this.zen).lerp(grey, 0.6).multiplyScalar(0.85);
    this.cloudOff.x += Math.sin(this.windDir) * (0.002 + ctx.wind * 0.01) * dt;
    this.cloudOff.y += Math.cos(this.windDir) * (0.002 + ctx.wind * 0.01) * dt;
    su.uCloudOffset.value.copy(this.cloudOff);
    this.sky.setStars(night * (1 - c.cover * 0.9));
    this.sky.follow(ctx.camera, this.time);

    // ---- fog
    const fogCol = this.tmpC.copy(this.hor).lerp(this.zen, 0.12);
    fogCol.lerp(grey, c.desat * 0.4);
    if (ctx.weather === 'fog') fogCol.lerp(this.tmpC2.setRGB(0.75, 0.78, 0.8).multiplyScalar(lerp(1, 0.08, night)), 0.6);
    this.fog.color.copy(fogCol).addScalar(this.flash * 0.2);
    su.uFogColor.value.copy(this.fog.color);
    su.uHorizonFog.value = clamp(0.55 + c.fog * 0.1, 0, 0.95);
    const base = 1.6 / (ctx.renderDistance * 0.95);
    this.fog.density = base * Math.pow(c.fog, 0.8) * Math.sqrt(0.75 + 0.25 * fogB);
    Shared.uFogParams.value.set(0.006, ctx.carPos.y - 25, mistB * 0.5 + c.mist * 1.5, 45);
    Shared.uFogSunColor.value.copy(this.sunC).multiplyScalar(0.28 * (1 - c.desat) * smoothstep(-6, 4, elevDeg));
    Shared.uFogSunDir.value.copy(this.sunDir);

    // ---- lights
    const moonLight = night > 0.5;
    const ld = moonLight ? this.moonDir : this.sunDir;
    this.sun.color.copy(moonLight ? this.tmpC2.setRGB(0.55, 0.65, 0.95) : this.sunC);
    this.sun.intensity = moonLight ? 0.22 * (1 - c.cover * 0.8) : sunI;
    this.sun.position.copy(ctx.carPos).addScaledVector(ld, 220);
    this.sun.target.position.copy(ctx.carPos);
    this.sun.target.updateMatrixWorld();
    this.hemi.color.copy(this.zen).lerp(this.hor, 0.45).lerp(grey, 0.2);
    this.hemi.groundColor.setRGB(0.32, 0.3, 0.22).multiplyScalar(lerp(0.15, 1, dayish));
    this.hemi.intensity = hemiI * 1.1 + this.flash * 1.5;
    this.darkness = clamp(1 - (sunI / 2.2 + hemiI * 0.3), 0, 1);
    Shared.uNight.value = smoothstep(0.35, 0.8, this.darkness) * 0.9 + night * 0.1;

    // shadow camera follows the car, snapped to texels to avoid shimmering
    const sc = this.sun.shadow.camera;
    const R = this.shadowRange;
    if (sc.right !== R) {
      sc.left = -R;
      sc.right = R;
      sc.top = R;
      sc.bottom = -R;
      sc.near = 1;
      sc.far = 600;
      sc.updateProjectionMatrix();
    }

    // ---- precipitation & wetness
    const raining = c.precip === 1 ? c.intensity : 0;
    this.precip.set(c.precip, c.intensity, ctx.wind, this.windDir, ctx.precipQuality);
    this.precip.update(ctx.camera, this.time);
    this.wetness += ((raining > 0.1 ? 1 : 0) - this.wetness) * damp(raining > 0.1 ? 0.15 : 0.02, dt);

    // ---- backdrop
    this.ambient.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.6);
    this.haze.copy(this.fog.color);
    this.backdrop.update(ctx.camera, ctx.carPos.y, {
      height: mH,
      snow: mS,
      haze: this.haze,
      hazeAmt: clamp(0.35 + c.fog * 0.12 + fogB * 0.05, 0, 0.92),
      sunDir: this.sunDir,
      sunColor: this.tmpC2.copy(this.sunC).multiplyScalar(sunI * 0.45),
      ambient: this.ambient,
      skyline,
      night,
      season: ctx.season === 'winter' ? 1 : 0,
    });

    Shared.uWind.value = ctx.wind;
    Shared.uSnow.value = ctx.season === 'winter' ? 1 : c.precip === 2 ? c.intensity * 0.6 : 0;
  }

  get cover(): number {
    return this.cur.cover;
  }
  get precipKind(): number {
    return this.cur.precip;
  }
  get precipIntensity(): number {
    return this.cur.intensity;
  }
  get flashLevel(): number {
    return this.flash;
  }
  /** Exposure compensation so nights are dark-blue rather than black. */
  exposure(): number {
    return lerp(1.0, 1.9, this.night) * lerp(1, 1.15, this.cur.desat * (1 - this.night));
  }
}
