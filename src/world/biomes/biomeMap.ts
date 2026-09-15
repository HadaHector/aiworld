import { mulberry32, deriveSeed } from "../rng";
import { smoothstep } from "../mathUtils";
import type { ContinentSampler } from "../continent";
import { CONTINENT_CENTER_X, CONTINENT_CENTER_Z, CONTINENT_RADIUS_WORLD } from "../continent";
import { createVoronoiField, type VoronoiPoint } from "./voronoi";
import { BIOME_REGISTRY } from "./biomeDefinitions";
import type { BiomeDefinition } from "./biomeTypes";

export interface BiomeSample {
  primary: BiomeDefinition;
  secondary: BiomeDefinition;
  blend: number;
}

export interface BiomeField {
  sampleAt(worldX: number, worldZ: number): BiomeSample;
}

const BIOME_SEED_COUNT = 14;
const MIN_SEED_SPACING = 70;
const LAND_MARGIN = 0.15;
const MAX_PLACEMENT_ATTEMPTS_PER_SEED = 200;
const BORDER_BLEND_WIDTH = 18;

const SEED_POSITION_SALT = 301;
const SEED_BIOME_SALT = 302;

interface BiomeSeed extends VoronoiPoint {
  biome: BiomeDefinition;
}

function placeBiomeSeeds(seed: number, continent: ContinentSampler, count: number): VoronoiPoint[] {
  const rng = mulberry32(deriveSeed(seed, SEED_POSITION_SALT));
  const points: VoronoiPoint[] = [];

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS_PER_SEED; attempt++) {
      const angle = rng() * Math.PI * 2;
      const radius = Math.sqrt(rng()) * CONTINENT_RADIUS_WORLD;
      const x = CONTINENT_CENTER_X + Math.cos(angle) * radius;
      const z = CONTINENT_CENTER_Z + Math.sin(angle) * radius;

      if (continent(x, z).landmass <= LAND_MARGIN) continue;

      const tooClose = points.some((point) => {
        const dx = point.x - x;
        const dz = point.z - z;
        return dx * dx + dz * dz < MIN_SEED_SPACING * MIN_SEED_SPACING;
      });
      if (tooClose) continue;

      points.push({ x, z });
      break;
    }
  }

  return points;
}

function pickWeightedBiome(rng: () => number): BiomeDefinition {
  const totalWeight = BIOME_REGISTRY.reduce((sum, biome) => sum + biome.spawnWeight, 0);
  let roll = rng() * totalWeight;

  for (const biome of BIOME_REGISTRY) {
    roll -= biome.spawnWeight;
    if (roll <= 0) return biome;
  }

  return BIOME_REGISTRY[BIOME_REGISTRY.length - 1];
}

function assignBiomes(seed: number, positions: VoronoiPoint[]): BiomeSeed[] {
  const rng = mulberry32(deriveSeed(seed, SEED_BIOME_SALT));
  return positions.map((position) => ({ ...position, biome: pickWeightedBiome(rng) }));
}

function computeBorderBlend(nearestDistance: number, secondNearestDistance: number): number {
  const gap = secondNearestDistance - nearestDistance;
  const t = 1 - smoothstep(0, BORDER_BLEND_WIDTH, gap);
  return t * 0.5;
}

export function createBiomeField(seed: number, continent: ContinentSampler): BiomeField {
  const positions = placeBiomeSeeds(seed, continent, BIOME_SEED_COUNT);
  const seeds = assignBiomes(seed, positions);
  const cellSize = Math.max(40, CONTINENT_RADIUS_WORLD / Math.sqrt(Math.max(1, seeds.length)));
  const voronoi = createVoronoiField(seeds, cellSize);

  function sampleAt(worldX: number, worldZ: number): BiomeSample {
    const query = voronoi.query(worldX, worldZ);
    const primary = seeds[query.nearestIndex]?.biome ?? BIOME_REGISTRY[0];
    const secondary = seeds[query.secondNearestIndex]?.biome ?? primary;
    const blend = query.secondNearestIndex === -1 ? 0 : computeBorderBlend(query.nearestDistance, query.secondNearestDistance);

    return { primary, secondary, blend };
  }

  return { sampleAt };
}
