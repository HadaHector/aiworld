import type { ColorTuple } from "../terrain/pipeline/pipelineTypes";

/**
 * Grass: what a kind of grass is (each one a file in a pack's grass/ folder), and the scatter's own
 * fixed rules. Which ground grows which kind is up to the materials (MaterialDef.grass).
 *
 * Grass is part of the ground surface, so it is driven by the terrain's own material weights rather
 * than by a density map of its own like trees: whatever the material blend says the ground is made
 * of at a point decides what grows there. That keeps grass off roads, bare rock, snow and beach for
 * free - the material rules already put those materials exactly where they are - and makes grass
 * agree with the texture under it everywhere, which a separate map never quite would.
 */

export interface GrassKindDef {
  id: string;
  /** Tuft size in metres before per-tuft scale jitter. */
  width: number;
  height: number;
  /** How far the tip sways in wind, as a fraction of height. */
  sway: number;
  /** Tufts start shrinking into the ground at this distance from the camera, and are gone by
   *  fadeEnd - so bigger plants, which read from further away, can be given a longer reach. Only
   *  full-detail chunks carry grass, so fadeEnd is capped in practice by the first level of detail's
   *  maxDistance (world.ts's CHUNK_LOD_LEVELS). */
  fadeStart: number;
  fadeEnd: number;
  /** Grows in patches instead of evenly: a value noise `scale` metres across decides where, and
   *  `coverage` is roughly the fraction of ground inside a patch. A material's density for this
   *  kind is then the density inside a patch. */
  cluster?: { scale: number; coverage: number };
  /** How deep a water this kind stands in, in metres - reeds grow out of the shallows. Without it a
   *  kind stops GRASS_WATER_CLEARANCE above the water line, like every other grass. */
  wades?: number;
  /** Blade texture (see grassTextures.ts). */
  blades: {
    count: number;
    /** Blade height as a fraction of the texture, min..max. */
    minHeight: number;
    maxHeight: number;
    /** Blade width at its base, in texture pixels. */
    baseWidth: number;
    /** How far a tip leans sideways, as a fraction of the texture width. */
    lean: number;
    /** Blades grow from a narrow clump at the centre and fan out (tussocks) instead of standing
     *  side by side across the whole width. */
    fan: boolean;
    /** Seed heads on the tips. */
    seedHeads: boolean;
    /** Flower heads on the tips of this many blades, `radius` texture pixels across. Each tuft's
     *  petals take one of `colors`, picked at random per tuft, rather than the tuft's own (stem)
     *  colour; `eye`, if given, colours a flower's centre (a daisy's yellow, a poppy's black) -
     *  without it the centre is a darker shade of the petals. `shape` is one of FLOWER_SHAPES, and
     *  `petals` its count of petals, bells, florets or rays, each shape having its own default. */
    flowerHeads?: { count: number; radius: number; colors: ColorTuple[]; shape: FlowerShape; petals?: number; eye?: ColorTuple };
  };
}

/**
 * How a flower head is drawn (see grassTextures.ts's drawHead):
 *  - "flower": broad round petals round a centre (5) - buttercup, wild rose, open poppy;
 *  - "daisy": many narrow petals raying from a large eye (14) - daisy, aster, chamomile;
 *  - "cup": a tall petal between petals leaning out, in profile (3) - tulip, closed poppy, crocus;
 *  - "bell": bells hanging from an arching tip, mouths down (3) - bluebell, harebell;
 *  - "raceme": florets crowded up the top of the stem (12) - lupin, foxglove, lavender;
 *  - "umbel": a flat-topped dome of tiny florets on thin rays (9) - yarrow, cow parsley;
 *  - "globe": a ball of tiny florets (26) - clover, allium, thistle;
 *  - "spike": a bulrush's cattail - a long, rounded head a little below the tip.
 */
export const FLOWER_SHAPES = ["flower", "daisy", "cup", "bell", "raceme", "umbel", "globe", "spike"] as const;
export type FlowerShape = (typeof FLOWER_SHAPES)[number];

/** Side of the jittered grid tufts are scattered on - at most one tuft per cell, so this also caps
 *  density at 1 / GRASS_CELL_SIZE^2 per square metre. */
export const GRASS_CELL_SIZE = 0.8;

/** Grass stops this far above the water line, so it never pokes out of the shallows. */
export const GRASS_WATER_CLEARANCE = 0.3;

export const GRASS_SALT = 0x67a55;

/** A tuft's kind and scale share one float, kind * GRASS_KIND_STRIDE + scale - room enough, as a
 *  tuft's scale stays under 2 (see grassScatter.ts). */
export const GRASS_KIND_STRIDE = 4;
