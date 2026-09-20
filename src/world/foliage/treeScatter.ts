import { deriveSeed, mulberry32 } from "../rng";
import { smoothstep } from "../mathUtils";
import { createBaseNoise2D, type Noise2D } from "../terrain/noise";
import type { TerrainSample } from "../terrain/terrainSampler";
import {
  TREE_SPACING,
  TREE_CANDIDATES_PER_CELL,
  TREE_MAX_LAKE_FACTOR,
  TREE_MIN_HEIGHT,
  TREE_SHORE_HEIGHT,
  TREE_ROAD_CLEARANCE,
  TREE_ROAD_FADE,
  TREE_EASY_SLOPE,
  TREE_MAX_SLOPE,
  TREE_LINE_START,
  TREE_LINE_END,
  TREE_PATCH_FREQUENCY,
  TREE_PATCH_STRENGTH,
  TREE_SCALE_MIN,
  TREE_SCALE_MAX,
  TREE_SINK,
  FOLIAGE_SALT,
} from "./foliageConfig";

/** What the scatter needs to know about the ground under a candidate. */
export interface TreeGround {
  /** Surface height, on the mesh the player will actually stand on. */
  height: number;
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
  scale: number;
  rotation: number;
  tint: number;
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
 */
export function createTreeScatter(seed: number): TreeScatter {
  const patchNoise: Noise2D = createBaseNoise2D(deriveSeed(seed, FOLIAGE_SALT));

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
        scale: TREE_SCALE_MIN + rng() * (TREE_SCALE_MAX - TREE_SCALE_MIN),
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
   * How much of the lattice this ground actually grows, 0-1.
   *
   * Every term is a fade. A biome's own figure is blended over every area with a say here (the
   * same weights the terrain blends height and materials by), so a wood does not stop at a zone
   * border - it thins across it.
   */
  function densityAt(ground: TreeGround, x: number, z: number): number {
    const { sample } = ground;
    if (!sample.isLand) return 0;
    if (sample.lakeFactor > TREE_MAX_LAKE_FACTOR) return 0;

    let density = 0;
    for (const { biome, weight } of sample.areaWeights) {
      density += biome.treeDensity * weight;
    }
    if (density <= 0) return 0;

    density *= smoothstep(TREE_MIN_HEIGHT, TREE_SHORE_HEIGHT, ground.height);
    density *= 1 - smoothstep(TREE_LINE_START, TREE_LINE_END, ground.height);
    density *= 1 - smoothstep(TREE_EASY_SLOPE, TREE_MAX_SLOPE, ground.slope);
    // roadGap is Infinity where no road is in range, which smoothstep clamps to 1.
    density *= smoothstep(TREE_ROAD_CLEARANCE, TREE_ROAD_FADE, sample.roadGap);
    const patch = smoothstep(-0.4, 0.4, patchNoise(x * TREE_PATCH_FREQUENCY, z * TREE_PATCH_FREQUENCY));
    return density * patch * TREE_PATCH_STRENGTH;
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
          if (candidate.densityRoll >= densityAt(ground, candidate.x, candidate.z)) continue;

          trees.push({
            x: candidate.x,
            y: ground.height - TREE_SINK,
            z: candidate.z,
            scale: candidate.scale,
            rotation: candidate.rotation,
            tint: candidate.tint,
          });
        }
      }
    }

    return trees;
  };
}
