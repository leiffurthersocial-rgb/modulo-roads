/**
 * Trains and trams running on the track that parallels the road: red SBB-style
 * intercity trains in the Mittelland/Lake/Valais, small red Rhaetian-style
 * trains in the Engadin, and blue-and-white trams in the Zurich outskirts.
 * Trains follow the road frame at the rail offset and only show where the
 * track exists.
 */
import * as THREE from 'three';
import { Road, DS, RoadFrame, F_RAIL, RAIL_OFFSET } from './Road';
import { GeoBuilder } from './GeoBuilder';
import { lambert } from './Materials';
import { BIOMES, BIOME_COUNT, type RailKind } from './Biomes';

const BOX = new THREE.BoxGeometry(1, 1, 1);

interface Train {
  kind: Exclude<RailKind, null>;
  s: number; // head position along route
  dir: 1 | -1;
  speed: number;
  cars: THREE.Group[];
  carLen: number;
}

function carModel(kind: Exclude<RailKind, null>, loco: boolean, windowsMat: THREE.Material, bodyMat: THREE.Material): THREE.Group {
  const gb = new GeoBuilder();
  const win = new GeoBuilder();
  let L = 25;
  let W = 2.9;
  let H = 3.9;
  let body = 0xc8202a;
  let stripe = 0xf2f2f2;
  if (kind === 'rhb') {
    L = 18;
    W = 2.65;
    H = 3.5;
    body = 0xb0182a;
    stripe = 0xe8e2d0;
  } else if (kind === 'tram') {
    L = 14;
    W = 2.4;
    H = 3.4;
    body = 0xf3f4f6;
    stripe = 0x1f63b8;
  } else if (!loco) {
    body = 0xe9ebe8;
    stripe = 0xc8202a;
  }
  // bogies / underframe
  gb.color(0x2a2a2a).prim(BOX, 0, 0.55, 0, W * 0.8, 0.7, L * 0.92);
  gb.color(body).prim(BOX, 0, 0.9 + H / 2, 0, W, H, L);
  gb.color(stripe).prim(BOX, 0, 0.9 + H * 0.28, 0, W + 0.02, 0.35, L + 0.02);
  gb.color(0x8a8e92).prim(BOX, 0, 0.95 + H, 0, W * 0.75, 0.18, L * 0.96);
  if (loco || kind === 'tram') {
    // pantograph
    gb.color(0x3a3a3a).prim(BOX, 0, 1.4 + H, L * 0.2, 0.08, 0.9, 1.4, 0, 0.6, 0);
    // cab front
    gb.color(0x1a1e24).prim(BOX, 0, 0.9 + H * 0.68, L / 2 + 0.01, W * 0.86, H * 0.32, 0.05);
  }
  if (kind === 'tram') {
    gb.color(0x1f63b8).prim(BOX, 0, 0.9 + H * 0.92, 0, W + 0.02, 0.25, L + 0.02);
  }
  // side windows
  const wy = 0.9 + H * 0.52;
  const n = Math.floor(L / 2.2);
  for (let i = 0; i < n; i++) {
    const z = -L / 2 + 1.4 + (i * (L - 2.8)) / Math.max(1, n - 1);
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 + 0.03);
      if (sx > 0) win.quad(x, wy, z + 0.75, x, wy, z - 0.75, x, wy + 1.0, z - 0.75, x, wy + 1.0, z + 0.75);
      else win.quad(x, wy, z - 0.75, x, wy, z + 0.75, x, wy + 1.0, z + 0.75, x, wy + 1.0, z - 0.75);
    }
  }
  const g = new THREE.Group();
  const bm = new THREE.Mesh(gb.build(), bodyMat);
  bm.castShadow = true;
  g.add(bm);
  const wm = new THREE.Mesh(win.build(), windowsMat);
  g.add(wm);
  g.userData.len = L + 0.6;
  return g;
}

export class Railway {
  readonly group = new THREE.Group();
  private trains: Train[] = [];
  private cooldown = 6;
  private frame = new RoadFrame();
  private bodyMat = lambert({ vertexColors: true, flatShading: true });
  private winMat = lambert({ color: 0x3a4652, emissive: 0xfff0c8, emissiveIntensity: 1.4 }, { nightGlow: true });
  private w = new Float32Array(BIOME_COUNT);
  /** Distance from the car to the nearest train (m), for audio. */
  nearestDist = 1e9;
  nearestSpeed = 0;

  constructor(private road: Road) {}

  private railKindAt(s: number): Exclude<RailKind, null> | null {
    this.road.schedule.weights(s, this.w);
    let best: RailKind = null;
    let bw = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      if (this.w[b] > bw && BIOMES[b].rail) {
        bw = this.w[b];
        best = BIOMES[b].rail;
      }
    }
    return best;
  }

  private hasRail(s: number): boolean {
    const i = Math.floor(s / DS);
    if (!this.road.hasSample(i)) return false;
    return (this.road.flags(i) & F_RAIL) !== 0;
  }

  private spawn(carS: number): void {
    // look for track ahead
    const ahead = Math.random() < 0.6;
    const s0 = ahead ? carS + 600 + Math.random() * 300 : carS - 350 - Math.random() * 100;
    if (!this.hasRail(s0)) return;
    const kind = this.railKindAt(s0);
    if (!kind) return;
    const nCars = kind === 'tram' ? 2 : kind === 'rhb' ? 4 : 5;
    const cars: THREE.Group[] = [];
    for (let i = 0; i < nCars; i++) {
      const loco = i === 0 || (kind !== 'tram' && i === nCars - 1 && kind === 'train');
      const c = carModel(kind, loco, this.winMat, this.bodyMat);
      this.group.add(c);
      cars.push(c);
    }
    const speed = kind === 'tram' ? 14 : kind === 'rhb' ? 18 : 33;
    // oncoming when spawned ahead; overtaking from behind otherwise
    this.trains.push({ kind, s: s0, dir: ahead ? -1 : 1, speed, cars, carLen: cars[0].userData.len as number });
  }

  update(dt: number, carS: number, carPos: THREE.Vector3): void {
    this.cooldown -= dt;
    if (this.cooldown <= 0 && this.trains.length < 2) {
      this.cooldown = 25 + Math.random() * 45;
      this.spawn(carS);
    }
    this.nearestDist = 1e9;
    for (let t = this.trains.length - 1; t >= 0; t--) {
      const tr = this.trains[t];
      tr.s += tr.dir * tr.speed * dt;
      if (Math.abs(tr.s - carS) > 1400 || tr.s < this.road.baseIndex * DS + 50 || tr.s > (this.road.nFinal - 3) * DS) {
        for (const c of tr.cars) {
          this.group.remove(c);
          c.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
        }
        this.trains.splice(t, 1);
        continue;
      }
      const side = this.road.railSideAt(0);
      for (let i = 0; i < tr.cars.length; i++) {
        const car = tr.cars[i];
        const s = tr.s - tr.dir * (i * tr.carLen + tr.carLen / 2);
        if (!this.hasRail(s)) {
          car.visible = false;
          continue;
        }
        car.visible = true;
        const F = this.road.frameAt(s, this.frame);
        const u = side * RAIL_OFFSET;
        car.position.set(F.x + F.rx * u, F.y + 0.05, F.z + F.rz * u);
        car.rotation.set(0, F.heading + (tr.dir < 0 ? Math.PI : 0), 0);
        const d = car.position.distanceTo(carPos);
        if (d < this.nearestDist) {
          this.nearestDist = d;
          this.nearestSpeed = tr.speed;
        }
      }
    }
  }

  clear(): void {
    for (const tr of this.trains) for (const c of tr.cars) this.group.remove(c);
    this.trains.length = 0;
  }
}
