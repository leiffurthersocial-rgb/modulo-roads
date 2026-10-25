/**
 * Seasonal colour transforms for terrain palettes and vegetation.
 * All colours are linear RGB (three.js working space).
 */
import { Color } from 'three';
import type { Season } from '../core/Settings';
import { BIOMES, type Palette, type TreeKind } from './Biomes';

const tmp = new Color();

function mix(a: Color, hex: number, t: number): Color {
  tmp.setHex(hex);
  return a.lerp(tmp, t);
}

/** Season-adjusted copy of a biome palette. */
export function seasonalPalette(biome: number, season: Season): Palette {
  const src = BIOMES[biome].palette;
  const p: Palette = {
    grass: src.grass.clone(),
    grass2: src.grass2.clone(),
    dry: src.dry.clone(),
    rock: src.rock.clone(),
    snow: src.snow.clone(),
    forest: src.forest.clone(),
    sand: src.sand.clone(),
  };
  const bias = BIOMES[biome].autumnBias;
  const autumn = (amt: number) => {
    mix(p.grass, 0xa39a45, 0.45 * amt);
    mix(p.grass2, 0xc59a3e, 0.5 * amt);
    mix(p.forest, 0x7a4a1c, 0.45 * amt);
    mix(p.dry, 0xa07a40, 0.4 * amt);
  };
  switch (season) {
    case 'spring':
      mix(p.grass, 0x86c048, 0.45);
      mix(p.grass2, 0xa9cf55, 0.45);
      mix(p.dry, 0x9cc24f, 0.55);
      if (bias > 0) autumn(bias * 0.2);
      break;
    case 'summer':
      if (bias > 0) autumn(bias * 0.55);
      break;
    case 'autumn':
      autumn(1);
      break;
    case 'winter':
      mix(p.grass, 0xe8edf4, 0.88);
      mix(p.grass2, 0xdfe6ef, 0.85);
      mix(p.dry, 0xe2e7ee, 0.85);
      mix(p.forest, 0x6f7f78, 0.55);
      mix(p.sand, 0xcfd6de, 0.6);
      break;
  }
  return p;
}

/** Foliage colour for a tree kind in a given season (linear RGB). */
export function foliageColor(kind: TreeKind, season: Season, variant: number, autumnBias: number, out: Color): Color {
  const v = variant; // 0..1 random per instance
  switch (kind) {
    case 'fir':
      out.setHex(v < 0.5 ? 0x2f5a32 : 0x3a6638);
      if (season === 'winter') mix(out, 0xdfe7ee, 0.35);
      break;
    case 'pine':
      out.setHex(v < 0.5 ? 0x3e6a3a : 0x4b7340);
      if (season === 'winter') mix(out, 0xdfe7ee, 0.3);
      break;
    case 'larch': {
      out.setHex(0x6f9a40);
      const a = season === 'autumn' ? 1 : season === 'winter' ? 0.2 : season === 'summer' ? autumnBias * 0.9 : autumnBias * 0.3;
      mix(out, v < 0.5 ? 0xe0a636 : 0xd18a2a, a);
      if (season === 'winter') mix(out, 0x9a8f7a, 0.6);
      break;
    }
    case 'broadleaf':
    case 'apple':
    case 'birch': {
      out.setHex(kind === 'birch' ? 0x86a94a : v < 0.5 ? 0x4f8a36 : 0x5f9a3c);
      if (season === 'spring') mix(out, 0x8cc455, 0.45);
      if (season === 'autumn') mix(out, v < 0.33 ? 0xc0442a : v < 0.66 ? 0xd88a2c : 0xc9a234, 0.85);
      else if (autumnBias > 0 && season === 'summer') mix(out, 0xc9a234, autumnBias * 0.4);
      if (season === 'winter') out.setHex(0x8a7e72); // bare branches read as brown-grey
      break;
    }
    case 'palm':
      out.setHex(v < 0.5 ? 0x4f8f3a : 0x5e9a40);
      break;
    case 'cypress':
      out.setHex(0x2f5230);
      break;
    case 'bush':
      out.setHex(v < 0.5 ? 0x4a7c34 : 0x5c8a3a);
      if (season === 'autumn') mix(out, 0xa8652c, 0.6);
      if (season === 'winter') mix(out, 0xdfe7ee, 0.55);
      break;
  }
  return out;
}

export function grassTint(season: Season, out: Color): Color {
  switch (season) {
    case 'spring':
      return out.setHex(0x86c048);
    case 'summer':
      return out.setHex(0x6fa63e);
    case 'autumn':
      return out.setHex(0xa8994a);
    case 'winter':
      return out.setHex(0xc9d3d8);
  }
}
