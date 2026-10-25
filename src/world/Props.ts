/**
 * Procedural props: trees, farms, villages, animals, vineyards, boats, cable
 * cars… placed per road chunk from a seeded RNG, rendered through a handful
 * of global InstancedMesh pools (one draw call per model part regardless of
 * how many chunks are loaded). Slots are recycled with swap-remove so the
 * instance count always equals the live count.
 */
import * as THREE from 'three';
import { models, modelMaterials, type Model } from './Models';
import { Road, DS, RoadFrame, F_TUNNEL, F_BRIDGE } from './Road';
import { TerrainSampler, type HeightInfo } from './Terrain';
import { BIOMES, BIOME_COUNT, type BiomeDef, type TreeKind } from './Biomes';
import { RNG, hashInts } from '../core/rng';
import { smoothstep } from '../core/math';
import { foliageColor, grassTint } from './Season';
import type { Season, ShadowQuality } from '../core/Settings';
import { WATER_LEVEL } from './TerrainField';

export const CHUNK = 64; // samples per road chunk (128 m)

class Handle {
  constructor(
    public pool: InstancePool,
    public slot: number,
  ) {}
}

export class InstancePool {
  mesh: THREE.InstancedMesh;
  private owners: Handle[] = [];
  private dirty = false;
  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    private capacity: number,
    private tint: boolean,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (tint) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    }
  }

  get count(): number {
    return this.owners.length;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const m = new Float32Array(cap * 16);
    m.set(this.mesh.instanceMatrix.array as Float32Array);
    this.mesh.instanceMatrix = new THREE.InstancedBufferAttribute(m, 16);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.tint && this.mesh.instanceColor) {
      const c = new Float32Array(cap * 3).fill(1);
      c.set(this.mesh.instanceColor.array as Float32Array);
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(c, 3);
    }
    this.capacity = cap;
  }

  alloc(m: THREE.Matrix4, color?: THREE.Color): Handle {
    if (this.owners.length >= this.capacity) this.grow();
    const slot = this.owners.length;
    const h = new Handle(this, slot);
    this.owners.push(h);
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, slot * 16);
    if (this.tint && this.mesh.instanceColor) {
      const arr = this.mesh.instanceColor.array as Float32Array;
      if (color) {
        arr[slot * 3] = color.r;
        arr[slot * 3 + 1] = color.g;
        arr[slot * 3 + 2] = color.b;
      } else arr[slot * 3] = arr[slot * 3 + 1] = arr[slot * 3 + 2] = 1;
    }
    this.mesh.count = this.owners.length;
    this.dirty = true;
    return h;
  }

  set(h: Handle, m: THREE.Matrix4): void {
    m.toArray(this.mesh.instanceMatrix.array as Float32Array, h.slot * 16);
    this.dirty = true;
  }

  release(h: Handle): void {
    const last = this.owners.length - 1;
    const slot = h.slot;
    if (slot < 0) return;
    if (slot !== last) {
      const mover = this.owners[last];
      const ma = this.mesh.instanceMatrix.array as Float32Array;
      ma.copyWithin(slot * 16, last * 16, last * 16 + 16);
      if (this.tint && this.mesh.instanceColor) {
        const ca = this.mesh.instanceColor.array as Float32Array;
        ca.copyWithin(slot * 3, last * 3, last * 3 + 3);
      }
      mover.slot = slot;
      this.owners[slot] = mover;
    }
    this.owners.pop();
    h.slot = -1;
    this.mesh.count = this.owners.length;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

interface Animated {
  kind: 'boat' | 'cabin';
  handles: Handle[];
  // boat
  x: number;
  y: number;
  z: number;
  rot: number;
  scale: number;
  phase: number;
  drift: number;
  // cable car: from (x,y,z) to (x2,y2,z2)
  x2: number;
  y2: number;
  z2: number;
}

interface ChunkProps {
  handles: Handle[];
  anim: Animated[];
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const C = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class PropSystem {
  readonly group = new THREE.Group();
  private pools = new Map<string, InstancePool[]>();
  private main = new Map<number, ChunkProps>();
  private grass = new Map<number, ChunkProps>();
  private frame = new RoadFrame();
  private info: HeightInfo = { flatten: 0, roadDist: 0, nearest: -1, natural: 0, u: 0 };
  private w = new Float32Array(BIOME_COUNT);
  private current: ChunkProps | null = null;
  private villageCenters: { x: number; z: number }[] = [];
  treeDensity = 1;
  grassDensity = 0.5;
  season: Season = 'summer';
  lowDetail = false;

  constructor(
    private road: Road,
    private sampler: TerrainSampler,
    private seed: number,
  ) {
    const lib = models();
    for (const name of Object.keys(lib)) {
      const model = lib[name];
      const cap = name === 'grass' || name === 'flower' ? 8000 : model.shadow === 'tree' ? 3000 : 256;
      const parts = model.parts.map((p) => {
        const pool = new InstancePool(p.geo, p.mat, cap, p.tint);
        this.group.add(pool.mesh);
        return pool;
      });
      this.pools.set(name, parts);
    }
  }

  setShadows(q: ShadowQuality): void {
    const lib = models();
    for (const [name, pools] of this.pools) {
      const sh = lib[name].shadow;
      const cast =
        q === 'high' ? sh !== 'none' : q === 'medium' ? sh === 'building' || sh === 'tree' : false;
      for (const p of pools) {
        p.mesh.castShadow = cast;
        p.mesh.receiveShadow = q !== 'off' && sh === 'building';
      }
    }
  }

  // ------------------------------------------------------------ placement
  private place(name: string, x: number, y: number, z: number, rotY: number, scale: number, color?: THREE.Color, sy?: number): Handle[] {
    const pools = this.pools.get(name)!;
    E.set(0, rotY, 0);
    Q.setFromEuler(E);
    M.compose(P.set(x, y, z), Q, S.set(scale, sy ?? scale, scale));
    const hs: Handle[] = [];
    for (const pool of pools) {
      const h = pool.alloc(M, color);
      hs.push(h);
      this.current!.handles.push(h);
    }
    return hs;
  }

  private placeMatrix(name: string, m: THREE.Matrix4, color?: THREE.Color): Handle[] {
    const pools = this.pools.get(name)!;
    const hs: Handle[] = [];
    for (const pool of pools) {
      const h = pool.alloc(m, color);
      hs.push(h);
      this.current!.handles.push(h);
    }
    return hs;
  }

  private pickBiome(rng: RNG): BiomeDef {
    let r = rng.next();
    for (let b = 0; b < BIOME_COUNT; b++) {
      r -= this.w[b];
      if (r <= 0) return BIOMES[b];
    }
    let best = 0;
    for (let b = 1; b < BIOME_COUNT; b++) if (this.w[b] > this.w[best]) best = b;
    return BIOMES[best];
  }

  private blended(key: keyof BiomeDef): number {
    let v = 0;
    for (let b = 0; b < BIOME_COUNT; b++) if (this.w[b] > 0) v += this.w[b] * (BIOMES[b][key] as number);
    return v;
  }

  private static pickWeighted<T>(list: [T, number][], rng: RNG): T {
    let tot = 0;
    for (const [, w] of list) tot += w;
    let r = rng.next() * tot;
    for (const [k, w] of list) {
      r -= w;
      if (r <= 0) return k;
    }
    return list[0][0];
  }

  /** World point at distance s with lateral offset u (uses road frame). */
  private at(s: number, u: number): RoadFrame {
    const F = this.road.frameAt(s, this.frame);
    F.x += F.rx * u;
    F.z += F.rz * u;
    return F;
  }

  private nearVillage(x: number, z: number, r: number): boolean {
    for (const v of this.villageCenters) if ((v.x - x) ** 2 + (v.z - z) ** 2 < r * r) return true;
    return false;
  }

  private ground(x: number, z: number): number {
    return this.sampler.heightAt(x, z, null, this.info);
  }

  private clearOfRoad(minDist: number): boolean {
    return this.info.nearest < 0 || this.info.roadDist > minDist;
  }

  /** Place the main (non-grass) props for chunk k. */
  buildMain(k: number): void {
    if (this.main.has(k)) return;
    const cp: ChunkProps = { handles: [], anim: [] };
    this.main.set(k, cp);
    this.current = cp;
    const road = this.road;
    const i0 = k * CHUNK;
    const i1 = Math.min(i0 + CHUNK, road.nFinal - 2);
    if (i1 <= i0) return;
    const sMid = ((i0 + i1) / 2) * DS;
    road.schedule.weights(sMid, this.w);
    const rng = new RNG(hashInts(k, 11, 3, this.seed));
    const hw = road.halfWidth;
    const noise = road.field.noise;
    const sRand = () => (i0 + rng.next() * (i1 - i0)) * DS;
    this.villageCenters.length = 0;
    // does the chunk's road run through a tunnel? (skip most props then)
    const midFlags = road.flags(Math.floor((i0 + i1) / 2));
    const inTunnel = (midFlags & F_TUNNEL) !== 0;

    // --- villages first (they exclude trees)
    if (!inTunnel && rng.chance(this.blended('villageChance'))) {
      const def = this.pickBiome(rng);
      const sc = sMid;
      const centre = this.at(sc, 0);
      this.villageCenters.push({ x: centre.x, z: centre.z });
      const n = rng.int(6, 11);
      let church = false;
      for (let j = 0; j < n; j++) {
        const side = j % 2 === 0 ? 1 : -1;
        const s = sc + rng.range(-62, 62);
        let kind = PropSystem.pickWeighted(def.village, rng) as string;
        if (kind === 'church') {
          if (church) kind = def.village[0][0];
          church = true;
        }
        const fp = models()[kind].footprint;
        const u = side * (hw + fp + 4 + rng.range(0, 26));
        this.building(kind, s, u, side, rng, fp);
      }
      for (let f = 0; f < 2; f++) if (rng.chance(0.7)) this.flagAt(sc + rng.range(-50, 50), rng.sign() * (hw + 6), rng);
    }

    // --- farms
    if (!inTunnel && rng.chance(this.blended('farmChance'))) {
      const def = this.pickBiome(rng);
      const s = sRand();
      const side = rng.sign();
      const kind = PropSystem.pickWeighted(def.buildings, rng) as string;
      const fp = models()[kind].footprint;
      const u = side * (hw + fp + 8 + rng.range(0, 45));
      if (this.building(kind, s, u, side, rng, fp)) {
        if (rng.chance(0.5)) this.building(rng.chance(0.5) ? 'barn' : kind, s + rng.sign() * 22, u + side * rng.range(0, 10), side, rng, 9);
        if (rng.chance(def.flags * 2)) this.flagAt(s + 8, u - side * (fp + 2), rng);
      }
    }

    // --- trees
    const tCount = Math.round(this.blended('treeCount') * this.treeDensity * (this.lowDetail ? 1.4 : 2.2));
    for (let n = 0; n < tCount; n++) {
      const def = this.pickBiome(rng);
      const s = sRand();
      const side = rng.sign();
      const u = side * (hw + 5 + Math.pow(rng.next(), 1.5) * 240);
      const F = this.at(s, u);
      const forest = smoothstep(def.forestThreshold, def.forestThreshold + 0.16, noise.fbm(F.x / def.forestScale, F.z / def.forestScale, 2));
      if (rng.next() > 0.07 + 0.93 * forest) continue;
      if (this.nearVillage(F.x, F.z, 70)) continue;
      const x = F.x;
      const z = F.z;
      const h = this.ground(x, z);
      if (!this.clearOfRoad(hw + 4.5) || h < WATER_LEVEL + 0.7) continue;
      const kind = PropSystem.pickWeighted(def.trees, rng) as TreeKind;
      const scale = rng.range(0.75, 1.35) * (kind === 'bush' ? 0.9 : 1);
      foliageColor(kind, this.season, rng.next(), def.autumnBias, C);
      C.multiplyScalar(rng.range(0.88, 1.08));
      this.place(kind, x, h - 0.15, z, rng.range(0, 6.28), scale, C);
    }

    // --- orchards
    if (!inTunnel && rng.chance(this.blended('orchards'))) {
      const s0 = sRand();
      const side = rng.sign();
      const u0 = hw + 14 + rng.range(0, 30);
      const autumn = this.season === 'autumn';
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 6; b++) {
          const F = this.at(s0 + b * 9 - 22, side * (u0 + a * 9));
          const x = F.x;
          const z = F.z;
          const h = this.ground(x, z);
          if (!this.clearOfRoad(hw + 5) || h < 0.6) continue;
          foliageColor('apple', this.season, rng.next(), 0, C);
          if (autumn && rng.chance(0.5)) C.setHex(0xb8402a);
          this.place('apple', x, h - 0.1, z, rng.range(0, 6.28), rng.range(0.85, 1.1), C);
        }
      }
    }

    // --- vineyards (rows across the slope, Lavaux / Valais style)
    if (!inTunnel && rng.chance(this.blended('vineyards'))) {
      const s0 = sRand();
      const side = rng.sign();
      const u0 = hw + 10 + rng.range(0, 20);
      const rows = rng.int(8, 15);
      const segs = rng.int(6, 11);
      for (let a = 0; a < rows; a++) {
        for (let b = 0; b < segs; b++) {
          const s = s0 + (b - segs / 2) * 4.2;
          const F = this.at(s, side * (u0 + a * 2.6));
          const x = F.x;
          const z = F.z;
          const h = this.ground(x, z);
          if (!this.clearOfRoad(hw + 4) || h < 0.8) continue;
          if (this.season === 'autumn') C.setHex(rng.chance(0.5) ? 0xc9a234 : 0xb8742a);
          else if (this.season === 'winter') C.setHex(0x7a6a58);
          else C.setHex(this.season === 'spring' ? 0x86b84a : 0x5f8f38);
          this.place('vine', x, h - 0.05, z, F.heading, 1, C);
        }
      }
    }

    // --- animals
    const herd = (name: string, chance: number, nMin: number, nMax: number, spread: number) => {
      if (inTunnel || !rng.chance(chance)) return;
      const s0 = sRand();
      const side = rng.sign();
      const u0 = side * (hw + 16 + rng.range(0, 55));
      const n = rng.int(nMin, nMax);
      for (let j = 0; j < n; j++) {
        const F = this.at(s0 + rng.range(-spread, spread), u0 + rng.range(-spread, spread) * 0.6);
        const x = F.x;
        const z = F.z;
        const h = this.ground(x, z);
        if (!this.clearOfRoad(hw + 6) || h < 0.8) continue;
        const v = rng.next();
        if (name === 'cow') C.setRGB(v < 0.5 ? 1 : v < 0.8 ? 0.55 : 1.05, v < 0.5 ? 1 : v < 0.8 ? 0.42 : 0.95, v < 0.5 ? 1 : v < 0.8 ? 0.36 : 0.85);
        else C.setRGB(1, 1, 1);
        this.place(name, x, h, z, rng.range(0, 6.28), rng.range(0.9, 1.1), C);
      }
    };
    herd('cow', this.blended('cows'), 3, 8, 16);
    herd('sheep', this.blended('sheep'), 5, 12, 12);
    herd('marmot', this.blended('marmots'), 2, 4, 5);

    // --- rocks
    const rocks = Math.round(this.blended('rocks') * rng.range(0.5, 1.5));
    for (let j = 0; j < rocks; j++) {
      const F = this.at(sRand(), rng.sign() * (hw + 4 + Math.pow(rng.next(), 1.3) * 160));
      const x = F.x;
      const z = F.z;
      const h = this.ground(x, z);
      if (!this.clearOfRoad(hw + 3)) continue;
      const g = rng.range(0.8, 1.1);
      C.setRGB(g, g * 0.98, g * 0.95);
      this.place('rock', x, h - 0.2, z, rng.range(0, 6.28), rng.range(0.4, 2.6), C);
    }

    // --- hay bales
    if (!inTunnel && this.season !== 'winter' && this.season !== 'spring' && rng.chance(this.blended('haybales'))) {
      const s0 = sRand();
      const side = rng.sign();
      const u0 = hw + 15 + rng.range(0, 40);
      const wrapped = rng.chance(0.6);
      for (let j = 0; j < rng.int(3, 8); j++) {
        const F = this.at(s0 + j * 4 + rng.range(-1, 1), side * (u0 + rng.range(-3, 3)));
        const h = this.ground(F.x, F.z);
        if (!this.clearOfRoad(hw + 6) || h < 0.6) continue;
        if (wrapped) C.setRGB(1, 1, 1);
        else C.setHex(0xd8b45a);
        this.place('haybale', F.x, h, F.z, F.heading + rng.range(-0.3, 0.3), 1, C);
      }
    }

    // --- roadside flags
    if (!inTunnel && rng.chance(this.blended('flags') * 0.5)) this.flagAt(sRand(), rng.sign() * (hw + 7 + rng.range(0, 6)), rng);

    // --- waterfalls on steep slopes
    if (rng.chance(this.blended('waterfalls'))) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const s = sRand();
        const side = rng.sign();
        const u = side * (hw + 25 + rng.range(0, 70));
        const F = this.at(s, u);
        const x = F.x;
        const z = F.z;
        const rx = F.rx * side;
        const rz = F.rz * side;
        const h = this.ground(x, z);
        if (!this.clearOfRoad(hw + 10)) continue;
        const hOut = this.ground(x + rx * 8, z + rz * 8);
        if ((hOut - h) / 8 < 0.75) continue;
        const rot = Math.atan2(-rx, -rz);
        const sc = rng.range(0.8, 1.4);
        this.place('waterfall', x + rx * 1.5, h - 1, z + rz * 1.5, rot, sc);
        for (let r = 0; r < 4; r++) this.place('rock', x - rx * 2 + rng.range(-3, 3), h - 0.4, z - rz * 2 + rng.range(-3, 3), rng.range(0, 6), rng.range(0.6, 1.4));
        break;
      }
    }

    // --- cable cars (Valais / Alpine)
    if (!inTunnel && rng.chance(this.blended('cableCars'))) this.cableCar(sRand(), rng);

    // --- boats on the lakes
    const boats = this.blended('boats');
    if (boats > 0.2) {
      const n = Math.round(boats * rng.range(0.3, 1.2));
      for (let j = 0; j < n; j++) {
        const side = rng.sign();
        const F = this.at(sRand(), side * (40 + Math.pow(rng.next(), 0.8) * 500));
        const x = F.x;
        const z = F.z;
        const h = this.sampler.heightAt(x, z, null, this.info);
        if (h > WATER_LEVEL - 3) continue;
        const steam = rng.chance(0.08);
        const name = steam ? 'steamer' : 'sailboat';
        const rot = rng.range(0, 6.28);
        const scale = steam ? 1 : rng.range(0.8, 1.3);
        const hs = this.place(name, x, WATER_LEVEL, z, rot, scale);
        cp.anim.push({ kind: 'boat', handles: hs, x, y: WATER_LEVEL, z, rot, scale, phase: rng.range(0, 6.28), drift: steam ? 3.5 : rng.range(0.3, 1.2), x2: 0, y2: 0, z2: 0 });
      }
    }
    this.current = null;
  }

  private building(kind: string, s: number, u: number, side: number, rng: RNG, fp: number): boolean {
    const F = this.at(s, u);
    const x = F.x;
    const z = F.z;
    const h0 = this.ground(x, z);
    if (!this.clearOfRoad(this.road.halfWidth + fp + 2)) return false;
    if (h0 < WATER_LEVEL + 1) return false;
    // also check the road side of the footprint
    const fx = x - F.rx * side * fp;
    const fz = z - F.rz * side * fp;
    const h1 = this.ground(fx, fz);
    if (!this.clearOfRoad(this.road.halfWidth + 2)) return false;
    const h2 = this.ground(x + F.rx * side * fp, z + F.rz * side * fp);
    const base = Math.min(h0, h1, h2) - 0.3;
    if (Math.max(h0, h1, h2) - base > 7) return false; // too steep
    // face the road
    const rot = Math.atan2(-F.rx * side, -F.rz * side) + rng.range(-0.25, 0.25);
    const g = rng.range(0.9, 1.05);
    if (kind === 'stoneHouse' && rng.chance(0.35)) C.setRGB(1.05, 0.92, 0.72); // ochre plaster
    else if (kind === 'apartment' || kind === 'villa') {
      const v = rng.next();
      C.setRGB(v < 0.3 ? 1 : 0.95 * g, v < 0.3 ? 0.95 : 0.95 * g, v < 0.3 ? 0.85 : 0.95 * g);
    } else C.setRGB(g, g, g);
    const pools = this.pools.get(kind)!;
    E.set(0, rot, 0);
    Q.setFromEuler(E);
    M.compose(P.set(x, base, z), Q, S.set(1, 1, 1));
    const lit = rng.next();
    for (let p = 0; p < pools.length; p++) {
      // part 1 = windows: tint decides lit (1) or dark (0.08)
      const col = p === 0 ? C : lit < 0.75 ? WIN_LIT : WIN_DARK;
      this.current!.handles.push(pools[p].alloc(M, col));
    }
    return true;
  }

  private flagAt(s: number, u: number, rng: RNG): void {
    const F = this.at(s, u);
    const h = this.ground(F.x, F.z);
    if (!this.clearOfRoad(this.road.halfWidth + 2) || h < 0.6) return;
    this.place('flag', F.x, h, F.z, rng.range(0, 6.28), 1);
  }

  private cableCar(s: number, rng: RNG): void {
    const road = this.road;
    const hw = road.halfWidth;
    const F0 = road.frameAt(s, this.frame);
    const fx = F0.x;
    const fz = F0.z;
    const rx = F0.rx;
    const rz = F0.rz;
    const hL = this.ground(fx - rx * 300, fz - rz * 300);
    const hR = this.ground(fx + rx * 300, fz + rz * 300);
    const side = hR > hL ? 1 : -1;
    const u0 = hw + 30;
    const L = rng.range(500, 850);
    const bx = fx + rx * side * u0;
    const bz = fz + rz * side * u0;
    const hb = this.ground(bx, bz);
    if (!this.clearOfRoad(hw + 10)) return;
    const tx = bx + rx * side * L;
    const tz = bz + rz * side * L;
    const ht = this.ground(tx, tz);
    if (ht - hb < 80) return;
    const rot = Math.atan2(rx * side, rz * side);
    this.place('station', bx, hb - 0.5, bz, rot, 1);
    this.place('station', tx, ht - 0.5, tz, rot, 1);
    const y0 = hb + 7.5;
    const y1 = ht + 7.5;
    // pylons
    const nP = Math.floor(L / 160);
    const pts: [number, number, number][] = [[bx, y0, bz]];
    for (let p = 1; p <= nP; p++) {
      const t = p / (nP + 1);
      const px = bx + (tx - bx) * t;
      const pz = bz + (tz - bz) * t;
      const g = this.ground(px, pz);
      const cy = y0 + (y1 - y0) * t;
      const hgt = Math.max(8, cy - g + 6);
      this.place('pylon', px, g - 0.5, pz, rot + Math.PI / 2, 1, undefined, hgt / 18);
      pts.push([px, g - 0.5 + hgt, pz]);
    }
    pts.push([tx, y1, tz]);
    // cable segments: the pylon mesh stretched thin between consecutive points
    for (let p = 0; p < pts.length - 1; p++) {
      const a = pts[p];
      const b = pts[p + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      const dir = P.set(dx / len, dy / len, dz / len);
      Q.setFromUnitVectors(UP, dir);
      M.compose(S.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), Q, CABLE_SCALE.set(0.04, len / 18, 0.04));
      // pylon geometry spans y = 0..18; shift so it is centred on the segment
      M.multiply(SHIFT_9);
      this.placeMatrix('pylon', M);
    }
    // two cabins moving in opposite directions
    for (let c = 0; c < 2; c++) {
      const hs = this.place('cabin', bx, y0, bz, rot, 1);
      this.current!.anim.push({ kind: 'cabin', handles: hs, x: bx, y: y0, z: bz, rot, scale: 1, phase: c * 0.5, drift: 0, x2: tx, y2: y1, z2: tz });
    }
  }

  /** Grass and flowers for chunk k (only near the car). */
  buildGrass(k: number): void {
    if (this.grass.has(k)) return;
    const cp: ChunkProps = { handles: [], anim: [] };
    this.grass.set(k, cp);
    this.current = cp;
    const road = this.road;
    const i0 = k * CHUNK;
    const i1 = Math.min(i0 + CHUNK, road.nFinal - 2);
    if (i1 <= i0 || this.grassDensity <= 0.01) {
      this.current = null;
      return;
    }
    const rng = new RNG(hashInts(k, 23, 5, this.seed));
    const hw = road.halfWidth;
    road.schedule.weights(((i0 + i1) / 2) * DS, this.w);
    const winter = this.season === 'winter';
    const n = Math.round(520 * this.grassDensity * (winter ? 0.25 : 1));
    const flowerChance = this.season === 'spring' ? 0.22 : this.season === 'summer' ? 0.1 : 0;
    const dry = this.blended('dryness');
    for (let j = 0; j < n; j++) {
      const s = (i0 + rng.next() * (i1 - i0)) * DS;
      const u = rng.sign() * (hw + SHOULDER_GAP + Math.pow(rng.next(), 1.7) * 55);
      const F = this.at(s, u);
      const flags = road.flags(F.i);
      if (flags & (F_TUNNEL | F_BRIDGE)) continue;
      const x = F.x;
      const z = F.z;
      const h = this.ground(x, z);
      if (!this.clearOfRoad(hw + 1.5) || h < 0.4) continue;
      if (rng.chance(flowerChance)) {
        const v = rng.next();
        C.setHex(v < 0.35 ? 0xffffff : v < 0.6 ? 0xf5d33a : v < 0.8 ? 0xa77ad8 : 0xe0483a);
        this.place('flower', x, h - 0.05, z, rng.range(0, 6.28), rng.range(0.8, 1.4), C);
      } else {
        grassTint(this.season, C);
        if (dry > 0.4) C.lerp(TMP_DRY, dry * 0.5);
        C.multiplyScalar(rng.range(0.8, 1.15));
        this.place('grass', x, h - 0.05, z, rng.range(0, 6.28), rng.range(0.8, 1.7), C);
      }
    }
    this.current = null;
  }

  removeMain(k: number): void {
    const cp = this.main.get(k);
    if (!cp) return;
    for (const h of cp.handles) h.pool.release(h);
    this.main.delete(k);
  }
  removeGrass(k: number): void {
    const cp = this.grass.get(k);
    if (!cp) return;
    for (const h of cp.handles) h.pool.release(h);
    this.grass.delete(k);
  }
  hasMain(k: number): boolean {
    return this.main.has(k);
  }
  hasGrass(k: number): boolean {
    return this.grass.has(k);
  }
  mainKeys(): IterableIterator<number> {
    return this.main.keys();
  }
  grassKeys(): IterableIterator<number> {
    return this.grass.keys();
  }

  clearAll(): void {
    for (const k of [...this.main.keys()]) this.removeMain(k);
    for (const k of [...this.grass.keys()]) this.removeGrass(k);
  }

  /** Animate boats and cable cars; flush dirty pools. */
  update(time: number): void {
    for (const cp of this.main.values()) {
      for (const a of cp.anim) {
        if (a.kind === 'boat') {
          const bob = Math.sin(time * 1.3 + a.phase) * 0.12;
          const roll = Math.sin(time * 0.9 + a.phase * 2) * 0.04;
          const dx = Math.sin(a.rot) * a.drift * Math.sin(time * 0.02 + a.phase) * 20;
          const dz = Math.cos(a.rot) * a.drift * Math.sin(time * 0.02 + a.phase) * 20;
          E.set(roll, a.rot, roll * 0.5);
          Q.setFromEuler(E);
          M.compose(P.set(a.x + dx, a.y + bob, a.z + dz), Q, S.set(a.scale, a.scale, a.scale));
          for (const h of a.handles) h.pool.set(h, M);
        } else {
          // ping-pong along the cable over ~70 s
          const t = 0.5 - 0.5 * Math.cos(time * 0.045 + a.phase * Math.PI);
          const x = a.x + (a.x2 - a.x) * t;
          const y = a.y + (a.y2 - a.y) * t - Math.sin(t * Math.PI) * 6;
          const z = a.z + (a.z2 - a.z) * t;
          E.set(0, a.rot, Math.sin(time * 0.7 + a.phase) * 0.02);
          Q.setFromEuler(E);
          M.compose(P.set(x, y, z), Q, S.set(1, 1, 1));
          for (const h of a.handles) h.pool.set(h, M);
        }
      }
    }
    modelMaterials().fallTex.offset.y = -time * 0.9;
    for (const pools of this.pools.values()) for (const p of pools) p.flush();
  }

  dispose(): void {
    this.clearAll();
    for (const pools of this.pools.values()) for (const p of pools) p.mesh.dispose();
  }

  stats(): number {
    let n = 0;
    for (const pools of this.pools.values()) n += pools[0].count;
    return n;
  }
}

const SHOULDER_GAP = 1.4;
const CABLE_SCALE = new THREE.Vector3();
const SHIFT_9 = new THREE.Matrix4().makeTranslation(0, -9, 0);
const WIN_LIT = new THREE.Color(1, 1, 1);
const WIN_DARK = new THREE.Color(0.08, 0.08, 0.1);
const TMP_DRY = new THREE.Color(0xb3a35a);
export type { Model };
