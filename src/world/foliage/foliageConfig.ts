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

// The world's own rules, applied on top of whatever density map a biome asks for (see
// BiomeOutputs.foliage): nothing grows in a road cut, in a lake or off a cliff, whatever the zone
// would like. Everything but the lake test is a fade, because a hard line in a density field reads
// as a drawn edge in the world - the same reason terrain here carves rather than switches.
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

// Per-tree variety. Uniform scale only - a placeholder that leans or squashes just looks broken.
export const TREE_SCALE_MIN = 0.75;
export const TREE_SCALE_MAX = 1.35;

// Buries the trunk base slightly. The ground a tree is placed on is the rendered triangle it
// stands on, so this is not correcting an error - it is insurance against one, since a trunk
// hovering by a few centimetres is far more visible than one sunk by the same amount.
export const TREE_SINK = 0.4;

export const FOLIAGE_SALT = 801;

/**
 * Which shape of tree a biome grows. The shapes and their dimensions live in treeModels.ts; this
 * is here so the biome registry can name one without depending on anything that draws.
 *
 * A tree picks its kind from the zone it stands in, weighted by how much of the trees around it
 * that zone is responsible for - so a border between a pine zone and a broadleaf one comes out as
 * a mixed fringe rather than a line where one species stops.
 */
export const TREE_KINDS = ["broadleaf", "pine", "palm"] as const;
export type TreeKind = (typeof TREE_KINDS)[number];
