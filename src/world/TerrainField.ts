/**
 * The *natural* terrain height field: a blend of the per-biome height
 * functions. It knows nothing about the road – the road is routed over this
 * field and the final terrain (see Terrain.heightAt) is then flattened to it.
 */
import { Noise } from '../core/rng';
import { BIOMES, BIOME_COUNT } from './Biomes';

export const WATER_LEVEL = 0;

export class TerrainField {
  readonly noise: Noise;
  constructor(
    seed: number,
    public hilliness: number,
  ) {
    this.noise = new Noise(seed);
  }

  /** Large-scale height only (smooth) – used for routing decisions. */
  coarse(x: number, z: number, w: Float32Array): number {
    let h = 0;
    const hill = this.hilliness;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const wb = w[b];
      if (wb < 0.002) continue;
      h += wb * BIOMES[b].coarse(this.noise, x, z, hill);
    }
    return h;
  }

  /** Full natural height (coarse + detail). */
  natural(x: number, z: number, w: Float32Array): number {
    let h = 0;
    const hill = this.hilliness;
    const n = this.noise;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const wb = w[b];
      if (wb < 0.002) continue;
      const def = BIOMES[b];
      h += wb * (def.coarse(n, x, z, hill) + def.detail(n, x, z, hill));
    }
    return h;
  }
}
