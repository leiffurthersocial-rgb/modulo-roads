/**
 * Quality management: turns user settings (plus Low Battery Mode overrides)
 * into the effective values every system uses, estimates the power saving,
 * and runs dynamic resolution to hold the target frame rate.
 */
import type { Settings, ShadowQuality } from '../core/Settings';
import { clamp } from '../core/math';

export interface Effective {
  renderDistance: number;
  shadows: ShadowQuality;
  shadowMap: number;
  shadowRange: number;
  pixelRatio: number;
  resolutionScale: number;
  fpsCap: number;
  bloom: boolean;
  dof: boolean;
  grade: boolean;
  vignette: boolean;
  grain: boolean;
  fxaa: boolean;
  msaa: boolean;
  waterReflections: boolean;
  treeDensity: number;
  grassDensity: number;
  cloudOctaves: number;
  precipQuality: number;
  dynamicResolution: boolean;
  buildBudgetMs: number;
  envUpdates: boolean;
  lowBattery: boolean;
}

export function deviceMaxPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

export function effectiveSettings(s: Settings, lowBattery: boolean, msaaAvailable: boolean): Effective {
  const g = s.graphics;
  const e: Effective = {
    renderDistance: g.renderDistance,
    shadows: g.shadows,
    shadowMap: g.shadows === 'high' ? 4096 : g.shadows === 'medium' ? 2048 : 1024,
    shadowRange: g.shadows === 'high' ? 110 : g.shadows === 'medium' ? 70 : 28,
    pixelRatio: deviceMaxPixelRatio() * g.resolutionScale,
    resolutionScale: g.resolutionScale,
    fpsCap: g.fpsCap,
    bloom: g.bloom,
    dof: g.dof,
    grade: g.colorGrading,
    vignette: g.vignette,
    grain: g.filmGrain,
    fxaa: g.antialias === 'fxaa',
    msaa: g.antialias === 'msaa' && msaaAvailable,
    waterReflections: g.waterReflections,
    treeDensity: g.treeDensity,
    grassDensity: g.grassDensity,
    cloudOctaves: g.preset === 'low' ? 3 : g.preset === 'ultra' ? 6 : 5,
    precipQuality: g.preset === 'low' ? 0.4 : g.preset === 'medium' ? 0.6 : 1,
    dynamicResolution: g.dynamicResolution,
    buildBudgetMs: 4,
    envUpdates: true,
    lowBattery,
  };
  if (lowBattery) {
    // Calm and cohesive, just cheaper: fewer pixels, half the frames, no
    // shadow pass, no post chain, no mirror render, shorter draw distance
    // with denser fog hiding the edge, and fewer particles/props/voices.
    e.fpsCap = 30;
    e.resolutionScale = clamp(Math.min(g.resolutionScale, 0.7), 0.6, 0.75);
    e.pixelRatio = deviceMaxPixelRatio() * e.resolutionScale;
    e.shadows = 'off';
    e.bloom = e.dof = e.grain = e.fxaa = false;
    e.grade = false;
    e.vignette = false;
    e.msaa = false;
    e.waterReflections = false;
    e.renderDistance = Math.min(g.renderDistance, 600);
    e.treeDensity = Math.min(g.treeDensity, 0.6);
    e.grassDensity = Math.min(g.grassDensity, 0.25);
    e.cloudOctaves = 2;
    e.precipQuality = 0.3;
    e.dynamicResolution = false;
    e.buildBudgetMs = 2;
    e.envUpdates = false;
  }
  return e;
}

/** Rough relative GPU+CPU cost model, used for the "saves ~xx%" label. */
export function costEstimate(e: Effective, displayHz = 60): number {
  const fps = e.fpsCap > 0 ? Math.min(e.fpsCap, displayHz) : displayHz;
  const px = e.pixelRatio * e.pixelRatio;
  // a fixed per-frame cost (scene traversal, physics, audio, compositing) plus pixel work
  let perFrame = 0.9 + px * (1 + (e.renderDistance / 1000) * 0.6);
  if (e.shadows !== 'off') perFrame += px * 0.15 + (e.shadows === 'high' ? 0.5 : e.shadows === 'medium' ? 0.3 : 0.1);
  if (e.waterReflections) perFrame += px * 0.25 + 0.3;
  if (e.bloom) perFrame += px * 0.25;
  if (e.dof) perFrame += px * 0.4;
  if (e.grade || e.vignette || e.grain || e.fxaa) perFrame += px * 0.15;
  if (e.msaa) perFrame += px * 0.3;
  perFrame += (e.treeDensity + e.grassDensity) * 0.3;
  return perFrame * fps;
}

export function savingPercent(s: Settings, msaa: boolean): number {
  const normal = costEstimate(effectiveSettings(s, false, msaa));
  const low = costEstimate(effectiveSettings(s, true, msaa));
  return clamp(Math.round((1 - low / normal) * 100), 0, 95);
}

/**
 * Dynamic resolution: nudges the pixel ratio down when frames run long and
 * back up when there is headroom. Changes at most every 1.5 s.
 */
export class DynamicResolution {
  scale = 1; // multiplier on the configured pixel ratio (0.55..1)
  private acc = 0;
  private frames = 0;
  private cooldown = 2;

  update(dt: number, frameMs: number, targetFps: number): boolean {
    this.acc += frameMs;
    this.frames++;
    this.cooldown -= dt;
    if (this.cooldown > 0 || this.frames < 30) return false;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    const budget = 1000 / targetFps;
    let changed = false;
    if (avg > budget * 1.12 && this.scale > 0.56) {
      this.scale = Math.max(0.55, this.scale - 0.07);
      changed = true;
    } else if (avg < budget * 0.8 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      changed = true;
    }
    if (changed) this.cooldown = 1.5;
    return changed;
  }
}
