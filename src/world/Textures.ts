/**
 * Procedurally painted canvas textures (no image assets to download).
 */
import * as THREE from 'three';
import { RNG } from '../core/rng';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Road length (metres) covered by one V repeat of the asphalt texture. */
export const ROAD_TEX_LEN = 12;

/**
 * Asphalt with Swiss-style markings: solid white edge lines, dashed white
 * centre line (3 m dash / 6 m gap → 4 m + 8 m over a 12 m tile).
 */
export function roadTexture(markings: boolean): THREE.CanvasTexture {
  const W = 256;
  const H = 512;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#4a4b4f';
  g.fillRect(0, 0, W, H);
  const rng = new RNG(1234);
  // aggregate speckle
  for (let i = 0; i < 9000; i++) {
    const v = 60 + rng.next() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 3},${0.25 + rng.next() * 0.35})`;
    g.fillRect(rng.next() * W, rng.next() * H, 1 + rng.next() * 1.5, 1 + rng.next() * 1.5);
  }
  // wheel-track polish (slightly darker, smoother bands)
  for (const x of [0.22, 0.36, 0.64, 0.78]) {
    const grd = g.createLinearGradient((x - 0.06) * W, 0, (x + 0.06) * W, 0);
    grd.addColorStop(0, 'rgba(30,30,34,0)');
    grd.addColorStop(0.5, 'rgba(30,30,34,0.18)');
    grd.addColorStop(1, 'rgba(30,30,34,0)');
    g.fillStyle = grd;
    g.fillRect((x - 0.06) * W, 0, 0.12 * W, H);
  }
  // patch repairs
  for (let i = 0; i < 3; i++) {
    g.fillStyle = `rgba(40,40,44,${0.15 + rng.next() * 0.15})`;
    g.fillRect(rng.next() * W * 0.8, rng.next() * H, 20 + rng.next() * 50, 30 + rng.next() * 80);
  }
  if (markings) {
    g.fillStyle = '#e9e9e2';
    const lw = 5;
    g.fillRect(10, 0, lw, H);
    g.fillRect(W - 10 - lw, 0, lw, H);
    // centre dashes: 4 m on, 8 m off over 12 m
    const dash = (4 / ROAD_TEX_LEN) * H;
    g.fillRect(W / 2 - 2.5, H * 0.1, lw, dash);
    // wear
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = `rgba(70,70,74,${rng.next() * 0.5})`;
      const x = rng.pick([12, W - 12, W / 2]);
      g.fillRect(x - 3 + rng.next() * 6, rng.next() * H, 1.5, 1.5);
    }
  }
  return finish(c);
}

/** Ballast + sleepers for the railway (one tile = 6 m). */
export function trackTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#6c6458';
  g.fillRect(0, 0, 128, 256);
  const rng = new RNG(77);
  for (let i = 0; i < 4000; i++) {
    const v = 70 + rng.next() * 60;
    g.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
    g.fillRect(rng.next() * 128, rng.next() * 256, 2, 2);
  }
  // sleepers every 0.6 m → 10 per tile
  for (let i = 0; i < 10; i++) {
    const y = (i + 0.5) * 25.6;
    g.fillStyle = '#4e4640';
    g.fillRect(14, y - 5, 100, 10);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(14, y + 4, 100, 2);
  }
  return finish(c);
}

/** Swiss flag (square, red with white cross). */
export function swissFlagTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = '#d52b1e';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff';
  // cross arms: 6/20 wide, 20/32 long per the federal spec proportions
  const u = 64 / 32;
  g.fillRect(13 * u, 6 * u, 6 * u, 20 * u);
  g.fillRect(6 * u, 13 * u, 20 * u, 6 * u);
  return finish(c, false);
}

/** Soft round blob used for clouds, mist, glows. */
export function softDotTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return finish(c, false, false);
}

/** Puffy cloud sprite made of overlapping blobs. */
export function cloudTexture(seed: number): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  const rng = new RNG(seed);
  for (let i = 0; i < 26; i++) {
    const x = 40 + rng.next() * 176;
    const y = 50 + rng.next() * 40 - Math.abs(x - 128) * 0.15;
    const r = 18 + rng.next() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return finish(c, false, false);
}

/** Facade texture with windows for buildings (white = wall, alpha unused). */
export function windowGlowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 64);
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, '#fff2c8');
  grd.addColorStop(1, '#000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return finish(c, false);
}

/** Streaky white-water texture for waterfalls. */
export function waterfallTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 256);
  g.fillStyle = 'rgba(200,220,235,0.0)';
  g.fillRect(0, 0, 64, 256);
  const rng = new RNG(5);
  for (let i = 0; i < 160; i++) {
    const x = rng.next() * 64;
    const y = rng.next() * 256;
    const a = 0.3 + rng.next() * 0.6;
    g.fillStyle = `rgba(240,248,255,${a})`;
    g.fillRect(x, y, 1 + rng.next() * 3, 20 + rng.next() * 60);
  }
  return finish(c);
}
