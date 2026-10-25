/**
 * World orchestrator: owns the road, terrain, props, water, railway and
 * atmosphere for one journey and streams them around the car with a
 * per-frame time budget.
 */
import * as THREE from 'three';
import { Road, DS, RoadFrame, type RoadParams, type Projection, F_BRIDGE, F_TUNNEL } from './Road';
import { TerrainSampler, SHOULDER, type HeightInfo } from './Terrain';
import { TerrainTiles } from './TerrainTiles';
import { RoadChunks } from './RoadChunks';
import { PropSystem, CHUNK } from './Props';
import { Water } from './Water';
import { Atmosphere } from './Atmosphere';
import { Railway } from './Railway';
import { BIOME_COUNT } from './Biomes';
import type { Season, ShadowQuality } from '../core/Settings';
import { hashString } from '../core/rng';

export type Surface = 'asphalt' | 'gravel' | 'grass' | 'bridge' | 'tunnel' | 'water';

export interface Ground {
  y: number;
  surface: Surface;
  wall: number; // signed push (m) if the car is beyond a wall/guardrail
}

export interface WorldOptions {
  seed: string;
  map: number;
  curvature: number;
  hilliness: number;
  tunnels: number;
  roadWidth: 'narrow' | 'normal' | 'wide';
  season: Season;
  renderDistance: number;
  treeDensity: number;
  grassDensity: number;
  guardrails: boolean;
  laneMarkings: boolean;
  shadows: ShadowQuality;
  waterReflections: boolean;
  lowBattery: boolean;
  cloudOctaves: number;
}

const CHUNK_LEN = CHUNK * DS;

export class World {
  readonly group = new THREE.Group();
  readonly road: Road;
  readonly sampler: TerrainSampler;
  readonly tiles: TerrainTiles;
  readonly chunks: RoadChunks;
  readonly props: PropSystem;
  readonly water: Water;
  readonly atmos: Atmosphere;
  readonly railway: Railway;
  readonly seedNum: number;
  private opts: WorldOptions;
  private refreshT = 0;
  private proj: Projection = { i: 0, s: 0, u: 0, dist: 0, y: 0 };
  private info: HeightInfo = { flatten: 0, roadDist: 0, nearest: -1, natural: 0, u: 0 };
  readonly biomeW = new Float32Array(BIOME_COUNT);
  private lastCarS = 0;

  constructor(
    private scene: THREE.Scene,
    opts: WorldOptions,
  ) {
    this.opts = { ...opts };
    this.seedNum = hashString(opts.seed);
    const halfWidth = opts.roadWidth === 'narrow' ? 2.85 : opts.roadWidth === 'wide' ? 3.75 : 3.3;
    const params: RoadParams = {
      seed: this.seedNum,
      map: opts.map,
      curvature: opts.curvature,
      hilliness: opts.hilliness,
      tunnels: opts.tunnels,
      halfWidth,
    };
    this.road = new Road(params);
    this.sampler = new TerrainSampler(this.road);
    this.tiles = new TerrainTiles(this.road, this.sampler, opts.season);
    this.road.onFinal = (a, b) => this.tiles.onRoadFinal(a, b);
    this.chunks = new RoadChunks(this.road, this.sampler, this.seedNum);
    this.props = new PropSystem(this.road, this.sampler, this.seedNum);
    this.water = new Water();
    this.railway = new Railway(this.road);
    this.atmos = new Atmosphere(scene, this.seedNum, opts.cloudOctaves);
    this.group.add(this.tiles.group, this.chunks.group, this.props.group, this.water.mesh, this.railway.group);
    scene.add(this.group);
    this.applyOptions(opts, true);
  }

  get options(): WorldOptions {
    return this.opts;
  }

  /** Apply runtime-changeable options (anything that does not change the route). */
  applyOptions(o: Partial<WorldOptions>, initial = false): void {
    const prev = this.opts;
    this.opts = { ...this.opts, ...o };
    const n = this.opts;
    this.tiles.radius = n.renderDistance;
    this.chunks.guardrails = n.guardrails;
    this.chunks.setMarkings(n.laneMarkings);
    this.props.treeDensity = n.treeDensity;
    this.props.grassDensity = n.grassDensity;
    this.props.season = n.season;
    this.props.lowDetail = n.lowBattery;
    this.props.setShadows(n.shadows);
    const cast = n.shadows === 'medium' || n.shadows === 'high';
    this.chunks.setShadows(cast, n.shadows !== 'off');
    this.tiles.shadows = n.shadows === 'high';
    this.water.setReflections(n.waterReflections);
    this.atmos.sky.setOctaves(n.cloudOctaves);
    if (initial) return;
    if (prev.season !== n.season) {
      this.tiles.setSeason(n.season);
      this.tiles.invalidateAll();
      this.props.clearAll();
    }
    if (prev.treeDensity !== n.treeDensity || prev.lowBattery !== n.lowBattery) this.props.clearAll();
    if (prev.grassDensity !== n.grassDensity) for (const k of [...this.props.grassKeys()]) this.props.removeGrass(k);
    if (prev.guardrails !== n.guardrails) this.chunks.clearAll();
  }

  /** Synchronously generate the area around the start; yields for the loading bar. */
  async prepare(startS: number, onProgress: (p: number) => void): Promise<void> {
    const R = this.opts.renderDistance;
    this.road.generateTo(startS + R + 900);
    onProgress(0.1);
    const F = this.road.frameAt(startS, new RoadFrame());
    this.tiles.refresh(F.x, F.z);
    const total = this.tiles.pending();
    let guard = 0;
    while (this.tiles.pending() > 0 && guard++ < 5000) {
      this.tiles.update(30);
      onProgress(0.1 + 0.7 * (1 - this.tiles.pending() / Math.max(1, total)));
      await new Promise((r) => setTimeout(r, 0));
    }
    // road chunks & props around the start
    this.lastCarS = startS;
    this.streamChunks(startS, 1e9);
    onProgress(0.9);
    await new Promise((r) => setTimeout(r, 0));
    this.streamProps(startS, 1e9);
    onProgress(1);
  }

  private streamChunks(carS: number, budgetMs: number): void {
    const t0 = performance.now();
    const R = this.opts.renderDistance;
    const k0 = Math.floor((carS - 400) / CHUNK_LEN);
    const k1 = Math.floor((carS + R + 250) / CHUNK_LEN);
    const kc = Math.floor(carS / CHUNK_LEN);
    for (const k of [...this.chunks.keys()]) if (k < k0 - 1 || k > k1 + 1) this.chunks.remove(k);
    // nearest first
    for (let d = 0; d <= Math.max(kc - k0, k1 - kc); d++) {
      for (const k of [kc + d, kc - d]) {
        if (k < k0 || k > k1 || this.chunks.has(k)) continue;
        if ((k + 1) * CHUNK >= this.road.nFinal - 1 || k * CHUNK < this.road.baseIndex) continue;
        this.chunks.build(k);
        if (performance.now() - t0 > budgetMs) return;
      }
    }
  }

  private streamProps(carS: number, budgetMs: number): void {
    const t0 = performance.now();
    const R = Math.min(this.opts.renderDistance, this.opts.lowBattery ? 650 : 1100);
    const k0 = Math.floor((carS - 300) / CHUNK_LEN);
    const k1 = Math.floor((carS + R) / CHUNK_LEN);
    const kc = Math.floor(carS / CHUNK_LEN);
    for (const k of [...this.props.mainKeys()]) if (k < k0 - 1 || k > k1 + 1) this.props.removeMain(k);
    const g0 = Math.floor((carS - 120) / CHUNK_LEN);
    const g1 = Math.floor((carS + (this.opts.lowBattery ? 160 : 280)) / CHUNK_LEN);
    for (const k of [...this.props.grassKeys()]) if (k < g0 - 1 || k > g1 + 1) this.props.removeGrass(k);
    for (let d = 0; d <= Math.max(kc - k0, k1 - kc); d++) {
      for (const k of [kc + d, kc - d]) {
        if (k < k0 || k > k1) continue;
        if ((k + 1) * CHUNK >= this.road.nFinal - 1 || k * CHUNK < this.road.baseIndex) continue;
        if (!this.props.hasMain(k)) {
          this.props.buildMain(k);
          if (performance.now() - t0 > budgetMs) return;
        }
        if (k >= g0 && k <= g1 && !this.props.hasGrass(k) && this.opts.grassDensity > 0.01) {
          this.props.buildGrass(k);
          if (performance.now() - t0 > budgetMs) return;
        }
      }
    }
  }

  /** Streaming update; `budgetMs` caps total generation work this frame. */
  update(dt: number, carS: number, carPos: THREE.Vector3, budgetMs: number): void {
    this.lastCarS = carS;
    const R = this.opts.renderDistance;
    this.road.generateTo(carS + R + 900);
    this.road.trimBefore(carS - Math.max(1600, R + 600));
    this.refreshT -= dt;
    if (this.refreshT <= 0) {
      this.refreshT = 0.3;
      this.tiles.refresh(carPos.x, carPos.z);
    }
    const t0 = performance.now();
    // road surface first (it is what you drive on), then terrain, then props
    this.streamChunks(carS, budgetMs * 0.35);
    const used = performance.now() - t0;
    this.tiles.update(Math.max(0.5, budgetMs * 0.6 - used));
    const used2 = performance.now() - t0;
    this.streamProps(carS, Math.max(0.5, budgetMs - used2));
    this.road.schedule.weights(carS, this.biomeW);
    this.railway.update(dt, carS, carPos);
  }

  /** Per-frame visual updates that are not streaming. */
  animate(time: number, camera: THREE.PerspectiveCamera): void {
    this.props.update(time);
    this.water.follow(camera);
    this.water.mesh.visible = this.tiles.minLoadedHeight < 0.5;
  }

  // -------------------------------------------------------------- queries
  /**
   * Ground under a world point for vehicle physics. `hint` is the last road
   * sample index (kept by the car) – updated in place via the return value.
   */
  ground(x: number, z: number, hint: number, out: Ground): number {
    const p = this.road.project(x, z, hint, this.proj);
    const hw = this.road.halfWidth;
    const au = Math.abs(p.u);
    const f = this.road.flags(p.i);
    out.wall = 0;
    if (au <= hw + SHOULDER + 0.3 || (f & (F_BRIDGE | F_TUNNEL) && au < hw + 3)) {
      const i = p.i;
      const t = p.s / DS - i;
      const bank = this.road.bank(i) * (1 - t) + this.road.bank(i + 1) * t;
      const uc = Math.max(-hw, Math.min(hw, p.u));
      let y = p.y + uc * bank;
      if (au > hw) y -= f & (F_BRIDGE | F_TUNNEL) ? 0 : ((au - hw) / SHOULDER) * 0.13;
      out.y = y;
      out.surface = f & F_TUNNEL ? 'tunnel' : f & F_BRIDGE ? 'bridge' : au <= hw ? 'asphalt' : 'gravel';
      if (f & (F_BRIDGE | F_TUNNEL)) {
        const lim = f & F_TUNNEL ? hw + 1.0 : hw + 0.6;
        if (au > lim) out.wall = Math.sign(p.u) * (au - lim);
      }
    } else {
      out.y = this.sampler.heightAt(x, z, null, this.info);
      out.surface = out.y < 0.05 ? 'water' : 'grass';
    }
    return p.i;
  }

  /** Lateral offset and distance along the road of a point (for recovery/HUD). */
  projectPoint(x: number, z: number, hint: number): Projection {
    return this.road.project(x, z, hint, this.proj);
  }

  get carS(): number {
    return this.lastCarS;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.remove(this.atmos.sky.dome, this.atmos.sky.stars, this.atmos.backdrop.group, this.atmos.precip.mesh, this.atmos.sun, this.atmos.sun.target, this.atmos.hemi);
    this.tiles.dispose();
    this.chunks.clearAll();
    this.props.clearAll();
    this.railway.clear();
    this.props.dispose();
    this.water.setReflections(false);
  }
}
