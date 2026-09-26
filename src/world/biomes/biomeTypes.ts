import type { ColorTuple, PipelineDef } from "../terrain/pipeline/pipelineTypes";
import type { MaterialLayer } from "../materials/materialTypes";
import type { TreeRules } from "../foliage/foliageConfig";
import type { SettlementStyle } from "../settlements/settlementConfig";

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
  /** Fraction of the draw distance at which fog begins - the counterpart to world.ts's
   *  FOG_END_FRACTION, which stays fixed globally (fog always finishes just past the load radius,
   *  whatever zone that happens to be). Pulling this in per biome is what lets a zone read as
   *  hemmed-in and close (the swamp, low) without changing what "far" means everywhere else. */
  fogStartFraction: number;
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
  // Future, unimplemented: wetness?: PipelineDef; material?: PipelineDef;
}

export interface BiomeDefinition {
  id: string;
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
  /** Where trees thin out here. Biomes that do not set their own share one object, the defaults'. */
  treeRules: TreeRules;
  /** What settlements here look like, or null for a biome nobody settles. */
  settlementStyle: SettlementStyle | null;
  atmosphere: BiomeAtmosphere;
  dayNight: BiomeDayNight;
}

/** The shape of the hills raised along a border between two zones - see cells/areaField.ts. */
export interface BoundaryHillStyle {
  id: string;
  name: string;
  heightPipeline: PipelineDef;
}
