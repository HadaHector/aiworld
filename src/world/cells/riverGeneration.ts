import { mulberry32, deriveSeed } from "../rng";
import { RIVERS_PER_CONTINENT_RANGE, RIVER_LENGTH_RANGE, RIVER_SOURCE_SALT, RIVER_LENGTH_SALT, RIVER_WALK_SALT } from "./config";

function randomIntInRange(rng: () => number, [min, max]: [number, number]): number {
  return Math.round(min + rng() * (max - min));
}

function isMouthCandidate(
  cell: number,
  adjacency: number[][],
  landCells: ReadonlySet<number>,
  lakeCells: ReadonlySet<number>,
  usedRiverCells: ReadonlySet<number>,
): boolean {
  if (lakeCells.has(cell) || usedRiverCells.has(cell)) return false;
  return adjacency[cell].some((n) => !landCells.has(n) || lakeCells.has(n));
}

/** Randomized walk through the adjacency graph, staying inside this continent's land, never
 *  crossing into a lake cell or revisiting an already-used cell. Stops at a dead end or maxLength. */
function walkRiver(
  rng: () => number,
  adjacency: number[][],
  continentCells: ReadonlySet<number>,
  lakeCells: ReadonlySet<number>,
  usedRiverCells: Set<number>,
  mouth: number,
  maxLength: number,
): number[] {
  const path = [mouth];
  usedRiverCells.add(mouth);

  for (let i = 0; i < maxLength - 1; i++) {
    const current = path[path.length - 1];
    const candidates = adjacency[current].filter((n) => continentCells.has(n) && !lakeCells.has(n) && !usedRiverCells.has(n));
    if (candidates.length === 0) break;

    const picked = candidates[Math.floor(rng() * candidates.length)];
    path.push(picked);
    usedRiverCells.add(picked);
  }

  return path;
}

export interface RiverGenParams {
  continentSeed: number;
  adjacency: number[][];
  continentCells: ReadonlySet<number>;
  landCells: ReadonlySet<number>;
  lakeCells: ReadonlySet<number>;
  usedRiverCells: Set<number>;
}

/**
 * Pure graph-topology river generation - no height signal exists yet at this point (cell/area
 * generation runs before createBedrockSampler/the height pipelines are constructed), so this is
 * deliberately not downhill-routed, matching how growLandmass/partitionIntoAreas also ignore
 * height entirely. Each river starts at a cell adjacent to open ocean or a lake (its "mouth") and
 * randomly extends inland; a river never crosses into a lake's interior (only touches one at the
 * mouth) and never shares a cell with another river, so no two rivers can ever cross or merge.
 */
export function generateRiversForContinent(params: RiverGenParams): number[][] {
  const { continentSeed, adjacency, continentCells, landCells, lakeCells, usedRiverCells } = params;

  const countRng = mulberry32(deriveSeed(continentSeed, RIVER_SOURCE_SALT));
  const riverCount = randomIntInRange(countRng, RIVERS_PER_CONTINENT_RANGE);
  const lengthRng = mulberry32(deriveSeed(continentSeed, RIVER_LENGTH_SALT));
  const walkRng = mulberry32(deriveSeed(continentSeed, RIVER_WALK_SALT));

  const paths: number[][] = [];

  for (let i = 0; i < riverCount; i++) {
    const mouths = [...continentCells].filter((c) => isMouthCandidate(c, adjacency, landCells, lakeCells, usedRiverCells));
    if (mouths.length === 0) break;

    const mouth = mouths[Math.floor(walkRng() * mouths.length)];
    const length = randomIntInRange(lengthRng, RIVER_LENGTH_RANGE);
    const path = walkRiver(walkRng, adjacency, continentCells, lakeCells, usedRiverCells, mouth, length);
    if (path.length >= 2) paths.push(path);
  }

  return paths;
}
