import { deriveSeed, mulberry32 } from "../rng";
import { smoothstep } from "../mathUtils";
import { compileOutputs, type CompiledOutputs } from "../terrain/pipeline/pipelineCompiler";
import type { BiomeDefinition } from "../biomes/biomeTypes";
import type { WorldContent } from "../content/worldContent";
import type { TerrainSample } from "../terrain/terrainSampler";
import type { PipelineDef } from "../terrain/pipeline/pipelineTypes";
import {
  TREE_SPACING,
  TREE_CANDIDATES_PER_CELL,
  TREE_MAX_LAKE_FACTOR,
  TREE_ROAD_CLEARANCE,
  TREE_ROAD_FADE,
  TREE_SINK,
  FOLIAGE_SALT,
  BUSH_SPACING,
  BUSH_CANDIDATES_PER_CELL,
  BUSH_SALT,
  BUSH_TRUNK_CLEARANCE,
  BUSH_SHADE_INNER,
  BUSH_SHADE_OUTER,
  BUSH_OPEN_SHARE,
  BUSH_ROAD_CLEARANCE,
  BUSH_ROAD_FADE,
  BUSH_SINK,
  type OldTrees,
  type TreeKindDef,
  type TreeRules,
} from "./foliageConfig";
import type { TerrainSampler } from "../terrain/terrainSampler";

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
  /** Which of its kind's models it is drawn with. Left out, as the scatter does, it is hashed from
   *  where the tree stands (see treeField.ts); the workbench names one to show it. */
  variant?: number;
}

/**
 * How wooded the ground is at a point, 0-1: the share of the tree lattice that would grow there -
 * every zone's tree graphs and rules, exactly as the scatter applies them, but before any dart is
 * thrown. A smooth field rather than the trees themselves, so the ground under a wood can follow
 * the wood (see materials/materialContext.ts's treeCover) without a seam at every trunk.
 */
export type TreeCover = (worldX: number, worldZ: number, ground: TreeGround) => number;

export type TreeScatter = (
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  probe: TreeGroundProbe,
) => TreePlacement[];

/**
 * Everything that differs between trees and bushes. The scatter itself is the same.
 */
interface ScatterLevel {
  /** Names this level in errors and in its graphs' noise seeds. */
  name: string;
  kinds: TreeKindDef[];
  /** Which of a biome's graphs says how much of each kind grows. */
  graphOf: (biome: BiomeDefinition) => PipelineDef | undefined;
  /** Namespaces a biome's graph, so its noises are seeded apart from every other graph's. */
  namespace: (biome: BiomeDefinition) => string;
  spacing: number;
  candidatesPerCell: number;
  salt: number;
  roadClearance: number;
  roadFade: number;
  sink: number;
  /** Old trees, for a level that has them (see OldTrees). */
  old?: OldTrees;
  /**
   * The trees an understory grows among: it keeps clear of their trunks and is thicker in their
   * shade. `ground` stands in for the chunk's own probe beyond the ground the chunk can see, so a
   * tree just across a chunk border still casts its shade.
   */
  understory?: { trees: ScatterWhere; ground: TreeGroundProbe; youngReach: number; oldReach: number };
}

/** A scatter over only the darts `keep` accepts - an understory looks further out for old trees
 *  than for young ones, since their shade reaches further. */
type ScatterWhere = (minX: number, minZ: number, maxX: number, maxZ: number, probe: TreeGroundProbe, keep: (size: number) => boolean) => TreePlacement[];

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
  /** 1 for a young tree, an old one's size multiple otherwise. It is also the room it takes. */
  size: number;
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

type TreeContent = Pick<WorldContent, "biomes" | "treeKinds" | "oldTrees">;

/** The trees: the zones' `trees` graphs, on the wide lattice. */
export function createTreeScatter(seed: number, content: TreeContent): TreeScatter {
  return createScatter(seed, content.biomes, treeLevel(content)).scatter;
}

export function createTreeCover(seed: number, content: TreeContent): TreeCover {
  return createScatter(seed, content.biomes, treeLevel(content)).cover;
}

function treeLevel(content: Pick<WorldContent, "treeKinds" | "oldTrees">): ScatterLevel {
  return {
    old: content.oldTrees,
    name: "tree",
    kinds: content.treeKinds,
    graphOf: (biome) => biome.outputs.foliage,
    namespace: (biome) => `${biome.id}:foliage`,
    spacing: TREE_SPACING,
    candidatesPerCell: TREE_CANDIDATES_PER_CELL,
    salt: FOLIAGE_SALT,
    roadClearance: TREE_ROAD_CLEARANCE,
    roadFade: TREE_ROAD_FADE,
    sink: TREE_SINK,
  };
}

/**
 * The ground under a point from the terrain sampler alone - for a tree beyond what a chunk's own
 * probe covers. The chunk's probe decides on the same full-detail surface, only interpolated, so
 * the two agree on all but the odd tree whose density roll lands right on its threshold.
 */
function samplerGround(sampleTerrain: TerrainSampler): TreeGroundProbe {
  return (x, z) => {
    const sample = sampleTerrain(x, z);
    const riseX = sampleTerrain(x + 1, z).height - sample.height;
    const riseZ = sampleTerrain(x, z + 1).height - sample.height;
    const gradient = Math.hypot(riseX, riseZ);
    return { height: sample.height, surfaceHeight: sample.height, slope: gradient / Math.sqrt(1 + gradient * gradient), sample };
  };
}

/**
 * The bushes: the zones' `bushes` graphs, on a lattice of their own, among the trees - clear of
 * their trunks and thickest in their shade (see ScatterLevel.understory).
 */
export function createBushScatter(seed: number, content: TreeContent & Pick<WorldContent, "bushKinds">, sampleTerrain: TerrainSampler): TreeScatter {
  const trees = createScatter(seed, content.biomes, treeLevel(content));
  const young = Math.max(1, ...content.treeKinds.map((kind) => kind.scale[1]));
  const largest = Math.max(young, ...content.treeKinds.map((kind) => kind.scale[1] * (kind.growsOld ? content.oldTrees.size[1] : 1)));
  return createScatter(seed, content.biomes, {
    name: "bush",
    kinds: content.bushKinds,
    graphOf: (biome) => biome.outputs.bushes,
    namespace: (biome) => `${biome.id}:bushes`,
    spacing: BUSH_SPACING,
    candidatesPerCell: BUSH_CANDIDATES_PER_CELL,
    salt: BUSH_SALT,
    roadClearance: BUSH_ROAD_CLEARANCE,
    roadFade: BUSH_ROAD_FADE,
    sink: BUSH_SINK,
    understory: { trees: trees.scatterWhere, ground: samplerGround(sampleTerrain), youngReach: BUSH_SHADE_OUTER * young, oldReach: BUSH_SHADE_OUTER * largest },
  }).scatter;
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
function createScatter(seed: number, biomes: BiomeDefinition[], level: ScatterLevel): { scatter: TreeScatter; scatterWhere: ScatterWhere; cover: TreeCover } {
  const kinds = level.kinds;
  const kindIds = kinds.map((kind) => kind.id);
  const spacing = level.spacing;
  const old = level.old && level.old.share > 0 ? level.old : null;
  // How many lattice cells out two darts can still be in each other's way: two of the largest old
  // trees stand spacing x their size apart.
  const reachCells = Math.ceil(old ? old.size[1] : 1);

  function compileFoliage(biome: BiomeDefinition): BiomeFoliage | null {
    const def = level.graphOf(biome);
    if (!def) return null;

    for (const name of Object.keys(def.outputs ?? {})) {
      if (!kindIds.includes(name)) {
        throw new Error(`Biome "${biome.id}" declares a ${level.name} output "${name}", which is not a ${level.name} kind`);
      }
    }

    const graph = compileOutputs(def, seed, level.namespace(biome));
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
  for (const biome of biomes) foliageOf.set(biome.id, compileFoliage(biome));

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
    const rng = mulberry32(deriveSeed(seed, level.salt ^ mixed));
    const candidates: Candidate[] = [];
    for (let index = 0; index < level.candidatesPerCell; index++) {
      candidates.push({
        x: (gx + rng()) * spacing,
        z: (gz + rng()) * spacing,
        priority: rng(),
        gx,
        gz,
        index,
        densityRoll: rng(),
        kindRoll: rng(),
        scaleRoll: rng(),
        rotation: rng() * Math.PI * 2,
        tint: rng(),
        size: 1,
      });
    }
    // Whether each is old is drawn after everything else, so adding old trees left every young
    // one's position, species and look exactly as it was.
    if (old) {
      for (const candidate of candidates) {
        const ageRoll = rng();
        const sizeRoll = rng();
        if (ageRoll < old.share) candidate.size = old.size[0] + sizeRoll * (old.size[1] - old.size[0]);
      }
    }
    return candidates;
  }

  /** A strict total order. Equal priorities are vanishingly unlikely but not impossible, and two
   *  candidates that merely tie would each see no one above them and both be kept - breaking the
   *  one guarantee this whole scheme exists to make. */
  function outranks(a: Candidate, b: Candidate): boolean {
    // An old tree outranks every young one: it was there first.
    if ((a.size > 1) !== (b.size > 1)) return a.size > 1;
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
      if (remaining <= 0) return kinds[k];
    }
    // Only reachable on a rounding edge, where the last species with any share is the answer.
    for (let k = perKind.length - 1; k >= 0; k--) {
      if (perKind[k] > 0) return kinds[k];
    }
    return kinds[0];
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
    fade *= smoothstep(level.roadClearance, level.roadFade, sample.roadGap);
    return fade;
  }

  /** Every dart in the region that nothing too close to it outranks - too close being `spacing`
   *  times the average of the two darts' sizes. */
  function survivors(minX: number, minZ: number, maxX: number, maxZ: number, keep: (size: number) => boolean): Candidate[] {
    // A ring of cells beyond the region as wide as a dart's reach, because a dart just outside it
    // can still outrank - and therefore delete - one just inside.
    const gxMin = Math.floor(minX / spacing) - reachCells;
    const gxMax = Math.floor(maxX / spacing) + reachCells;
    const gzMin = Math.floor(minZ / spacing) - reachCells;
    const gzMax = Math.floor(maxZ / spacing) + reachCells;
    const width = gxMax - gxMin + 1;
    const depth = gzMax - gzMin + 1;

    const cells: Candidate[][] = new Array(width * depth);
    for (let ix = 0; ix < width; ix++) {
      for (let iz = 0; iz < depth; iz++) {
        cells[ix * depth + iz] = cellCandidates(gxMin + ix, gzMin + iz);
      }
    }

    const kept: Candidate[] = [];

    for (let ix = reachCells; ix < width - reachCells; ix++) {
      for (let iz = reachCells; iz < depth - reachCells; iz++) {
        for (const candidate of cells[ix * depth + iz]) {
          // Ownership is by position, so every dart belongs to exactly one region and a shared
          // border neither duplicates nor drops one.
          if (candidate.x < minX || candidate.x >= maxX) continue;
          if (candidate.z < minZ || candidate.z >= maxZ) continue;
          if (!keep(candidate.size)) continue;

          let beaten = false;
          for (let dx = -reachCells; dx <= reachCells && !beaten; dx++) {
            for (let dz = -reachCells; dz <= reachCells && !beaten; dz++) {
              for (const other of cells[(ix + dx) * depth + (iz + dz)]) {
                if (other === candidate) continue;
                if (!outranks(other, candidate)) continue;
                const ox = other.x - candidate.x;
                const oz = other.z - candidate.z;
                const apart = (spacing * (other.size + candidate.size)) / 2;
                if (ox * ox + oz * oz < apart * apart) {
                  beaten = true;
                  break;
                }
              }
            }
          }
          if (!beaten) kept.push(candidate);
        }
      }
    }
    return kept;
  }

  const understory = level.understory;

  /**
   * How an understory plant fares among the trees: 0 on a trunk, otherwise BUSH_OPEN_SHARE in the
   * open rising to 1 in a tree's shade - each tree's clearance and shade sized by its scale.
   */
  function amongTrees(trees: TreePlacement[], x: number, z: number): number {
    let shade = 0;
    for (const tree of trees) {
      const distance = Math.hypot(tree.x - x, tree.z - z);
      if (distance < BUSH_TRUNK_CLEARANCE * tree.scale) return 0;
      shade = Math.max(shade, 1 - smoothstep(BUSH_SHADE_INNER * tree.scale, BUSH_SHADE_OUTER * tree.scale, distance));
    }
    return BUSH_OPEN_SHARE + (1 - BUSH_OPEN_SHARE) * shade;
  }

  function scatterWhere(minX: number, minZ: number, maxX: number, maxZ: number, probe: TreeGroundProbe, keep: (size: number) => boolean): TreePlacement[] {
    const trees: TreePlacement[] = [];
    // The trees around, for an understory - found only once something here wants to grow at all,
    // since most chunks grow no bushes and finding the trees means sampling ground past the chunk.
    let among: TreePlacement[] | null = null;

    for (const candidate of survivors(minX, minZ, maxX, maxZ, keep)) {
      const ground = probe(candidate.x, candidate.z);
      if (!ground) continue;
      let wanted = speciesDensities(ground, candidate.x, candidate.z);
      if (wanted <= 0) continue;
      const kind = kindFor(wanted, candidate.kindRoll);
      if (understory) {
        among ??= treesAround(understory, minX, minZ, maxX, maxZ, probe);
        wanted *= amongTrees(among, candidate.x, candidate.z);
      }
      if (candidate.densityRoll >= wanted * survivalFade(ground)) continue;

      const size = kind.growsOld ? candidate.size : 1;
      trees.push({
        x: candidate.x,
        y: ground.surfaceHeight - level.sink * size,
        z: candidate.z,
        kind: kind.id,
        scale: (kind.scale[0] + candidate.scaleRoll * (kind.scale[1] - kind.scale[0])) * size,
        rotation: candidate.rotation,
        tint: candidate.tint,
      });
    }
    return trees;
  }

  /** The trees whose shade can reach into a region: young ones from close by, old ones from further. */
  function treesAround(
    understory: NonNullable<ScatterLevel["understory"]>,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    probe: TreeGroundProbe,
  ): TreePlacement[] {
    const ground = (x: number, z: number): TreeGround | null => probe(x, z) ?? understory.ground(x, z);
    const y = understory.youngReach;
    const o = understory.oldReach;
    return [
      ...understory.trees(minX - y, minZ - y, maxX + y, maxZ + y, ground, (size) => size === 1),
      ...(o > y ? understory.trees(minX - o, minZ - o, maxX + o, maxZ + o, ground, (size) => size > 1) : []),
    ];
  }

  const everyTree = (): boolean => true;
  const scatter: TreeScatter = (minX, minZ, maxX, maxZ, probe) => scatterWhere(minX, minZ, maxX, maxZ, probe, everyTree);

  return {
    scatter,
    scatterWhere,
    cover: (x, z, ground) => {
      const wanted = speciesDensities(ground, x, z);
      return wanted <= 0 ? 0 : Math.min(1, wanted * survivalFade(ground));
    },
  };
}
