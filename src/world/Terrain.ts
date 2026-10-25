/**
 * Final terrain height: the natural field flattened into a smooth corridor
 * around the road (with cut/fill slopes), kept clear above tunnels and below
 * bridge decks. Used by terrain meshes, prop placement and car physics, so all
 * three agree exactly.
 */
import { Road, DS, CELL, F_BRIDGE, F_RAIL, F_TUNNEL, RAIL_OFFSET } from './Road';
import { BIOME_COUNT } from './Biomes';
import { smoothstep } from '../core/math';

export const BLEND = 20; // width of the cut/fill blend beyond the flat corridor
export const SHOULDER = 1.3;
/** Radius within which hills are carved back from the road (valley walls). */
export const CARVE_R = 190;
const CARVE_TILE = 128;
const CARVE_N = 16; // grid cells per carve tile (8 m)

export interface HeightInfo {
  flatten: number; // 0..1 how much the road corridor influenced this point
  roadDist: number; // distance to nearest road segment (≤ ~40 m, else large)
  nearest: number; // nearest sample index or -1
  natural: number;
  u: number; // signed lateral offset to nearest segment
}

export class TerrainSampler {
  private wRoad = new Float32Array(BIOME_COUNT);
  private wMix = new Float32Array(BIOME_COUNT);
  private lastWS = NaN;
  private railSide: number;
  /** Per-tile coarse grids of (distance to road, weighted road height). */
  private carveCache = new Map<number, Float32Array>();

  constructor(readonly road: Road) {
    this.railSide = road.railSideAt(0);
  }

  /** Biome weights at a sample index (cached for the last one queried). */
  private weightsAtIndex(i: number): Float32Array {
    const s = i * DS;
    if (s !== this.lastWS) {
      this.road.schedule.weights(s, this.wRoad);
      this.lastWS = s;
    }
    return this.wRoad;
  }

  /**
   * Height at world (x, z). `hint` are biome weights for points far from
   * the road (tiles pass interpolated corner weights); if null the nearest
   * road sample's weights are used, falling back to a coarse search.
   */
  heightAt(x: number, z: number, hint: Float32Array | null, info?: HeightInfo): number {
    const road = this.road;
    const hw = road.halfWidth;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const R = RAIL_OFFSET + 4 + BLEND;
    let maxW = 0;
    let sumW = 0;
    let sumT = 0;
    let dmin = 1e9;
    let imin = -1;
    let umin = 0;
    let minH = -1e9;
    let maxH = 1e9;
    const last = road.nFinal - 1;
    const base = road.baseIndex;
    for (let a = -1; a <= 1; a++) {
      for (let c = -1; c <= 1; c++) {
        const list = road.cellList(cx + a, cz + c);
        if (!list) continue;
        for (let n = 0; n < list.length; n++) {
          const i = list[n];
          if (i >= last || i < base) continue;
          const xi = road.x(i);
          const zi = road.z(i);
          const px = x - xi;
          const pz = z - zi;
          if (px > R || px < -R || pz > R || pz < -R) continue;
          const sx = road.x(i + 1) - xi;
          const sz = road.z(i + 1) - zi;
          const len2 = sx * sx + sz * sz;
          let t = (px * sx + pz * sz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = px - sx * t;
          const qz = pz - sz * t;
          const d = Math.sqrt(qx * qx + qz * qz);
          const invLen = 1 / Math.sqrt(len2);
          const u = (px * -sz + pz * sx) * invLen; // right vector = (-dz, dx)
          if (d < dmin) {
            dmin = d;
            imin = i;
            umin = u;
          }
          const f = road.flags(i);
          const yi = road.y(i) + (road.y(i + 1) - road.y(i)) * t;
          if (f & F_TUNNEL) {
            if (d < hw + 5) minH = Math.max(minH, yi + 8.5);
            continue;
          }
          if (f & F_BRIDGE) {
            if (d < hw + 4) maxH = Math.min(maxH, yi - 2.6);
            continue;
          }
          let plateau = hw + SHOULDER + 1.2;
          if (f & F_RAIL && u * this.railSide > 0) plateau = RAIL_OFFSET + 3.6;
          if (d >= plateau + BLEND) continue;
          const w = 1 - smoothstep(plateau, plateau + BLEND, d);
          const uc = u < -hw ? -hw : u > hw ? hw : u;
          const target = yi + uc * road.bank(i) - 0.24;
          const w2 = w * w * w;
          sumW += w2;
          sumT += w2 * target;
          if (w > maxW) maxW = w;
        }
      }
    }

    // biome weights
    let w: Float32Array;
    if (imin >= 0) {
      const wr = this.weightsAtIndex(imin);
      if (hint) {
        const f = 1 - smoothstep(12, R, dmin);
        for (let b = 0; b < BIOME_COUNT; b++) this.wMix[b] = hint[b] + (wr[b] - hint[b]) * f;
        w = this.wMix;
      } else w = wr;
    } else if (hint) {
      w = hint;
    } else {
      w = this.weightsAtIndex(road.nearestIndexCoarse(x, z));
    }

    let natural = road.field.natural(x, z, w);
    // carve hills back from the road: height may not exceed a valley-wall
    // profile rising from the road (smooth-min to avoid creases)
    const allowed = this.carveAllowed(x, z);
    if (allowed < natural + 8) {
      const k = 8;
      const hh = Math.max(k - Math.abs(natural - allowed), 0) / k;
      natural = Math.min(natural, allowed) - hh * hh * k * 0.25;
    }
    let h = natural;
    if (maxW > 0) h = natural + (sumT / sumW - natural) * maxW;
    if (h < minH) h = minH;
    if (h > maxH) h = maxH;
    if (info) {
      info.flatten = maxW;
      info.roadDist = dmin;
      info.nearest = imin;
      info.natural = natural;
      info.u = umin;
    }
    return h;
  }

  private static tileKey(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  /** Forget carve grids near a tile (road was extended nearby). */
  invalidateCarve(x: number, z: number, r: number): void {
    const ix0 = Math.floor((x - r) / CARVE_TILE);
    const ix1 = Math.floor((x + r) / CARVE_TILE);
    const iz0 = Math.floor((z - r) / CARVE_TILE);
    const iz1 = Math.floor((z + r) / CARVE_TILE);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) this.carveCache.delete(TerrainSampler.tileKey(ix, iz));
  }

  /** Maximum allowed terrain height at (x, z) from the carve grid. */
  private carveAllowed(x: number, z: number): number {
    const ix = Math.floor(x / CARVE_TILE);
    const iz = Math.floor(z / CARVE_TILE);
    const key = TerrainSampler.tileKey(ix, iz);
    let g = this.carveCache.get(key);
    if (!g) {
      g = this.buildCarve(ix, iz);
      this.carveCache.set(key, g);
      if (this.carveCache.size > 3000) {
        // drop the oldest quarter
        let n = 0;
        for (const k of this.carveCache.keys()) {
          this.carveCache.delete(k);
          if (++n > 750) break;
        }
      }
    }
    const fx = ((x - ix * CARVE_TILE) / CARVE_TILE) * CARVE_N;
    const fz = ((z - iz * CARVE_TILE) / CARVE_TILE) * CARVE_N;
    const x0 = Math.min(CARVE_N - 1, Math.floor(fx));
    const z0 = Math.min(CARVE_N - 1, Math.floor(fz));
    const tx = fx - x0;
    const tz = fz - z0;
    const N = CARVE_N + 1;
    const i00 = (z0 * N + x0) * 2;
    const i10 = i00 + 2;
    const i01 = i00 + N * 2;
    const i11 = i01 + 2;
    const lerp2 = (o: number) => {
      const a = g![i00 + o] + (g![i10 + o] - g![i00 + o]) * tx;
      const b = g![i01 + o] + (g![i11 + o] - g![i01 + o]) * tx;
      return a + (b - a) * tz;
    };
    const d = lerp2(0);
    if (d >= CARVE_R) return 1e9;
    const y = lerp2(1);
    const e = Math.max(0, d - (this.road.halfWidth + 6));
    return y + 2 + e * 0.55 + e * e * 0.0045;
  }

  private buildCarve(ix: number, iz: number): Float32Array {
    const road = this.road;
    const N = CARVE_N + 1;
    const out = new Float32Array(N * N * 2);
    const x0 = ix * CARVE_TILE;
    const z0 = iz * CARVE_TILE;
    // gather candidate samples (every other one) around the tile
    const cand: number[] = [];
    const c0x = Math.floor((x0 - CARVE_R) / CELL);
    const c1x = Math.floor((x0 + CARVE_TILE + CARVE_R) / CELL);
    const c0z = Math.floor((z0 - CARVE_R) / CELL);
    const c1z = Math.floor((z0 + CARVE_TILE + CARVE_R) / CELL);
    const last = road.nFinal - 1;
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = road.cellList(cx, cz);
        if (!list) continue;
        for (let n = 0; n < list.length; n++) {
          const i = list[n];
          if ((i & 1) || i >= last || i < road.baseIndex) continue;
          if (road.flags(i) & F_TUNNEL) continue;
          cand.push(road.x(i), road.z(i), road.y(i));
        }
      }
    }
    const R2 = CARVE_R * CARVE_R;
    for (let gz = 0; gz < N; gz++) {
      for (let gx = 0; gx < N; gx++) {
        const px = x0 + (gx / CARVE_N) * CARVE_TILE;
        const pz = z0 + (gz / CARVE_N) * CARVE_TILE;
        let dmin2 = R2;
        let sw = 0;
        let sy = 0;
        for (let c = 0; c < cand.length; c += 3) {
          const dx = cand[c] - px;
          const dz = cand[c + 1] - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= R2) continue;
          if (d2 < dmin2) dmin2 = d2;
          const w = 1 / (d2 + 400);
          sw += w;
          sy += w * cand[c + 2];
        }
        const o = (gz * N + gx) * 2;
        out[o] = Math.sqrt(dmin2);
        out[o + 1] = sw > 0 ? sy / sw : 0;
      }
    }
    return out;
  }
}
