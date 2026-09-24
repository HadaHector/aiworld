/**
 * Grass: which kinds exist, what they look like, and which ground grows them.
 *
 * Grass is part of the ground surface, so it is driven by the terrain's own material weights rather
 * than by a density map of its own like trees: whatever the material blend says the ground is made
 * of at a point decides what grows there. That keeps grass off roads, bare rock, snow and beach for
 * free - the material rules already put those materials exactly where they are - and makes grass
 * agree with the texture under it everywhere, which a separate map never quite would.
 */

export const GRASS_KINDS = ["meadow", "dry", "tuft", "tall", "flowers"] as const;
export type GrassKind = (typeof GRASS_KINDS)[number];

export interface GrassKindDef {
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
    /** Flower heads on the tips of this many blades, `radius` texture pixels across. Petals are
     *  coloured per tuft from FLOWER_COLORS rather than by the tuft's own (stem) colour. */
    flowerHeads?: { count: number; radius: number };
  };
}

export const GRASS_KIND_DEFS: Record<GrassKind, GrassKindDef> = {
  // Lush, even green lawn-to-meadow grass.
  meadow: {
    width: 0.95,
    height: 0.5,
    sway: 0.18,
    fadeStart: 15,
    fadeEnd: 200,
    blades: { count: 60, minHeight: 0.45, maxHeight: 0.95, baseWidth: 7, lean: 0.12, fan: false, seedHeads: false },
  },
  // Tall, thin, sparse stalks with seed heads - dry grassland, dune and silt edges.
  dry: {
    width: 0.95,
    height: 0.85,
    sway: 0.28,
    fadeStart: 15,
    fadeEnd: 200,
    blades: { count: 26, minHeight: 0.55, maxHeight: 0.97, baseWidth: 4, lean: 0.18, fan: false, seedHeads: true },
  },
  tall: {
    width: 0.75,
    height: 1.35,
    sway: 0.28,
    fadeStart: 60,
    fadeEnd: 400,
    blades: { count: 15, minHeight: 0.55, maxHeight: 0.97, baseWidth: 4, lean: 0.18, fan: false, seedHeads: true },
  },
  // Wild flowers: a few thin stems, most of them topped with a five-petalled head, in patches.
  flowers: {
    width: 1.25,
    height: 1.25,
    sway: 0.22,
    fadeStart: 70,
    fadeEnd: 300,
    cluster: { scale: 9, coverage: 0.35 },
    blades: {
      count: 12,
      minHeight: 0.5,
      maxHeight: 0.92,
      baseWidth: 2.5,
      lean: 0.15,
      fan: false,
      seedHeads: false,
      flowerHeads: { count: 7, radius: 16 },
    },
  },
  // Short, springy clumps fanning out from one root - tundra, faded grass, moss.
  tuft: {
    width: 0.6,
    height: 0.3,
    sway: 0.1,
    fadeStart: 20,
    fadeEnd: 200,
    blades: { count: 30, minHeight: 0.4, maxHeight: 0.9, baseWidth: 8, lean: 0.35, fan: true, seedHeads: false },
  },
};

/** Petal colours a flowering tuft picks from, one colour per tuft. */
export const FLOWER_COLORS: [number, number, number][] = [
  [0.96, 0.95, 0.9], // white
  [0.98, 0.84, 0.22], // yellow
  [0.62, 0.42, 0.88], // violet
  [0.92, 0.42, 0.55], // pink
];

export interface GrassSpec {
  kind: GrassKind;
  /** Tufts per square metre where this material has full weight. */
  density: number;
  /** Blade colour, multiplied by the blade texture's own light-to-dark shading. */
  color: [number, number, number];
}

/**
 * What each ground material grows, keyed by MaterialDef id. A material not listed grows nothing.
 * A point's grass is every material's specs scaled by that material's weight there, so blends
 * between materials thin one kind out as the next thickens in.
 */
export const GRASS_BY_MATERIAL: Record<string, GrassSpec[]> = {
  grass: [
    { kind: "meadow", density: 3.0, color: [0.47, 0.66, 0.3] },
    { kind: "tall", density: 0.2, color: [0.47, 0.8, 0.4] },
    { kind: "flowers", density: 1.2, color: [0.4, 0.62, 0.26] },
  ],
  grassPale: [
    { kind: "tuft", density: 2.0, color: [0.64, 0.7, 0.5] },
    { kind: "meadow", density: 0.6, color: [0.58, 0.66, 0.44] },
    { kind: "flowers", density: 0.6, color: [0.52, 0.62, 0.38] },
  ],
  grassDry: [
    { kind: "dry", density: 2.0, color: [0.72, 0.62, 0.34] },
    { kind: "tuft", density: 0.4, color: [0.62, 0.56, 0.32] },
  ],
  weeds: [{ kind: "meadow", density: 3.0, color: [0.27, 0.4, 0.18] }],
  moss: [{ kind: "tuft", density: 0.8, color: [0.3, 0.42, 0.18] }],
  tundraGround: [
    { kind: "tuft", density: 1.0, color: [0.55, 0.6, 0.5] },
    { kind: "flowers", density: 0.3, color: [0.5, 0.58, 0.44] },
  ],
  mud: [{ kind: "dry", density: 0.30, color: [0.42, 0.44, 0.24] }],
  sand: [{ kind: "dry", density: 0.05, color: [0.7, 0.66, 0.42] }],
  desertSilt: [{ kind: "dry", density: 0.2, color: [0.64, 0.6, 0.36] }],
};

/**
 * Materials that clear grass rather than merely growing none, by strength.
 *
 * Not growing any is not enough for a road: layer weights are normalised to sum to 1, and a road
 * cut is where other layers fire too (valley layers, river-bank grass), so even at its centre the
 * road is only some 60-70% of the blend - the texture reads as road, but the rest of the blend is
 * still grass material and grew grass in proportion. A clearing material thins everything by
 * strength x its own weight instead: at 2, grass is gone wherever the road is half the blend or
 * more, and thins out across the road's edge on the way in.
 */
export const GRASS_CLEARING_MATERIALS: Record<string, number> = {
  track: 2,
  trackSand: 2,
  trackStone: 2,
};

/** Side of the jittered grid tufts are scattered on - at most one tuft per cell, so this also caps
 *  density at 1 / GRASS_CELL_SIZE^2 per square metre. */
export const GRASS_CELL_SIZE = 0.8;


/** Grass stops this far above the water line, so it never pokes out of the shallows. */
export const GRASS_WATER_CLEARANCE = 0.3;

export const GRASS_SALT = 0x67a55;
