import { deriveSeed, mulberry32 } from "../rng";
import { smoothstep } from "../mathUtils";
import { compileOutputs, type CompiledOutputs } from "../terrain/pipeline/pipelineCompiler";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import type { WorldContent } from "../content/worldContent";
import type { TerrainSample } from "../terrain/terrainSampler";
import {
  TREE_SPACING,
  TREE_CANDIDATES_PER_CELL,
  TREE_MAX_LAKE_FACTOR,
  TREE_ROAD_CLEARANCE,
  TREE_ROAD_FADE,
  TREE_SINK,
  FOLIAGE_SALT,
  type TreeKindDef,
  type TreeRules,
} from "./foliageConfig";

/** What the scatter needs to know about the ground under a candidate. */
export interface TreeGround {
  /** Height of the full-detail surface - what decides whether a tree grows here, so the decision
   *  does not change with the level of detail the ground happens to be drawn at. */
  height: number;
  /** Height of the ground as actually drawn, which is where the trunk is planted. */
  surfaceHeight: number;
  /** Sine of the ground angle: 0 flat, 1 vertical. */
  slope: number;
  sample: TerrainSample;
}

/** Returns null where the caller has no data - outside its own patch of world. */
export type TreeGroundProbe = (worldX: number, worldZ: number) => TreeGround | null;

export interface TreePlacement {
  x: number;
  y: number;
  z: number;
  /** A TreeKindDef id. */
  kind: string;
  /** Uniform. Multiplies the whole placeholder model. */
  scale: number;
  /** Radians about Y. */
  rotation: number;
  /** 0-1, mixes the canopy colour so a stand of trees is not one flat green. */
  tint: number;
}

export type TreeScatter = (
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  probe: TreeGroundProbe,
) => TreePlacement[];

/**
 * One dart. Everything random about a tree is drawn here, at generation time, so that rejecting a
 * candidate consumes no randomness and a cell's stream stays in step no matter what the terrain
 * under it turns out to be - which is what makes the scatter reproducible from the seed alone.
 */
interface Candidate {
  x: number;
  z: number;
  priority: number;
  gx: number;
  gz: number;
  index: number;
  densityRoll: number;
  kindRoll: number;
  /** 0-1, where in its kind's scale range the tree lands - drawn before the kind is known. */
  scaleRoll: number;
  rotation: number;
  tint: number;
}

/**
 * One biome's compiled density map.
 *
 * `offsetOf` holds where each kind's result lands in the graph's scratch buffer, or -1 for a kind
 * this biome does not grow - so reading a species out of an evaluation is an indexed read rather
 * than a name lookup, and a biome that grows two species still only runs its graph once.
 */
interface BiomeFoliage {
  graph: CompiledOutputs;
  offsetOf: Int32Array;
}

/**
 * Poisson-disk scatter that needs no global pass and no communication between chunks.
 *
 * Each lattice cell throws its darts from a seed derived from its own coordinates, and a dart is
 * kept only if nothing within TREE_SPACING outranks it. Since the lattice cell is TREE_SPACING
 * wide and a dart never leaves its own cell, "within TREE_SPACING" can only mean the 3x3 block
 * around it - so the decision is purely local, identical whichever chunk asks, and a tree sitting
 * on a chunk border is placed the same way by both of its neighbours.
 *
 * It is a Matern type II hard-core process rather than true dart-throwing: a dart survives only if
 * it is a local maximum of priority, where classic sequential dart-throwing would also keep a dart
 * whose better-ranked rival was itself rejected. That costs roughly half the maximum achievable
 * density and buys the locality, which is the whole point - the alternative is a world-wide
 * sequential pass that cannot be streamed. TREE_SPACING is set against the density that comes out,
 * not against the density a maximal packing would have given.
 *
 * What survives the spacing rule is then thinned by the density map each biome declares (see
 * BiomeOutputs.foliage), which is also what decides which species a surviving dart becomes.
 */
export function createTreeScatter(seed: number, content: Pick<WorldContent, "biomes" | "treeKinds">): TreeScatter {
  const kindIds = content.treeKinds.map((kind) => kind.id);

  function compileFoliage(biome: BiomeDefinition): BiomeFoliage | null {
    const def = biome.outputs.foliage;
    if (!def) return null;

    for (const name of Object.keys(def.outputs ?? {})) {
      if (!kindIds.includes(name)) {
        throw new Error(`Biome "${biome.id}" declares a foliage output "${name}", which is not a tree kind`);
      }
    }

    const graph = compileOutputs(def, seed, `${biome.id}:foliage`);
    const offsetOf = new Int32Array(kindIds.length).fill(-1);
    let grows = false;
    for (let k = 0; k < kindIds.length; k++) {
      const ref = graph.output(kindIds[k]);
      if (!ref) continue;
      if (ref.type !== "scalar") {
        throw new Error(`Biome "${biome.id}" foliage output "${kindIds[k]}" is a colour; a density has to be a scalar`);
      }
      offsetOf[k] = ref.offset;
      grows = true;
    }
    return grows ? { graph, offsetOf } : null;
  }

  const foliageOf = new Map<string, BiomeFoliage | null>();
  for (const biome of content.biomes) foliageOf.set(biome.id, compileFoliage(biome));

  // Reused across candidates rather than rebuilt per call: this is the hottest thing in a chunk
  // build after the terrain samples themselves.
  const perKind = new Float64Array(kindIds.length);
  const context: Record<string, number> = {
    height: 0,
    slope: 0,
    riverGap: 0,
    roadGap: 0,
    lakeFactor: 0,
    areaBorderGap: 0,
  };

  function cellCandidates(gx: number, gz: number): Candidate[] {
    // Mixed before deriveSeed rather than added, so neighbouring cells - which differ by 1 in one
    // coordinate - get unrelated streams instead of adjacent ones.
    const mixed = (Math.imul(gx, 0x27d4eb2d) ^ Math.imul(gz, 0x165667b1)) >>> 0;
    const rng = mulberry32(deriveSeed(seed, FOLIAGE_SALT ^ mixed));
    const candidates: Candidate[] = [];
    for (let index = 0; index < TREE_CANDIDATES_PER_CELL; index++) {
      candidates.push({
        x: (gx + rng()) * TREE_SPACING,
        z: (gz + rng()) * TREE_SPACING,
        priority: rng(),
        gx,
        gz,
        index,
        densityRoll: rng(),
        kindRoll: rng(),
        scaleRoll: rng(),
        rotation: rng() * Math.PI * 2,
        tint: rng(),
      });
    }
    return candidates;
  }

  /** A strict total order. Equal priorities are vanishingly unlikely but not impossible, and two
   *  candidates that merely tie would each see no one above them and both be kept - breaking the
   *  one guarantee this whole scheme exists to make. */
  function outranks(a: Candidate, b: Candidate): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    if (a.gx !== b.gx) return a.gx > b.gx;
    if (a.gz !== b.gz) return a.gz > b.gz;
    return a.index > b.index;
  }

  /**
   * Fills `perKind` with what every zone with a say here would grow, and returns the total.
   *
   * Each zone's graph runs once and every species it declares is read out of that one evaluation,
   * then weighted by the zone's own say - the same weights the terrain blends height and materials
   * by. So a wood does not stop at a zone border, it thins across it, and a border between two
   * zones that favour different species comes out as a genuine mixture rather than a line.
   */
  function speciesDensities(ground: TreeGround, x: number, z: number): number {
    const { sample } = ground;
    perKind.fill(0);

    context.height = ground.height;
    context.slope = ground.slope;
    context.riverGap = sample.riverGap;
    context.roadGap = sample.roadGap;
    context.lakeFactor = sample.lakeFactor;
    context.areaBorderGap = sample.areaBorderGap;

    let total = 0;
    for (const { biome, weight } of sample.areaWeights) {
      const foliage = foliageOf.get(biome.id);
      if (!foliage) continue;
      foliage.graph.run(x, z, context);
      for (let k = 0; k < perKind.length; k++) {
        const offset = foliage.offsetOf[k];
        if (offset < 0) continue;
        // Clamped at zero because a graph is free to ramp below it, and a negative density would
        // eat another species' share of the mix rather than simply meaning "none of this one".
        const density = Math.max(0, foliage.graph.slots[offset]) * weight;
        perKind[k] += density;
        total += density;
      }
    }
    return total;
  }

  /** Which species this one is, drawn from the mix `speciesDensities` just left in `perKind`. */
  function kindFor(total: number, roll: number): TreeKindDef {
    let remaining = roll * total;
    for (let k = 0; k < perKind.length; k++) {
      remaining -= perKind[k];
      if (remaining <= 0) return content.treeKinds[k];
    }
    // Only reachable on a rounding edge, where the last species with any share is the answer.
    for (let k = perKind.length - 1; k >= 0; k--) {
      if (perKind[k] > 0) return content.treeKinds[k];
    }
    return content.treeKinds[0];
  }

  function rulesFade(rules: TreeRules, ground: TreeGround): number {
    let fade = smoothstep(rules.shore[0], rules.shore[1], ground.height);
    fade *= 1 - smoothstep(rules.line[0], rules.line[1], ground.height);
    fade *= 1 - smoothstep(rules.slope[0], rules.slope[1], ground.slope);
    return fade;
  }

  /**
   * The rules applied on top of whatever a biome's density map asked for: each zone's own TreeRules
   * (shore, treeline, slope), blended by the zones' weights, then the world's own - nothing grows
   * in a lake or a road cut, whatever the zone would like. Every one but the lake is a fade,
   * because a hard line in a density field reads as a drawn edge in the world.
   */
  function survivalFade(ground: TreeGround): number {
    const { sample } = ground;
    if (!sample.isLand) return 0;
    if (sample.lakeFactor > TREE_MAX_LAKE_FACTOR) return 0;

    // Zones that do not set rules of their own share the defaults' object, so the usual case is a
    // single rule set that needs no blending at all.
    let first: TreeRules | null = null;
    let firstFade = 0;
    let mixed = false;
    let blended = 0;
    let weightSum = 0;
    for (const { biome, weight } of sample.areaWeights) {
      const zoneFade = rulesFade(biome.treeRules, ground);
      if (first === null) {
        first = biome.treeRules;
        firstFade = zoneFade;
      } else if (biome.treeRules !== first) {
        mixed = true;
      }
      blended += zoneFade * weight;
      weightSum += weight;
    }
    if (first === null) return 0;
    let fade = mixed ? blended / weightSum : firstFade;
    // roadGap is Infinity where no road is in range, which smoothstep clamps to 1.
    fade *= smoothstep(TREE_ROAD_CLEARANCE, TREE_ROAD_FADE, sample.roadGap);
    return fade;
  }

  return function scatterTrees(minX, minZ, maxX, maxZ, probe): TreePlacement[] {
    // One ring of cells beyond the region, because a dart just outside it can still outrank - and
    // therefore delete - one just inside.
    const gxMin = Math.floor(minX / TREE_SPACING) - 1;
    const gxMax = Math.floor(maxX / TREE_SPACING) + 1;
    const gzMin = Math.floor(minZ / TREE_SPACING) - 1;
    const gzMax = Math.floor(maxZ / TREE_SPACING) + 1;
    const width = gxMax - gxMin + 1;
    const depth = gzMax - gzMin + 1;

    const cells: Candidate[][] = new Array(width * depth);
    for (let ix = 0; ix < width; ix++) {
      for (let iz = 0; iz < depth; iz++) {
        cells[ix * depth + iz] = cellCandidates(gxMin + ix, gzMin + iz);
      }
    }

    const spacingSq = TREE_SPACING * TREE_SPACING;
    const trees: TreePlacement[] = [];

    for (let ix = 1; ix < width - 1; ix++) {
      for (let iz = 1; iz < depth - 1; iz++) {
        for (const candidate of cells[ix * depth + iz]) {
          // Ownership is by position, so every dart belongs to exactly one region and a shared
          // border neither duplicates nor drops one.
          if (candidate.x < minX || candidate.x >= maxX) continue;
          if (candidate.z < minZ || candidate.z >= maxZ) continue;

          let beaten = false;
          for (let dx = -1; dx <= 1 && !beaten; dx++) {
            for (let dz = -1; dz <= 1 && !beaten; dz++) {
              for (const other of cells[(ix + dx) * depth + (iz + dz)]) {
                if (other === candidate) continue;
                if (!outranks(other, candidate)) continue;
                const ox = other.x - candidate.x;
                const oz = other.z - candidate.z;
                if (ox * ox + oz * oz < spacingSq) {
                  beaten = true;
                  break;
                }
              }
            }
          }
          if (beaten) continue;

          const ground = probe(candidate.x, candidate.z);
          if (!ground) continue;
          const wanted = speciesDensities(ground, candidate.x, candidate.z);
          if (wanted <= 0) continue;
          if (candidate.densityRoll >= wanted * survivalFade(ground)) continue;

          const kind = kindFor(wanted, candidate.kindRoll);
          trees.push({
            x: candidate.x,
            y: ground.surfaceHeight - TREE_SINK,
            z: candidate.z,
            kind: kind.id,
            scale: kind.scale[0] + candidate.scaleRoll * (kind.scale[1] - kind.scale[0]),
            rotation: candidate.rotation,
            tint: candidate.tint,
          });
        }
      }
    }

    return trees;
  };
}
