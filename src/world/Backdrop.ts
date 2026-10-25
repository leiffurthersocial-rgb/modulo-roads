/**
 * Far-away scenery that is never reached: rings of snowy peaks on the
 * horizon and, in the Zurich region, a dusk skyline with the Grossmünster's
 * twin towers, the Fraumünster spire and St. Peter. Both follow the camera
 * horizontally (no parallax at that distance) and use their own aerial
 * perspective instead of scene fog so they stay visible at any render distance.
 */
import * as THREE from 'three';
import { Noise } from '../core/rng';
import { GeoBuilder } from './GeoBuilder';

const mtnVert = /* glsl */ `
attribute float aSnow;
varying float vH;
varying float vSnow;
varying vec3 vN;
void main() {
  vH = position.y;
  vSnow = aSnow;
  vN = normalize( mat3( modelMatrix ) * normal );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const mtnFrag = /* glsl */ `
varying float vH;
varying float vSnow;
varying vec3 vN;
uniform vec3 uRock;
uniform vec3 uSnowCol;
uniform vec3 uHaze;
uniform float uHazeAmt;
uniform float uSnowLine;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
void main() {
  float snow = smoothstep( uSnowLine - 0.06, uSnowLine + 0.04, vSnow );
  vec3 base = mix( uRock, uSnowCol, snow );
  float l = max( dot( normalize( vN ), uSunDir ), 0.0 );
  vec3 col = base * ( uAmbient + uSunColor * l * 0.8 );
  // aerial perspective: lower parts hazier
  float haze = clamp( uHazeAmt + ( 1.0 - smoothstep( 0.0, 0.7, vSnow ) ) * 0.25, 0.0, 1.0 );
  col = mix( col, uHaze, haze );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function ringGeometry(noise: Noise, radius: number, segs: number, seedOff: number, peakiness: number): THREE.BufferGeometry {
  // a band of triangles: bottom at y = -0.2, top following a ridge profile in [0, 1]
  const pos: number[] = [];
  const snow: number[] = [];
  const idx: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const cx = Math.cos(a) * 3;
    const cz = Math.sin(a) * 3;
    let h = 0.35 + 0.35 * noise.fbm(cx + seedOff, cz, 3);
    const r = noise.ridged(cx * 2.2 + seedOff, cz * 2.2, 3);
    h += peakiness * 0.55 * r * r;
    heights.push(Math.max(0.05, h));
  }
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    const h = heights[i];
    // three rows: base, mid shoulder, crest – gives some facets for lighting
    const mid = h * 0.55;
    const inward = 0.97;
    pos.push(x, -0.25, z, x * inward, mid, z * inward, x * 0.94, h, z * 0.94);
    snow.push(0, mid, h);
  }
  for (let i = 0; i < segs; i++) {
    for (let r = 0; r < 2; r++) {
      const a = i * 3 + r;
      const b = (i + 1) * 3 + r;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSnow', new THREE.Float32BufferAttribute(snow, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Backdrop {
  readonly group = new THREE.Group();
  private far: THREE.Mesh;
  private near: THREE.Mesh;
  readonly uniforms = {
    uRock: { value: new THREE.Color(0x7d8794) },
    uSnowCol: { value: new THREE.Color(0xf2f5fa) },
    uHaze: { value: new THREE.Color(0xc8d8e8) },
    uHazeAmt: { value: 0.45 },
    uSnowLine: { value: 0.55 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.5, 0.55, 0.6) },
  };
  private nearUniforms: typeof this.uniforms;
  readonly skyline: THREE.Group;
  private skyBodyMat: THREE.MeshBasicMaterial;
  private skyWinMat: THREE.MeshBasicMaterial;
  private mountainHeight = 1;

  constructor(seed: number) {
    const noise = new Noise(seed ^ 0x77);
    const mat = new THREE.ShaderMaterial({ vertexShader: mtnVert, fragmentShader: mtnFrag, uniforms: this.uniforms, depthWrite: true });
    this.nearUniforms = THREE.UniformsUtils.clone(this.uniforms);
    const matNear = new THREE.ShaderMaterial({ vertexShader: mtnVert, fragmentShader: mtnFrag, uniforms: this.nearUniforms });
    this.far = new THREE.Mesh(ringGeometry(noise, 1, 260, 0, 1.0), mat);
    this.near = new THREE.Mesh(ringGeometry(noise, 1, 200, 50, 0.6), matNear);
    this.far.frustumCulled = false;
    this.near.frustumCulled = false;
    this.far.renderOrder = 1e6 - 2;
    this.near.renderOrder = 1e6 - 3;
    this.group.add(this.far, this.near);

    // Zurich skyline
    this.skyBodyMat = new THREE.MeshBasicMaterial({ color: 0x2b2f44, fog: false });
    this.skyWinMat = new THREE.MeshBasicMaterial({ color: 0xffc77a, fog: false, vertexColors: true });
    this.skyline = this.buildSkyline(seed);
    this.skyline.visible = false;
    this.group.add(this.skyline);
  }

  private buildSkyline(seed: number): THREE.Group {
    const body = new GeoBuilder();
    const win = new GeoBuilder();
    const n = new Noise(seed ^ 0x2c);
    // Buildings live in a local frame: x along the horizon (−1..1 → metres), z towards the viewer.
    const width = 1400;
    for (let i = 0; i < 70; i++) {
      const x = -width / 2 + (i / 70) * width + n.n1(i * 0.7) * 10;
      const h = 14 + Math.abs(n.n1(i * 0.33 + 3)) * 28;
      const w = 14 + Math.abs(n.n1(i * 0.9)) * 18;
      const d = 14;
      body.prim(BOX, x, h / 2, n.n1(i) * 40, w, h, d);
      // windows: a few lit rows
      for (let f = 3; f < h - 2; f += 3.4) {
        for (let k = -w / 2 + 2; k < w / 2 - 1; k += 3) {
          const lit = Math.abs(n.n2(x + k, f)) > 0.25 ? 1 : 0.0;
          if (!lit) continue;
          win.rgb(1, 0.85 + 0.15 * Math.random(), 0.7);
          win.quad(x + k, f, n.n1(i) * 40 + d / 2 + 0.2, x + k + 1.2, f, n.n1(i) * 40 + d / 2 + 0.2, x + k + 1.2, f + 1.4, n.n1(i) * 40 + d / 2 + 0.2, x + k, f + 1.4, n.n1(i) * 40 + d / 2 + 0.2);
        }
      }
    }
    // Prime Tower (tall, slim)
    body.prim(BOX, 380, 63, -60, 30, 126, 22);
    for (let f = 6; f < 122; f += 4) win.rgb(0.7, 0.9, 1).quad(368, f, -48.8, 392, f, -48.8, 392, f + 1.2, -48.8, 368, f + 1.2, -48.8);
    // Grossmünster: twin towers with domed caps
    for (const dx of [-12, 12]) {
      body.prim(BOX, -120 + dx, 30, 20, 11, 60, 11);
      body.prim(SPHERE, -120 + dx, 62, 20, 6.5, 8, 6.5);
      body.prim(BOX, -120 + dx, 70, 20, 0.6, 6, 0.6);
    }
    body.prim(BOX, -120, 16, 0, 40, 32, 30);
    // Fraumünster: slim pointed spire
    body.prim(BOX, 40, 30, 30, 9, 60, 9);
    body.prim(PYR, 40, 76, 30, 7, 34, 7, Math.PI / 4);
    body.prim(BOX, 40, 14, 10, 18, 28, 30);
    // St. Peter: square tower with big clock and steep spire
    body.prim(BOX, -20, 32, -10, 12, 64, 12);
    body.prim(PYR, -20, 76, -10, 9, 24, 9, Math.PI / 4);
    win.rgb(1, 0.9, 0.6).quad(-26, 52, -3.8, -14, 52, -3.8, -14, 60, -3.8, -26, 60, -3.8);
    // Hills behind (Uetliberg ridge) with the TV tower
    body.prim(SPHERE, 520, -60, -300, 420, 160, 200);
    body.prim(BOX, 560, 125, -320, 3, 180, 3);

    const g = new THREE.Group();
    const bm = new THREE.Mesh(body.build(), this.skyBodyMat);
    const wm = new THREE.Mesh(win.build(), this.skyWinMat);
    bm.frustumCulled = wm.frustumCulled = false;
    bm.renderOrder = 1e6 - 4;
    wm.renderOrder = 1e6 - 4;
    g.add(bm, wm);
    return g;
  }

  /** Per-frame update. `bearing` is a fixed world angle for the skyline. */
  update(
    camera: THREE.PerspectiveCamera,
    baseY: number,
    params: {
      height: number; // 0..1.3 mountain height factor (biome blend)
      snow: number; // 0..1.3
      haze: THREE.Color;
      hazeAmt: number;
      sunDir: THREE.Vector3;
      sunColor: THREE.Color;
      ambient: THREE.Color;
      skyline: number; // 0..1
      night: number;
      season: number; // 1 in winter
    },
  ): void {
    const R = camera.far * 0.86;
    this.mountainHeight += (params.height - this.mountainHeight) * 0.02;
    const hFar = R * 0.11 * Math.max(0.15, this.mountainHeight);
    this.far.position.set(camera.position.x, baseY - 40, camera.position.z);
    this.far.scale.set(R, hFar, R);
    this.near.position.set(camera.position.x, baseY - 40, camera.position.z);
    this.near.scale.set(R * 0.72, hFar * 0.55, R * 0.72);
    for (const u of [this.uniforms, this.nearUniforms]) {
      u.uHaze.value.copy(params.haze);
      u.uSunDir.value.copy(params.sunDir);
      u.uSunColor.value.copy(params.sunColor);
      u.uAmbient.value.copy(params.ambient);
      u.uSnowLine.value = 1.05 - Math.min(1.2, params.snow + params.season * 0.4) * 0.5;
    }
    this.uniforms.uHazeAmt.value = params.hazeAmt;
    this.nearUniforms.uHazeAmt.value = Math.max(0, params.hazeAmt - 0.15);
    this.nearUniforms.uRock.value.setRGB(0.36, 0.42, 0.38);
    this.far.visible = this.near.visible = params.height > 0.05;

    // skyline sits at a fixed compass bearing, ~1.9 km away
    this.skyline.visible = params.skyline > 0.02;
    if (this.skyline.visible) {
      const bearing = 2.4;
      const dist = Math.min(R * 0.8, 2400);
      const sx = camera.position.x + Math.sin(bearing) * dist;
      const sz = camera.position.z + Math.cos(bearing) * dist;
      this.skyline.position.set(sx, baseY - 25, sz);
      this.skyline.rotation.y = bearing + Math.PI;
      const sc = (dist / 2400) * (0.3 + 0.7 * params.skyline);
      this.skyline.scale.set(sc, sc, sc);
      this.skyBodyMat.color.copy(params.haze).multiplyScalar(0.45 + 0.25 * (1 - params.night));
      this.skyBodyMat.color.lerp(params.haze, params.hazeAmt * 0.6);
      this.skyWinMat.color.setRGB(1, 0.8, 0.5).multiplyScalar(0.1 + params.night * 2.2);
    }
  }
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(1, 10, 6);
const PYR = new THREE.ConeGeometry(1, 1, 4);
