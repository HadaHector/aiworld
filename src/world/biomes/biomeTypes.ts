import type { ColorTuple, PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { GrassSpec, MaterialLayer } from "../materials/materialTypes";
import type { TreeRules } from "../foliage/foliageConfig";
import type { SettlementStyle } from "../settlements/settlementConfig";
import type { ColorAdjust } from "../materials/colorAdjust";
import type { WeatherChance } from "../weather/weatherTypes";

/** Reserved for future differentiated border generation; only "smooth" is generated today. */
export type BorderType = "smooth" | "mountain" | "river" | "cliff" | "wall";

/**
 * A zone's own sky and haze. `horizon` doubles as this zone's fog colour - the sky dome is drawn
 * at infinite distance, so if the two ever disagreed the join between fogged-out ground and sky
 * would be a visible seam rather than the ground simply fading into it.
 */
export interface BiomeAtmosphere {
  horizon: ColorTuple;
  zenith: ColorTuple;
  cloud: ColorTuple;
  /** Fractions of the draw distance at which fog begins and where it is complete. Pulling them in
   *  per zone is what lets a zone read as hemmed-in and close (a misty wood, the swamp) and another
   *  as open and far-seeing (the steppe) without changing what "far" means anywhere else. Past the
   *  end the ground is all fog - the horizon colour, so it meets the sky without a seam. */
  fogStartFraction: number;
  fogEndFraction: number;
}

/**
 * A zone's own lighting across the day/night cycle (see lighting/sunLighting.ts). The sun and moon
 * are the same DirectionalLight re-coloured and re-aimed rather than two separate lights - which is
 * also why there is one `sunPeakElevation`/`moonPeakElevation` pair rather than a single "how high
 * does light get" number: a zone can want a harsh overhead noon and a low, barely-clearing moon (a
 * desert) or the reverse (a tundra's grazing sun and big bright moon).
 *
 * Colour and elevation are the only two things this file states; sunLighting.ts turns them into an
 * actual direction/intensity/colour by the current time of day, so a zone never has to state a
 * literal time -> value curve itself. Every field here blends the same way atmosphere's colours do -
 * weighted by whichever areas are in range of a point - so crossing a border fades lighting exactly
 * as smoothly as it fades sky and fog.
 */
export interface BiomeDayNight {
  /** Degrees above the horizon the sun reaches at true noon. */
  sunPeakElevation: number;
  /** Degrees above the horizon the moon reaches at true midnight. */
  moonPeakElevation: number;
  /** The ambient sky-fill's colour and strength at full day and full night - see
   *  sunLighting.ts's updateDayNight for how these cross-fade across dawn and dusk. */
  ambientDay: ColorTuple;
  ambientDayIntensity: number;
  ambientNight: ColorTuple;
  ambientNightIntensity: number;
  /** The sun's own colour low on the horizon (dawn/dusk) versus high overhead (noon) - the one
   *  place light colour genuinely varies across the day rather than just fading in and out. */
  sunHorizonColor: ColorTuple;
  sunZenithColor: ColorTuple;
  sunIntensity: number;
  moonColor: ColorTuple;
  moonIntensity: number;
}

export interface BiomeOutputs {
  height: PipelineDef;
  /**
   * Rock relief, added on top of the height - real ground, so the character stands on it and the
   * trees grow on it. Read as a graph with two inputs: `height`, the ground as shaped so far (the
   * world's bedrock and the zone's height, before rivers, lakes and roads), and `steepness`, the sine
   * of its slope there - so a zone can raise crags from a rock-formation noise, or `terrace` the
   * height into ledges, only where the ground is already steep. Costs two more evaluations of the
   * height per sample, in a zone that has one.
   */
  relief?: PipelineDef;
  /**
   * How thickly this zone grows each kind of tree, as one graph with a named output per tree kind
   * id (a pack's trees/ folder) - so a zone is not one species at one density, it is a density *map*
   * per species, and two species can share ground with the mix shifting across it.
   *
   * A kind with no output does not grow here. Each output reads as a 0-1 share of the scatter
   * lattice (see foliage/treeScatter.ts) and the world's own rules - water, roads, cliffs, the
   * treeline - thin whatever this asks for afterwards.
   *
   * One graph rather than one per species so shared work is shared: a "how wooded is it here"
   * noise feeding both broadleaf and pine is evaluated once per sample, not once per output.
   *
   * Besides noise, the graph can read named values of the ground it is being asked about via
   * `op: "input"` - "height", "slope", "riverGap", "roadGap", "lakeFactor" and "areaBorderGap" -
   * which is what lets a zone put conifers up its slopes and broadleaf in its valleys, or gather
   * palms at its water.
   */
  foliage?: PipelineDef;
  /** The same for bushes, one output per bush kind - scattered on a lattice of their own, under and
   *  between the trees (see foliage/treeScatter.ts's createBushScatter). */
  bushes?: PipelineDef;
  /** The same for boulders, one output per rock kind (a pack's rocks/ folder) - on the trees' own
   *  lattice, so a boulder takes a tree's room, and a big one clears a wide circle. Rocks keep out
   *  of water and roads, but not the zone's shore, treeline or slope rules: those are for trees. */
  rocks?: PipelineDef;
  // Future, unimplemented: wetness?: PipelineDef; material?: PipelineDef;
}

/** One part of a tree's recolouring: the area's adjustment, and how far each tree may stray from it. */
export interface TreeTintPart {
  adjust: ColorAdjust;
  /** Per tree, up to: this many degrees of hue either way, and this fraction of saturation and
   *  value either way - so a wood is many shades of its colour, not one. 0s for none. */
  spread: { hue: number; saturation: number; value: number };
}

/** A `treeTints` rule: which kinds it recolours (null for every kind), leaves and bark - and a
 *  boulder's stone. */
export interface TreeTintRuleDef {
  kinds: string[] | null;
  leaves: TreeTintPart;
  bark: TreeTintPart;
  stone: TreeTintPart;
  /** How much snow lies on them, 0-1: on a boulder's top, and further down its sides the more there
   *  is. 0 for none. */
  snow: number;
}

export interface BiomeDefinition {
  id: string;
  /**
   * What this biome's noises are seeded by: its id, or for an area's own roll of it (see
   * content/biomeRolls.ts) its id and the area's - so every area of a biome grows its own hills,
   * woods and ground patterns, not the one pattern seen from somewhere else.
   */
  seedKey: string;
  name: string;
  /** Which phonetic palette this biome's zones are named from (naming/nameGenerator.ts). A property
   *  of the biome rather than a lookup table elsewhere, so adding a biome cannot forget to set it. */
  voiceId: string;
  outputs: BiomeOutputs;
  /** A per-biome declared preference. "mountain" generates boundary hills along a qualifying edge
   *  (see cells/areaField.ts); "river"/"cliff"/"wall" remain reserved, unbranched. */
  borderType: BorderType;
  spawnWeight: number;
  /** Probability (0-1) any given cell inside an area of this biome becomes a lake cell. Unset/0 = never. */
  lakeChance?: number;
  /** MaterialDef id this biome's ground texture falls back to wherever no overlay layer
   *  (rock/sand/snow) outweighs it. */
  baseMaterialId: string;
  /** The surface a road through this zone is made of, as a MaterialDef id. Roads are graded
   *  into the terrain and painted by one layer that reaches everywhere, but what that layer paints
   *  is the zone's own choice - a track through a desert is not a track through a forest. Biomes
   *  may share one, and sharing is what keeps the material roster small at a border between them. */
  roadMaterialId: string;
  /** Layers checked only where this biome has a say, on top of the universal ones. This is what
   *  keeps per-vertex cost flat as more biomes grow their own layers: a point only ever evaluates
   *  the universal list plus its own biomes' lists, never every biome's layers put together. */
  materialLayers: MaterialLayer[];
  /** A recolouring of all of this zone's ground, after each material's own (`ground.adjust`) - the
   *  knob that makes one area's meadow greener or its sand redder than the next area's. */
  groundAdjust: ColorAdjust;
  /** Recolourings of one family of this zone's ground materials each (`ground.tints`), after
   *  groundAdjust - so an area's meadows can turn blue or orange while its roads and rock do not. */
  groundTints: { family: string; adjust: ColorAdjust }[];
  /** Grass this zone grows on top of what its materials grow, on every material of one family
   *  (`ground.grass`) - with a roll's `chance` on each, one area's meadows go with clover and the
   *  next with daisies, whichever sward they are. */
  groundGrass: { family: string; spec: GrassSpec }[];
  /** How this zone recolours its trees and bushes (`treeTints`), rule by rule - a tree takes the
   *  first rule naming its kind, or naming none. */
  treeTints: TreeTintRuleDef[];
  /** Where trees thin out here. Biomes that do not set their own share one object, the defaults'. */
  treeRules: TreeRules;
  /** What settlements here look like, or null for a biome nobody settles. */
  settlementStyle: SettlementStyle | null;
  atmosphere: BiomeAtmosphere;
  dayNight: BiomeDayNight;
  /** The weathers this zone can have and how likely each is (see weather/weatherSystem.ts) - the
   *  packs' defaults.json5 list for a biome that names none. Empty: always as written. */
  weather: WeatherChance[];
}

/** The shape of the hills raised along a border between two zones - see cells/areaField.ts. */
export interface BoundaryHillStyle {
  id: string;
  name: string;
  heightPipeline: PipelineDef;
}
