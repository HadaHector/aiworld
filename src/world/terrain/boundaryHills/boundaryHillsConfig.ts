export const BOUNDARY_HILL_WIDTH = 300; // world units the effect reaches from the border (controllable)

// Guaranteed smooth bump height, added on top of the lerped zone heights independently of whatever
// the style's own noise is doing at a given point - this is what gives the hill a clean, designed
// silhouette (a real bump) rather than the silhouette being entirely a byproduct of tapering noise.
export const BOUNDARY_HILL_PEAK_HEIGHT = 50;

// Expression-of-width, not an independent number - same discipline as COAST_NOISE_AMPLITUDE vs
// COAST_BORDER_WIDTH in cells/config.ts, so the edge jitter can never push the effective width wildly
// out of proportion to BOUNDARY_HILL_WIDTH.
export const BOUNDARY_HILL_EDGE_NOISE_FREQUENCY = 1.1 / 1000;
export const BOUNDARY_HILL_EDGE_NOISE_AMPLITUDE = 50 * 4;

// Continues cells/config.ts's salt sequence (601-610, 700) and terrainSampler.ts's OCEAN_SALT (402) -
// must not collide with any of those, or the "independent" noise fields below become identical.
export const BOUNDARY_HILL_EDGE_NOISE_SALT = 611;
export const BOUNDARY_HILL_STYLE_SALT = 612;

// Where a zone's shore hills part for their bays (areaField.ts) - continues the sequence past
// TREE_SHADE_SALT (621) in terrain/foliage.
export const SHORE_BAY_SALT = 622;
