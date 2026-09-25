import type { BiomeDefinition } from "./biomes/biomeTypes";

/**
 * Testing-only override: when set to a biome id, every area in the world is assigned
 * that one biome instead of the normal weighted-random mix, so its height pipeline can be tuned
 * by walking around a huge, uninterrupted stretch of it starting right at spawn - no need to hunt
 * the map for a naturally-spawned zone. Land/ocean shape and area boundaries are untouched; only
 * which biome each area resolves to is overridden. Set back to null before real play/commits.
 */
export const FORCE_BIOME_ID: string | null = null;

export function resolveForcedBiome(biomes: BiomeDefinition[]): BiomeDefinition | null {
  if (FORCE_BIOME_ID === null) return null;
  const biome = biomes.find((b) => b.id === FORCE_BIOME_ID);
  if (!biome) {
    throw new Error(`FORCE_BIOME_ID "${FORCE_BIOME_ID}" does not match any biome id`);
  }
  return biome;
}
