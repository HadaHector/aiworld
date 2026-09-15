import { mulberry32, deriveSeed } from "../rng";
import { BIOME_REGISTRY } from "../biomes/biomeDefinitions";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import { AREA_SEED_SALT, AREA_GROWTH_SALT, AREA_BIOME_SALT } from "./config";

function computeLandDistances(seeds: number[], landCells: Set<number>, adjacency: number[][]): Map<number, number> {
  const dist = new Map<number, number>();
  const queue: number[] = [];

  for (const s of seeds) {
    dist.set(s, 0);
    queue.push(s);
  }

  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const curDist = dist.get(cur)!;
    for (const n of adjacency[cur]) {
      if (landCells.has(n) && !dist.has(n)) {
        dist.set(n, curDist + 1);
        queue.push(n);
      }
    }
  }

  return dist;
}

/** Picks area-seed cells spread apart (farthest-point sampling over graph distance) so no region is starved of a nearby seed. */
export function pickSpreadAreaSeeds(seed: number, landCells: Set<number>, adjacency: number[][], areaCount: number): number[] {
  const rng = mulberry32(deriveSeed(seed, AREA_SEED_SALT));
  const landArray = [...landCells];
  const chosen = new Set<number>();

  const first = landArray[Math.floor(rng() * landArray.length)];
  chosen.add(first);

  while (chosen.size < areaCount && chosen.size < landArray.length) {
    const dist = computeLandDistances([...chosen], landCells, adjacency);
    let best = -1;
    let bestDist = -1;

    for (const cell of landArray) {
      if (chosen.has(cell)) continue;
      const d = dist.get(cell) ?? Number.POSITIVE_INFINITY;
      if (d > bestDist) {
        bestDist = d;
        best = cell;
      }
    }

    if (best === -1) break;
    chosen.add(best);
  }

  return [...chosen];
}

/**
 * Simultaneous randomized multi-source flood-fill: each step picks one candidate uniformly at
 * random across every area's combined pending frontier (not round-robin), so areas that happen
 * to open into more territory claim it faster — this is what produces genuine size/shape variance
 * between areas rather than a balanced, evenly-sized partition.
 */
export function partitionIntoAreas(seed: number, adjacency: number[][], landCells: Set<number>, areaCount: number): Map<number, number> {
  const areaSeeds = pickSpreadAreaSeeds(seed, landCells, adjacency, areaCount);
  const rng = mulberry32(deriveSeed(seed, AREA_GROWTH_SALT));

  const assignment = new Map<number, number>();
  areaSeeds.forEach((cell, areaId) => assignment.set(cell, areaId));

  const frontiers: Set<number>[] = areaSeeds.map((seedCell) =>
    new Set(adjacency[seedCell].filter((n) => landCells.has(n) && !assignment.has(n))),
  );

  let remaining = landCells.size - areaSeeds.length;

  while (remaining > 0) {
    const candidates: { areaId: number; cell: number }[] = [];
    frontiers.forEach((frontier, areaId) => {
      for (const cell of frontier) {
        if (!assignment.has(cell)) candidates.push({ areaId, cell });
      }
    });

    if (candidates.length === 0) break;

    const picked = candidates[Math.floor(rng() * candidates.length)];
    assignment.set(picked.cell, picked.areaId);
    remaining--;

    frontiers.forEach((f) => f.delete(picked.cell));
    for (const n of adjacency[picked.cell]) {
      if (landCells.has(n) && !assignment.has(n)) frontiers[picked.areaId].add(n);
    }
  }

  return assignment;
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

/** Assigns one biome per area (not per cell) via weighted roulette, so every cell in an area shares its look. */
export function assignAreaBiomes(seed: number, areaCount: number): BiomeDefinition[] {
  const rng = mulberry32(deriveSeed(seed, AREA_BIOME_SALT));
  const biomes: BiomeDefinition[] = [];

  for (let i = 0; i < areaCount; i++) {
    biomes.push(pickWeightedBiome(rng));
  }

  return biomes;
}
