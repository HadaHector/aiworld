import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";
import type { TextureDef } from "../materials/textureGen";
import type { ColorMatrix } from "../materials/colorAdjust";

/**
 * Foliage comes in three levels - large (trees), medium (bushes), small (grass). Grass is a system
 * of its own: a texture-scale detail scattered from the ground's materials, never an object. Trees
 * and bushes are both objects standing on the ground, so they share the scatter (see
 * treeScatter.ts) and the renderer (treeField.ts) - but each level has its own lattice, spacing and
 * density maps, so a bush never takes a tree's place and a wood can be as dense below as above.
 * The constants below are the trees'; the bushes' follow them.
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

// Bushes: a tighter lattice of their own, under and between the trees. They stay off the trunks and
// gather in the trees' shade, and are only placed near enough to see - out to the second level of
// detail (400 units), past which a two-metre bush is a few pixels in the haze.
export const BUSH_SPACING = 3;
export const BUSH_CANDIDATES_PER_CELL = 3;
export const BUSH_SALT = 802;
/** How far a bush keeps from a trunk - clear of the flared base, not of the roots - per unit of the
 *  tree's scale, so an old giant's base is kept clear in proportion. */
export const BUSH_TRUNK_CLEARANCE = 4;
/** A tree's shade, per unit of its scale: full out to the inner radius, gone by the outer - about
 *  where a broadleaf's crown ends. Bushes grow at their full density in shade, at BUSH_OPEN_SHARE
 *  of it in the open. */
export const BUSH_SHADE_INNER = 7;
export const BUSH_SHADE_OUTER = 15;
export const BUSH_OPEN_SHARE = 0.3;
/** Bushes line a road's verge, so they come closer to it than trees do. */
export const BUSH_ROAD_CLEARANCE = 11;
export const BUSH_ROAD_FADE = 18;
export const BUSH_SINK = 0.15;
/** Chunks coarser than this many times full detail carry no bushes. */
export const BUSH_MAX_DETAIL_RATIO = 2;

// Boulders: a lattice of their own, finer than the trees' so they can pile up - under a crag,
// along a shore - but wide enough that two ordinary ones never overlap. They keep clear of the
// trunks, and are placed out to the fourth level of detail (about 800 units); past that even a big
// one is a speck.
export const ROCK_SPACING = 9;
export const ROCK_CANDIDATES_PER_CELL = 3;
export const ROCK_SALT = 803;
/** The share of rock darts that are giants, OldTrees.size times as big - a few in every rocky area. */
export const ROCK_GIANT_SHARE = 0.008;
/** How far a boulder keeps from a trunk, per unit of the tree's scale, beyond its own reach. */
export const ROCK_TRUNK_CLEARANCE = 1.5;
export const ROCK_ROAD_CLEARANCE = 11;
export const ROCK_ROAD_FADE = 16;
export const ROCK_SINK = 0.1;
/** The deepest ground a boulder stands on: shallow water at a shore - stones half out of the water
 *  are what a shore is made of - but not a lake's or a river's middle. The water is at 0. */
export const ROCK_MIN_HEIGHT = -1.2;
export const ROCK_MAX_DETAIL_RATIO = 4;
/** How far round a point `uphill` looks for higher ground (see treeScatter.ts). */
export const UPHILL_RADII = [14, 30];
/** The steepest a boulder leans to lie along the ground: tan of about 40 degrees. */
export const ROCK_MAX_LEAN = 0.84;

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
    /** The trunk swells to 1 + `bulge` times its girth around `bulgeAt` of the way up, easing back
     *  either side - a baobab's bottle. 0 for none. */
    bulge: number;
    bulgeAt: number;
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
    /** Buttress roots - a jungle giant's - instead of round ones: each a tall, thin plank standing
     *  on edge, `height` metres up the trunk where it leaves it, curving down to the ground at its
     *  end, `thickness` metres through. `radius` is then unused. */
    buttress: { height: number; thickness: number } | null;
    /** Stilt roots - a mangrove's: each leaves the trunk somewhere between these heights (metres),
     *  and dives or arches down into the ground or the water like a prop. None, the usual roots
     *  arching out from the flare. */
    stilt: [number, number] | null;
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
    /** How far a branch bends back up towards its tip, as a fraction of its length - below 0, over
     *  and outwards. */
    arc: number;
    /** The share of branches and twigs snapped off short, their ends left blunt - a dead tree's. */
    broken: number;
    /** How crooked a branch grows: at every ring it kinks off its line by up to this share of its
     *  length, the kinks adding up along it - 0 straight, 0.05 gnarled. */
    crook: number;
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
    /** Each cluster's height as a fraction of its width: below 1, flattened into a layer. */
    squash: number;
    /** How far (0-1) every cluster is pulled to the crown's mean height - 1 is one flat layer, an
     *  acacia's umbrella. */
    level: number;
  } | null;
  /** A crown of fronds on top of the trunk - a tree fern's - built as a fern bush's (see Fronds),
   *  instead of or as well as leaf clusters. */
  crown: Fronds | null;
  /** Lianas hung from the limbs: `count` woody strands `radius` thick, each hanging straight down
   *  `length` metres (never to the ground) from a point along a branch's outer half, or - for a
   *  `loops` share of them - slung between two such points, sagging. Wood, drawn with the bark;
   *  left off a distant tree. With `leaves`, each strand is instead a ribbon
   *  `width` metres wide, the leaf atlas tiled down them every `tile` metres (default `width`) - a
   *  willow's weeping curtain - which a distant tree keeps, thinned to every other whip. */
  vines: { count: [number, number]; length: [number, number]; radius: number; loops: number; leaves: { width: number; tile: number } | null } | null;
  bark: BarkTexture;
  /** None for a bare tree, which has neither leaves nor a crown. A frond crown's atlas is a fern's
   *  (a BushTexture with the "fern" builder). */
  foliage: FoliageTexture | BushTexture | null;
}

/** A tree's bark: a texture graph like a ground material's (diffuse, roughness, height), with u
 *  running around a limb and v along it. */
export interface BarkTexture {
  /** Metres of trunk one texture repeat covers. */
  tile: number;
  texture: TextureDef;
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

export const FOLIAGE_BUILDERS = ["broadleaf"] as const;

/**
 * A conifer, from a small generator of its own (see treeGenerator.ts's generateConifer): a tall,
 * tapering trunk with a natural bend - a sweep out at the foot and back up, a lean, a slow sway -
 * standing on a few short roots, and the crown as a stack of open cones, lowest widest. There is no
 * base to a cone: each is a ring of overlapping panels running from the trunk down and out to a
 * drooping rim, every panel showing one of a few generated fir-branch sprays (see treeTextures.ts's
 * bakeConiferFoliage), mirrored and turned at random so no two cones match. Lengths are metres.
 */
export interface ConiferTree {
  model: "conifer";
  variants: number;
  trunk: {
    height: number;
    radius: number;
    topRadius: number;
    /** How far the top leans off vertical, as a fraction of the height. */
    lean: number;
    /** How far the trunk sweeps out near its foot before growing straight up, in metres. */
    bend: number;
    /** A slow side-to-side sway up the trunk, in metres. */
    wobble: number;
    flare: number;
    flareHeight: number;
    sides: number;
    rings: number;
  };
  roots: { count: number; length: [number, number]; radius: number; drop: number; sides: number; rings: number };
  tiers: {
    count: [number, number];
    /** The lowest tier's rim sits at this fraction of the trunk's height - below it, bare trunk. */
    from: number;
    /** A tier's rim radius and its height (apex to rim), for the lowest tier and the topmost. */
    radius: [number, number];
    height: [number, number];
    /** How far a branch bends over: its stem's height falls as along^(1 + droop) from the trunk to
     *  the rim - 0 is a straight slope, 0.6 leaves the middle a third of the way down. */
    droop: number;
    /** Branches round one tier - each a square card along its diagonal - and how wide a branch is
     *  for its length (1 keeps the spray's own proportions). */
    panels: number;
    breadth: number;
    /** How far a branch's sides fold down from its stem, as a fraction of its half-width. */
    arch: number;
    /** How far a tier tips off level, as a fraction of its radius. */
    tilt: number;
    /** How much each branch differs from the next: its length by up to this fraction either way,
     *  its bend by twice that, its drop by 0.7x and its width by half of it. */
    variety: number;
  };
  bark: BarkTexture;
  foliage: ConiferTexture;
}

/** A generated fir-branch atlas: four variants of a spray, see treeTextures.ts. */
export interface ConiferTexture {
  builder: "firSpray";
  /** Needles range between these - old growth dark, the fresh tips light. */
  dark: ColorTuple;
  light: ColorTuple;
  /** The twigs' colour. */
  twig: ColorTuple;
  /** Side twigs down each side of the spray. */
  twigs: number;
  /** A needle's length and width as a fraction of the spray, and the gap between needle pairs. */
  needleLength: number;
  needleWidth: number;
  needleGap: number;
}

export const CONIFER_FOLIAGE_BUILDERS = ["firSpray"] as const;

/**
 * A bush: no wood at all, only cards. A few large ones crossed through its middle each show a whole
 * bush from the side - stems rising from the ground and forking, leaves over their upper part - and
 * smaller leaf clumps sit over its top so it has volume from any direction, including above. The
 * branches are in the texture (see treeTextures.ts's bakeBushFoliage), which is where anything this
 * thin belongs at this scale. Lengths are metres.
 */
export interface BushShape {
  model: "bush";
  variants: number;
  width: [number, number];
  height: [number, number];
  /** Whole-bush cards crossed through the middle. */
  cards: number;
  /** Leaf clumps over the top, and a clump card's width. */
  clumps: number;
  clumpSize: [number, number];
  /** Built of fronds instead of cards (a fern) - see Fronds; null for cards. */
  fronds: Fronds | null;
  /** Grown in beds - see BushBed; null for one plant at a time. */
  bed: BushBed | null;
  foliage: BushTexture;
}

/**
 * A plant built of fronds rather than crossed cards: each frond a strip of quads rising from the
 * root, arching out and over - folded a little along its midrib - showing one of the atlas's four
 * single fronds along its length. Lengths metres, angles degrees.
 */
export interface Fronds {
  count: [number, number];
  length: [number, number];
  /** A frond's width, across its leaflets. */
  width: number;
  /** Angle from vertical a frond sets off at, and how much further it curls over by its tip. */
  angle: [number, number];
  curl: number;
  /** How high the midrib stands above the frond's edges, as a fraction of its width. */
  fold: number;
  /** Quads along a frond. */
  segments: number;
  /** A bare stalk before the blade - a banana's or an elephant ear's leaf on its stem - `length`
   *  metres of it (before the frond's own `length`), `width` across. It shows the bottom
   *  FROND_STALK_SHARE of the atlas cell, down its middle, where a broad-leaf atlas paints it. None,
   *  a fern: leaflets from the root. */
  stalk: { length: [number, number]; width: number } | null;
}

/** The bottom share of a broad-leaf atlas cell given to its stalk, and the stalk's half-width there
 *  as a share of the cell's width - painted by treeTextures.ts, laid on by generateFronds. */
export const FROND_STALK_SHARE = 0.12;
export const FROND_STALK_HALF_WIDTH = 0.03;

/**
 * A bed: each placed bush of the kind comes with more of it round it - `plants` in all, the others
 * up to `spread` metres from it (times its scale), each its own size, turn and ground height. The
 * bush lattice keeps bushes metres apart; a bed is how a kind grows close together, in patches.
 */
export interface BushBed {
  plants: [number, number];
  spread: number;
}

/**
 * A generated bush atlas: two side views of a whole bush and two leaf clumps, see treeTextures.ts.
 * With the `fern` builder, for a plant built of `fronds`, it is four single fronds instead: `leaves`
 * pairs of leaflets down each, `leafLength`/`leafWidth` the longest leaflet's size.
 */
/**
 * `paddleLeaf` and `heartLeaf` paint one broad leaf per cell, stalk at the bottom: a banana's long
 * paddle, torn into strips from its edges (`leaves` tears), or an elephant ear's heart, with
 * `leaves` veins fanning from the stalk. `leafWidth` is the blade's half-width as a share of the
 * cell's; `leafLength`, `stems` and `bare` are unused.
 *
 * `palmFrond` is the fern's frond made a palm's: leaflets all near the same length, tapering only
 * at the tip, and little varied in size or shade - for many thin ones in a row.
 *
 * `willowWhip` paints one tile of a willow whip per cell - a stem down the middle, `leaves` narrow
 * leaves to each width of whip (`leafLength`/`leafWidth`, fractions of its width) off it angled one
 * way - repeated end to end down a willow's leafy vines; a tile longer than wide holds more.
 */
export interface BushTexture {
  builder: "leafyBush" | "fern" | "palmFrond" | "paddleLeaf" | "heartLeaf" | "willowWhip";
  /** Leaves range between these, lighter towards the top and the rim. */
  dark: ColorTuple;
  light: ColorTuple;
  /** The stems' colour, shaded round across their width. */
  stem: ColorTuple;
  /** Main stems rising from the ground in one side view. */
  stems: [number, number];
  /** Leaves per side view (a clump gets 60% as many), and a leaf's size as a fraction of it. */
  leaves: number;
  leafLength: number;
  leafWidth: number;
  /** The bottom fraction of the bush left bare, where only the stems show. */
  bare: number;
}

export const BUSH_FOLIAGE_BUILDERS = ["leafyBush", "fern", "palmFrond", "paddleLeaf", "heartLeaf", "willowWhip"] as const;

/**
 * A boulder: a lump of stone standing on the ground, scattered on the trees' lattice (a pack's
 * rocks/ folder, placed by a biome's `rocks` graph - see treeScatter.ts). Generated (see
 * boulderGenerator.ts) as a sphere pushed in and out by a slow noise, squashed and stretched, with a
 * few flat faces sheared off it - the way weathered, split stone looks - then tipped a little and
 * sunk into the ground. Lengths are metres.
 */
export interface BoulderShape {
  model: "boulder";
  variants: number;
  /** Half its width, before its kind's scale. */
  radius: number;
  /** Its height as a fraction of its width, and its length as a multiple of it - each variant
   *  somewhere in each range. */
  squash: [number, number];
  stretch: [number, number];
  /** How far the surface swells in and out, as a fraction of the radius. */
  lumps: number;
  /** How much narrower it grows towards its top (0-1): 0 an egg, near 1 a spire - a termite mound. */
  taper: number;
  /** How many flat faces are sheared off it, and how deep they cut at most, as a fraction of the
   *  radius. */
  facets: [number, number];
  facetDepth: number;
  /** Degrees it may lean off upright. */
  tilt: number;
  /** The share of its height below the ground - each variant somewhere in the range, so some sit
   *  on the ground and some are half buried. */
  sink: [number, number];
  stone: StoneTexture;
}

/** A boulder's stone: a texture graph like a ground material's, or a material's own texture, with
 *  that material's recolouring and the kind's own after it. Mapped from three sides (triplanar). */
export interface StoneTexture {
  /** Metres of stone one texture repeat covers. */
  tile: number;
  texture: TextureDef;
  /** The material it is drawn from, if it is one's: its texture is baked once, under its id. */
  material?: string;
  adjust: ColorMatrix;
}

/** The texture a kind bakes for its wood or its stone, or null for one that bakes none. */
export function surfaceTexture(def: TreeKindDef): BarkTexture | StoneTexture | null {
  switch (def.shape.model) {
    case "branching":
    case "conifer":
      return def.shape.bark;
    case "boulder":
      return def.shape.stone;
    default:
      return null;
  }
}

/** The original placeholder trees: a trunk cylinder and a crown from one primitive builder. */
export interface PrimitiveTree {
  model: "primitive";
  trunk: TreeTrunk;
  crown: TreeCrown;
}

/**
 * A kind of tree - or bush, or boulder - a biome can grow, named by its foliage graph's outputs (see
 * BiomeOutputs.foliage and BiomeOutputs.bushes).
 *
 * A tree picks its kind from the zone it stands in, weighted by how much of the trees around it
 * that zone is responsible for - so a border between a pine zone and a broadleaf one comes out as
 * a mixed fringe rather than a line where one species stops.
 */
export interface TreeKindDef {
  id: string;
  shape: PrimitiveTree | BranchingTree | ConiferTree | BushShape | BoulderShape;
  /** Each tree's foliage colour is multiplied by a random mix of these two: the canopy colour of a
   *  primitive tree (whose canopy is white), and a shade of its texture for a branching one. */
  tint: [ColorTuple, ColorTuple];
  /** Each tree is scaled uniformly by a random factor in this range. */
  scale: [number, number];
  /** Whether this kind grows old - some of its trees then stand WorldContent.oldTrees.size times
   *  their usual size. A kind that does not still gets the room an old tree would have taken. */
  growsOld: boolean;
  /** A tree that stands with its feet in the water - a mangrove: its zone's shore rule does not
   *  hold it back from the waterline. Only a tree kind's; nothing grows in a lake or a road cut
   *  whatever it is. */
  wetFeet?: boolean;
}

/**
 * A few trees are old: several times the size of the rest, and given room in proportion - two trees
 * stand at least TREE_SPACING times the average of their sizes apart, so an old tree clears the
 * young ones out from under its crown. Whether a tree is old is decided with its position, before
 * anything is known about the ground or its species; see treeScatter.ts.
 */
export interface OldTrees {
  /** The share of the lattice's darts that are old. Each clears a wide circle, so a little goes far. */
  share: number;
  /** An old tree's size, as a multiple of its kind's own scale. */
  size: [number, number];
}
