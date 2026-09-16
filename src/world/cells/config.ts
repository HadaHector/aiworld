// 1 world unit = 1 meter (the character capsule is 1.8 units tall). CELL_SPACING is chosen so
// that CELLS_PER_AREA * CELL_SPACING^2 ~= 10 km^2 per zone, which combined with a 20-30 zone
// range per continent lands continents in the "hundreds of km^2" target range.
export const CELL_SPACING = 1000; // world units, nominal pre-relaxation point spacing
export const LLOYD_RELAX_ITERATIONS = 2;
export const CELL_BOUNDS_MARGIN = CELL_SPACING * 2;

// Content-first sizing: the user sets how many continents and how large they are; world size is
// derived from this (see cells/continentLayout.ts), not the other way around.
export const CONTINENT_COUNT_RANGE: [number, number] = [3, 5];
export const AREAS_PER_CONTINENT_RANGE: [number, number] = [20, 30];
export const CELLS_PER_AREA = 10;

// Ratio of actual growth bounding radius to a naive equal-area-circle radius, empirically
// measured across the weighted-frontier BFS growth algorithm: p99 ~= 1.7-2.3, worst observed
// single sample 2.6. 3.0 leaves >15% headroom above the worst case so growth never hits the
// generated region's edge (the original cause of the "world border cuts the continent" bug).
export const GROWTH_RADIUS_SAFETY_FACTOR = 3.0;

// Minimum guaranteed open ocean between any two continents' safety-radius circles.
export const CONTINENT_OCEAN_GAP = CELL_SPACING * 6;

// Border BLEND WIDTH is deliberately NOT scaled with CELL_SPACING - it's a "how far do you have
// to walk before a transition completes" distance, tied to the player's local visible/traversable
// scale (chunk load radius, tens to low hundreds of units), not to the abstract cell/zone size.
// Scaling it up to CELL_SPACING's size once CELL_SPACING got large (1000) made blend zones wider
// than the entire visible area, so the player was almost always inside a blend, averaging two
// different biomes' height noise together - this measurably flattens terrain (averaging reduces
// variance) and pulls height closer to a shared mean near sea level, which is what caused the
// "everything is flat" / lake-edge z-fighting bug.
export const COAST_BORDER_WIDTH = 30;
export const AREA_BORDER_WIDTH = 30;

// Coastline wavelength (how broad the coastal wobble is) still scales with CELL_SPACING - that's
// purely a shape property, proportionate to cell/zone size. Amplitude must NOT scale independently
// of the border width above: jitter is added directly into the blend-gap before the border-width
// smoothstep, so if amplitude exceeds the border width, it can flip a point that's geometrically
// deep inside solid land/one area (tens of units past any real edge) into "ocean" or "50/50 blended
// with a neighbor" - completely disconnected from actual proximity to a coastline or area boundary.
// That produced the "small zones look cut off" bug and was a large contributor to spurious below-
// sea-level speckling everywhere. Keeping amplitude well under the border width confines jitter's
// effect to genuinely near-edge points, where it belongs.
export const COAST_NOISE_FREQUENCY = 1.1 / CELL_SPACING;
export const COAST_NOISE_AMPLITUDE = COAST_BORDER_WIDTH * 0.6;

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
