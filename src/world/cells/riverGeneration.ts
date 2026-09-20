import { mulberry32, deriveSeed } from "../rng";
import { RIVERS_PER_CONTINENT_RANGE, RIVER_LENGTH_RANGE, RIVER_SOURCE_SALT, RIVER_LENGTH_SALT, RIVER_WALK_SALT } from "./config";

function randomIntInRange(rng: () => number, [min, max]: [number, number]): number {
  return Math.round(min + rng() * (max - min));
}

function isOceanAdjacent(cell: number, adjacency: number[][], landCells: ReadonlySet<number>): boolean {
  return adjacency[cell].some((n) => !landCells.has(n));
}

/**
 * The neighbour whose shared border the river's centreline should START at, or -1 if there is none.
 *
 * A river's path is a chain of cells, and its centreline runs through the midpoint of each
 * consecutive pair's shared border. Left alone, that line therefore begins at the border between
 * the mouth cell and the SECOND cell - a full cell away from the water the river drains into, with
 * untouched land in between. Prepending the water body itself to the chain puts the first point of
 * the line on the shore where it belongs.
 *
 * Open ocean is not a single cell, but the cells beyond the coastline are, and the coastline runs
 * roughly along their border with the land - so an ocean neighbour works here exactly like a lake.
 * Lakes are preferred when a mouth touches both, then a trunk river (which makes a tributary
 * actually meet the river it was generated to join), then the sea.
 *
 * MUST be called before walkRiver, which adds this path's own cells to usedRiverCells - afterwards
 * a neighbour that merely happens to lie further along this same river would look like a trunk.
 */
function findMouthLink(
  cell: number,
  adjacency: number[][],
  landCells: ReadonlySet<number>,
  lakeCells: ReadonlySet<number>,
  usedRiverCells: ReadonlySet<number>,
): number {
  const lake = adjacency[cell].find((n) => lakeCells.has(n));
  if (lake !== undefined) return lake;
  const trunk = adjacency[cell].find((n) => usedRiverCells.has(n));
  if (trunk !== undefined) return trunk;
  return adjacency[cell].find((n) => !landCells.has(n)) ?? -1;
}

/** A valid river mouth is adjacent to open ocean, a lake, OR an already-placed river cell (a
 *  tributary joining an existing one) - never a lake's own interior or an already-used cell. */
function isMouthCandidate(
  cell: number,
  adjacency: number[][],
  landCells: ReadonlySet<number>,
  lakeCells: ReadonlySet<number>,
  usedRiverCells: ReadonlySet<number>,
): boolean {
  if (lakeCells.has(cell) || usedRiverCells.has(cell)) return false;
  return adjacency[cell].some((n) => !landCells.has(n) || lakeCells.has(n) || usedRiverCells.has(n));
}

/**
 * Randomized walk through the adjacency graph, staying inside this continent's land, never
 * crossing into a lake cell, never revisiting an already-used cell. After the mouth, PREFERS a
 * cell that isn't itself ocean-adjacent (steering inland, away from the coast, so a river doesn't
 * read as a short shortcut connecting one patch of open water to another) but FALLS BACK to an
 * ocean-adjacent candidate when that's the only option - a coastal cell's neighbors are often also
 * coastal (the shore clusters together), so unconditionally banning every ocean-adjacent cell
 * meant almost every ocean-mouthed river immediately had zero valid next steps and got discarded
 * as a 1-cell dud, while lake mouths (always comfortably inland, see areaField.ts's lake-roll)
 * never hit that wall - silently biasing every generated river toward lake mouths only. Stops at a
 * genuine dead end (no unclaimed neighbor at all) or maxLength.
 */
function walkRiver(
  rng: () => number,
  adjacency: number[][],
  continentCells: ReadonlySet<number>,
  landCells: ReadonlySet<number>,
  lakeCells: ReadonlySet<number>,
  usedRiverCells: Set<number>,
  mouth: number,
  maxLength: number,
): number[] {
  const path = [mouth];
  usedRiverCells.add(mouth);

  for (let i = 0; i < maxLength - 1; i++) {
    const current = path[path.length - 1];
    const allCandidates = adjacency[current].filter((n) => continentCells.has(n) && !lakeCells.has(n) && !usedRiverCells.has(n));
    if (allCandidates.length === 0) break;

    const inlandCandidates = allCandidates.filter((n) => !isOceanAdjacent(n, adjacency, landCells));
    const candidates = inlandCandidates.length > 0 ? inlandCandidates : allCandidates;

    const picked = candidates[Math.floor(rng() * candidates.length)];
    path.push(picked);
    usedRiverCells.add(picked);
  }

  return path;
}

/** One generated river: its path through the cell graph, plus the neighbour whose shared border its
 *  centreline starts at - the lake, trunk river or stretch of sea it drains into. */
export interface RiverPath {
  cells: number[];
  mouthLink: number;
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
 * height entirely. Each river starts at a cell adjacent to open ocean, a lake, or an already-placed
 * river (a tributary) and randomly extends inland; a river never crosses into a lake's interior
 * (only touches one at the mouth), prefers to steer inland after its own mouth rather than
 * re-touching open ocean (falling back to a coastal step only when no inland option exists), and
 * never shares a cell with another river, so no two rivers can ever cross or merge. Each
 * path also carries the neighbour it drains into, so its centreline can start at that shore rather
 * than a cell away from it (see findMouthLink).
 */
export function generateRiversForContinent(params: RiverGenParams): RiverPath[] {
  const { continentSeed, adjacency, continentCells, landCells, lakeCells, usedRiverCells } = params;

  const countRng = mulberry32(deriveSeed(continentSeed, RIVER_SOURCE_SALT));
  const riverCount = randomIntInRange(countRng, RIVERS_PER_CONTINENT_RANGE);
  const lengthRng = mulberry32(deriveSeed(continentSeed, RIVER_LENGTH_SALT));
  const walkRng = mulberry32(deriveSeed(continentSeed, RIVER_WALK_SALT));

  const paths: RiverPath[] = [];

  for (let i = 0; i < riverCount; i++) {
    const mouths = [...continentCells].filter((c) => isMouthCandidate(c, adjacency, landCells, lakeCells, usedRiverCells));
    if (mouths.length === 0) break;

    const mouth = mouths[Math.floor(walkRng() * mouths.length)];
    const mouthLink = findMouthLink(mouth, adjacency, landCells, lakeCells, usedRiverCells);
    const length = randomIntInRange(lengthRng, RIVER_LENGTH_RANGE);
    const path = walkRiver(walkRng, adjacency, continentCells, landCells, lakeCells, usedRiverCells, mouth, length);
    if (path.length >= 2) paths.push({ cells: path, mouthLink });
  }

  return paths;
}
