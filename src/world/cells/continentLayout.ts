import { mulberry32, deriveSeed } from "../rng";
import {
  CONTINENT_COUNT_RANGE,
  AREAS_PER_CONTINENT_RANGE,
  CELLS_PER_AREA,
  GROWTH_RADIUS_SAFETY_FACTOR,
  CONTINENT_OCEAN_GAP,
  CELL_SPACING,
  CONTINENT_COUNT_SALT,
  AREAS_PER_CONTINENT_SALT,
  CONTINENT_LAYOUT_SALT,
  CONTINENT_SEED_BASE,
} from "./config";

export interface ContinentPlan {
  seed: number;
  centerX: number;
  centerZ: number;
  areaCount: number;
  cellCount: number;
  radius: number;
}

export interface WorldLayout {
  continents: ContinentPlan[];
  worldExtent: number;
}

const RING_ANGLE_JITTER_FRACTION = 0.15;

function randomIntInRange(rng: () => number, [min, max]: [number, number]): number {
  return Math.round(min + rng() * (max - min));
}

function continentRadius(cellCount: number): number {
  return CELL_SPACING * Math.sqrt(cellCount / Math.PI) * GROWTH_RADIUS_SAFETY_FACTOR;
}

/**
 * Rolls how many continents exist and how large each is (both ranges, randomized per seed), then
 * places them on a deterministic ring around continent 0 (always at world origin, since the
 * character spawns at heightAt(0,0)) so separation between any two continents is guaranteed by
 * construction, not just probable. World size is derived to comfortably contain the result.
 */
export function planWorld(seed: number): WorldLayout {
  const countRng = mulberry32(deriveSeed(seed, CONTINENT_COUNT_SALT));
  const continentCount = randomIntInRange(countRng, CONTINENT_COUNT_RANGE);

  const areaCountRng = mulberry32(deriveSeed(seed, AREAS_PER_CONTINENT_SALT));
  const areaCounts: number[] = [];
  for (let i = 0; i < continentCount; i++) {
    areaCounts.push(randomIntInRange(areaCountRng, AREAS_PER_CONTINENT_RANGE));
  }

  const radii = areaCounts.map((areaCount) => continentRadius(areaCount * CELLS_PER_AREA));

  const ringCount = continentCount - 1;
  let ringRadius = 0;

  // Center clearance: every ring continent must clear continent 0 (always exactly `ringRadius`
  // from origin regardless of angular jitter, since jitter here is angular only).
  for (let i = 1; i < continentCount; i++) {
    ringRadius = Math.max(ringRadius, radii[0] + radii[i] + CONTINENT_OCEAN_GAP);
  }

  // Adjacent-on-ring clearance, evaluated at the worst-case (most-closed) post-jitter angle.
  if (ringCount >= 2) {
    const angleStep = (Math.PI * 2) / ringCount;
    const worstAngleStep = angleStep * (1 - 2 * RING_ANGLE_JITTER_FRACTION);
    for (let i = 1; i < continentCount; i++) {
      const j = i === continentCount - 1 ? 1 : i + 1;
      const clearance = (radii[i] + radii[j] + CONTINENT_OCEAN_GAP) / (2 * Math.sin(worstAngleStep / 2));
      ringRadius = Math.max(ringRadius, clearance);
    }
  }

  const jitterRng = mulberry32(deriveSeed(seed, CONTINENT_LAYOUT_SALT));
  const continents: ContinentPlan[] = [];

  for (let i = 0; i < continentCount; i++) {
    const continentSeed = deriveSeed(seed, CONTINENT_SEED_BASE + i);
    const areaCount = areaCounts[i];
    const cellCount = areaCount * CELLS_PER_AREA;
    const radius = radii[i];

    if (i === 0) {
      continents.push({ seed: continentSeed, centerX: 0, centerZ: 0, areaCount, cellCount, radius });
      continue;
    }

    const ringIndex = i - 1;
    const angleStep = (Math.PI * 2) / ringCount;
    const jitter = (jitterRng() * 2 - 1) * RING_ANGLE_JITTER_FRACTION * angleStep;
    const angle = angleStep * ringIndex + jitter;

    continents.push({
      seed: continentSeed,
      centerX: Math.cos(angle) * ringRadius,
      centerZ: Math.sin(angle) * ringRadius,
      areaCount,
      cellCount,
      radius,
    });
  }

  const maxRingRadius = continents.slice(1).reduce((max, c) => Math.max(max, c.radius), 0);
  const farthestExtent = ringCount > 0 ? ringRadius + maxRingRadius : radii[0];
  const worldExtent = 2 * farthestExtent;

  return { continents, worldExtent };
}
