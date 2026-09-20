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
// toward the source; areaField.ts precomputes a 0 (mouth) to 1 (far end) taper per river edge from
// the river's own path length, and the evaluator lerps between these with it.
//
// The visible waterline sits further out than this, where the bank climbs back up through 0: with
// a mouth bed at -8 and RIVER_BANK_SLOPE, that is another ~32 units, so the water is ~165 units
// across at the mouth. That is what has to stay wide enough to register at Continent-view debug-map
// resolution (~60 world units/pixel, measured), which is the constraint the old single width
// constant was carrying alone.
export const RIVER_BED_HALF_WIDTH_MOUTH = 50;
export const RIVER_BED_HALF_WIDTH_SOURCE = 15;

// Gradient of the bank climbing out of the channel, in height units per unit of distance. This is
// the ONLY thing that sets how steep a riverbank is, and it is a gradient rather than a height
// precisely so that it cannot produce a cliff: the bank rises at this rate until it meets the
// terrain and then stops, so a river crossing a mountain flank gets a LONGER bank, not a steeper
// one.
export const RIVER_BANK_SLOPE = 0.25;

// How far past the flat bed the valley is allowed to keep cutting. The bank normally meets the
// terrain well inside this, and then nothing happens out here at all - the reach exists only as a
// guarantee that the carve has reached zero before isRiverEdge itself switches off (which it does
// abruptly, at the edge of the two cells sharing this river's seam). Without it, terrain high
// enough that the bank had not yet caught up would drop a step at that switch.
export const RIVER_VALLEY_REACH = 300;

// Fraction of the reach at which that forced fade-out begins. Inside it the profile is used as-is.
export const RIVER_VALLEY_FADE_START = 0.6;

// Expression-of-width, not an independent number - same discipline as COAST_NOISE_AMPLITUDE vs
// COAST_BORDER_WIDTH and BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE vs BOUNDARY_HILL_WIDTH. Applied to
// whichever (tapered) bed half-width is active at a given point, not a fixed amplitude. A flat bed
// meets its bank at a definite line, so this carries more of the organic look than it did under the
// old bell curve (where it was 0.01, about one world unit) and is scaled up to match.
export const RIVER_EDGE_NOISE_FREQUENCY = 1 / 25;
export const RIVER_EDGE_NOISE_AMPLITUDE_RATIO = 0.25;

// Continues cells/config.ts's salt sequence (601-610, 613-617) and boundaryHillsConfig.ts's 611-612 -
// must not collide with any of those, or the "independent" noise fields become identical.
export const RIVER_EDGE_NOISE_SALT = 618;
