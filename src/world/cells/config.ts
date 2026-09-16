export const CELL_SPACING = 55; // world units, nominal pre-relaxation point spacing
export const LLOYD_RELAX_ITERATIONS = 2;
export const CELL_BOUNDS_MARGIN = CELL_SPACING * 2;

// Content-first sizing: the user sets how many continents and how large they are; world size is
// derived from this (see cells/continentLayout.ts), not the other way around.
export const CONTINENT_COUNT_RANGE: [number, number] = [3, 5];
export const AREAS_PER_CONTINENT_RANGE: [number, number] = [6, 10];
export const CELLS_PER_AREA = 10;

// Ratio of actual growth bounding radius to a naive equal-area-circle radius, empirically
// measured across the weighted-frontier BFS growth algorithm: p99 ~= 1.7-2.3, worst observed
// single sample 2.6. 3.0 leaves >15% headroom above the worst case so growth never hits the
// generated region's edge (the original cause of the "world border cuts the continent" bug).
export const GROWTH_RADIUS_SAFETY_FACTOR = 3.0;

// Minimum guaranteed open ocean between any two continents' safety-radius circles.
export const CONTINENT_OCEAN_GAP = CELL_SPACING * 6;

export const COAST_NOISE_FREQUENCY = 0.02;
export const COAST_NOISE_AMPLITUDE = 6;
export const COAST_BORDER_WIDTH = 10;
export const AREA_BORDER_WIDTH = 10;

// Salts for deriving independent sub-seeds from one root world seed (see ../rng.ts deriveSeed).
export const GRID_JITTER_SALT = 601;
export const START_CELL_SALT = 602;
export const GROWTH_SALT = 603;
export const AREA_SEED_SALT = 604;
export const AREA_GROWTH_SALT = 605;
export const AREA_BIOME_SALT = 606;
export const EDGE_NOISE_SALT = 607;
export const CONTINENT_COUNT_SALT = 608;
export const AREAS_PER_CONTINENT_SALT = 609;
export const CONTINENT_LAYOUT_SALT = 610;
export const CONTINENT_SEED_BASE = 700; // continentSeed[i] = deriveSeed(seed, CONTINENT_SEED_BASE + i)
