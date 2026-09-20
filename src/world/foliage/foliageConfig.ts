/**
 * Foliage comes in three levels - large (trees), medium (bushes), small (grass) - which are
 * deliberately not one system with a size parameter: a tree is an object you walk around and a
 * blade of grass is a texture-scale detail you never collide with, so they will want different
 * scattering, different streaming and different rendering. Only the large level exists today; the
 * constants below are all its.
 */

// The hard-core radius of the scatter: no two trunks in the world are closer than this, whatever
// the biome. It is the number that makes a forest walkable, so it is set against the character
// (1.8 units tall) rather than against the canopy - the canopies overlap into a closed roof well
// before the trunks get near each other, which is exactly the oversized, stroll-through-it look
// this is after.
export const TREE_SPACING = 10;

// Darts thrown per lattice cell before the spacing rule thins them. The accepted set converges as
// this rises (it is a Matern hard-core process - see treeScatter.ts), and by 3 it is within a few
// percent of saturated, so more would only cost RNG.
export const TREE_CANDIDATES_PER_CELL = 3;

// Hard rejections. Everything else is a fade, because a hard line in a density field reads as a
// drawn edge in the world - the same reason terrain here carves rather than switches.
export const TREE_MAX_LAKE_FACTOR = 0.02;

// A shore fade rather than a waterline: trees thin out as the ground approaches the water instead
// of marching down to it and stopping dead.
export const TREE_MIN_HEIGHT = 1.5;
export const TREE_SHORE_HEIGHT = 6;

// Roads are graded into the terrain with a shoulder either side (ROAD_HALF_WIDTH + its shoulder),
// so the clearance has to cover the shoulder too or trees stand on the cut. The fade past it is
// what gives a road an open verge that closes back into the wood.
export const TREE_ROAD_CLEARANCE = 13;
export const TREE_ROAD_FADE = 34;

// Slope as sin of the ground angle (0 flat, 1 vertical). Thinning from EASY to MAX means a
// hillside loses its trees gradually up the steep part and a cliff has none, with no cutoff line
// drawn across the slope.
export const TREE_EASY_SLOPE = 0.3;
export const TREE_MAX_SLOPE = 0.72;

// The treeline. Mountain peaks reach ~120 units, so this bares the top third of the big ones and
// leaves the shoulders wooded.
export const TREE_LINE_START = 70;
export const TREE_LINE_END = 95;

// Groves and clearings. Without this a biome density of 0.12 is 12% of the lattice spread evenly -
// lone trees at regular intervals, which reads as an orchard. A slow noise multiplying the density
// instead gives stands of wood with open ground between them; it averages near 1 so it changes
// where the trees are, not how many.
export const TREE_PATCH_FREQUENCY = 0.004; // ~250 units between grove and clearing
export const TREE_PATCH_STRENGTH = 1.8; // peak multiplier; the trough is 0, i.e. a real clearing

// Per-tree variety. Uniform scale only - a placeholder that leans or squashes just looks broken.
export const TREE_SCALE_MIN = 0.75;
export const TREE_SCALE_MAX = 1.35;

// Buries the trunk base slightly. The ground a tree is placed on is the rendered triangle it
// stands on, so this is not correcting an error - it is insurance against one, since a trunk
// hovering by a few centimetres is far more visible than one sunk by the same amount.
export const TREE_SINK = 0.4;

export const FOLIAGE_SALT = 801;

// The placeholder model, in world units at scale 1. Total height ~18 - ten times the character,
// which is the proportion that makes the walk between them feel like a wood rather than a park.
export const TRUNK_HEIGHT = 8;
export const TRUNK_DIAMETER_BOTTOM = 1.9;
export const TRUNK_DIAMETER_TOP = 1.1;
export const TRUNK_SIDES = 8;
export const CANOPY_CENTRE_Y = 12.5;
export const CANOPY_RADIUS = 6.5;
/** Squashed a little, so it reads as a crown rather than a ball on a stick. */
export const CANOPY_HEIGHT_RATIO = 0.82;
