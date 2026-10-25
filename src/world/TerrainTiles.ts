/**
 * Streaming terrain: square tiles on a world grid, built around the car with
 * distance-based LOD, skirts to hide LOD cracks, pooled geometry buffers and
 * a per-frame time budget so building never causes hitches.
 */
import * as THREE from 'three';
import { BIOME_COUNT, BIOMES, type Palette } from './Biomes';
import { TerrainSampler, CARVE_R, type HeightInfo } from './Terrain';
import { Road, DS } from './Road';
import { seasonalPalette } from './Season';
import { lambert } from './Materials';
import { hash01 } from '../core/rng';
import { clamp, smoothstep } from '../core/math';
import type { Season } from '../core/Settings';
import { WATER_LEVEL } from './TerrainField';

export const TILE = 128;
const LOD_SEGS = [64, 32, 16, 8];

interface Tile {
  ix: number;
  iz: number;
  lod: number;
  mesh: THREE.Mesh | null;
  dirty: boolean;
  minH: number;
  wanted: boolean;
}

/** Shared index buffers per LOD (grid + skirt). */
const indexCache = new Map<number, THREE.BufferAttribute>();
function gridIndex(n: number): THREE.BufferAttribute {
  let idx = indexCache.get(n);
  if (idx) return idx;
  const vpr = n + 1;
  const quads = n * n + 4 * n;
  const arr = new Uint32Array(quads * 6);
  let p = 0;
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const a = z * vpr + x;
      const b = a + 1;
      const c = a + vpr;
      const d = c + 1;
      // alternate diagonal for a less regular look
      if ((x + z) & 1) {
        arr[p++] = a; arr[p++] = c; arr[p++] = b;
        arr[p++] = b; arr[p++] = c; arr[p++] = d;
      } else {
        arr[p++] = a; arr[p++] = c; arr[p++] = d;
        arr[p++] = a; arr[p++] = d; arr[p++] = b;
      }
    }
  }
  // skirts: ring of vertices after the grid, ordered along edges
  const base = vpr * vpr;
  const edge = (k: number, e: number) => {
    // returns grid index of k-th vertex on edge e (0:top z=0, 1:right x=n, 2:bottom z=n, 3:left x=0)
    switch (e) {
      case 0: return k;
      case 1: return k * vpr + n;
      case 2: return n * vpr + k;
      default: return k * vpr;
    }
  };
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < n; k++) {
      const g0 = edge(k, e);
      const g1 = edge(k + 1, e);
      const s0 = base + e * vpr + k;
      const s1 = s0 + 1;
      // winding chosen so the skirt faces outward; DoubleSide-free
      if (e === 0 || e === 1) {
        arr[p++] = g0; arr[p++] = g1; arr[p++] = s0;
        arr[p++] = g1; arr[p++] = s1; arr[p++] = s0;
      } else {
        arr[p++] = g0; arr[p++] = s0; arr[p++] = g1;
        arr[p++] = g1; arr[p++] = s0; arr[p++] = s1;
      }
    }
  }
  idx = new THREE.BufferAttribute(arr, 1);
  indexCache.set(n, idx);
  return idx;
}

export class TerrainTiles {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshLambertMaterial;
  private tiles = new Map<number, Tile>();
  private queue: Tile[] = [];
  private pools: THREE.BufferGeometry[][] = LOD_SEGS.map(() => []);
  private cornerW = new Map<number, Float32Array>();
  private palettes: Palette[] = [];
  private info: HeightInfo = { flatten: 0, roadDist: 0, nearest: -1, natural: 0, u: 0 };
  private wv = new Float32Array(BIOME_COUNT);
  private hbuf = new Float32Array((LOD_SEGS[0] + 3) ** 2);
  private fbuf = new Float32Array((LOD_SEGS[0] + 3) ** 2);
  private dbuf = new Float32Array((LOD_SEGS[0] + 3) ** 2);
  private carX = 0;
  private carZ = 0;
  radius = 1200;
  shadows = false;
  /** Lowest terrain height among loaded tiles – used to hide water when unneeded. */
  minLoadedHeight = 0;

  constructor(
    private road: Road,
    private sampler: TerrainSampler,
    season: Season,
  ) {
    this.material = lambert({ vertexColors: true });
    this.setSeason(season);
  }

  setSeason(season: Season): void {
    this.palettes = BIOMES.map((_, i) => seasonalPalette(i, season));
    this.season = season;
  }
  private season: Season = 'summer';

  private static key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  private lodFor(dist: number, current: number): number {
    // hysteresis: only switch when clearly past the boundary
    const bounds = [200, 460, 900];
    let lod = 3;
    for (let i = 0; i < 3; i++) {
      if (dist < bounds[i] + (current >= 0 && current <= i ? 30 : -30)) {
        lod = i;
        break;
      }
    }
    return lod;
  }

  /** Mark tiles intersecting newly finalised road samples dirty. */
  onRoadFinal(i0: number, i1: number): void {
    const R = CARVE_R + 10;
    for (let i = i0; i < i1; i += 16) this.sampler.invalidateCarve(this.road.x(i), this.road.z(i), R);
    let lastKey = -1;
    for (let i = i0; i < i1; i += 3) {
      const x = this.road.x(i);
      const z = this.road.z(i);
      const ix0 = Math.floor((x - R) / TILE);
      const ix1 = Math.floor((x + R) / TILE);
      const iz0 = Math.floor((z - R) / TILE);
      const iz1 = Math.floor((z + R) / TILE);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = TerrainTiles.key(ix, iz);
          if (k === lastKey) continue;
          lastKey = k;
          const t = this.tiles.get(k);
          if (t && t.mesh && !t.dirty) {
            t.dirty = true;
            this.queue.push(t);
          }
        }
      }
    }
  }

  /** Recompute which tiles are wanted around the car. Cheap; call ~4×/s. */
  refresh(carX: number, carZ: number): void {
    this.carX = carX;
    this.carZ = carZ;
    const r = this.radius;
    const ix0 = Math.floor((carX - r) / TILE);
    const ix1 = Math.floor((carX + r) / TILE);
    const iz0 = Math.floor((carZ - r) / TILE);
    const iz1 = Math.floor((carZ + r) / TILE);
    for (const t of this.tiles.values()) t.wanted = false;
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const cx = (ix + 0.5) * TILE;
        const cz = (iz + 0.5) * TILE;
        const d = Math.hypot(cx - carX, cz - carZ) - TILE * 0.5;
        if (d > r) continue;
        const k = TerrainTiles.key(ix, iz);
        let t = this.tiles.get(k);
        if (!t) {
          t = { ix, iz, lod: -1, mesh: null, dirty: true, minH: 0, wanted: true };
          this.tiles.set(k, t);
          this.queue.push(t);
        }
        t.wanted = true;
        const lod = this.lodFor(Math.max(0, d), t.lod);
        if (lod !== t.lod && !t.dirty) {
          t.dirty = true;
          this.queue.push(t);
        }
      }
    }
    // remove unwanted
    let minH = 1e9;
    for (const [k, t] of this.tiles) {
      if (!t.wanted) {
        this.release(t);
        this.tiles.delete(k);
      } else if (t.mesh) minH = Math.min(minH, t.minH);
    }
    this.minLoadedHeight = minH;
    // sort queue: nearest first, drop removed
    this.queue = this.queue.filter((t) => t.wanted && t.dirty && this.tiles.get(TerrainTiles.key(t.ix, t.iz)) === t);
    const dist = (t: Tile) => Math.hypot((t.ix + 0.5) * TILE - carX, (t.iz + 0.5) * TILE - carZ);
    this.queue.sort((a, b) => dist(a) - dist(b));
    // de-dup
    let w = 0;
    for (let i = 0; i < this.queue.length; i++) if (this.queue.indexOf(this.queue[i]) === i) this.queue[w++] = this.queue[i];
    this.queue.length = w;
    // drop corner cache entries far away
    if (this.cornerW.size > 4000) this.cornerW.clear();
  }

  /** Build queued tiles until the time budget (ms) is used. Returns remaining count. */
  update(budgetMs: number): number {
    const t0 = performance.now();
    while (this.queue.length > 0) {
      const t = this.queue.shift()!;
      if (!t.wanted || !t.dirty) continue;
      this.build(t);
      if (performance.now() - t0 > budgetMs) break;
    }
    return this.queue.length;
  }

  pending(): number {
    return this.queue.length;
  }

  /** Rebuild everything (season change, road settings…). */
  invalidateAll(): void {
    for (const t of this.tiles.values()) {
      if (!t.dirty) {
        t.dirty = true;
        this.queue.push(t);
      }
    }
    this.refresh(this.carX, this.carZ);
  }

  dispose(): void {
    for (const t of this.tiles.values()) this.release(t);
    this.tiles.clear();
    this.queue.length = 0;
    for (const p of this.pools) for (const g of p) g.dispose();
  }

  private release(t: Tile): void {
    if (t.mesh) {
      this.group.remove(t.mesh);
      this.pools[t.lod].push(t.mesh.geometry as THREE.BufferGeometry);
      t.mesh = null;
    }
  }

  private corner(ix: number, iz: number): Float32Array {
    const k = TerrainTiles.key(ix, iz);
    let w = this.cornerW.get(k);
    if (!w) {
      w = new Float32Array(BIOME_COUNT);
      const i = this.road.nearestIndexCoarse(ix * TILE, iz * TILE);
      this.road.schedule.weights(i * DS, w);
      this.cornerW.set(k, w);
    }
    return w;
  }

  private build(t: Tile): void {
    const d = Math.max(0, Math.hypot((t.ix + 0.5) * TILE - this.carX, (t.iz + 0.5) * TILE - this.carZ) - TILE * 0.5);
    const lod = this.lodFor(d, t.lod);
    const n = LOD_SEGS[lod];
    const step = TILE / n;
    const x0 = t.ix * TILE;
    const z0 = t.iz * TILE;
    const N = n + 3; // with 1-vertex ring for normals
    const w00 = this.corner(t.ix, t.iz);
    const w10 = this.corner(t.ix + 1, t.iz);
    const w01 = this.corner(t.ix, t.iz + 1);
    const w11 = this.corner(t.ix + 1, t.iz + 1);
    const wv = this.wv;
    const hb = this.hbuf;
    const info = this.info;
    let minH = 1e9;
    for (let gz = 0; gz < N; gz++) {
      const fz = clamp((gz - 1) / n, 0, 1);
      for (let gx = 0; gx < N; gx++) {
        const fx = clamp((gx - 1) / n, 0, 1);
        for (let b = 0; b < BIOME_COUNT; b++) {
          const top = w00[b] + (w10[b] - w00[b]) * fx;
          const bot = w01[b] + (w11[b] - w01[b]) * fx;
          wv[b] = top + (bot - top) * fz;
        }
        const x = x0 + (gx - 1) * step;
        const z = z0 + (gz - 1) * step;
        const h = this.sampler.heightAt(x, z, wv, info);
        const k = gz * N + gx;
        hb[k] = h;
        this.fbuf[k] = info.flatten;
        this.dbuf[k] = info.roadDist;
        if (gx > 0 && gz > 0 && gx < N - 1 && gz < N - 1 && h < minH) minH = h;
      }
    }

    const vpr = n + 1;
    const vcount = vpr * vpr + 4 * vpr;
    let geo = this.pools[lod].pop();
    if (!geo) {
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3));
      geo.setIndex(gridIndex(n));
    }
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const P = pos.array as Float32Array;
    const NO = nor.array as Float32Array;
    const CO = col.array as Float32Array;
    const noise = this.road.field.noise;
    const hw = this.road.halfWidth;
    const pal = this.palettes;
    const winter = this.season === 'winter';
    const seasonSnow = this.season === 'winter' ? -400 : this.season === 'spring' ? -60 : this.season === 'autumn' ? -20 : 0;

    for (let z = 0; z <= n; z++) {
      for (let x = 0; x <= n; x++) {
        const gx = x + 1;
        const gz = z + 1;
        const k = gz * N + gx;
        const h = hb[k];
        const vi = z * vpr + x;
        P[vi * 3] = x * step;
        P[vi * 3 + 1] = h;
        P[vi * 3 + 2] = z * step;
        let nx = hb[k - 1] - hb[k + 1];
        let nz = hb[k - N] - hb[k + N];
        let ny = 2 * step;
        const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= il;
        ny *= il;
        nz *= il;
        NO[vi * 3] = nx;
        NO[vi * 3 + 1] = ny;
        NO[vi * 3 + 2] = nz;

        // ----- colour -----
        const wx = x0 + x * step;
        const wz = z0 + z * step;
        const fx = x / n;
        const fz = z / n;
        let r = 0;
        let g = 0;
        let bl = 0;
        let snowLine = 0;
        let forestThr = 0;
        let forestScale = 0;
        let dryness = 0;
        let waterBiome = 0;
        for (let b = 0; b < BIOME_COUNT; b++) {
          const top = w00[b] + (w10[b] - w00[b]) * fx;
          const bot = w01[b] + (w11[b] - w01[b]) * fx;
          const wb = top + (bot - top) * fz;
          wv[b] = wb;
          if (wb < 0.002) continue;
          const def = BIOMES[b];
          snowLine += wb * def.snowLine;
          forestThr += wb * def.forestThreshold;
          forestScale += wb * def.forestScale;
          dryness += wb * def.dryness;
          if (def.boats > 0) waterBiome += wb;
        }
        // base grass with variation & field patchwork
        const v1 = noise.n2(wx / 47, wz / 47);
        const cellX = Math.floor((wx + 40 * noise.n2(wz / 260, wx / 260)) / 62);
        const cellZ = Math.floor((wz + 40 * noise.n2(wx / 240, wz / 240)) / 48);
        const patch = hash01(cellX, cellZ, 7, 99);
        const forest = smoothstep(forestThr, forestThr + 0.16, noise.fbm(wx / forestScale, wz / forestScale, 2));
        const slope = 1 - ny;
        for (let b = 0; b < BIOME_COUNT; b++) {
          const wb = wv[b];
          if (wb < 0.002) continue;
          const p = pal[b];
          const t = smoothstep(-0.4, 0.6, v1);
          let cr = p.grass.r + (p.grass2.r - p.grass.r) * t;
          let cg = p.grass.g + (p.grass2.g - p.grass.g) * t;
          let cb = p.grass.b + (p.grass2.b - p.grass.b) * t;
          // patchwork fields (stronger where dry / agricultural)
          const fieldAmt = patch < 0.18 + dryness * 0.35 ? 0.75 : patch > 0.85 ? -0.12 : 0;
          if (fieldAmt > 0) {
            cr += (p.dry.r - cr) * fieldAmt;
            cg += (p.dry.g - cg) * fieldAmt;
            cb += (p.dry.b - cb) * fieldAmt;
          } else if (fieldAmt < 0) {
            cr *= 0.9;
            cg *= 0.95;
            cb *= 0.85;
          }
          // forest floor tint
          const fa = forest * 0.85;
          cr += (p.forest.r - cr) * fa;
          cg += (p.forest.g - cg) * fa;
          cb += (p.forest.b - cb) * fa;
          // rock on slopes
          const ra = smoothstep(0.22, 0.42, slope + v1 * 0.04);
          cr += (p.rock.r - cr) * ra;
          cg += (p.rock.g - cg) * ra;
          cb += (p.rock.b - cb) * ra;
          // shore sand / underwater
          if (waterBiome > 0.05) {
            const sa = smoothstep(2.2, 0.6, h - WATER_LEVEL) * 0.85;
            cr += (p.sand.r - cr) * sa;
            cg += (p.sand.g - cg) * sa;
            cb += (p.sand.b - cb) * sa;
          }
          r += wb * cr;
          g += wb * cg;
          bl += wb * cb;
        }
        // snow cover
        const sl = snowLine + seasonSnow;
        let snow = smoothstep(sl - 25, sl + 35, h + 18 * v1) * (1 - smoothstep(0.45, 0.75, slope) * 0.75);
        if (winter) snow = Math.max(snow, 0.92 * (1 - smoothstep(0.35, 0.7, slope)) * (1 - forest * 0.35));
        if (snow > 0) {
          r += (0.86 - r) * snow;
          g += (0.89 - g) * snow;
          bl += (0.95 - bl) * snow;
        }
        // road verge: gravel/dirt
        const fl = this.fbuf[k];
        const rd = this.dbuf[k];
        if (fl > 0.5 && rd < hw + 3.2) {
          const va = smoothstep(hw + 3.2, hw + 1.0, rd) * (winter ? 0.6 : 0.85);
          r += (0.33 - r) * va;
          g += (0.31 - g) * va;
          bl += (0.28 - bl) * va;
        }
        if (h < WATER_LEVEL - 0.3) {
          const da = smoothstep(-0.3, -6, h - WATER_LEVEL);
          r *= 1 - 0.55 * da;
          g *= 1 - 0.45 * da;
          bl *= 1 - 0.35 * da;
        }
        // subtle grain
        const grain = 1 + 0.06 * noise.n2(wx / 9.3, wz / 9.3);
        CO[vi * 3] = r * grain;
        CO[vi * 3 + 1] = g * grain;
        CO[vi * 3 + 2] = bl * grain;
      }
    }
    // skirts
    const base = vpr * vpr;
    const drop = step * 0.6 + 1.5;
    for (let e = 0; e < 4; e++) {
      for (let k = 0; k <= n; k++) {
        let gi: number;
        switch (e) {
          case 0: gi = k; break;
          case 1: gi = k * vpr + n; break;
          case 2: gi = n * vpr + k; break;
          default: gi = k * vpr;
        }
        const si = base + e * vpr + k;
        P[si * 3] = P[gi * 3];
        P[si * 3 + 1] = P[gi * 3 + 1] - drop;
        P[si * 3 + 2] = P[gi * 3 + 2];
        NO[si * 3] = NO[gi * 3];
        NO[si * 3 + 1] = NO[gi * 3 + 1];
        NO[si * 3 + 2] = NO[gi * 3 + 2];
        CO[si * 3] = CO[gi * 3];
        CO[si * 3 + 1] = CO[gi * 3 + 1];
        CO[si * 3 + 2] = CO[gi * 3 + 2];
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    if (t.mesh && t.lod !== lod) this.release(t);
    if (t.mesh) {
      // same LOD rebuild: swap geometry
      const old = t.mesh.geometry as THREE.BufferGeometry;
      if (old !== geo) this.pools[lod].push(old);
      t.mesh.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(x0, 0, z0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.receiveShadow = true;
      mesh.castShadow = this.shadows;
      this.group.add(mesh);
      t.mesh = mesh;
    }
    t.lod = lod;
    t.dirty = false;
    t.minH = minH;
  }

  get count(): number {
    return this.tiles.size;
  }
}
