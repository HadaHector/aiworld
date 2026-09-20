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

// Continues cells/config.ts's salt sequence (601-610, 613-617) and boundaryHillsConfig.ts's 611-612 -
// must not collide with any of those, or the "independent" noise fields become identical.
export const RIVER_EDGE_NOISE_SALT = 618;
