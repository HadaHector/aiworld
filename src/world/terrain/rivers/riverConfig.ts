// A river is carved as a VALLEY PROFILE the terrain is clipped down to, not as a fixed depth
// subtracted from whatever was there. The difference matters because the water surface is a single
// global plane at SEA_LEVEL: a channel only reads as water if its floor is genuinely below 0, and
// "terrain minus 20" is below 0 only where the terrain happened to be under 20 already. Measured on
// one real river, that meant the middle of it read as water while the mouth sat submerged in a
// swamp and the source dissolved into a mountain flank with 44-66 units of relief across 400 -
// three disconnected ponds where one river was generated. An absolute bed height is below the water
// plane everywhere by construction, whatever the terrain above it is doing.

// Absolute floor height of the channel, tapering from mouth to source. SEA_LEVEL is 0, so both ends
// sit under the water plane and the whole length reads as water; the mouth is deeper so a river
// runs visibly downhill into the sea or lake it drains to. Kept above LAKE_TARGET_HEIGHT (-10) so a
// river never cuts below the lake it feeds.
export const RIVER_BED_HEIGHT_MOUTH = -8;
export const RIVER_BED_HEIGHT_SOURCE = -3;

// Half-width of the FLAT part of the bed - the channel proper. Widest at the mouth, narrowing
// toward the source; the taper is arc-length position along the river's own centreline, so it runs
// evenly from 0 at the mouth to 1 at the source rather than stepping once per cell.
//
// These are TRUE distances. They used to be compared against a cell-pair gap (|PB| - |PA|), which
// is about twice the perpendicular distance to the border between those two cells, so every width
// constant here was silently rendering at half its stated value.
//
// The visible waterline sits further out than the flat bed, where the bank climbs back up through
// 0: with a mouth bed at -8 and RIVER_BANK_SLOPE, that is another 32 units, so the water is ~124
// units across at the mouth. That is what has to stay wide enough to register at Continent-view
// debug-map resolution (~60 world units/pixel, measured).
export const RIVER_BED_HALF_WIDTH_MOUTH = 30;
export const RIVER_BED_HALF_WIDTH_SOURCE = 10;

// Gradient of the bank climbing out of the channel, in height units per unit of distance. This is
// the ONLY thing that sets how steep a riverbank is, and it is a gradient rather than a height
// precisely so that it cannot produce a cliff: the bank rises at this rate until it meets the
// terrain and then stops, so a river crossing a mountain flank gets a LONGER bank, not a steeper
// one.
export const RIVER_BANK_SLOPE = 0.25;

// How far past the flat bed the valley is allowed to keep cutting. The bank normally meets the
// terrain well inside this and nothing happens out here at all; the reach caps how wide a valley
// very high ground can open up, and bounds the field's own search radius.
export const RIVER_VALLEY_REACH = 200;

// Fraction of the reach at which that forced fade-out begins. Inside it the profile is used as-is.
export const RIVER_VALLEY_FADE_START = 0.6;

// Expression-of-width, not an independent number - same discipline as COAST_NOISE_AMPLITUDE vs
// COAST_BORDER_WIDTH and BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE vs BOUNDARY_HILL_WIDTH. Applied to
// whichever (tapered) bed half-width is active at a given point, not a fixed amplitude. A flat bed
// meets its bank at a definite line, so this carries more of the organic look than it did under the
// old bell curve (where it was 0.01, about one world unit) and is scaled up to match.
export const RIVER_EDGE_NOISE_FREQUENCY = 1 / 25;
export const RIVER_EDGE_NOISE_AMPLITUDE_RATIO = 0.25;

// How far riverField.ts has to look for a centreline. Past this the carve is zero by construction,
// so the answer cannot matter - but it must cover the widest possible valley INCLUDING a jitter
// that pulls the bank outward, or a point just outside would be reported as having no river at all
// while still being inside its fade. Derived, never tuned independently.
export const RIVER_QUERY_RADIUS =
  RIVER_BED_HALF_WIDTH_MOUTH * (1 + RIVER_EDGE_NOISE_AMPLITUDE_RATIO) + RIVER_VALLEY_REACH;

// Boundary hills are suppressed near a river: a hill's whole job is to raise a ridge along an area
// border, and a river's centreline runs along cell borders, which are frequently the same line. The
// suppression used to be a plain "is there a river here at all", which switched a hill on at full
// height the instant that went false - measured, a 63 -> 165 unit step across two world units,
// still the single worst discontinuity anywhere near a river once the carve itself was continuous.
// Fading it over these two distances instead costs nothing and cannot step.
export const RIVER_HILL_SUPPRESSION_INNER = 80;
export const RIVER_HILL_SUPPRESSION_OUTER = RIVER_QUERY_RADIUS;

// --- Meanders (riverCentreline.ts) ---------------------------------------------------------
// The raw centreline is a handful of cell-border midpoints hundreds of units apart, so a river
// reads as long straight runs meeting at angles. These shape it into something that wanders.

// Arc step the raw chain is resampled at before being displaced. Sets how finely the wave can be
// followed; below the detail wavelength by enough to resolve it.
export const RIVER_MEANDER_SAMPLE_STEP = 40;

// Ceiling on the sideways displacement. The ACTUAL amplitude is the smaller of this and a fraction
// of the local corridor - see RIVER_MEANDER_ROOM_FRACTION - so this only binds where cells are
// unusually large.
export const RIVER_MEANDER_MAX_AMPLITUDE = 300;

// Fraction of the local corridor half-width (half the distance between the two cells whose border
// the river is following) the meander is allowed to use. This is the guard on zone boundaries:
// area borders ARE cell borders, so a meander that stays well inside the corridor between two
// cells cannot swing across into a neighbouring biome, however large the wave gets elsewhere.
export const RIVER_MEANDER_ROOM_FRACTION = 1.0;

// Fraction of the MEASURED clearance - the distance from a point on the raw line to the edge of the
// cells the river's path runs through - the meander may use. This is the bound that actually holds
// the river inside its own corridor, and therefore inside its own zones; the two above are
// per-vertex estimates that only bind where a cell is unusually large. Measured, raising it much
// past this starts putting centreline points into zones the straight river never touched.
export const RIVER_MEANDER_CLEARANCE_FRACTION = 0.85;

// Displacing a line sideways makes it cross itself wherever the offset exceeds the local radius of
// curvature - the standard offset-curve cusp, and at a sharp corner of the generated path the
// radius is small. Measured, that produced 1-11 crossings per seed, all of them tiny loops of
// 10-600 units of arc. Bounding the amplitude by curvature would trade real meanders away to avoid
// them; excising the loops afterwards costs nothing and is exact, so riverCentreline.ts does that
// instead and no constant is needed here.

// Wavelengths in ARC LENGTH along the river, not in world distance - that is what makes the wave
// travel along the channel rather than being a noise field stamped over it. Two octaves: a long
// swing plus a smaller wobble on top.
export const RIVER_MEANDER_WAVELENGTH = 550;
export const RIVER_MEANDER_DETAIL_WAVELENGTH = 210;
export const RIVER_MEANDER_DETAIL_RATIO = 0.35;

// Distance over which the displacement fades in from each end. The mouth point sits exactly on the
// lake, trunk or coastline the river drains into, and must not be moved off it.
export const RIVER_MEANDER_END_TAPER = 300;

// Chaikin passes, then the deviation below which a point is dropped again. The rounding is what
// removes the original chain's corners; the simplification is purely a cost control, and at a
// couple of units it is invisible against a channel over a hundred units wide.
export const RIVER_SMOOTHING_PASSES = 2;
export const RIVER_SIMPLIFY_TOLERANCE = 1.5;

// Continues cells/config.ts's salt sequence (601-610, 613-617) and boundaryHillsConfig.ts's 611-612 -
// must not collide with any of those, or the "independent" noise fields become identical.
export const RIVER_EDGE_NOISE_SALT = 618;
export const RIVER_MEANDER_SALT = 619;
