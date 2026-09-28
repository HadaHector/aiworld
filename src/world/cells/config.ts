// 1 world unit = 1 meter (the character capsule is 1.8 units tall). CELL_SPACING is chosen so
// that CELLS_PER_AREA * CELL_SPACING^2 ~= 10 km^2 per zone, which combined with a 20-30 zone
// range per continent lands continents in the "hundreds of km^2" target range.
export const CELL_SPACING = 1000; // world units, nominal pre-relaxation point spacing
export const LLOYD_RELAX_ITERATIONS = 1;
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
export const GROWTH_RADIUS_SAFETY_FACTOR = 1.5;

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
export const COAST_BORDER_WIDTH = 200;
export const AREA_BORDER_WIDTH = 30;

// Per-area jitter for the biome blend. Each area samples the shared edge noise at its own hashed
// offset, so neighbouring areas wobble independently and their border reads as an organic edge
// rather than a clean Voronoi bisector. A single shared jitter would be added to every area's gap
// equally and cancel out entirely, since only the DIFFERENCE between gaps decides the blend.
//
// Kept below AREA_BORDER_WIDTH for the same reason COAST_NOISE_AMPLITUDE is capped against
// COAST_BORDER_WIDTH: jitter is added into the gap before the width smoothstep, so an amplitude
// past the width could hand real weight to an area that is geometrically far away.
export const AREA_BLEND_JITTER_AMPLITUDE = AREA_BORDER_WIDTH * 0.8;
export const AREA_BLEND_NOISE_FREQUENCY = 2.2 / CELL_SPACING;
// Offsets that separate one area's jitter sample from another's - arbitrary, just mutually prime-ish
// so two areas never land on the same patch of noise.
export const AREA_BLEND_OFFSET_X = 137.7;
export const AREA_BLEND_OFFSET_Z = 91.3;

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
export const COAST_NOISE_AMPLITUDE = COAST_BORDER_WIDTH * 4;

// Lake-shore blend width - a cell-scale border, so it stays small (like AREA_BORDER_WIDTH), not
// scaled with CELL_SPACING. Amplitude is an expression of width, same discipline as
// COAST_NOISE_AMPLITUDE/BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE, so lake-shore jitter can't reach past
// a point that's geometrically deep inside solid dry land or deep inside the lake.
export const LAKE_BORDER_WIDTH = 100;
export const LAKE_NOISE_FREQUENCY = 1 / CELL_SPACING;
export const LAKE_NOISE_AMPLITUDE = LAKE_BORDER_WIDTH * 3;

// Rivers per continent, and how many cells long each one's path walk runs (see cells/riverGeneration.ts).
export const RIVERS_PER_CONTINENT_RANGE: [number, number] = [3, 5];
export const RIVER_LENGTH_RANGE: [number, number] = [8, 10];

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

export const LAKE_ROLL_SALT = 613;
export const LAKE_EDGE_NOISE_SALT = 614;
export const RIVER_SOURCE_SALT = 615;
export const RIVER_LENGTH_SALT = 616;
export const RIVER_WALK_SALT = 617;
// After riverConfig.ts's 618-619: each area's roll of its biome (content/biomeRolls.ts), salted
// again by the area's id.
export const AREA_ROLL_SALT = 620;
// Each area's shades of its trees (foliage/treeTints.ts), salted again by the area and rule.
export const TREE_SHADE_SALT = 621;
