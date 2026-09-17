// Widened from an original 20: at Continent-view debug-map resolution (~60 world units/pixel,
// measured), a 2x20=40-unit-wide channel is sub-pixel and effectively invisible on the map even
// though it reads fine up close in 3D - rivers get ALL their width from this constant (unlike
// lakes, which are visible because the whole cell is flagged, not just a border band), so it has
// to carry the map-visibility requirement alone. 2x100=200 units spans >3 map pixels.
//
// Widest at the mouth, narrowing toward the source - areaField.ts precomputes a 0 (mouth) to 1
// (far end) taper fraction per river edge from each river's own path length at generation time;
// riverEvaluator.ts lerps between these two using that fraction.
export const RIVER_WIDTH_MOUTH = 100;
export const RIVER_WIDTH_SOURCE = 30;
export const RIVER_DEPTH = 20; // shallower than boundary hills' 15 peak height

// Expression-of-width, not an independent number - same discipline as COAST_NOISE_AMPLITUDE vs
// COAST_BORDER_WIDTH and BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE vs BOUNDARY_HILL_WIDTH. Applied to
// whichever (tapered) width is active at a given point, not a fixed amplitude.
export const RIVER_EDGE_NOISE_FREQUENCY = 1 / 25;
export const RIVER_EDGE_NOISE_AMPLITUDE_RATIO = 0.01;

// Continues cells/config.ts's salt sequence (601-610, 613-617) and boundaryHillsConfig.ts's 611-612 -
// must not collide with any of those, or the "independent" noise fields become identical.
export const RIVER_EDGE_NOISE_SALT = 618;
