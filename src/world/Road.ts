/**
 * Infinite, deterministic road centre-line.
 *
 * The road is a sequence of samples spaced DS metres apart. It is produced
 * by a multi-stage streaming pipeline, each stage lagging the previous one by
 * the look-ahead it needs:
 *
 *   1. XZ      – integrate curvature (noise + pull to a wandering base
 *                direction + lake-shore/valley contour following + hairpin
 *                switchback sequences) and sample the natural ground height.
 *   2. Avg     – moving average of ground height (removes bumps).
 *   3. Clamp   – forward pass limiting the grade and keeping above water.
 *   4. Y       – short smoothing so crests and dips are soft.
 *   5. Core    – detect deep cuts (tunnels) and high fills (bridges).
 *   6. Flags   – dilate bridges into abutments.
 *   7. Rail    – decide where a parallel railway can run.
 *   8. Final   – compute banking and insert into the spatial hash.
 *
 * Only *final* samples are used by meshes, terrain and physics. Because every
 * stage is a pure function of the seed and earlier samples, a seed always
 * reproduces exactly the same route.
 */
import { BiomeSchedule, BIOMES, BIOME_COUNT } from './Biomes';
import { TerrainField, WATER_LEVEL } from './TerrainField';
import { RNG } from '../core/rng';
import { clamp, smoothstep, wrapAngle } from '../core/math';

export const DS = 2; // metres between samples
const BB = 10; // block bits
const BLOCK = 1 << BB;
const BM = BLOCK - 1;

export const F_TUNNEL = 1;
export const F_BRIDGE = 2;
export const F_RAIL = 4;
export const F_HAIRPIN = 8;
const F_TCORE = 16;
const F_BCORE = 32;
const F_RAILOK = 64;

const AVG_W = 40;
const Y_W = 8;
const BACK_W = 160;
const WIDE_W = 150;
const BAND = 24; // metres the road profile may stray from the wide-smoothed ground before it tunnels / bridges
const CORE_LOOK = 46;
const TUNNEL_MIN = 45;
const BRIDGE_MIN = 6;
const DIL = 3;
const RAIL_LOOK = 50;
const BANK_W = 6;

export const RAIL_OFFSET = 12.5;
const PLAN_LOOK = [60, 150, 300];
const PLAN_W = [1, 0.7, 0.4];
export const CELL = 40; // spatial hash cell size (m)

export interface RoadParams {
  seed: number;
  map: number;
  curvature: number;
  hilliness: number;
  tunnels: number; // 0..2 frequency multiplier
  halfWidth: number;
}

class Block {
  x = new Float64Array(BLOCK);
  z = new Float64Array(BLOCK);
  y = new Float64Array(BLOCK);
  g = new Float64Array(BLOCK); // natural ground
  yAvg = new Float64Array(BLOCK);
  yClamp = new Float64Array(BLOCK);
  yBack = new Float64Array(BLOCK);
  yLow = new Float64Array(BLOCK);
  gWide = new Float64Array(BLOCK); // ground smoothed over ±WIDE_W samples
  heading = new Float64Array(BLOCK);
  curv = new Float32Array(BLOCK);
  bank = new Float32Array(BLOCK);
  flags = new Uint8Array(BLOCK);
}

/** Interpolated frame on the road. Re-used objects, never allocate per frame. */
export class RoadFrame {
  s = 0;
  i = 0;
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  dx = 0; // forward
  dz = 1;
  rx = -1; // right
  rz = 0;
  bank = 0;
  curv = 0;
  flags = 0;
  grade = 0;
}

export interface Projection {
  i: number; // segment start index
  s: number;
  u: number; // lateral offset along right vector
  dist: number; // |u| basically
  y: number; // road centre height at s
}

export class Road {
  readonly schedule: BiomeSchedule;
  readonly field: TerrainField;
  readonly halfWidth: number;
  readonly params: RoadParams;
  private blocks: (Block | undefined)[] = [];
  baseIndex = 0;

  nXZ = 0;
  private nAvg = 0;
  private nAvgStart = 0;
  private wideSum = 0;
  private wideCnt = 0;
  private nClamp = 0;
  private nBack = 0;
  private nY = 0;
  private nCore = 0;
  private nFlags = 0;
  nFinal = 0;

  // generation state
  private gx = 0;
  private gz = 0;
  private gh = 0;
  private lastK = 0;
  private base0: number;
  private rng: RNG;
  private mode: 0 | 1 | 2 = 0; // normal | leg | turn
  private hpTurns = 0;
  private hpSign = 1;
  private hpBase = 0;
  private hpLegTarget = 0;
  private hpLegEnd = 0;
  private hpRadius = 14;
  private nextHairpinCheck = 600;
  private nextPlan = 0;
  private planHeading = 0;
  private planSteep = 0;
  private w = new Float32Array(BIOME_COUNT);
  private tunnelTh: number;
  private bridgeTh: number;
  private readonly railSide: number;

  /** Spatial hash of final samples: cell key → sample indices. */
  private grid = new Map<number, number[]>();
  /** Called with [i0, i1) whenever new samples become final. */
  onFinal: ((i0: number, i1: number) => void) | null = null;

  constructor(params: RoadParams) {
    this.params = params;
    this.halfWidth = params.halfWidth;
    this.schedule = new BiomeSchedule(params.seed, params.map);
    this.field = new TerrainField(params.seed, params.hilliness);
    this.rng = new RNG(params.seed ^ 0x40ad);
    this.base0 = this.rng.range(0, Math.PI * 2);
    this.gh = this.base0;
    const f = clamp(params.tunnels, 0, 2);
    this.tunnelTh = f <= 0.01 ? 1e9 : 30 / Math.sqrt(f);
    this.bridgeTh = f <= 0.01 ? 1e9 : 9 / Math.sqrt(f);
    this.railSide = this.schedule.region(0).railSide;
    this.findStart();
  }

  /**
   * Start somewhere pleasant: a low, gentle, dry spot near the origin so a
   * journey never begins halfway up a cliff.
   */
  private findStart(): void {
    const w = this.schedule.weights(0, this.w);
    let best = Infinity;
    for (let a = 0; a < 7; a++) {
      for (let b = 0; b < 7; b++) {
        const x = (a - 3) * 700;
        const z = (b - 3) * 700;
        const h = this.field.coarse(x, z, w);
        const e = 30;
        const gx = this.field.coarse(x + e, z, w) - this.field.coarse(x - e, z, w);
        const gz = this.field.coarse(x, z + e, w) - this.field.coarse(x, z - e, w);
        const slope = Math.hypot(gx, gz) / (2 * e);
        const cost = h * 0.02 + slope * 40 + (h < WATER_LEVEL + 4 ? 20 : 0);
        if (cost < best) {
          best = cost;
          this.gx = x;
          this.gz = z;
        }
      }
    }
  }

  // ---------------------------------------------------------------- storage
  private blk(i: number): Block {
    const b = i >> BB;
    let blk = this.blocks[b];
    if (!blk) blk = this.blocks[b] = new Block();
    return blk;
  }
  hasSample(i: number): boolean {
    return i >= this.baseIndex && i < this.nFinal;
  }
  x(i: number): number {
    return this.blocks[i >> BB]!.x[i & BM];
  }
  z(i: number): number {
    return this.blocks[i >> BB]!.z[i & BM];
  }
  y(i: number): number {
    return this.blocks[i >> BB]!.y[i & BM];
  }
  ground(i: number): number {
    return this.blocks[i >> BB]!.g[i & BM];
  }
  heading(i: number): number {
    return this.blocks[i >> BB]!.heading[i & BM];
  }
  curv(i: number): number {
    return this.blocks[i >> BB]!.curv[i & BM];
  }
  bank(i: number): number {
    return this.blocks[i >> BB]!.bank[i & BM];
  }
  flags(i: number): number {
    return this.blocks[i >> BB]!.flags[i & BM];
  }
  /** Which side (+1 right / -1 left) a railway runs on. */
  railSideAt(_i: number): number {
    return this.railSide;
  }

  // ------------------------------------------------------------- generation
  /** Generate until at least `s` metres are final. */
  generateTo(s: number): void {
    const target = Math.ceil(s / DS) + 1;
    let guard = 0;
    while (this.nFinal < target && guard++ < 200000) this.step();
  }

  /** Produce one XZ sample and advance downstream stages as far as possible. */
  private step(): void {
    this.stepXZ();
    // Avg: needs g up to i + AVG_W
    while (this.nAvg + WIDE_W < this.nXZ) this.stepAvg();
    while (this.nClamp < this.nAvg) this.stepClamp();
    while (this.nBack + BACK_W < this.nClamp) this.stepBack();
    while (this.nY + Y_W < this.nBack) this.stepY();
    while (this.nCore + CORE_LOOK < this.nY) this.stepCore();
    while (this.nFlags + DIL < this.nCore) this.stepFlags();
    const before = this.nFinal;
    while (this.nFinal + RAIL_LOOK < this.nFlags && this.nFinal + BANK_W < this.nXZ) this.stepFinal();
    if (this.nFinal > before && this.onFinal) this.onFinal(before, this.nFinal);
  }

  private stepXZ(): void {
    const i = this.nXZ;
    const s = i * DS;
    if (i > 0) {
      this.gh += this.lastK * DS;
      // midpoint integration keeps arcs round
      const hm = this.gh - this.lastK * DS * 0.5;
      this.gx += Math.sin(hm) * DS;
      this.gz += Math.cos(hm) * DS;
    }
    const b = this.blk(i);
    const o = i & BM;
    const w = this.schedule.weights(s, this.w);
    b.x[o] = this.gx;
    b.z[o] = this.gz;
    b.heading[o] = this.gh;
    const g = this.field.natural(this.gx, this.gz, w);
    b.g[o] = g;

    // blended road behaviour
    // occasional mountain passes: the preferred level rises for a few km
    const passBump = smoothstep(0.3, 0.75, 0.5 + 0.5 * this.field.noise.n1(s / 4200 + 11.1));
    let curvB = 0;
    let contour = 0;
    let level = 0;
    let hp = 0;
    let steer = 0;
    for (let k = 0; k < BIOME_COUNT; k++) {
      const wk = w[k];
      if (wk <= 0) continue;
      const d = BIOMES[k];
      curvB += wk * d.curvature;
      contour += wk * d.contour;
      level += wk * (d.contourLevel + d.passHeight * passBump);
      hp += wk * d.hairpins;
      steer += wk * d.terrainSteer;
    }
    const n = this.field.noise;
    const cset = this.params.curvature;
    const baseDir = this.base0 + 0.8 * n.n1(s / 5200 + 3.3);
    let k = 0;
    let flags = 0;
    if (i === 0) this.planHeading = this.gh;

    if (this.mode === 0) {
      const kn = cset * curvB * (0.0105 * n.n1(s / 230) + 0.0065 * n.n1(s / 81 + 40) + 0.002 * n.n1(s / 31 + 7));
      let target = baseDir;
      if (contour > 0.02) {
        // Follow a contour line (lake shore / valley floor): steer along the
        // iso-height and gently towards the preferred level.
        const e = 10;
        const gxp = this.field.coarse(this.gx + e, this.gz, w);
        const gxm = this.field.coarse(this.gx - e, this.gz, w);
        const gzp = this.field.coarse(this.gx, this.gz + e, w);
        const gzm = this.field.coarse(this.gx, this.gz - e, w);
        const gradX = (gxp - gxm) / (2 * e);
        const gradZ = (gzp - gzm) / (2 * e);
        const gl = Math.hypot(gradX, gradZ);
        if (gl > 0.004) {
          let cx = gradZ / gl;
          let cz = -gradX / gl;
          // pick the contour direction closest to where we want to go
          if (cx * Math.sin(baseDir) + cz * Math.cos(baseDir) < 0) {
            cx = -cx;
            cz = -cz;
          }
          const hc = (gxp + gxm + gzp + gzm) * 0.25;
          const err = clamp((hc - level) / 35, -1, 1) * 0.75;
          const dx = cx - (gradX / gl) * err;
          const dz = cz - (gradZ / gl) * err;
          const desired = Math.atan2(dx, dz);
          const delta = clamp(wrapAngle(desired - baseDir), -1.3, 1.3);
          target = baseDir + delta * clamp(contour, 0, 1) * clamp(gl * 20, 0, 1);
        }
      }
      // Terrain-aware routing: every few samples, probe a fan of headings at
      // several look-ahead distances and pick the gentlest one that stays out
      // of the water. This makes roads follow valley floors and lake shores.
      if (steer > 0.02) {
        if (i >= this.nextPlan) {
          this.nextPlan = i + 4;
          let bestCost = 1e9;
          let best = 0;
          let sumW = 0;
          let sumA = 0;
          let minGrade = 1e9;
          for (let c = -4; c <= 4; c++) {
            const hd = this.gh + c * 0.24;
            const dev = wrapAngle(hd - baseDir);
            if (Math.abs(dev) > 1.35) continue;
            let cost = 0;
            let worst = 0;
            for (let q = 0; q < 3; q++) {
              const look = PLAN_LOOK[q];
              const hp = this.field.coarse(this.gx + Math.sin(hd) * look, this.gz + Math.cos(hd) * look, w);
              const grade = Math.abs(hp - g) / look;
              worst = Math.max(worst, grade);
              cost += PLAN_W[q] * grade * grade * 60;
              if (hp < WATER_LEVEL + 3) cost += PLAN_W[q] * 4;
            }
            cost += Math.abs(wrapAngle(hd - target)) * 0.35 + Math.abs(c) * 0.04;
            if (worst < minGrade) minGrade = worst;
            if (cost < bestCost) {
              bestCost = cost;
              best = hd;
            }
            const wgt = Math.exp(-cost * 3);
            sumW += wgt;
            sumA += wgt * wrapAngle(hd - this.gh);
          }
          this.planHeading = sumW > 1e-9 ? this.gh + sumA / sumW : best;
          this.planSteep = minGrade;
        }
        target = target + wrapAngle(this.planHeading - target) * clamp(steer, 0, 1);
      }
      k = kn + 0.016 * wrapAngle(target - this.gh);
      const kMax = 1 / 42;
      k = clamp(k, -kMax, kMax);

      // Hairpin switchbacks on moderate mountain slopes: legs run across the
      // slope so each one climbs (or descends) gently.
      if (hp > 0.15 && s >= this.nextHairpinCheck) {
        this.nextHairpinCheck = s + 400;
        const e = 40;
        const gradX = (this.field.coarse(this.gx + e, this.gz, w) - this.field.coarse(this.gx - e, this.gz, w)) / (2 * e);
        const gradZ = (this.field.coarse(this.gx, this.gz + e, w) - this.field.coarse(this.gx, this.gz - e, w)) / (2 * e);
        const gl = Math.hypot(gradX, gradZ);
        if (gl > 0.07 && gl < 0.35 && this.planSteep < 0.13 && this.rng.chance(hp * 0.4)) {
          let dir = Math.atan2(gradX, gradZ); // uphill
          if (Math.abs(wrapAngle(dir - this.gh)) > Math.PI / 2) dir += Math.PI; // descend instead
          this.mode = 1;
          this.hpTurns = 2 * this.rng.int(2, 3);
          this.hpBase = baseDir + clamp(wrapAngle(dir - baseDir), -0.5, 0.5);
          this.hpSign = this.rng.sign();
          this.hpLegTarget = this.hpBase + this.hpSign * 1.35;
          this.hpLegEnd = s + this.rng.range(40, 70);
          this.hpRadius = this.rng.range(13, 17);
          this.nextHairpinCheck = s + 2400;
        }
      }
    } else if (this.mode === 1) {
      // straight-ish leg of a switchback
      flags |= F_HAIRPIN;
      const diff = wrapAngle(this.hpLegTarget - this.gh);
      k = clamp(0.06 * diff, -1 / 26, 1 / 26) + 0.002 * n.n1(s / 40);
      if (s >= this.hpLegEnd && Math.abs(diff) < 0.12) {
        if (this.hpTurns <= 0) this.mode = 0;
        else this.mode = 2;
      }
    } else {
      // the hairpin itself: constant tight radius until the next leg heading
      flags |= F_HAIRPIN;
      const turnSign = -this.hpSign;
      k = turnSign / this.hpRadius;
      const nextTarget = this.hpBase - this.hpSign * 1.35;
      const remain = wrapAngle(nextTarget - this.gh) * turnSign;
      if (remain <= k * turnSign * DS) {
        this.hpSign = -this.hpSign;
        this.hpLegTarget = nextTarget;
        this.hpTurns--;
        this.mode = 1;
        this.hpLegEnd = s + this.rng.range(70, 130);
        if (this.hpTurns <= 0) this.hpLegEnd = s + 60;
      }
    }
    b.curv[o] = k;
    b.flags[o] = flags;
    this.lastK = k;
    this.nXZ++;
  }

  private stepAvg(): void {
    const i = this.nAvg;
    let sum = 0;
    let cnt = 0;
    const lo = Math.max(this.baseIndex, i - AVG_W);
    for (let j = lo; j <= i + AVG_W; j++) {
      // triangular weights → smoother than a box
      const wgt = AVG_W + 1 - Math.abs(j - i);
      sum += this.blocks[j >> BB]!.g[j & BM] * wgt;
      cnt += wgt;
    }
    const b = this.blk(i);
    b.yAvg[i & BM] = sum / cnt;
    // wide box average via running sum
    const add = i + WIDE_W;
    this.wideSum += this.blocks[add >> BB]!.g[add & BM];
    this.wideCnt++;
    if (i === this.nAvgStart) {
      for (let j = Math.max(this.baseIndex, i - WIDE_W); j < add; j++) {
        this.wideSum += this.blocks[j >> BB]!.g[j & BM];
        this.wideCnt++;
      }
    }
    const rem = i - WIDE_W - 1;
    if (rem >= this.baseIndex && rem >= 0) {
      this.wideSum -= this.blocks[rem >> BB]!.g[rem & BM];
      this.wideCnt--;
    }
    b.gWide[i & BM] = this.wideSum / this.wideCnt;
    this.nAvg++;
  }

  private maxGradeAt(s: number): number {
    const w = this.schedule.weights(s, this.w);
    let g = 0;
    for (let k = 0; k < BIOME_COUNT; k++) if (w[k] > 0) g += w[k] * BIOMES[k].maxGrade;
    return g;
  }

  /**
   * Forward passes of the grade envelopes: upper U = min(f, U[i-1] + G) and
   * lower L = max(f, L[i-1] − G). Combined with the backward passes in
   * stepBack, (U + L) / 2 is the grade-limited profile that minimises the
   * worst cut or fill (the minimax Lipschitz fit).
   */
  private stepClamp(): void {
    const i = this.nClamp;
    const b = this.blk(i);
    const wide = b.gWide[i & BM];
    const f = Math.max(clamp(b.yAvg[i & BM], wide - BAND, wide + BAND), WATER_LEVEL + 2.4);
    let u = f;
    let l = f;
    if (i > this.baseIndex) {
      const pb = this.blocks[(i - 1) >> BB]!;
      const G = this.maxGradeAt(i * DS) * DS;
      u = Math.min(f, pb.yClamp[(i - 1) & BM] + G);
      l = Math.max(f, pb.yLow[(i - 1) & BM] - G);
    }
    b.yClamp[i & BM] = u;
    b.yLow[i & BM] = l;
    this.nClamp++;
  }

  /** Backward envelope passes over a look-ahead window, then the midpoint. */
  private stepBack(): void {
    const i = this.nBack;
    const G = this.maxGradeAt(i * DS) * DS;
    const end = i + BACK_W;
    const be = this.blocks[end >> BB]!;
    let u = be.yClamp[end & BM];
    let l = be.yLow[end & BM];
    for (let j = end - 1; j >= i; j--) {
      const bj = this.blocks[j >> BB]!;
      const uf = bj.yClamp[j & BM];
      const lf = bj.yLow[j & BM];
      u = uf < u + G ? uf : u + G;
      l = lf > l - G ? lf : l - G;
    }
    // Bias towards the upper (cutting) envelope: the terrain carves back from the
    // road cheaply, whereas fills need embankments or bridges.
    let y = Math.max(u + (l - u) * 0.32, WATER_LEVEL + 2.4);
    // The window is finite, so re-impose the grade limit on the output.
    if (i > this.baseIndex) {
      const prev = this.blocks[(i - 1) >> BB]!.yBack[(i - 1) & BM];
      y = clamp(y, prev - G, prev + G);
    }
    this.blk(i).yBack[i & BM] = y;
    this.nBack++;
  }

  private stepY(): void {
    const i = this.nY;
    let sum = 0;
    let cnt = 0;
    const lo = Math.max(this.baseIndex, i - Y_W);
    for (let j = lo; j <= i + Y_W; j++) {
      const wgt = Y_W + 1 - Math.abs(j - i);
      sum += this.blocks[j >> BB]!.yBack[j & BM] * wgt;
      cnt += wgt;
    }
    this.blk(i).y[i & BM] = sum / cnt;
    this.nY++;
  }

  /** Ground smoothed over ±6 samples (ignores single bumps when deciding structures). */
  private gSmooth(i: number): number {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(this.baseIndex, i - 6); j <= i + 6; j++) {
      sum += this.blocks[j >> BB]!.g[j & BM];
      cnt++;
    }
    return sum / cnt;
  }

  private stepCore(): void {
    const i = this.nCore;
    const b = this.blk(i);
    const o = i & BM;
    const gs = this.gSmooth(i);
    const cut = gs - b.y[o];
    const fill = b.y[o] - Math.min(gs, b.g[o] + 3);
    let f = b.flags[o];
    const prevF = i > this.baseIndex ? this.blocks[(i - 1) >> BB]!.flags[(i - 1) & BM] : 0;
    if (cut > this.tunnelTh) {
      if (prevF & F_TCORE) f |= F_TCORE;
      else {
        let run = 0;
        for (let j = i; j < i + TUNNEL_MIN; j++) {
          const bj = this.blocks[j >> BB]!;
          if (this.gSmooth(j) - bj.y[j & BM] > this.tunnelTh) run++;
          else break;
        }
        if (run >= TUNNEL_MIN) f |= F_TCORE;
      }
    }
    if (fill > this.bridgeTh) {
      if (prevF & F_BCORE) f |= F_BCORE;
      else {
        let run = 0;
        for (let j = i; j < i + BRIDGE_MIN; j++) {
          const bj = this.blocks[j >> BB]!;
          if (bj.y[j & BM] - Math.min(this.gSmooth(j), bj.g[j & BM] + 3) > this.bridgeTh) run++;
          else break;
        }
        if (run >= BRIDGE_MIN) f |= F_BCORE;
      }
    }
    b.flags[o] = f;
    this.nCore++;
  }

  private stepFlags(): void {
    const i = this.nFlags;
    const b = this.blk(i);
    const o = i & BM;
    let f = b.flags[o];
    if (f & F_TCORE) f |= F_TUNNEL;
    let bridge = false;
    for (let j = Math.max(this.baseIndex, i - DIL); j <= i + DIL; j++) {
      if (this.blocks[j >> BB]!.flags[j & BM] & F_BCORE) {
        bridge = true;
        break;
      }
    }
    if (bridge && !(f & F_TUNNEL)) f |= F_BRIDGE;
    // rail eligibility
    const s = i * DS;
    const w = this.schedule.weights(s, this.w);
    let railW = 0;
    for (let k = 0; k < BIOME_COUNT; k++) if (BIOMES[k].rail) railW += w[k];
    if (railW > 0.75 && !(f & (F_TUNNEL | F_BRIDGE | F_HAIRPIN))) {
      let ok = true;
      for (let j = Math.max(this.baseIndex, i - 12); j <= i + 12 && j < this.nXZ; j++) {
        if (Math.abs(this.blocks[j >> BB]!.curv[j & BM]) > 1 / 95) {
          ok = false;
          break;
        }
      }
      if (ok) f |= F_RAILOK;
    }
    b.flags[o] = f;
    this.nFlags++;
  }

  private stepFinal(): void {
    const i = this.nFinal;
    const b = this.blk(i);
    const o = i & BM;
    let f = b.flags[o];
    if (f & F_RAILOK) {
      const prevF = i > this.baseIndex ? this.blocks[(i - 1) >> BB]!.flags[(i - 1) & BM] : 0;
      if (prevF & F_RAIL) f |= F_RAIL;
      else {
        let run = 0;
        for (let j = i; j < i + RAIL_LOOK; j++) {
          if (this.blocks[j >> BB]!.flags[j & BM] & F_RAILOK) run++;
          else break;
        }
        if (run >= RAIL_LOOK) f |= F_RAIL;
      }
    }
    b.flags[o] = f;
    // banking from smoothed curvature – tilts into the corner
    let kc = 0;
    let cnt = 0;
    for (let j = Math.max(this.baseIndex, i - BANK_W); j <= i + BANK_W; j++) {
      kc += this.blocks[j >> BB]!.curv[j & BM];
      cnt++;
    }
    kc /= cnt;
    const maxBank = f & F_HAIRPIN ? 0.05 : 0.075;
    b.bank[o] = clamp(kc * 9, -maxBank, maxBank) * (f & F_BRIDGE ? 0.5 : 1);
    this.insertGrid(i);
    this.nFinal++;
  }

  // ----------------------------------------------------------- spatial hash
  private static key(cx: number, cz: number): number {
    return ((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff);
  }
  private insertGrid(i: number): void {
    const k = Road.key(Math.floor(this.x(i) / CELL), Math.floor(this.z(i) / CELL));
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, (list = []));
    list.push(i);
  }
  /** Sample indices in the cell containing (x, z) and its 8 neighbours. */
  forEachNear(x: number, z: number, fn: (i: number) => void): void {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++) {
      for (let c = -1; c <= 1; c++) {
        const list = this.grid.get(Road.key(cx + a, cz + c));
        if (!list) continue;
        for (let n = 0; n < list.length; n++) fn(list[n]);
      }
    }
  }
  /** Direct cell access for hot loops (avoids closures). */
  cellList(cx: number, cz: number): number[] | undefined {
    return this.grid.get(Road.key(cx, cz));
  }

  /** Drop samples far behind to bound memory. */
  trimBefore(sKeep: number): void {
    const keepIdx = Math.floor(sKeep / DS) - AVG_W - 16;
    const b0 = this.baseIndex >> BB;
    const b1 = (keepIdx >> BB) - 1; // keep one spare block
    if (b1 < b0) return;
    for (let bi = b0; bi <= b1; bi++) {
      const blk = this.blocks[bi];
      if (!blk) continue;
      for (let o = 0; o < BLOCK; o++) {
        const i = (bi << BB) + o;
        if (i >= this.nFinal) break;
        const k = Road.key(Math.floor(blk.x[o] / CELL), Math.floor(blk.z[o] / CELL));
        const list = this.grid.get(k);
        if (list) {
          const idx = list.indexOf(i);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.grid.delete(k);
        }
      }
      this.blocks[bi] = undefined;
    }
    this.baseIndex = (b1 + 1) << BB;
  }

  // ---------------------------------------------------------------- queries
  /** Interpolated road frame at distance s (clamped to the final range). */
  frameAt(s: number, out: RoadFrame): RoadFrame {
    let f = s / DS;
    const maxI = this.nFinal - 2;
    if (f < this.baseIndex) f = this.baseIndex;
    if (f > maxI) f = maxI;
    const i = Math.floor(f);
    const t = f - i;
    const b0 = this.blocks[i >> BB]!;
    const o0 = i & BM;
    const j = i + 1;
    const b1 = this.blocks[j >> BB]!;
    const o1 = j & BM;
    out.s = f * DS;
    out.i = i;
    out.x = b0.x[o0] + (b1.x[o1] - b0.x[o0]) * t;
    out.z = b0.z[o0] + (b1.z[o1] - b0.z[o0]) * t;
    out.y = b0.y[o0] + (b1.y[o1] - b0.y[o0]) * t;
    out.heading = b0.heading[o0] + wrapAngle(b1.heading[o1] - b0.heading[o0]) * t;
    out.bank = b0.bank[o0] + (b1.bank[o1] - b0.bank[o0]) * t;
    out.curv = b0.curv[o0] + (b1.curv[o1] - b0.curv[o0]) * t;
    out.flags = t < 0.5 ? b0.flags[o0] : b1.flags[o1];
    out.grade = (b1.y[o1] - b0.y[o0]) / DS;
    out.dx = Math.sin(out.heading);
    out.dz = Math.cos(out.heading);
    out.rx = -out.dz;
    out.rz = out.dx;
    return out;
  }

  /**
   * Project a world point onto the road, searching locally from `hint`.
   * Cheap enough to run every physics step for the car.
   */
  project(x: number, z: number, hint: number, out: Projection): Projection {
    const lo = this.baseIndex;
    const hi = this.nFinal - 2;
    let i = clamp(Math.round(hint), lo, hi);
    const d2 = (k: number) => {
      const b = this.blocks[k >> BB]!;
      const dx = b.x[k & BM] - x;
      const dz = b.z[k & BM] - z;
      return dx * dx + dz * dz;
    };
    let best = d2(i);
    // coarse hop then fine walk
    for (let step = 32; step >= 1; step >>= 1) {
      let improved = true;
      while (improved) {
        improved = false;
        if (i + step <= hi) {
          const d = d2(i + step);
          if (d < best) {
            best = d;
            i += step;
            improved = true;
            continue;
          }
        }
        if (i - step >= lo) {
          const d = d2(i - step);
          if (d < best) {
            best = d;
            i -= step;
            improved = true;
          }
        }
      }
    }
    // pick segment [i-1,i] or [i,i+1]
    let a = i;
    if (i > lo) {
      const b = this.blocks[i >> BB]!;
      const hx = Math.sin(b.heading[i & BM]);
      const hz = Math.cos(b.heading[i & BM]);
      const px = x - b.x[i & BM];
      const pz = z - b.z[i & BM];
      if (px * hx + pz * hz < 0) a = i - 1;
    }
    if (a > hi) a = hi;
    const ba = this.blocks[a >> BB]!;
    const bb = this.blocks[(a + 1) >> BB]!;
    const ax = ba.x[a & BM];
    const az = ba.z[a & BM];
    const sx = bb.x[(a + 1) & BM] - ax;
    const sz = bb.z[(a + 1) & BM] - az;
    const len2 = sx * sx + sz * sz;
    let t = ((x - ax) * sx + (z - az) * sz) / len2;
    t = clamp(t, 0, 1);
    const px = ax + sx * t;
    const pz = az + sz * t;
    const len = Math.sqrt(len2);
    // right vector of the segment = (-dz, dx)
    const rx = -sz / len;
    const rz = sx / len;
    out.i = a;
    out.s = (a + t) * DS;
    out.u = (x - px) * rx + (z - pz) * rz;
    out.dist = Math.hypot(x - px, z - pz);
    out.y = ba.y[a & BM] + (bb.y[(a + 1) & BM] - ba.y[a & BM]) * t;
    return out;
  }

  /** Brute-force-ish nearest sample (strided). Used rarely (tile corners). */
  nearestIndexCoarse(x: number, z: number): number {
    let best = Infinity;
    let bi = this.baseIndex;
    const end = this.nFinal - 1;
    for (let i = this.baseIndex; i < end; i += 8) {
      const b = this.blocks[i >> BB]!;
      const dx = b.x[i & BM] - x;
      const dz = b.z[i & BM] - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return bi;
  }
}
