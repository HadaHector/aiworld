import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";

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
export const TREE_SPACING = 20;

// Darts thrown per lattice cell before the spacing rule thins them. The accepted set converges as
// this rises (it is a Matern hard-core process - see treeScatter.ts), and by 3 it is within a few
// percent of saturated, so more would only cost RNG.
export const TREE_CANDIDATES_PER_CELL = 3;

// The world's own rules, applied on top of whatever density map a biome asks for (see
// BiomeOutputs.foliage): nothing grows in a road cut or in a lake, whatever the zone would like.
// The road rule is a fade, because a hard line in a density field reads as a drawn edge in the
// world - the same reason terrain here carves rather than switches. The rules a zone may set for
// itself - shore, treeline, slope - are its TreeRules.
export const TREE_MAX_LAKE_FACTOR = 0.02;

// Roads are graded into the terrain with a shoulder either side (ROAD_HALF_WIDTH + its shoulder),
// so the clearance has to cover the shoulder too or trees stand on the cut. The fade past it is
// what gives a road an open verge that closes back into the wood.
export const TREE_ROAD_CLEARANCE = 13;
export const TREE_ROAD_FADE = 34;

// Buries the trunk base slightly. The ground a tree is placed on is the rendered triangle it
// stands on, so this is not correcting an error - it is insurance against one, since a trunk
// hovering by a few centimetres is far more visible than one sunk by the same amount.
export const TREE_SINK = 0.4;

export const FOLIAGE_SALT = 801;

/**
 * Where a zone's trees thin out, each a [start, end] range the density fades across - a fade
 * rather than a line, so no cutoff is drawn across the landscape. Blended across a zone border by
 * the zones' weights, like everything else about them.
 */
export interface TreeRules {
  /** Ground height: trees grow from the first value up, fully by the second - a shore fade, so they
   *  thin out towards the water instead of marching down to it and stopping dead. */
  shore: [number, number];
  /** Ground height: trees start thinning at the first value and are gone by the second. */
  line: [number, number];
  /** Sine of the ground angle (0 flat, 1 vertical): a hillside loses its trees gradually up the
   *  steep part and a cliff has none. */
  slope: [number, number];
}

/** A tree's trunk: a tapered cylinder standing on the origin. */
export interface TreeTrunk {
  height: number;
  diameterBottom: number;
  diameterTop: number;
  sides: number;
  color: ColorTuple;
}

/**
 * A tree's crown, as one of the builders in treeModels.ts and its shape. The builder is code; which
 * one a tree kind uses and how it is proportioned is data.
 */
export type TreeCrown =
  /** One squashed, faceted ball - a broadleaf. */
  | { builder: "sphereCrown"; centreY: number; radius: number; heightRatio: number }
  /** Overlapping cones of decreasing width - a conifer. */
  | { builder: "tieredCones"; sides: number; tiers: { diameter: number; height: number; baseY: number }[] }
  /** Flattened fronds swept out and down from the top of the trunk - a palm. */
  | {
      builder: "frondCrown";
      count: number;
      length: number;
      width: number;
      thickness: number;
      /** How far the root of a frond sits from the trunk's axis, before the droop is applied. */
      reach: number;
      /** Radians the frond tips fall below horizontal. */
      droop: number;
      y: number;
    };

/** The crown builders a tree kind can name - see TreeCrown. */
export const TREE_CROWN_BUILDERS = ["sphereCrown", "tieredCones", "frondCrown"] as const;

/**
 * A tree built by a small structural generator (see treeGenerator.ts): a trunk with a flared base
 * and roots diving into the ground, a handful of main branches each carrying a few twigs, and the
 * foliage as clusters of crossed, textured cards at the ends of them - the way stylised game trees
 * are made, rather than modelling leaves. Everything finer than a twig is in the textures, which are
 * generated too (see treeTextures.ts). Lengths are metres, angles degrees.
 */
export interface BranchingTree {
  model: "branching";
  /** How many distinct trees are generated from this description; each placed tree is one of them. */
  variants: number;
  trunk: {
    height: number;
    /** Radius just above the flare, and at the top. */
    radius: number;
    topRadius: number;
    /** How far the top leans off vertical, as a fraction of the height, and how much the trunk
     *  wanders from side to side on the way up (metres). */
    lean: number;
    wobble: number;
    /** The base swells to `flare` times the radius, easing back over the bottom `flareHeight` metres. */
    flare: number;
    flareHeight: number;
    sides: number;
    rings: number;
  };
  roots: {
    count: number;
    length: [number, number];
    /** Radius where a root leaves the trunk, as a fraction of the trunk's radius. */
    radius: number;
    /** How far below the ground a root's end dives. */
    drop: number;
    sides: number;
    rings: number;
  };
  branches: {
    count: [number, number];
    /** Branches leave the trunk between this fraction of its height and the top. */
    from: number;
    length: [number, number];
    /** Radius where a branch leaves the trunk, as a fraction of the trunk's radius there. */
    radius: number;
    /** Angle from vertical a branch sets off at. */
    angle: [number, number];
    /** How far a branch bends back up towards its tip, as a fraction of its length. */
    arc: number;
    sides: number;
    rings: number;
    twigs: {
      count: [number, number];
      /** As a fraction of the branch's length. */
      length: [number, number];
      /** Angle off the branch. */
      angle: [number, number];
      sides: number;
      rings: number;
    };
  };
  leaves: {
    /** Width of one leaf card. */
    size: [number, number];
    /** Crossed cards per cluster. */
    cards: number;
    /** A cluster sits at every branch and twig tip; this many more along each branch's outer half,
     *  and this many on top of the trunk. */
    alongBranch: number;
    top: number;
    /** How far a card may sit from its cluster's point. */
    spread: number;
  };
  bark: BarkTexture;
  foliage: FoliageTexture;
}

/** A generated bark texture - see treeTextures.ts. */
export interface BarkTexture {
  builder: "plates";
  /** Groove and ridge colours; ridges catch the light, grooves stay dark. */
  dark: ColorTuple;
  light: ColorTuple;
  /** Vertical plates across one texture repeat. */
  plates: number;
  /** Metres of trunk one texture repeat covers. */
  tile: number;
  bumpStrength: number;
}

/** A generated leaf-cluster atlas - four variants of one clump, see treeTextures.ts. */
export interface FoliageTexture {
  builder: "broadleaf";
  /** Leaves range between these, the outer ones lighter where they catch the light. */
  dark: ColorTuple;
  light: ColorTuple;
  /** Leaves per clump, and a leaf's size as a fraction of the clump. */
  leaves: number;
  leafLength: number;
  leafWidth: number;
}

export const BARK_BUILDERS = ["plates"] as const;
export const FOLIAGE_BUILDERS = ["broadleaf"] as const;

/** The original placeholder trees: a trunk cylinder and a crown from one primitive builder. */
export interface PrimitiveTree {
  model: "primitive";
  trunk: TreeTrunk;
  crown: TreeCrown;
}

/**
 * A kind of tree a biome can grow, named by its foliage graph's outputs (see BiomeOutputs.foliage).
 *
 * A tree picks its kind from the zone it stands in, weighted by how much of the trees around it
 * that zone is responsible for - so a border between a pine zone and a broadleaf one comes out as
 * a mixed fringe rather than a line where one species stops.
 */
export interface TreeKindDef {
  id: string;
  shape: PrimitiveTree | BranchingTree;
  /** Each tree's foliage colour is multiplied by a random mix of these two: the canopy colour of a
   *  primitive tree (whose canopy is white), and a shade of its texture for a branching one. */
  tint: [ColorTuple, ColorTuple];
  /** Each tree is scaled uniformly by a random factor in this range. */
  scale: [number, number];
}
