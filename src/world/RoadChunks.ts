/**
 * Builds the meshes for one road chunk (CHUNK samples ≈ 128 m):
 *  - asphalt ribbon (banked, textured, darkened inside tunnels)
 *  - "detail" mesh (vertex-coloured): gravel shoulders, delineator posts,
 *    guardrails, bridge decks/parapets/pillars/arches, tunnel portals,
 *    wooden fences, dry-stone walls, ballast, rails and catenary masts
 *  - unlit tunnel tube with lamps
 *  - railway track ribbon
 * All positions are relative to the chunk origin so float32 stays precise
 * hundreds of kilometres into a journey.
 */
import * as THREE from 'three';
import { Road, DS, F_BRIDGE, F_HAIRPIN, F_RAIL, F_TUNNEL, RAIL_OFFSET } from './Road';
import { TerrainSampler, SHOULDER } from './Terrain';
import { GeoBuilder } from './GeoBuilder';
import { CHUNK } from './Props';
import { BIOMES, BIOME_COUNT } from './Biomes';
import { lambert, basic, standard } from './Materials';
import { roadTexture, trackTexture, ROAD_TEX_LEN } from './Textures';
import { RNG, hashInts } from '../core/rng';
import { clamp } from '../core/math';

const PILLAR_EVERY = 12;
const TRACK_TEX_LEN = 6;

export class RoadChunks {
  readonly group = new THREE.Group();
  private chunks = new Map<number, THREE.Group>();
  readonly roadMat: THREE.MeshStandardMaterial;
  readonly detailMat: THREE.MeshLambertMaterial;
  readonly tunnelMat: THREE.MeshBasicMaterial;
  readonly trackMat: THREE.MeshLambertMaterial;
  private texMarked = roadTexture(true);
  private texPlain = roadTexture(false);
  guardrails = true;
  castShadows = false;
  private w = new Float32Array(BIOME_COUNT);

  constructor(
    private road: Road,
    private sampler: TerrainSampler,
    private seed: number,
  ) {
    this.roadMat = standard({ map: this.texMarked, vertexColors: true, roughness: 0.88, metalness: 0.0 });
    this.detailMat = lambert({ vertexColors: true }, { snowable: true });
    this.tunnelMat = basic({ vertexColors: true });
    this.trackMat = lambert({ map: trackTexture() });
  }

  setMarkings(on: boolean): void {
    this.roadMat.map = on ? this.texMarked : this.texPlain;
    this.roadMat.needsUpdate = true;
  }

  has(k: number): boolean {
    return this.chunks.has(k);
  }
  keys(): IterableIterator<number> {
    return this.chunks.keys();
  }

  remove(k: number): void {
    const g = this.chunks.get(k);
    if (!g) return;
    this.group.remove(g);
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.chunks.delete(k);
  }

  clearAll(): void {
    for (const k of [...this.chunks.keys()]) this.remove(k);
  }

  setShadows(cast: boolean, receive: boolean): void {
    this.castShadows = cast;
    for (const g of this.chunks.values()) {
      for (const o of g.children) {
        const m = o as THREE.Mesh;
        m.receiveShadow = receive && m.material !== this.tunnelMat;
        if (m.material === this.detailMat) m.castShadow = cast;
      }
    }
  }

  build(k: number): void {
    if (this.chunks.has(k)) return;
    const road = this.road;
    const i0 = k * CHUNK;
    const i1 = Math.min(i0 + CHUNK, road.nFinal - 2);
    if (i1 <= i0 || i0 < road.baseIndex) return;
    const n = i1 - i0 + 1;
    const hw = road.halfWidth;
    const ox = road.x(i0);
    const oz = road.z(i0);
    const rng = new RNG(hashInts(k, 7, 1, this.seed));
    road.schedule.weights(((i0 + i1) / 2) * DS, this.w);
    let dom = 0;
    for (let b = 1; b < BIOME_COUNT; b++) if (this.w[b] > this.w[dom]) dom = b;
    const biome = BIOMES[dom];
    const railSide = road.railSideAt(i0);

    // ---- per-row frame cache
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    const Z = new Float64Array(n);
    const RX = new Float64Array(n);
    const RZ = new Float64Array(n);
    const FX = new Float64Array(n);
    const FZ = new Float64Array(n);
    const B = new Float64Array(n);
    const FL = new Uint8Array(n);
    const LIGHT = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const i = i0 + j;
      X[j] = road.x(i) - ox;
      Z[j] = road.z(i) - oz;
      Y[j] = road.y(i);
      const h = road.heading(i);
      FX[j] = Math.sin(h);
      FZ[j] = Math.cos(h);
      RX[j] = -FZ[j];
      RZ[j] = FX[j];
      B[j] = road.bank(i);
      FL[j] = road.flags(i);
      // tunnel darkness with a soft ramp at portals
      if (FL[j] & F_TUNNEL) {
        let d = 8;
        for (let q = 1; q <= 8; q++) {
          if (!(road.flags(Math.max(road.baseIndex, i - q)) & F_TUNNEL) || !(road.flags(Math.min(road.nFinal - 1, i + q)) & F_TUNNEL)) {
            d = q;
            break;
          }
        }
        LIGHT[j] = 1 - 0.68 * Math.min(1, d / 6);
      } else LIGHT[j] = 1;
    }
    // world-space helpers (relative to chunk origin)
    const px = (j: number, u: number) => X[j] + RX[j] * u;
    const pz = (j: number, u: number) => Z[j] + RZ[j] * u;
    const py = (j: number, u: number) => Y[j] + clamp(u, -hw, hw) * B[j];
    const ground = (j: number, u: number) => this.sampler.heightAt(px(j, u) + ox, pz(j, u) + oz, null);

    const surf = new GeoBuilder();
    const det = new GeoBuilder();
    const tun = new GeoBuilder();
    const trk = new GeoBuilder();

    /**
     * Ribbon between two lateral profiles a(j) → b(j). Normal = (b - a) × forward,
     * i.e. a floor when b is right of a, a left-facing wall when b is above a.
     */
    const ribbon = (
      gb: GeoBuilder,
      ja: number,
      jb: number,
      a: (j: number) => [number, number, number],
      b: (j: number) => [number, number, number],
      color?: (j: number, side: 0 | 1) => void,
      uvs?: (j: number, side: 0 | 1) => [number, number],
    ) => {
      if (jb <= ja) return;
      const start = gb.vertexCount;
      for (let j = ja; j <= jb; j++) {
        const A = a(j);
        const Bp = b(j);
        const ex = Bp[0] - A[0];
        const ey = Bp[1] - A[1];
        const ez = Bp[2] - A[2];
        // (e) × f   with f = (FX, 0, FZ)
        let nx = ey * FZ[j];
        let ny = ez * FX[j] - ex * FZ[j];
        let nz = -ey * FX[j];
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        if (color) color(j, 0);
        const uvA = uvs ? uvs(j, 0) : [0, 0];
        gb.vertex(A[0], A[1], A[2], nx, ny, nz, uvA[0], uvA[1]);
        if (color) color(j, 1);
        const uvB = uvs ? uvs(j, 1) : [1, 0];
        gb.vertex(Bp[0], Bp[1], Bp[2], nx, ny, nz, uvB[0], uvB[1]);
      }
      for (let j = 0; j < jb - ja; j++) {
        const a0 = start + j * 2;
        const b0 = a0 + 1;
        const a1 = a0 + 2;
        const b1 = a0 + 3;
        gb.tri(a0, b0, a1);
        gb.tri(b0, b1, a1);
      }
    };

    /** Iterate maximal runs of rows where pred(j) holds. */
    const runs = (pred: (j: number) => boolean, fn: (ja: number, jb: number) => void) => {
      let s = -1;
      for (let j = 0; j <= n; j++) {
        const ok = j < n && pred(j);
        if (ok && s < 0) s = j;
        if (!ok && s >= 0) {
          fn(s, j - 1);
          s = -1;
        }
      }
    };

    // ---- asphalt
    const vBase = Math.floor(i0 / 6000) * 6000;
    ribbon(
      surf,
      0,
      n - 1,
      (j) => [px(j, -hw), py(j, -hw), pz(j, -hw)],
      (j) => [px(j, hw), py(j, hw), pz(j, hw)],
      (j) => surf.rgb(LIGHT[j], LIGHT[j], LIGHT[j]),
      (j, side) => [side, ((i0 + j - vBase) * DS) / ROAD_TEX_LEN],
    );

    // ---- shoulders: gravel normally, concrete curb on bridges/tunnels
    const isStruct = (j: number) => (FL[j] & (F_BRIDGE | F_TUNNEL)) !== 0;
    for (const side of [-1, 1] as const) {
      const inner = side * hw;
      const outer = side * (hw + SHOULDER);
      const drop = (j: number) => (isStruct(j) ? 0.12 : -0.13);
      const col = (j: number) => {
        if (FL[j] & F_BRIDGE) det.rgb(0.55, 0.55, 0.53);
        else if (FL[j] & F_TUNNEL) det.rgb(0.42 * LIGHT[j], 0.42 * LIGHT[j], 0.41 * LIGHT[j]);
        else {
          const v = 0.42 + 0.05 * Math.sin((i0 + j) * 1.7);
          det.rgb(v, v * 0.96, v * 0.9);
        }
      };
      const A = (j: number): [number, number, number] =>
        side < 0 ? [px(j, outer), py(j, inner) + drop(j), pz(j, outer)] : [px(j, inner), py(j, inner), pz(j, inner)];
      const Bf = (j: number): [number, number, number] =>
        side < 0 ? [px(j, inner), py(j, inner), pz(j, inner)] : [px(j, outer), py(j, inner) + drop(j), pz(j, outer)];
      ribbon(det, 0, n - 1, A, Bf, (j) => col(j));
    }

    // ---- guardrail requirement per side
    const needRail: [Uint8Array, Uint8Array] = [new Uint8Array(n), new Uint8Array(n)];
    if (this.guardrails) {
      for (let j = 0; j < n; j += 2) {
        if (FL[j] & (F_BRIDGE | F_TUNNEL)) continue;
        for (let si = 0; si < 2; si++) {
          const side = si === 0 ? -1 : 1;
          const h = ground(j, side * (hw + 4.5));
          const drop = Y[j] - h;
          if (drop > 2.0 || (FL[j] & F_HAIRPIN && drop > 0.6)) {
            needRail[si][j] = 1;
            if (j + 1 < n) needRail[si][j + 1] = 1;
          }
        }
      }
      // dilate and remove short runs
      for (let si = 0; si < 2; si++) {
        const src = needRail[si].slice();
        for (let j = 0; j < n; j++) {
          let any = 0;
          for (let q = -3; q <= 3; q++) if (j + q >= 0 && j + q < n && src[j + q]) any = 1;
          needRail[si][j] = any && !(FL[j] & (F_BRIDGE | F_TUNNEL)) ? 1 : 0;
        }
      }
    }

    // ---- guardrails
    for (let si = 0; si < 2; si++) {
      const side = si === 0 ? -1 : 1;
      const u = side * (hw + SHOULDER * 0.75);
      runs(
        (j) => needRail[si][j] === 1,
        (ja, jb) => {
          if (jb - ja < 4) return;
          const base = (j: number) => py(j, side * hw) - 0.05;
          det.rgb(0.72, 0.74, 0.76);
          const lo = (j: number): [number, number, number] => [px(j, u), base(j) + 0.42, pz(j, u)];
          const hi = (j: number): [number, number, number] => [px(j, u), base(j) + 0.78, pz(j, u)];
          // road-facing side and back side
          if (side > 0) {
            ribbon(det, ja, jb, lo, hi);
            ribbon(det, ja, jb, hi, lo);
          } else {
            ribbon(det, ja, jb, hi, lo);
            ribbon(det, ja, jb, lo, hi);
          }
          det.rgb(0.45, 0.46, 0.48);
          for (let j = ja; j <= jb; j += 2) {
            const uu = u + side * 0.12;
            det.box(px(j, uu), base(j) + 0.36, pz(j, uu), 0.06, 0.4, 0.06, FX[j], FZ[j]);
          }
        },
      );
    }

    // ---- delineator posts (white with black band) every 50 m where no guardrail
    for (let j = 0; j < n; j++) {
      const i = i0 + j;
      if (i % 25 !== 0 || FL[j] & (F_BRIDGE | F_TUNNEL)) continue;
      for (let si = 0; si < 2; si++) {
        if (needRail[si][j]) continue;
        const side = si === 0 ? -1 : 1;
        const u = side * (hw + SHOULDER + 0.35);
        const by = py(j, side * hw) - 0.15;
        det.rgb(0.92, 0.92, 0.9).box(px(j, u), by + 0.5, pz(j, u), 0.06, 0.5, 0.06, FX[j], FZ[j]);
        det.rgb(0.08, 0.08, 0.08).box(px(j, u), by + 0.86, pz(j, u), 0.065, 0.08, 0.065, FX[j], FZ[j]);
        det.rgb(side > 0 ? 1.0 : 0.95, side > 0 ? 0.5 : 0.95, side > 0 ? 0.1 : 0.95).box(px(j, u) - FX[j] * 0.066, by + 0.75, pz(j, u) - FZ[j] * 0.066, 0.03, 0.03, 0.005, FX[j], FZ[j]);
      }
    }

    // ---- bridges
    const stone = biome.bridgeStyle === 'stone';
    const deckOut = hw + 1.25;
    const deckIn = hw + 0.95;
    const deckDepth = stone ? 1.0 : 1.4;
    runs(
      (j) => (FL[j] & F_BRIDGE) !== 0,
      (ja, jb) => {
        const wall = stone ? [0.56, 0.52, 0.47] : [0.62, 0.62, 0.6];
        for (const side of [-1, 1] as const) {
          const top = (j: number) => py(j, side * hw) + 0.95;
          const bot = (j: number) => py(j, side * hw) - deckDepth;
          const uin = side * deckIn;
          const uout = side * deckOut;
          det.rgb(wall[0], wall[1], wall[2]);
          // inner face (towards road), top, outer face (down to deck bottom)
          const inLo = (j: number): [number, number, number] => [px(j, uin), py(j, side * hw) + 0.1, pz(j, uin)];
          const inHi = (j: number): [number, number, number] => [px(j, uin), top(j), pz(j, uin)];
          const outHi = (j: number): [number, number, number] => [px(j, uout), top(j), pz(j, uout)];
          const outLo = (j: number): [number, number, number] => [px(j, uout), bot(j), pz(j, uout)];
          if (side > 0) {
            ribbon(det, ja, jb, inLo, inHi);
            ribbon(det, ja, jb, inHi, outHi);
            ribbon(det, ja, jb, outHi, outLo, () => det.rgb(wall[0] * 0.9, wall[1] * 0.9, wall[2] * 0.9));
          } else {
            ribbon(det, ja, jb, inHi, inLo);
            ribbon(det, ja, jb, outHi, inHi);
            ribbon(det, ja, jb, outLo, outHi, () => det.rgb(wall[0] * 0.9, wall[1] * 0.9, wall[2] * 0.9));
          }
          det.rgb(wall[0], wall[1], wall[2]);
        }
        // underside
        const archY = (j: number): number => {
          const i = i0 + j;
          const frac = (((i % PILLAR_EVERY) + PILLAR_EVERY) % PILLAR_EVERY) / PILLAR_EVERY;
          const deckBot = Y[j] - deckDepth;
          return stone ? deckBot - 0.4 - (1 - Math.sin(Math.PI * frac)) * 9 : deckBot;
        };
        det.rgb(wall[0] * 0.75, wall[1] * 0.75, wall[2] * 0.75);
        ribbon(
          det,
          ja,
          jb,
          (j) => [px(j, deckOut), archY(j), pz(j, deckOut)],
          (j) => [px(j, -deckOut), archY(j), pz(j, -deckOut)],
        );
        if (stone) {
          // spandrel walls between arch and deck
          det.rgb(wall[0] * 0.92, wall[1] * 0.92, wall[2] * 0.92);
          ribbon(det, ja, jb, (j) => [px(j, deckOut), Y[j] - deckDepth, pz(j, deckOut)], (j) => [px(j, deckOut), archY(j), pz(j, deckOut)]);
          ribbon(det, ja, jb, (j) => [px(j, -deckOut), archY(j), pz(j, -deckOut)], (j) => [px(j, -deckOut), Y[j] - deckDepth, pz(j, -deckOut)]);
        }
        // pillars
        const every = stone ? PILLAR_EVERY : 16;
        for (let j = ja; j <= jb; j++) {
          const i = i0 + j;
          if (i % every !== 0) continue;
          // skip the abutment ends
          if (!(road.flags(i - 3) & F_BRIDGE) || !(road.flags(i + 3) & F_BRIDGE)) continue;
          const g = ground(j, 0);
          const topY = stone ? archY(j) + 0.2 : Y[j] - deckDepth;
          const hgt = topY - g;
          if (hgt < 1.2) continue;
          const cy = g - 1.5 + (hgt + 1.5) / 2;
          if (stone) {
            det.rgb(wall[0] * 0.95, wall[1] * 0.95, wall[2] * 0.95).box(X[j], cy, Z[j], deckOut + 0.25, (hgt + 1.5) / 2, 1.4, FX[j], FZ[j], 0.9);
          } else {
            det.rgb(0.6, 0.6, 0.58).box(X[j], cy, Z[j], 1.9, (hgt + 1.5) / 2, 0.9, FX[j], FZ[j], 0.95);
          }
        }
      },
    );

    // ---- tunnels
    const prof: [number, number][] = [
      [-(hw + 1.5), -0.2],
      [-(hw + 1.5), 3.3],
      [-(hw + 0.7), 5.2],
      [-hw * 0.45, 6.25],
      [0, 6.5],
      [hw * 0.45, 6.25],
      [hw + 0.7, 5.2],
      [hw + 1.5, 3.3],
      [hw + 1.5, -0.2],
    ];
    runs(
      (j) => (FL[j] & F_TUNNEL) !== 0,
      (ja, jb) => {
        for (let p = 0; p < prof.length - 1; p++) {
          const pa = prof[p + 1];
          const pb = prof[p];
          const lower = p === 0 || p === prof.length - 2;
          ribbon(
            tun,
            ja,
            jb,
            (j) => [px(j, pa[0]), Y[j] + pa[1], pz(j, pa[0])],
            (j) => [px(j, pb[0]), Y[j] + pb[1], pz(j, pb[0])],
            (j) => {
              const i = i0 + j;
              const lamp = Math.exp(-(((i % 6) - 3) ** 2) / 3);
              const v = (lower ? 0.55 : 0.26) + lamp * 0.12;
              tun.rgb(v * 1.05, v * 0.98, v * 0.88);
            },
          );
        }
        // lamps: warm sodium strips on the ceiling
        for (let j = ja; j <= jb; j++) {
          if ((i0 + j) % 6 !== 0) continue;
          for (const u of [-hw * 0.35, hw * 0.35]) {
            tun.rgb(2.4, 1.6, 0.8).box(px(j, u), Y[j] + 6.15, pz(j, u), 0.18, 0.05, 1.1, FX[j], FZ[j]);
          }
        }
        // portals
        const portalCol = stone ? [0.55, 0.52, 0.48] : [0.66, 0.65, 0.62];
        const makePortal = (j: number, outward: 1 | -1) => {
          const shape = new THREE.Shape();
          shape.moveTo(-17, -2);
          shape.lineTo(17, -2);
          shape.lineTo(17, 13);
          shape.lineTo(-17, 13);
          shape.lineTo(-17, -2);
          const hole = new THREE.Path();
          hole.moveTo(prof[0][0], prof[0][1] - 1.8);
          for (let p = 0; p < prof.length; p++) hole.lineTo(prof[p][0] * 1.0, prof[p][1] + (p === 0 || p === prof.length - 1 ? -1.8 : 0.05));
          hole.lineTo(prof[0][0], prof[0][1] - 1.8);
          shape.holes.push(hole);
          const sg = new THREE.ShapeGeometry(shape, 6);
          const ox2 = outward > 0 ? FX[j] : -FX[j];
          const oz2 = outward > 0 ? FZ[j] : -FZ[j];
          // X axis = up × outward
          const ax = oz2;
          const az = -ox2;
          const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(ax, 0, az), new THREE.Vector3(0, 1, 0), new THREE.Vector3(ox2, 0, oz2));
          m.setPosition(X[j] + ox2 * 0.2, Y[j], Z[j] + oz2 * 0.2);
          det.rgb(portalCol[0], portalCol[1], portalCol[2]);
          det.geometry(sg, m);
          sg.dispose();
          // cornice
          det.rgb(portalCol[0] * 0.85, portalCol[1] * 0.85, portalCol[2] * 0.85);
          det.box(X[j] + ox2 * 0.8, Y[j] + 12.6, Z[j] + oz2 * 0.8, 17.5, 0.5, 0.9, FX[j], FZ[j]);
        };
        if (!(road.flags(i0 + ja - 1) & F_TUNNEL)) makePortal(ja, -1);
        if (!(road.flags(i0 + jb + 1) & F_TUNNEL)) makePortal(jb, 1);
      },
    );

    // ---- railway
    const ur = railSide * RAIL_OFFSET;
    runs(
      (j) => (FL[j] & F_RAIL) !== 0,
      (ja, jb) => {
        const ry = (j: number) => py(j, ur) + 0.05;
        // ballast top (textured)
        ribbon(
          trk,
          ja,
          jb,
          (j) => [px(j, ur - 1.6), ry(j), pz(j, ur - 1.6)],
          (j) => [px(j, ur + 1.6), ry(j), pz(j, ur + 1.6)],
          undefined,
          (j, side) => [side, ((i0 + j - vBase) * DS) / TRACK_TEX_LEN],
        );
        // ballast slopes
        det.rgb(0.42, 0.39, 0.35);
        ribbon(det, ja, jb, (j) => [px(j, ur - 2.5), ry(j) - 0.45, pz(j, ur - 2.5)], (j) => [px(j, ur - 1.6), ry(j), pz(j, ur - 1.6)]);
        ribbon(det, ja, jb, (j) => [px(j, ur + 1.6), ry(j), pz(j, ur + 1.6)], (j) => [px(j, ur + 2.5), ry(j) - 0.45, pz(j, ur + 2.5)]);
        // rails
        for (const g of [-0.72, 0.72]) {
          const a = ur + g - 0.04;
          const b = ur + g + 0.04;
          det.rgb(0.62, 0.6, 0.58);
          ribbon(det, ja, jb, (j) => [px(j, a), ry(j) + 0.17, pz(j, a)], (j) => [px(j, b), ry(j) + 0.17, pz(j, b)]);
          det.rgb(0.36, 0.3, 0.26);
          ribbon(det, ja, jb, (j) => [px(j, b), ry(j) + 0.17, pz(j, b)], (j) => [px(j, b), ry(j) + 0.02, pz(j, b)]);
          ribbon(det, ja, jb, (j) => [px(j, a), ry(j) + 0.02, pz(j, a)], (j) => [px(j, a), ry(j) + 0.17, pz(j, a)]);
        }
        // catenary masts + contact wire
        const um = ur + railSide * 2.6;
        for (let j = ja; j <= jb; j++) {
          if ((i0 + j) % 25 !== 0) continue;
          det.rgb(0.5, 0.52, 0.54).box(px(j, um), ry(j) + 3.4, pz(j, um), 0.12, 3.4, 0.12, FX[j], FZ[j]);
          const uarm = ur + railSide * 1.2;
          det.box(px(j, uarm), ry(j) + 6.3, pz(j, uarm), 0.06, 0.06, 1.5, RX[j], RZ[j]);
        }
        det.rgb(0.15, 0.15, 0.15);
        const w0 = ur - 0.03;
        const w1 = ur + 0.03;
        ribbon(det, ja, jb, (j) => [px(j, w1), ry(j) + 5.8, pz(j, w1)], (j) => [px(j, w0), ry(j) + 5.8, pz(j, w0)]);
        ribbon(det, ja, jb, (j) => [px(j, w0), ry(j) + 5.86, pz(j, w0)], (j) => [px(j, w1), ry(j) + 5.86, pz(j, w1)]);
      },
    );

    // ---- fences and dry-stone walls (chunk-level decisions)
    const fenceOK = (j: number, side: number) =>
      !(FL[j] & (F_BRIDGE | F_TUNNEL | F_HAIRPIN)) && !((FL[j] & F_RAIL) && side === railSide) && !needRail[side < 0 ? 0 : 1][j];
    for (const side of [-1, 1] as const) {
      if (rng.chance(biome.fences)) {
        const u = side * (hw + 5.5);
        let prev: [number, number, number] | null = null;
        for (let j = 0; j < n; j += 3) {
          if (!fenceOK(j, side)) {
            prev = null;
            continue;
          }
          const x = px(j, u);
          const z = pz(j, u);
          const g = this.sampler.heightAt(x + ox, z + oz, null);
          if (Math.abs(g - Y[j]) > 3.5) {
            prev = null;
            continue;
          }
          det.rgb(0.42, 0.3, 0.2).box(x, g + 0.55, z, 0.07, 0.65, 0.07, FX[j], FZ[j]);
          if (prev) {
            const mx = (x + prev[0]) / 2;
            const mz = (z + prev[2]) / 2;
            const my = (g + prev[1]) / 2;
            const dx = x - prev[0];
            const dz = z - prev[2];
            const len = Math.hypot(dx, dz);
            det.rgb(0.5, 0.37, 0.25);
            det.box(mx, my + 0.55, mz, 0.035, 0.05, len / 2, dx / len, dz / len);
            det.box(mx, my + 1.0, mz, 0.035, 0.05, len / 2, dx / len, dz / len);
          }
          prev = [x, g, z];
        }
      } else if (rng.chance(biome.stoneWalls)) {
        const u = side * (hw + 3.3);
        const gs = new Float64Array(n);
        for (let j = 0; j < n; j++) gs[j] = this.sampler.heightAt(px(j, u) + ox, pz(j, u) + oz, null);
        const t = 0.25;
        runs(
          (j) => fenceOK(j, side) && Math.abs(gs[j] - Y[j]) < 3,
          (ja, jb) => {
            if (jb - ja < 4) return;
            const col = (j: number) => {
              const v = 0.5 + 0.08 * Math.sin((i0 + j) * 2.3) + 0.05 * Math.sin((i0 + j) * 0.7);
              det.rgb(v, v * 0.97, v * 0.92);
            };
            const ui = u - side * t;
            const uo = u + side * t;
            const lo = (j: number, uu: number): [number, number, number] => [px(j, uu), gs[j] - 0.3, pz(j, uu)];
            const hi = (j: number, uu: number): [number, number, number] => [px(j, uu), gs[j] + 0.75, pz(j, uu)];
            if (side > 0) {
              ribbon(det, ja, jb, (j) => lo(j, ui), (j) => hi(j, ui), col);
              ribbon(det, ja, jb, (j) => hi(j, ui), (j) => hi(j, uo), col);
              ribbon(det, ja, jb, (j) => hi(j, uo), (j) => lo(j, uo), col);
            } else {
              ribbon(det, ja, jb, (j) => hi(j, ui), (j) => lo(j, ui), col);
              ribbon(det, ja, jb, (j) => hi(j, uo), (j) => hi(j, ui), col);
              ribbon(det, ja, jb, (j) => lo(j, uo), (j) => hi(j, uo), col);
            }
          },
        );
      }
    }

    // ---- assemble
    const grp = new THREE.Group();
    grp.position.set(ox, 0, oz);
    const add = (gb: GeoBuilder, mat: THREE.Material, receive: boolean, cast: boolean) => {
      if (gb.empty) return;
      const mesh = new THREE.Mesh(gb.build(), mat);
      mesh.receiveShadow = receive;
      mesh.castShadow = cast;
      mesh.matrixAutoUpdate = false;
      grp.add(mesh);
    };
    add(surf, this.roadMat, true, false);
    add(det, this.detailMat, true, this.castShadows);
    add(tun, this.tunnelMat, false, false);
    add(trk, this.trackMat, true, false);
    grp.updateMatrixWorld(true);
    this.group.add(grp);
    this.chunks.set(k, grp);
  }
}
