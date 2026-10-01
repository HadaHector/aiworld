import type { WorldContent } from "../world/content/worldContent";
import type { BiomeDefinition } from "../world/biomes/biomeTypes";
import type { TerrainSample, TerrainSampler } from "../world/terrain/terrainSampler";
import { rollAreaBiome } from "../world/content/resolveContent";
import { createBedrockSampler } from "../world/bedrock";
import { compilePipeline } from "../world/terrain/pipeline/pipelineCompiler";
import { createMaterialBlender } from "../world/materials/materialBlend";
import { createBushScatter, createRockScatter, createTreeCover, createTreeScatter, type TreeGround, type TreePlacement } from "../world/foliage/treeScatter";
import type { MaterialDef } from "../world/materials/materialTypes";

/** How far reliefCurvature looks, in metres - RELIEF_CURVATURE_RADIUS_STEPS on the game's full-detail
 *  grid (see materialContext.ts), so the preview's valley and ridge layers agree with the game's. On
 *  a coarser grid the nearest whole number of steps. */
const CURVATURE_RADIUS = 10;

/** The one area the preview has - every point is wholly its. */
const AREA_ID = 0;

/**
 * One area of a biome, sampled on a square grid for the workbench's 2D views: its own roll of the
 * biome (`roll` stands in for the area id, so each is a different area's roll), alone on open land -
 * no neighbours, no rivers, lakes or roads, the bedrock under it as the world's. Everything the
 * ground's graphs read is worked out as a chunk build works it out (see materialContext.ts): slope
 * and its facing from the grid's own normals, curvature over the same ten metres.
 */
export interface BiomeArea {
  biome: BiomeDefinition;
  /** Grid points along a side, metres between them, and the world position of the first (top-left:
   *  rows run from +z down). */
  size: number;
  step: number;
  minX: number;
  maxZ: number;
  heights: Float32Array;
  /** Sine of the ground's angle, 0 flat. */
  slopes: Float32Array;
  /** Light from the north-west on the grid's normals, 0-1 - relief shading for every view. */
  shade: Float32Array;
  /** The materials the blend uses here, and their weight at every point (`materials.length` per
   *  point, summing to 1). */
  materials: MaterialDef[];
  blend: Float32Array;
  /** The biome's own ground layers' raw weights - before they share out against one another. */
  layers: { id: string; materialId: string; weights: Float32Array }[];
  /** How wooded each point is, 0-1 (the scatter's own cover: what a forest floor keys on). */
  cover: Float32Array;
  /** The real scatters over the area - worked out on first asking, being the slow part. */
  plants: () => { trees: TreePlacement[]; bushes: TreePlacement[]; rocks: TreePlacement[] };
}

export function sampleBiomeArea(seed: number, content: WorldContent, biomeId: string, roll: number, extent: number, size: number): BiomeArea {
  const base = content.biomes.find((b) => b.id === biomeId);
  if (!base) throw new Error(`No biome "${biomeId}"`);
  const biome = rollAreaBiome(seed, roll, base, content);
  const step = extent / (size - 1);
  // Each roll somewhere of its own, so the bedrock under it differs too.
  const centreX = roll * 4096;
  const centreZ = 0;
  const minX = centreX - extent / 2;
  const maxZ = centreZ + extent / 2;

  const bedrock = createBedrockSampler(seed);
  const detail = compilePipeline(biome.outputs.height, seed, biome.seedKey);
  const heightAt = (x: number, z: number): number => bedrock(x, z) + detail(x, z);

  // The area alone: one area's say everywhere, nothing else near.
  const areaWeights = [{ areaId: AREA_ID, biome, weight: 1 }];
  const sampleAt = (x: number, z: number): TerrainSample => ({
    height: heightAt(x, z),
    primaryAreaId: AREA_ID,
    primaryBiome: biome,
    secondaryBiome: biome,
    biomeBlend: 0,
    areaWeights,
    isLand: true,
    landmass: 1,
    lakeFactor: 0,
    isRiverEdge: false,
    areaBorderGap: Infinity,
    riverGap: Infinity,
    roadGap: Infinity,
  });
  const sampleTerrain: TerrainSampler = sampleAt;

  // Heights on a grid padded for the curvature's reach, so it never clamps at the edge.
  const radius = Math.max(1, Math.round(CURVATURE_RADIUS / step));
  const pad = radius;
  const padded = size + pad * 2;
  const grid = new Float32Array(padded * padded);
  for (let r = 0; r < padded; r++) {
    for (let c = 0; c < padded; c++) grid[r * padded + c] = heightAt(minX + (c - pad) * step, maxZ - (r - pad) * step);
  }
  const at = (r: number, c: number): number => grid[(r + pad) * padded + (c + pad)];

  const count = size * size;
  const heights = new Float32Array(count);
  const slopes = new Float32Array(count);
  const shade = new Float32Array(count);
  const cover = new Float32Array(count);
  const blender = createMaterialBlender(seed, content, [biome]);
  const used = new Map<number, number>();
  const blendLists: [number, number][][] = [];
  const layerFns = biome.materialLayers.map((layer) =>
    compilePipeline(layer.weight, seed, biome.seedKey === biome.id ? `material-${layer.id}` : `material-${layer.id}|${biome.seedKey}`),
  );
  const layers = biome.materialLayers.map((layer) => ({ id: layer.id, materialId: layer.materialId, weights: new Float32Array(count) }));
  const treeCover = createTreeCover(seed, content);
  const light = normalize([-0.5, 0.75, 0.45]);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      const x = minX + c * step;
      const z = maxZ - r * step;
      const h = at(r, c);
      // The normal from the neighbours either side; rows run towards -z.
      const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * step);
      const dz = (at(r - 1, c) - at(r + 1, c)) / (2 * step);
      const n = normalize([-dx, 1, -dz]);
      const slope = Math.sqrt(Math.max(0, 1 - n[1] * n[1]));
      heights[i] = h;
      slopes[i] = slope;
      shade[i] = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      const sample = sampleAt(x, z);
      const ground: TreeGround = { height: h, surfaceHeight: h, slope, sample };
      cover[i] = treeCover(x, z, ground);
      const context: Record<string, number> = {
        treeCover: cover[i],
        height: h,
        slope: n[1],
        slopeFacing: -n[2],
        landmass: 1,
        lakeFactor: 0,
        riverGap: Infinity,
        roadGap: Infinity,
        reliefCurvature: (at(r - radius, c) + at(r + radius, c) + at(r, c - radius) + at(r, c + radius)) / 4 - h,
      };
      const list: [number, number][] = [];
      for (const [index, weight] of blender.buildMaterialBlend(x, z, context, areaWeights)) {
        if (!used.has(index)) used.set(index, used.size);
        list.push([used.get(index)!, weight]);
      }
      blendLists.push(list);
      for (let l = 0; l < layerFns.length; l++) layers[l].weights[i] = Math.max(0, layerFns[l](x, z, context));
    }
  }

  const materials = [...used.keys()].map((index) => blender.materialDefs[index]);
  const blend = new Float32Array(count * materials.length);
  blendLists.forEach((list, i) => {
    for (const [slot, weight] of list) blend[i * materials.length + slot] = weight;
  });

  let plants: ReturnType<BiomeArea["plants"]> | null = null;
  const probe = (x: number, z: number): TreeGround => {
    const sample = sampleAt(x, z);
    const e = 1;
    const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz);
    return { height: sample.height, surfaceHeight: sample.height, slope: g / Math.sqrt(1 + g * g), sample };
  };
  const minZ = maxZ - extent;
  const maxX = minX + extent;

  return {
    biome,
    size,
    step,
    minX,
    maxZ,
    heights,
    slopes,
    shade,
    materials,
    blend,
    layers,
    cover,
    plants: () => {
      if (!plants) {
        plants = {
          trees: createTreeScatter(seed, content)(minX, minZ, maxX, maxZ, probe),
          bushes: createBushScatter(seed, content, sampleTerrain)(minX, minZ, maxX, maxZ, probe),
          rocks: content.rockKinds.length > 0 ? createRockScatter(seed, content, sampleTerrain)(minX, minZ, maxX, maxZ, probe) : [],
        };
      }
      return plants;
    },
  };
}

function normalize(v: number[]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
