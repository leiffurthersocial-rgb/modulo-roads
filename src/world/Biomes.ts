/**
 * Biome ("map") definitions.
 *
 * Each biome describes how the road behaves (curvature, grades, hairpins,
 * whether it hugs a lake shore), how the natural terrain is shaped, its
 * palette, atmosphere, and which props populate it. In Auto journey mode the
 * BiomeSchedule cross-fades between them along the route.
 */
import { Color } from 'three';
import type { Noise } from '../core/rng';
import { RNG } from '../core/rng';
import { smoothstep } from '../core/math';

export type TreeKind = 'fir' | 'pine' | 'broadleaf' | 'larch' | 'palm' | 'cypress' | 'apple' | 'birch' | 'bush';
export type BuildingKind = 'chalet' | 'barn' | 'stoneHouse' | 'church' | 'hut' | 'apartment' | 'villa' | 'farmhouse';
export type RailKind = 'train' | 'tram' | 'rhb' | null;

export interface Palette {
  grass: Color;
  grass2: Color; // variation
  dry: Color; // dry grass / fields
  rock: Color;
  snow: Color;
  forest: Color; // ground tint under forests (reads as forest from far away)
  sand: Color; // shore
}

export interface BiomeDef {
  index: number;
  id: string;
  name: string;
  region: string; // canton-ish subtitle
  places: string[]; // place names for title cards
  // --- road behaviour ---
  curvature: number;
  maxGrade: number;
  hairpins: number; // 0..1 propensity
  contour: number; // 0..1: how strongly the road follows a contour line (lake shores, valley floors)
  contourLevel: number; // metres above water level the road tries to stay at
  terrainSteer: number; // 0..1: how much the road avoids steep grades and water
  passHeight: number; // metres the preferred level rises on mountain-pass sections
  // --- terrain ---
  /** Large-scale height (used for road routing). `h` is the hilliness multiplier. */
  coarse(n: Noise, x: number, z: number, h: number): number;
  /** Small-scale detail added on top. */
  detail(n: Noise, x: number, z: number, h: number): number;
  palette: Palette;
  snowLine: number; // metres; snow above this in summer
  autumnBias: number; // 0..1 pushes colours toward autumn (Engadin larches)
  dryness: number; // 0..1 (Valais is dry)
  // --- atmosphere ---
  fog: number; // fog density multiplier
  mist: number; // 0..1 low clouds hugging the ground (Jura)
  sunWarmth: number; // -1..1 colour temperature shift
  skyDeep: number; // 0..1 how deep blue the zenith is (Engadin)
  mountains: { height: number; snow: number; jagged: number }; // distant ring
  startHour?: number;
  // --- features ---
  rail: RailKind;
  bridgeStyle: 'stone' | 'concrete';
  trees: [TreeKind, number][];
  treeCount: number; // per 128 m road chunk at density 1
  forestScale: number; // metres
  forestThreshold: number; // -1..1, lower = more forest
  buildings: [BuildingKind, number][];
  farmChance: number; // isolated farm per chunk
  villageChance: number;
  village: [BuildingKind, number][];
  cows: number; // chance per chunk of a herd
  marmots: number;
  sheep: number;
  rocks: number; // count per chunk
  vineyards: number; // chance per chunk
  orchards: number;
  haybales: number;
  fences: number; // 0..1 chance a chunk has fences
  stoneWalls: number;
  flags: number;
  waterfalls: number;
  cableCars: number;
  boats: number; // count near water
  skyline: boolean;
  ambient: { birds: number; cowbells: number; water: number; crickets: number };
  preview: { sky: [string, string]; far: string; mid: string; near: string; accent: string };
}

const c = (hex: number) => new Color(hex);

/** |fbm| based valley network: 0 along valley floors, rising to 1 on ridges. */
function valley(n: Noise, x: number, z: number, scale: number): number {
  return Math.abs(n.fbm(x / scale, z / scale, 3));
}

export const BIOMES: BiomeDef[] = [
  {
    index: 0,
    id: 'mittelland',
    name: 'Mittelland',
    region: 'Bern · Emmental',
    places: ['Emmental', 'Langenthal', 'Burgdorf', 'Entlebuch', 'Huttwil', 'Sumiswald', 'Aarwangen', 'Wynigen'],
    curvature: 0.95,
    maxGrade: 0.075,
    hairpins: 0,
    contour: 0.25,
    contourLevel: 32,
    terrainSteer: 0.5,
    passHeight: 0,
    coarse: (n, x, z, h) => 34 + h * (26 * n.fbm(x / 1100, z / 1100, 3) + 10 * n.fbm(x / 380 + 50, z / 380, 2)),
    detail: (n, x, z, h) => h * 2.2 * n.fbm(x / 70, z / 70, 2),
    palette: {
      grass: c(0x6fa83c),
      grass2: c(0x8dbb46),
      dry: c(0xc9b25a),
      rock: c(0x8a8478),
      snow: c(0xf4f6fa),
      forest: c(0x34592a),
      sand: c(0xb9a77d),
    },
    snowLine: 9999,
    autumnBias: 0,
    dryness: 0.1,
    fog: 1,
    mist: 0.15,
    sunWarmth: 0.1,
    skyDeep: 0.4,
    mountains: { height: 0.55, snow: 0.8, jagged: 0.7 },
    rail: 'train',
    bridgeStyle: 'concrete',
    trees: [
      ['broadleaf', 5],
      ['fir', 3],
      ['birch', 1],
      ['bush', 2],
    ],
    treeCount: 70,
    forestScale: 520,
    forestThreshold: 0.25,
    buildings: [
      ['farmhouse', 4],
      ['barn', 3],
      ['chalet', 2],
    ],
    farmChance: 0.55,
    villageChance: 0.1,
    village: [
      ['farmhouse', 3],
      ['chalet', 3],
      ['villa', 2],
      ['church', 1],
    ],
    cows: 0.45,
    marmots: 0,
    sheep: 0.1,
    rocks: 1,
    vineyards: 0,
    orchards: 0.3,
    haybales: 0.4,
    fences: 0.55,
    stoneWalls: 0,
    flags: 0.25,
    waterfalls: 0,
    cableCars: 0,
    boats: 0,
    skyline: false,
    ambient: { birds: 1, cowbells: 0.8, water: 0, crickets: 0.6 },
    preview: { sky: ['#8ec5ef', '#e9f3f8'], far: '#b9c9d9', mid: '#7fae4a', near: '#5d923a', accent: '#9a4b2c' },
  },
  {
    index: 1,
    id: 'alpine',
    name: 'Alpine Pass',
    region: 'Uri · Graubünden',
    places: ['Gotthard', 'Furka', 'Susten', 'Oberalp', 'Klausen', 'Grimsel', 'San Bernardino', 'Andermatt'],
    curvature: 1.25,
    maxGrade: 0.1,
    hairpins: 0.9,
    contour: 0.7,
    contourLevel: 85,
    terrainSteer: 1,
    passHeight: 0,
    coarse: (n, x, z, h) => {
      const v = valley(n, x + 900, z - 300, 1900);
      const ridge = 0.7 + 0.3 * n.ridged(x / 1400, z / 1400, 3);
      return 70 + 30 * n.fbm(x / 900, z / 900, 2) + h * 400 * Math.pow(smoothstep(0.1, 0.65, v), 1.5) * ridge;
    },
    detail: (n, x, z, h) => h * (9 * n.ridged(x / 160, z / 160, 2) + 2 * n.n2(x / 23, z / 23)),
    palette: {
      grass: c(0x6e9b45),
      grass2: c(0x8aa654),
      dry: c(0x9b9a63),
      rock: c(0x7f7b77),
      snow: c(0xf2f5fb),
      forest: c(0x2e4a2c),
      sand: c(0x9d9585),
    },
    snowLine: 330,
    autumnBias: 0,
    dryness: 0.2,
    fog: 0.85,
    mist: 0.2,
    sunWarmth: -0.05,
    skyDeep: 0.75,
    mountains: { height: 1.0, snow: 1, jagged: 1 },
    rail: null,
    bridgeStyle: 'stone',
    trees: [
      ['fir', 6],
      ['pine', 2],
      ['larch', 2],
    ],
    treeCount: 55,
    forestScale: 380,
    forestThreshold: 0.1,
    buildings: [
      ['chalet', 3],
      ['hut', 3],
      ['barn', 1],
    ],
    farmChance: 0.2,
    villageChance: 0.05,
    village: [
      ['chalet', 4],
      ['church', 1],
      ['hut', 1],
    ],
    cows: 0.2,
    marmots: 0.45,
    sheep: 0.15,
    rocks: 9,
    vineyards: 0,
    orchards: 0,
    haybales: 0,
    fences: 0.25,
    stoneWalls: 0.2,
    flags: 0.2,
    waterfalls: 0.18,
    cableCars: 0.06,
    boats: 0,
    skyline: false,
    ambient: { birds: 0.4, cowbells: 0.5, water: 0.6, crickets: 0.1 },
    preview: { sky: ['#5b9be0', '#d7e9f7'], far: '#eef3f8', mid: '#7d8b9a', near: '#55794a', accent: '#c4442f' },
  },
  {
    index: 2,
    id: 'lake',
    name: 'Lake District',
    region: 'Lavaux · Vierwaldstättersee',
    places: ['Lavaux', 'Vevey', 'Montreux', 'Weggis', 'Vitznau', 'Brunnen', 'Cully', 'Gersau'],
    curvature: 0.9,
    maxGrade: 0.075,
    hairpins: 0,
    contour: 0.85,
    contourLevel: 7,
    terrainSteer: 0.9,
    passHeight: 0,
    coarse: (n, x, z, h) =>
      20 + h * (40 * n.fbm(x / 1100, z / 1100, 3) + 45 * Math.max(0, n.fbm(x / 1700 + 9, z / 1700, 2))) -
      70 * smoothstep(0.08, 0.42, n.fbm(x / 2400 - 40, z / 2400 + 11, 2)),
    detail: (n, x, z, h) => h * 2 * n.fbm(x / 80, z / 80, 2),
    palette: {
      grass: c(0x74a83e),
      grass2: c(0x95b84c),
      dry: c(0xb7a95e),
      rock: c(0x8c8678),
      snow: c(0xf4f6fa),
      forest: c(0x335a2b),
      sand: c(0xc2b48a),
    },
    snowLine: 9999,
    autumnBias: 0,
    dryness: 0.1,
    fog: 0.9,
    mist: 0.15,
    sunWarmth: 0.15,
    skyDeep: 0.45,
    mountains: { height: 0.8, snow: 0.9, jagged: 0.8 },
    rail: 'train',
    bridgeStyle: 'concrete',
    trees: [
      ['broadleaf', 5],
      ['fir', 2],
      ['cypress', 1],
      ['bush', 2],
    ],
    treeCount: 50,
    forestScale: 450,
    forestThreshold: 0.35,
    buildings: [
      ['villa', 4],
      ['chalet', 2],
      ['farmhouse', 1],
    ],
    farmChance: 0.35,
    villageChance: 0.14,
    village: [
      ['villa', 4],
      ['stoneHouse', 2],
      ['church', 1],
    ],
    cows: 0.1,
    marmots: 0,
    sheep: 0,
    rocks: 1,
    vineyards: 0.55,
    orchards: 0.1,
    haybales: 0.1,
    fences: 0.15,
    stoneWalls: 0.35,
    flags: 0.35,
    waterfalls: 0,
    cableCars: 0,
    boats: 6,
    skyline: false,
    ambient: { birds: 0.8, cowbells: 0.1, water: 1, crickets: 0.6 },
    preview: { sky: ['#78b5ea', '#f2ecdc'], far: '#c6d3df', mid: '#4f87b0', near: '#6f9a3c', accent: '#f2f2f2' },
  },
  {
    index: 3,
    id: 'ticino',
    name: 'Ticino',
    region: 'Lago Maggiore · Lugano',
    places: ['Ascona', 'Morcote', 'Gandria', 'Brissago', 'Locarno', 'Vira', 'Tenero', 'Caslano'],
    curvature: 1.1,
    maxGrade: 0.085,
    hairpins: 0.25,
    contour: 0.65,
    contourLevel: 12,
    terrainSteer: 0.9,
    passHeight: 0,
    coarse: (n, x, z, h) => {
      let t = 45 + h * (75 * n.fbm(x / 900, z / 900, 3) + 40 * Math.max(0, n.fbm(x / 1500, z / 1500 + 5, 2)));
      t -= 60 * smoothstep(0.12, 0.45, n.fbm(x / 2600 + 3, z / 2600 - 8, 2));
      // terraced hillsides
      if (t > 14) {
        const step = 6;
        const f = t / step;
        const fl = Math.floor(f);
        const terraced = (fl + smoothstep(0.65, 1, f - fl)) * step;
        t = t * 0.45 + terraced * 0.55;
      }
      return t;
    },
    detail: (n, x, z, h) => h * 1.6 * n.fbm(x / 70, z / 70, 2),
    palette: {
      grass: c(0x7a9e3a),
      grass2: c(0x9aae4a),
      dry: c(0xc2a258),
      rock: c(0x9a8f80),
      snow: c(0xf4f6fa),
      forest: c(0x3d5a2a),
      sand: c(0xd0bf92),
    },
    snowLine: 9999,
    autumnBias: 0.1,
    dryness: 0.35,
    fog: 0.8,
    mist: 0.05,
    sunWarmth: 0.5,
    skyDeep: 0.55,
    mountains: { height: 0.75, snow: 0.5, jagged: 0.8 },
    rail: null,
    bridgeStyle: 'stone',
    trees: [
      ['palm', 3],
      ['cypress', 3],
      ['broadleaf', 4],
      ['bush', 2],
    ],
    treeCount: 50,
    forestScale: 420,
    forestThreshold: 0.3,
    buildings: [
      ['stoneHouse', 5],
      ['villa', 2],
    ],
    farmChance: 0.35,
    villageChance: 0.2,
    village: [
      ['stoneHouse', 6],
      ['church', 1],
      ['villa', 1],
    ],
    cows: 0,
    marmots: 0,
    sheep: 0.05,
    rocks: 3,
    vineyards: 0.45,
    orchards: 0,
    haybales: 0,
    fences: 0,
    stoneWalls: 0.6,
    flags: 0.2,
    waterfalls: 0,
    cableCars: 0,
    boats: 5,
    skyline: false,
    ambient: { birds: 0.7, cowbells: 0, water: 0.8, crickets: 1 },
    preview: { sky: ['#6fb0ea', '#fde6c2'], far: '#b9b8c9', mid: '#3e7aa6', near: '#8a9a42', accent: '#e6b46a' },
  },
  {
    index: 4,
    id: 'engadin',
    name: 'Engadin',
    region: 'Graubünden · Oberengadin',
    places: ['Sils', 'Silvaplana', 'Pontresina', 'Celerina', 'Zuoz', 'Maloja', 'S-chanf', 'Samedan'],
    curvature: 0.95,
    maxGrade: 0.085,
    hairpins: 0.3,
    contour: 0.7,
    contourLevel: 26,
    terrainSteer: 1,
    passHeight: 0,
    coarse: (n, x, z, h) => {
      const v = valley(n, x - 1200, z + 700, 3200);
      const ridge = 0.7 + 0.3 * n.ridged(x / 1500, z / 1500, 3);
      let t = 26 + 18 * n.fbm(x / 600, z / 600, 2) + h * 380 * Math.pow(smoothstep(0.08, 0.62, v), 1.4) * ridge;
      t -= 34 * smoothstep(0.2, 0.55, n.fbm(x / 1400 + 7, z / 1400, 2)) * (1 - smoothstep(0.05, 0.2, v));
      return t;
    },
    detail: (n, x, z, h) => h * (4 * n.fbm(x / 100, z / 100, 3)),
    palette: {
      grass: c(0x93a04c),
      grass2: c(0xb0a456),
      dry: c(0xc7a759),
      rock: c(0x857f7a),
      snow: c(0xf3f6fc),
      forest: c(0x5a5a2a),
      sand: c(0xa69c86),
    },
    snowLine: 300,
    autumnBias: 0.6,
    dryness: 0.2,
    fog: 0.6,
    mist: 0.05,
    sunWarmth: 0.1,
    skyDeep: 1,
    mountains: { height: 1.0, snow: 1.3, jagged: 0.9 },
    rail: 'rhb',
    bridgeStyle: 'stone',
    trees: [
      ['larch', 7],
      ['pine', 2],
      ['fir', 1],
    ],
    treeCount: 60,
    forestScale: 400,
    forestThreshold: 0.15,
    buildings: [
      ['chalet', 2],
      ['stoneHouse', 2],
      ['hut', 1],
    ],
    farmChance: 0.25,
    villageChance: 0.08,
    village: [
      ['stoneHouse', 4],
      ['chalet', 2],
      ['church', 1],
    ],
    cows: 0.15,
    marmots: 0.25,
    sheep: 0.15,
    rocks: 5,
    vineyards: 0,
    orchards: 0,
    haybales: 0.15,
    fences: 0.2,
    stoneWalls: 0.1,
    flags: 0.15,
    waterfalls: 0.06,
    cableCars: 0.04,
    boats: 2,
    skyline: false,
    ambient: { birds: 0.5, cowbells: 0.4, water: 0.5, crickets: 0.2 },
    preview: { sky: ['#2f6fd6', '#cfe3f7'], far: '#f4f6fb', mid: '#c9973a', near: '#a88a3a', accent: '#d9a43a' },
  },
  {
    index: 5,
    id: 'jura',
    name: 'Jura',
    region: 'Jura · Neuchâtel',
    places: ['Franches-Montagnes', 'Saignelégier', 'La Chaux-de-Fonds', 'Le Locle', 'St-Ursanne', 'Vallée de Joux', 'Chasseral'],
    curvature: 1.05,
    maxGrade: 0.08,
    hairpins: 0.1,
    contour: 0.3,
    contourLevel: 60,
    terrainSteer: 0.7,
    passHeight: 0,
    coarse: (n, x, z, h) => {
      const a = 0.45;
      const r = x * Math.cos(a) + z * Math.sin(a);
      const fold = 0.5 + 0.5 * Math.sin(r / 420 + 1.8 * n.fbm(x / 1800, z / 1800, 2));
      return 55 + h * (85 * Math.pow(fold, 1.6) + 16 * n.fbm(x / 450, z / 450, 2));
    },
    detail: (n, x, z, h) => h * 2.5 * n.fbm(x / 75, z / 75, 2),
    palette: {
      grass: c(0x5f9a3c),
      grass2: c(0x7aa84a),
      dry: c(0xa8a35c),
      rock: c(0xa49c8a),
      snow: c(0xf4f6fa),
      forest: c(0x223f22),
      sand: c(0xa89f86),
    },
    snowLine: 9999,
    autumnBias: 0.05,
    dryness: 0.05,
    fog: 1.35,
    mist: 1,
    sunWarmth: -0.1,
    skyDeep: 0.35,
    mountains: { height: 0.25, snow: 0.0, jagged: 0.3 },
    rail: null,
    bridgeStyle: 'stone',
    trees: [
      ['fir', 7],
      ['pine', 3],
      ['broadleaf', 1],
    ],
    treeCount: 95,
    forestScale: 300,
    forestThreshold: -0.05,
    buildings: [
      ['farmhouse', 4],
      ['barn', 2],
    ],
    farmChance: 0.35,
    villageChance: 0.06,
    village: [
      ['farmhouse', 4],
      ['church', 1],
    ],
    cows: 0.5,
    marmots: 0,
    sheep: 0.1,
    rocks: 3,
    vineyards: 0,
    orchards: 0.05,
    haybales: 0.2,
    fences: 0.6,
    stoneWalls: 0.45,
    flags: 0.1,
    waterfalls: 0,
    cableCars: 0,
    boats: 0,
    skyline: false,
    ambient: { birds: 0.9, cowbells: 1, water: 0.1, crickets: 0.4 },
    preview: { sky: ['#9fb6c6', '#e4e8e6'], far: '#c5d0d3', mid: '#3c5f36', near: '#5c8e3a', accent: '#f3f3ef' },
  },
  {
    index: 6,
    id: 'valais',
    name: 'Valais',
    region: 'Wallis · Rhône Valley',
    places: ['Sion', 'Sierre', 'Leuk', 'Visp', 'Martigny', 'Salgesch', 'Fully', 'Chamoson'],
    curvature: 1.0,
    maxGrade: 0.09,
    hairpins: 0.45,
    contour: 0.7,
    contourLevel: 48,
    terrainSteer: 1,
    passHeight: 0,
    coarse: (n, x, z, h) => {
      const v = valley(n, x + 2100, z + 1300, 2800);
      const ridge = 0.7 + 0.3 * n.ridged(x / 1300, z / 1300, 3);
      return 42 + 14 * n.fbm(x / 500, z / 500, 2) + h * 440 * Math.pow(smoothstep(0.08, 0.6, v), 1.4) * ridge;
    },
    detail: (n, x, z, h) => h * (5 * n.fbm(x / 90, z / 90, 3) + 1.5 * n.n2(x / 19, z / 19)),
    palette: {
      grass: c(0x8f9a48),
      grass2: c(0xa9a052),
      dry: c(0xbfa463),
      rock: c(0x9a8b78),
      snow: c(0xf3f5fa),
      forest: c(0x46542c),
      sand: c(0xb8a580),
    },
    snowLine: 380,
    autumnBias: 0.15,
    dryness: 0.8,
    fog: 0.65,
    mist: 0,
    sunWarmth: 0.35,
    skyDeep: 0.8,
    mountains: { height: 1.05, snow: 1, jagged: 1.1 },
    rail: 'train',
    bridgeStyle: 'stone',
    trees: [
      ['pine', 5],
      ['larch', 2],
      ['bush', 3],
      ['cypress', 1],
    ],
    treeCount: 35,
    forestScale: 350,
    forestThreshold: 0.35,
    buildings: [
      ['stoneHouse', 4],
      ['chalet', 2],
      ['barn', 1],
    ],
    farmChance: 0.3,
    villageChance: 0.12,
    village: [
      ['stoneHouse', 4],
      ['chalet', 3],
      ['church', 1],
    ],
    cows: 0.05,
    marmots: 0.2,
    sheep: 0.2,
    rocks: 10,
    vineyards: 0.6,
    orchards: 0.15,
    haybales: 0,
    fences: 0.05,
    stoneWalls: 0.7,
    flags: 0.25,
    waterfalls: 0.05,
    cableCars: 0.14,
    boats: 0,
    skyline: false,
    ambient: { birds: 0.5, cowbells: 0.1, water: 0.2, crickets: 1 },
    preview: { sky: ['#4d8fe0', '#f3e6cf'], far: '#e9ecf2', mid: '#a28866', near: '#9b9a4f', accent: '#cbb38a' },
  },
  {
    index: 7,
    id: 'zurich',
    name: 'Zurich Outskirts',
    region: 'Zürich · Limmattal',
    places: ['Zollikon', 'Küsnacht', 'Kilchberg', 'Rüschlikon', 'Dietikon', 'Wollishofen', 'Thalwil', 'Meilen'],
    curvature: 0.85,
    maxGrade: 0.07,
    hairpins: 0,
    contour: 0.6,
    contourLevel: 8,
    terrainSteer: 0.7,
    passHeight: 0,
    coarse: (n, x, z, h) =>
      22 + h * (22 * n.fbm(x / 900, z / 900, 3) + 25 * Math.max(0, n.fbm(x / 1500 + 2, z / 1500, 2))) -
      50 * smoothstep(0.12, 0.45, n.fbm(x / 2500 + 13, z / 2500 + 4, 2)),
    detail: (n, x, z, h) => h * 1.2 * n.fbm(x / 70, z / 70, 2),
    palette: {
      grass: c(0x6b9c40),
      grass2: c(0x86ac4c),
      dry: c(0xaea35d),
      rock: c(0x8a867e),
      snow: c(0xf4f6fa),
      forest: c(0x2f5229),
      sand: c(0xb3a888),
    },
    snowLine: 9999,
    autumnBias: 0,
    dryness: 0.1,
    fog: 1.0,
    mist: 0.1,
    sunWarmth: 0.25,
    skyDeep: 0.4,
    mountains: { height: 0.5, snow: 0.9, jagged: 0.7 },
    startHour: 19.6,
    rail: 'tram',
    bridgeStyle: 'concrete',
    trees: [
      ['broadleaf', 6],
      ['birch', 2],
      ['fir', 2],
    ],
    treeCount: 40,
    forestScale: 450,
    forestThreshold: 0.4,
    buildings: [
      ['apartment', 5],
      ['villa', 4],
      ['farmhouse', 1],
    ],
    farmChance: 0.6,
    villageChance: 0.35,
    village: [
      ['apartment', 5],
      ['villa', 3],
      ['church', 1],
    ],
    cows: 0.05,
    marmots: 0,
    sheep: 0,
    rocks: 0,
    vineyards: 0.15,
    orchards: 0.1,
    haybales: 0.05,
    fences: 0.1,
    stoneWalls: 0.1,
    flags: 0.3,
    waterfalls: 0,
    cableCars: 0,
    boats: 5,
    skyline: true,
    ambient: { birds: 0.6, cowbells: 0, water: 0.7, crickets: 0.3 },
    preview: { sky: ['#2b3a67', '#f0a46a'], far: '#4b4e6d', mid: '#33405e', near: '#3d5a3a', accent: '#ffcf7a' },
  },
];

export const BIOME_COUNT = BIOMES.length;

/**
 * Decides which biome(s) apply at a given distance along the route.
 * Fixed maps return a one-hot weight vector; Auto journey walks a seeded
 * sequence of segments with long, gentle cross-fades.
 */
export class BiomeSchedule {
  private segs: { start: number; end: number; biome: number; place: string; railSide: number }[] = [];
  private rng: RNG;
  static readonly FADE = 1500; // metres of cross-fade between auto-journey regions

  constructor(
    seed: number,
    readonly map: number, // -1 = auto journey
  ) {
    this.rng = new RNG(seed ^ 0xb10e5);
    if (map >= 0) {
      const b = BIOMES[map];
      this.segs.push({ start: -1e9, end: 1e12, biome: map, place: this.rng.pick(b.places), railSide: this.rng.sign() });
    } else {
      this.extend(0);
    }
  }

  private extend(upTo: number): void {
    while (this.segs.length === 0 || this.segs[this.segs.length - 1].end < upTo + 20000) {
      const last = this.segs[this.segs.length - 1];
      let b: number;
      if (!last) b = this.rng.int(0, BIOME_COUNT - 1);
      else {
        do b = this.rng.int(0, BIOME_COUNT - 1);
        while (b === last.biome);
      }
      const start = last ? last.end : -1e6;
      const len = last ? this.rng.range(4500, 7500) : 1e6 + this.rng.range(4000, 6000);
      this.segs.push({ start, end: start + len, biome: b, place: this.rng.pick(BIOMES[b].places), railSide: this.rng.sign() });
    }
  }

  private findSeg(s: number): number {
    if (this.map < 0) this.extend(s);
    // segments are sorted; binary search
    let lo = 0;
    let hi = this.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segs[mid].start <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Fill `out` (length BIOME_COUNT) with blend weights at route distance s. */
  weights(s: number, out: Float32Array): Float32Array {
    out.fill(0);
    const i = this.findSeg(s);
    const seg = this.segs[i];
    if (this.map >= 0) {
      out[seg.biome] = 1;
      return out;
    }
    const half = BiomeSchedule.FADE / 2;
    const next = this.segs[i + 1];
    const prev = this.segs[i - 1];
    if (next && s > seg.end - half) {
      const t = smoothstep(seg.end - half, seg.end + half, s);
      out[seg.biome] += 1 - t;
      out[next.biome] += t;
    } else if (prev && s < seg.start + half) {
      const t = smoothstep(seg.start - half, seg.start + half, s);
      out[prev.biome] += 1 - t;
      out[seg.biome] += t;
    } else {
      out[seg.biome] = 1;
    }
    return out;
  }

  /** Dominant region at s (for title cards and stats). */
  region(s: number): { biome: number; place: string; start: number; railSide: number } {
    const seg = this.segs[this.findSeg(s)];
    return { biome: seg.biome, place: seg.place, start: seg.start, railSide: seg.railSide };
  }
}
