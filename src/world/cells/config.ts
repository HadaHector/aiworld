export const WORLD_EXTENT = 800; // world units; single source of truth, world.ts's TERRAIN_SIZE matches this
export const CELL_SPACING = 55; // world units, nominal pre-relaxation point spacing
export const LLOYD_RELAX_ITERATIONS = 2;
export const CELL_BOUNDS_MARGIN = CELL_SPACING * 2;

export const TARGET_LAND_CELLS = 80;
export const TARGET_AREA_COUNT = 8;

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
