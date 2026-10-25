/**
 * Procedural low-poly model library. Every prop is assembled from a few
 * primitives into merged, vertex-coloured geometry (one draw call per part
 * when instanced). Models face +Z, sit on y = 0, and are roughly to scale.
 */
import * as THREE from 'three';
import { GeoBuilder } from './GeoBuilder';
import { lambert, basic } from './Materials';
import { swissFlagTexture, waterfallTexture } from './Textures';

export interface ModelPart {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  tint: boolean; // receives per-instance colour
}
export interface Model {
  name: string;
  parts: ModelPart[];
  shadow: 'tree' | 'building' | 'small' | 'none';
  footprint: number; // rough radius in metres
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 7);
const CYL5 = new THREE.CylinderGeometry(1, 1, 1, 5);
const CONE = new THREE.ConeGeometry(1, 1, 7);
const CONE5 = new THREE.ConeGeometry(1, 1, 5);
const ICO = new THREE.IcosahedronGeometry(1, 0);
const ICO1 = new THREE.IcosahedronGeometry(1, 1);
const PYR = new THREE.ConeGeometry(1, 1, 4);

let mats: ReturnType<typeof createMaterials> | null = null;
function createMaterials() {
  const flagTex = swissFlagTexture();
  const fallTex = waterfallTexture();
  return {
    prop: lambert({ vertexColors: true, flatShading: true }, { snowable: true }),
    foliage: lambert({ vertexColors: true, flatShading: true }, { sway: 0.012, snowable: true }),
    windows: lambert({ color: 0x55606a, emissive: 0xffbe6a, emissiveIntensity: 2.2 }, { nightGlow: true }),
    flag: lambert({ map: flagTex, side: THREE.DoubleSide }, { wave: true }),
    grass: lambert({ vertexColors: true, side: THREE.DoubleSide }, { sway: 0.35 }),
    waterfall: basic({ map: fallTex, transparent: true, opacity: 0.85, depthWrite: false, color: 0xe8f2fa, side: THREE.DoubleSide }),
    fallTex,
  };
}
export function modelMaterials() {
  if (!mats) mats = createMaterials();
  return mats;
}

// ------------------------------------------------------------------ helpers
/** Gable roof prism along local Z, eaves at y0, ridge at y0+h, plus gable walls. */
function gableRoof(gb: GeoBuilder, w: number, d: number, y0: number, h: number, roofCol: number, wallCol: number, overhang = 0.6): void {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const t = 0.25;
  gb.color(roofCol);
  // two slopes (top surfaces)
  gb.quad(-hw, y0 - overhang * 0.5, -hd, -hw, y0 - overhang * 0.5, hd, 0, y0 + h, hd, 0, y0 + h, -hd);
  gb.quad(hw, y0 - overhang * 0.5, hd, hw, y0 - overhang * 0.5, -hd, 0, y0 + h, -hd, 0, y0 + h, hd);
  // undersides
  gb.quad(-hw, y0 - overhang * 0.5 - t, hd, -hw, y0 - overhang * 0.5 - t, -hd, 0, y0 + h - t, -hd, 0, y0 + h - t, hd);
  gb.quad(hw, y0 - overhang * 0.5 - t, -hd, hw, y0 - overhang * 0.5 - t, hd, 0, y0 + h - t, hd, 0, y0 + h - t, -hd);
  // gable triangles (wall colour)
  gb.color(wallCol);
  const ww = w / 2;
  const dd = d / 2;
  const a = gb.vertex(-ww, y0, dd, 0, 0, 1);
  const b = gb.vertex(ww, y0, dd, 0, 0, 1);
  const c = gb.vertex(0, y0 + h * (ww / hw), dd, 0, 0, 1);
  gb.tri(a, b, c);
  const a2 = gb.vertex(ww, y0, -dd, 0, 0, -1);
  const b2 = gb.vertex(-ww, y0, -dd, 0, 0, -1);
  const c2 = gb.vertex(0, y0 + h * (ww / hw), -dd, 0, 0, -1);
  gb.tri(a2, b2, c2);
}

/** Hipped roof: rectangular footprint, ridge along Z. */
function hipRoof(gb: GeoBuilder, w: number, d: number, y0: number, h: number, col: number, overhang = 0.8, ridgeFrac = 0.45): void {
  const hw = w / 2 + overhang;
  const hd = d / 2 + overhang;
  const rl = Math.max(0.1, hd * ridgeFrac);
  const ye = y0 - overhang * 0.4;
  gb.color(col);
  // long sides
  gb.quad(-hw, ye, -hd, -hw, ye, hd, 0, y0 + h, rl, 0, y0 + h, -rl);
  gb.quad(hw, ye, hd, hw, ye, -hd, 0, y0 + h, -rl, 0, y0 + h, rl);
  // hip ends (triangles)
  const f1 = gb.vertex(-hw, ye, hd, 0, 0.7, 0.7);
  const f2 = gb.vertex(hw, ye, hd, 0, 0.7, 0.7);
  const f3 = gb.vertex(0, y0 + h, rl, 0, 0.7, 0.7);
  gb.tri(f1, f2, f3);
  const b1 = gb.vertex(hw, ye, -hd, 0, 0.7, -0.7);
  const b2 = gb.vertex(-hw, ye, -hd, 0, 0.7, -0.7);
  const b3 = gb.vertex(0, y0 + h, -rl, 0, 0.7, -0.7);
  gb.tri(b1, b2, b3);
  // underside
  gb.quad(-hw, ye - 0.05, hd, -hw, ye - 0.05, -hd, hw, ye - 0.05, -hd, hw, ye - 0.05, hd);
}

/** Window quads on the four walls of a box footprint. */
function windowGrid(
  gb: GeoBuilder,
  w: number,
  d: number,
  rows: number[],
  perSideX: number,
  perSideZ: number,
  ww = 0.9,
  wh = 1.1,
  ox = 0,
  oz = 0,
): void {
  const eps = 0.04;
  const base = gb.vertexCount;
  for (const y of rows) {
    for (let i = 0; i < perSideX; i++) {
      const x = -w / 2 + ((i + 0.5) * w) / perSideX;
      // front (+z) and back (-z)
      gb.quad(x - ww / 2, y, d / 2 + eps, x + ww / 2, y, d / 2 + eps, x + ww / 2, y + wh, d / 2 + eps, x - ww / 2, y + wh, d / 2 + eps);
      gb.quad(x + ww / 2, y, -d / 2 - eps, x - ww / 2, y, -d / 2 - eps, x - ww / 2, y + wh, -d / 2 - eps, x + ww / 2, y + wh, -d / 2 - eps);
    }
    for (let i = 0; i < perSideZ; i++) {
      const z = -d / 2 + ((i + 0.5) * d) / perSideZ;
      gb.quad(w / 2 + eps, y, z + ww / 2, w / 2 + eps, y, z - ww / 2, w / 2 + eps, y + wh, z - ww / 2, w / 2 + eps, y + wh, z + ww / 2);
      gb.quad(-w / 2 - eps, y, z - ww / 2, -w / 2 - eps, y, z + ww / 2, -w / 2 - eps, y + wh, z + ww / 2, -w / 2 - eps, y + wh, z - ww / 2);
    }
  }
  if (ox !== 0 || oz !== 0) {
    for (let i = base; i < gb.vertexCount; i++) {
      gb.pos[i * 3] += ox;
      gb.pos[i * 3 + 2] += oz;
    }
  }
}

function part(gb: GeoBuilder, mat: THREE.Material, tint = false): ModelPart {
  return { geo: gb.build(), mat, tint };
}

// ------------------------------------------------------------------- models
function chalet(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x8f8b84).prim(BOX, 0, -0.4, 0, 8.4, 2.6, 9.4); // stone base
  gb.color(0x8a5a2e).prim(BOX, 0, 3.05, 0, 8, 4.3, 9); // timber
  gb.color(0x6a4220).prim(BOX, 0, 3.2, 4.95, 8.8, 0.22, 1.1); // balcony floor
  gb.color(0x5e3b1d).prim(BOX, 0, 3.75, 5.45, 8.8, 0.9, 0.08); // balcony rail
  gb.color(0xc23b2b).prim(BOX, 0, 3.5, 5.5, 8.6, 0.25, 0.1); // geraniums!
  gableRoof(gb, 8, 9, 5.2, 3.4, 0x4f3524, 0x8a5a2e, 1.1);
  gb.color(0x77736e).prim(BOX, 2.2, 8, -1.5, 0.7, 2, 0.7);
  const w = new GeoBuilder();
  windowGrid(w, 8, 9, [1.7, 3.9], 3, 3);
  return { name: 'chalet', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 7 };
}

function farmhouse(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xe9e3d3).prim(BOX, 0, 0.6, 0, 12, 4.4, 11);
  gb.color(0x93633a).prim(BOX, 0, 4.0, 0, 12, 2.6, 11);
  gb.color(0x6a4a2e).prim(BOX, 0, 1.4, 5.55, 3, 2.8, 0.1); // door
  hipRoof(gb, 12, 11, 5.0, 6.2, 0x5b3b27, 2.2, 0.35);
  const w = new GeoBuilder();
  windowGrid(w, 12, 11, [1.5, 3.6], 5, 4);
  return { name: 'farmhouse', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 9 };
}

function barn(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x7c3d24).prim(BOX, 0, 2.6, 0, 11, 6.2, 15);
  gb.color(0x4a2a1a).prim(BOX, 0, 2.2, 7.55, 4, 4.4, 0.1);
  gb.color(0xe8e2d8).prim(BOX, 0, 2.2, 7.6, 4.3, 0.2, 0.05);
  gableRoof(gb, 11, 15, 5.7, 4.2, 0x6d6a66, 0x7c3d24, 0.8);
  return { name: 'barn', parts: [part(gb, m.prop, true)], shadow: 'building', footprint: 9 };
}

function stoneHouse(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xa29a8c).prim(BOX, 0, 2.6, 0, 6.5, 7.6, 7.5);
  gb.color(0x5f7d4a).prim(BOX, 0, 3.6, 3.8, 3.8, 1.3, 0.06); // green shutters band
  gableRoof(gb, 6.5, 7.5, 6.4, 1.8, 0x6e6a64, 0xa29a8c, 0.5);
  const w = new GeoBuilder();
  windowGrid(w, 6.5, 7.5, [1.2, 3.6], 2, 2, 0.7, 1.0);
  return { name: 'stoneHouse', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 6 };
}

function villa(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xf0e4cc).prim(BOX, 0, 2.6, 0, 9, 7.2, 9);
  gb.color(0xcfc3aa).prim(BOX, 0, -0.6, 0, 9.3, 1.2, 9.3);
  hipRoof(gb, 9, 9, 6.2, 3.0, 0xa24f35, 0.7, 0.2);
  const w = new GeoBuilder();
  windowGrid(w, 9, 9, [1.0, 3.8], 3, 3, 1.0, 1.4);
  return { name: 'villa', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 7 };
}

function apartment(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  const floors = 4;
  const H = floors * 3.1;
  gb.color(0xe8e4dc).prim(BOX, 0, H / 2 - 0.5, 0, 14, H + 1, 12);
  for (let f = 1; f <= floors; f++) gb.color(0xb9b4aa).prim(BOX, 0, f * 3.1 - 0.7, 6.3, 12, 0.18, 1.2); // balconies
  gb.color(0x8f8b84).prim(BOX, 0, H + 0.2, 0, 14.4, 0.6, 12.4);
  const w = new GeoBuilder();
  const rows: number[] = [];
  for (let f = 0; f < floors; f++) rows.push(0.9 + f * 3.1);
  windowGrid(w, 14, 12, rows, 6, 5, 1.2, 1.4);
  return { name: 'apartment', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 10 };
}

function church(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xeee9de).prim(BOX, 0, 3.2, 0, 8, 8.4, 16);
  gableRoof(gb, 8, 16, 7.4, 4.2, 0x8a4a32, 0xeee9de, 0.5);
  // tower
  gb.color(0xe8e2d4).prim(BOX, 0, 9.5, 9.2, 4.2, 21, 4.2);
  gb.color(0x3e3a36).prim(BOX, 0, 17, 11.32, 1.6, 1.6, 0.05); // clock face
  gb.color(0xd8c070).prim(BOX, 0, 17, 11.35, 1.1, 1.1, 0.05);
  gb.color(0x5f8f7a).prim(PYR, 0, 24.5, 9.2, 3.2, 9, 3.2, Math.PI / 4);
  gb.color(0xd8c070).prim(BOX, 0, 29.6, 9.2, 0.12, 1.4, 0.12);
  const w = new GeoBuilder();
  windowGrid(w, 8, 16, [2.4], 0, 4, 1.0, 2.6);
  windowGrid(w, 4.2, 4.2, [14.2], 1, 1, 0.8, 1.6, 0, 9.2);
  return { name: 'church', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 12 };
}

function hut(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x8b877f).prim(BOX, 0, -0.2, 0, 5.4, 2.2, 6.4);
  gb.color(0x6e4a2a).prim(BOX, 0, 2.2, 0, 5, 2.8, 6);
  gableRoof(gb, 5, 6, 3.6, 2.6, 0x55524e, 0x6e4a2a, 0.6);
  gb.color(0xd52b1e).prim(BOX, 0, 2.6, 3.06, 1.2, 0.9, 0.04); // little flag panel
  gb.color(0xffffff).prim(BOX, 0, 2.6, 3.08, 0.6, 0.18, 0.03);
  gb.color(0xffffff).prim(BOX, 0, 2.6, 3.08, 0.18, 0.6, 0.03);
  const w = new GeoBuilder();
  windowGrid(w, 5, 6, [1.6], 2, 2, 0.7, 0.8);
  return { name: 'hut', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'building', footprint: 5 };
}

// trees -----------------------------------------------------------------------
function tree(kind: string): Model {
  const m = modelMaterials();
  const trunk = new GeoBuilder();
  const leaves = new GeoBuilder();
  leaves.rgb(1, 1, 1);
  switch (kind) {
    case 'fir':
      trunk.color(0x5a3e2a).prim(CYL5, 0, 1, 0, 0.28, 2.2, 0.28);
      leaves.prim(CONE, 0, 3.2, 0, 2.4, 4, 2.4);
      leaves.prim(CONE, 0, 5.4, 0, 1.85, 3.4, 1.85, 0.4);
      leaves.prim(CONE, 0, 7.5, 0, 1.25, 3, 1.25, 0.9);
      break;
    case 'larch':
      trunk.color(0x6a4a32).prim(CYL5, 0, 1.2, 0, 0.24, 2.6, 0.24);
      leaves.prim(CONE, 0, 3.6, 0, 1.9, 4.2, 1.9);
      leaves.prim(CONE, 0, 6.0, 0, 1.4, 3.6, 1.4, 0.5);
      leaves.prim(CONE5, 0, 8.2, 0, 0.9, 3, 0.9, 1);
      break;
    case 'pine':
      trunk.color(0x7a4e32).prim(CYL5, 0, 2.6, 0, 0.26, 5.4, 0.26);
      leaves.prim(ICO, 0, 5.8, 0, 2.2, 1.3, 2.2);
      leaves.prim(ICO, 0.9, 6.9, 0.3, 1.6, 1.0, 1.6);
      leaves.prim(ICO, -0.6, 4.9, -0.5, 1.5, 0.9, 1.5);
      break;
    case 'broadleaf':
      trunk.color(0x5d4430).prim(CYL5, 0, 1.4, 0, 0.32, 2.9, 0.32);
      leaves.prim(ICO1, 0, 4.4, 0, 2.7, 2.4, 2.7);
      leaves.prim(ICO, 1.3, 5.3, 0.6, 1.7, 1.5, 1.7);
      leaves.prim(ICO, -1.1, 3.9, -0.8, 1.6, 1.4, 1.6);
      break;
    case 'birch':
      trunk.color(0xe6e2da).prim(CYL5, 0, 2.2, 0, 0.18, 4.5, 0.18);
      trunk.color(0x2c2c2c).prim(CYL5, 0, 1.6, 0, 0.19, 0.25, 0.19);
      leaves.prim(ICO, 0, 5.2, 0, 1.6, 2.6, 1.6);
      break;
    case 'apple':
      trunk.color(0x5d4430).prim(CYL5, 0, 0.7, 0, 0.2, 1.5, 0.2);
      leaves.prim(ICO1, 0, 2.4, 0, 1.8, 1.4, 1.8);
      break;
    case 'cypress':
      trunk.color(0x5a3e2a).prim(CYL5, 0, 0.5, 0, 0.22, 1, 0.22);
      leaves.prim(ICO1, 0, 4.6, 0, 1.05, 4.4, 1.05);
      break;
    case 'bush':
      leaves.prim(ICO, 0, 0.6, 0, 1.3, 0.95, 1.3);
      leaves.prim(ICO, 0.7, 0.5, 0.4, 0.9, 0.7, 0.9);
      trunk.color(0x5a3e2a).prim(BOX, 0, 0.1, 0, 0.1, 0.2, 0.1);
      break;
    case 'palm': {
      trunk.color(0x8a6e4e);
      let x = 0;
      for (let i = 0; i < 6; i++) {
        trunk.prim(CYL5, x, 0.8 + i * 1.5, 0, 0.26 - i * 0.02, 1.6, 0.26 - i * 0.02, 0, 0, -0.08);
        x += 0.13 * i * 0.4;
      }
      const top = 9;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const fx = Math.sin(a);
        const fz = Math.cos(a);
        leaves.prim(BOX, x + fx * 1.6, top - 0.3, fz * 1.6, 0.9, 0.08, 3.4, a, 0.45, 0);
      }
      leaves.prim(ICO, x, top, 0, 0.6, 0.5, 0.6);
      break;
    }
  }
  return { name: kind, parts: [part(trunk, m.prop), part(leaves, m.foliage, true)], shadow: 'tree', footprint: 3 };
}

// animals & small stuff -----------------------------------------------------
function cow(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x8a5532).prim(BOX, 0, 1.0, 0, 0.75, 0.75, 1.7);
  gb.color(0xf2efe8).prim(BOX, 0.2, 1.05, 0.2, 0.4, 0.6, 0.8);
  gb.color(0xf2efe8).prim(BOX, 0, 1.15, 1.0, 0.42, 0.45, 0.5); // head
  gb.color(0x3a2a20).prim(BOX, 0, 1.0, 1.28, 0.36, 0.25, 0.12);
  gb.color(0xd9d2c4).prim(BOX, 0.26, 1.4, 1.0, 0.12, 0.08, 0.08);
  gb.color(0xd9d2c4).prim(BOX, -0.26, 1.4, 1.0, 0.12, 0.08, 0.08);
  gb.color(0xc9a24a).prim(BOX, 0, 0.82, 0.9, 0.14, 0.18, 0.12); // the cowbell
  gb.color(0x6a4128);
  for (const [lx, lz] of [[0.25, 0.6], [-0.25, 0.6], [0.25, -0.6], [-0.25, -0.6]]) gb.prim(BOX, lx, 0.32, lz, 0.16, 0.64, 0.16);
  return { name: 'cow', parts: [part(gb, m.prop, true)], shadow: 'small', footprint: 1.2 };
}

function sheep(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xeeeae0).prim(ICO, 0, 0.7, 0, 0.5, 0.42, 0.7);
  gb.color(0x2c2826).prim(BOX, 0, 0.75, 0.62, 0.22, 0.26, 0.3);
  gb.color(0x2c2826);
  for (const [lx, lz] of [[0.18, 0.3], [-0.18, 0.3], [0.18, -0.3], [-0.18, -0.3]]) gb.prim(BOX, lx, 0.2, lz, 0.08, 0.4, 0.08);
  return { name: 'sheep', parts: [part(gb, m.prop, true)], shadow: 'small', footprint: 0.8 };
}

function marmot(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x8a6a48).prim(ICO, 0, 0.25, 0, 0.16, 0.26, 0.14);
  gb.color(0x9a7a56).prim(ICO, 0, 0.55, 0.03, 0.1, 0.1, 0.1);
  gb.color(0x2a2220).prim(BOX, 0, 0.55, 0.12, 0.04, 0.03, 0.03);
  return { name: 'marmot', parts: [part(gb, m.prop)], shadow: 'none', footprint: 0.3 };
}

function rock(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x8c8780).prim(ICO, 0, 0.4, 0, 1.2, 0.9, 1);
  gb.color(0x7d7872).prim(ICO, 0.8, 0.2, 0.4, 0.7, 0.5, 0.6, 0.7);
  return { name: 'rock', parts: [part(gb, m.prop, true)], shadow: 'small', footprint: 1.5 };
}

function haybale(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xf2f2ee).prim(CYL, 0, 0.75, 0, 0.75, 1.2, 0.75, 0, 0, Math.PI / 2);
  return { name: 'haybale', parts: [part(gb, m.prop, true)], shadow: 'small', footprint: 1 };
}

function vineRow(): Model {
  const m = modelMaterials();
  const posts = new GeoBuilder();
  posts.color(0x6a5440).prim(BOX, 0, 0.7, -2, 0.08, 1.4, 0.08);
  posts.color(0x6a5440).prim(BOX, 0, 0.7, 2, 0.08, 1.4, 0.08);
  const leaves = new GeoBuilder();
  leaves.rgb(1, 1, 1).prim(BOX, 0, 0.8, 0, 0.55, 0.9, 4);
  return { name: 'vine', parts: [part(posts, m.prop), part(leaves, m.foliage, true)], shadow: 'none', footprint: 2 };
}

function flagpole(): Model {
  const m = modelMaterials();
  const pole = new GeoBuilder();
  pole.color(0xf2f2f2).prim(CYL5, 0, 4, 0, 0.06, 8, 0.06);
  pole.color(0xd8c070).prim(ICO, 0, 8.05, 0, 0.1, 0.1, 0.1);
  const flag = new GeoBuilder();
  // strip from the pole (u = 0) to the free end (u = 1), subdivided for waving
  const y0 = 6.3;
  const s = 1.5;
  const seg = 6;
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    flag.vertex(0.05 + s * u, y0, 0, 0, 0, 1, u, 0);
    flag.vertex(0.05 + s * u, y0 + s, 0, 0, 0, 1, u, 1);
  }
  for (let i = 0; i < seg; i++) {
    const k = i * 2;
    flag.tri(k, k + 2, k + 1);
    flag.tri(k + 1, k + 2, k + 3);
  }
  return { name: 'flag', parts: [part(pole, m.prop), part(flag, m.flag)], shadow: 'none', footprint: 0.5 };
}

function sailboat(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xf4f4f0).prim(BOX, 0, 0.15, 0, 1.8, 0.7, 6);
  gb.color(0xf4f4f0).prim(PYR, 0, 0.15, 3.4, 1.27, 1.2, 0.9, Math.PI / 4, Math.PI / 2, 0);
  gb.color(0x2c4a7a).prim(BOX, 0, -0.1, 0, 1.85, 0.12, 6.05);
  gb.color(0xc8c8c4).prim(CYL5, 0, 4.5, 0.6, 0.06, 8.5, 0.06);
  // sail
  gb.color(0xfbfbf8);
  const a = gb.vertex(0, 1.0, 0.7, 1, 0, 0);
  const b = gb.vertex(0, 1.0, -2.4, 1, 0, 0);
  const c = gb.vertex(0, 8.4, 0.7, 1, 0, 0);
  gb.tri(a, b, c);
  gb.tri(a, c, b);
  return { name: 'sailboat', parts: [part(gb, m.prop, true)], shadow: 'none', footprint: 4 };
}

function steamer(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xf7f5ef).prim(BOX, 0, 0.6, 0, 6, 1.6, 34);
  gb.color(0x2b3a52).prim(BOX, 0, 0.0, 0, 6.05, 0.4, 34.05);
  gb.color(0xf2efe6).prim(BOX, 0, 2.3, -1, 4.6, 1.8, 22);
  gb.color(0xe9e4d6).prim(BOX, 0, 3.7, -2, 3.6, 1.1, 12);
  gb.color(0xd9b44a).prim(CYL, 0, 5.4, 1, 0.75, 3.2, 0.75);
  gb.color(0x222222).prim(CYL, 0, 7.1, 1, 0.78, 0.3, 0.78);
  gb.color(0x6a6a6a).prim(CYL, 3.2, 1.3, 2, 2.2, 0.8, 2.2, 0, 0, Math.PI / 2);
  gb.color(0x6a6a6a).prim(CYL, -3.2, 1.3, 2, 2.2, 0.8, 2.2, 0, 0, Math.PI / 2);
  gb.color(0xd52b1e).prim(BOX, 0, 2.0, -17.6, 0.05, 1, 1.0);
  const w = new GeoBuilder();
  windowGrid(w, 4.6, 22, [2.0], 0, 10, 1.1, 0.7);
  return { name: 'steamer', parts: [part(gb, m.prop, true), part(w, m.windows, true)], shadow: 'none', footprint: 18 };
}

function grassTuft(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI + i * 0.3;
    const dx = Math.cos(a) * 0.22;
    const dz = Math.sin(a) * 0.22;
    const lean = 0.12 * ((i % 2) * 2 - 1);
    gb.rgb(0.55, 0.62, 0.42);
    const p0 = gb.vertex(-dx, 0, -dz, 0, 1, 0);
    const p1 = gb.vertex(dx, 0, dz, 0, 1, 0);
    gb.rgb(1, 1, 0.85);
    const p2 = gb.vertex(lean, 0.55 + (i % 3) * 0.12, lean * 0.5, 0, 1, 0);
    gb.tri(p0, p1, p2);
  }
  return { name: 'grass', parts: [part(gb, m.grass, true)], shadow: 'none', footprint: 0.3 };
}

function flower(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.rgb(0.35, 0.55, 0.25);
  const a = gb.vertex(-0.02, 0, 0, 0, 1, 0);
  const b = gb.vertex(0.02, 0, 0, 0, 1, 0);
  const c = gb.vertex(0, 0.35, 0, 0, 1, 0);
  gb.tri(a, b, c);
  gb.rgb(1, 1, 1).prim(ICO, 0, 0.38, 0, 0.07, 0.04, 0.07);
  gb.rgb(1, 1, 1).prim(ICO, 0.12, 0.3, 0.05, 0.06, 0.035, 0.06);
  return { name: 'flower', parts: [part(gb, m.grass, true)], shadow: 'none', footprint: 0.2 };
}

function pylon(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0x8a8e92).prim(BOX, 0, 9, 0, 1.6, 18, 1.6, 0, 0, 0);
  gb.color(0x8a8e92).prim(BOX, 0, 18, 0, 5, 0.5, 0.6);
  return { name: 'pylon', parts: [part(gb, m.prop)], shadow: 'small', footprint: 2 };
}

function station(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xb9b6ae).prim(BOX, 0, 3, 0, 8, 7, 10);
  gb.color(0x5a5650).prim(BOX, 0, 6.8, 0, 8.6, 0.6, 10.6);
  gb.color(0x3a3a3a).prim(BOX, 0, 3, 5.02, 4, 3.4, 0.05);
  const w = new GeoBuilder();
  windowGrid(w, 8, 10, [3.2], 2, 0, 1.4, 1.2);
  return { name: 'station', parts: [part(gb, m.prop), part(w, m.windows, true)], shadow: 'building', footprint: 6 };
}

function cabin(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  gb.color(0xd5281c).prim(BOX, 0, -2.6, 0, 2.2, 2, 2.6);
  gb.color(0x2a3440).prim(BOX, 0, -2.3, 0, 2.25, 0.9, 2.65);
  gb.color(0x555555).prim(BOX, 0, -0.8, 0, 0.12, 1.8, 0.12);
  gb.color(0x555555).prim(BOX, 0, 0, 0, 0.6, 0.3, 1.2);
  return { name: 'cabin', parts: [part(gb, m.prop)], shadow: 'none', footprint: 2 };
}

function waterfall(): Model {
  const m = modelMaterials();
  const gb = new GeoBuilder();
  // tall strip, uv.v along the fall
  const w = 3.2;
  const h = 24;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const bulge = Math.sin(t * Math.PI) * 0.6;
    gb.vertex(-w / 2 - t * 0.8, h * (1 - t), bulge, 0, 0, 1, 0, t * 4);
    gb.vertex(w / 2 + t * 0.8, h * (1 - t), bulge, 0, 0, 1, 1, t * 4);
  }
  for (let i = 0; i < 4; i++) {
    const k = i * 2;
    gb.tri(k, k + 2, k + 1);
    gb.tri(k + 1, k + 2, k + 3);
  }
  return { name: 'waterfall', parts: [part(gb, m.waterfall)], shadow: 'none', footprint: 3 };
}

let library: Record<string, Model> | null = null;
export function models(): Record<string, Model> {
  if (library) return library;
  library = {
    chalet: chalet(),
    farmhouse: farmhouse(),
    barn: barn(),
    stoneHouse: stoneHouse(),
    villa: villa(),
    apartment: apartment(),
    church: church(),
    hut: hut(),
    fir: tree('fir'),
    larch: tree('larch'),
    pine: tree('pine'),
    broadleaf: tree('broadleaf'),
    birch: tree('birch'),
    apple: tree('apple'),
    cypress: tree('cypress'),
    bush: tree('bush'),
    palm: tree('palm'),
    cow: cow(),
    sheep: sheep(),
    marmot: marmot(),
    rock: rock(),
    haybale: haybale(),
    vine: vineRow(),
    flag: flagpole(),
    sailboat: sailboat(),
    steamer: steamer(),
    grass: grassTuft(),
    flower: flower(),
    pylon: pylon(),
    station: station(),
    cabin: cabin(),
    waterfall: waterfall(),
  };
  return library;
}
