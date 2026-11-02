import { SEA_LEVEL } from "../world/cells/areaField";
import type { TerrainSample, TerrainSampler } from "../world/terrain/terrainSampler";
import type { MaterialBlender } from "../world/materials/materialBlend";
import type { TreeCover } from "../world/foliage/treeScatter";
import { drawThings, type MapThings } from "./things";

/**
 * The map's tiles (see MAP.md): one picture of the world at one resolution, cut into squares so only
 * what a view shows is drawn. Pure - no Babylon, no DOM - so a tile comes out the same bytes in the
 * page, in a worker and in a Node probe.
 */

/** A tile's side in pixels. */
export const MAP_TILE_PIXELS = 256;
/** The map's one resolution: metres to a pixel at 1x. */
export const MAP_METRES_PER_PIXEL = 0.25;
/** A tile's side in metres. */
export const MAP_TILE_METRES = MAP_TILE_PIXELS * MAP_METRES_PER_PIXEL;
/** Goes up whenever the drawing changes, so no cache shows an old tile. */
export const MAP_VERSION = 1;

export type Rgb = readonly [number, number, number];

/** A tile's name in every cache: the world (seed with its packs' and config's hash), the dimension,
 *  where. */
export function mapTileKey(world: string, dimension: string, tx: number, tz: number): string {
  return `map/v${MAP_VERSION}/${world}/${dimension}/${tx},${tz}`;
}

/** The tile a world point lies in. */
export function mapTileAt(x: number, z: number): { tx: number; tz: number } {
  return { tx: Math.floor(x / MAP_TILE_METRES), tz: Math.floor(z / MAP_TILE_METRES) };
}

/** What the ground is drawn from - a world's own sampler and material blend, as the chunk workers
 *  hold them. */
export interface MapGround {
  sampleTerrain: TerrainSampler;
  buildMaterialBlend: MaterialBlender["buildMaterialBlend"];
  /** The ground's materials' average colours, 0-1, by material index (MaterialLibrary's, as the
   *  chunk workers are sent them). */
  groundColors: readonly Rgb[];
  /** How wooded the ground is, for the layers that follow the woods - left out, none. */
  treeCover?: TreeCover;
}

const OCEAN: Rgb = [0.13, 0.33, 0.43];
const SHALLOW: Rgb = [0.29, 0.5, 0.56];
/** Water this deep (m) or deeper is drawn OCEAN; shallower fades to SHALLOW at the shore. */
const DEEP = 6;
/** The light the hills are shaded by: from the north-west and high, so a slope facing it brightens
 *  and one facing away darkens. */
const LIGHT = normalize([-0.5, 1.4, -0.5]);
/** How far the hill shading moves a colour - kept soft so the ground's own colours stay true. */
const SHADE = 0.9;
/** reliefCurvature's reach in metres, as the chunks measure it (materialContext.ts: four full-detail
 *  steps of 2.5 m). */
const CURVATURE_REACH = 10;
/** The coarse height grid curvature is read from, in metres. */
const CURVATURE_STEP = 2;
/** Rows of a tile between the slices mapTileSteps yields at. */
const SLICE_ROWS = 16;

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Draws tile (tx, tz): its RGBA pixels, row by row from its north-west corner (smallest x and z).
 * The ground pass: each pixel's materials blended as the chunks blend them, hill-shaded, water flat
 * and darker the deeper it is; then, given `things`, everything set down in it (things.ts).
 */
export function buildMapTile(ground: MapGround, tx: number, tz: number, things?: MapThings): Uint8ClampedArray {
  const steps = mapTileSteps(ground, tx, tz, things);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** buildMapTile a slice at a time - each `next()` a few milliseconds' work - so a thread that has
 *  other work (a chunk to build, a frame to draw) can take it between slices. */
export function* mapTileSteps(ground: MapGround, tx: number, tz: number, things?: MapThings): Generator<void, Uint8ClampedArray> {
  const n = MAP_TILE_PIXELS;
  const step = MAP_METRES_PER_PIXEL;
  const x0 = tx * MAP_TILE_METRES;
  const z0 = tz * MAP_TILE_METRES;
  // Samples at pixel centres, with a ring of one pixel round for the normals.
  const padded = n + 2;
  const samples: TerrainSample[] = new Array(padded * padded);
  const heights = new Float64Array(padded * padded);
  for (let row = 0; row < padded; row++) {
    for (let col = 0; col < padded; col++) {
      const s = ground.sampleTerrain(x0 + (col - 0.5) * step, z0 + (row - 0.5) * step);
      samples[row * padded + col] = s;
      heights[row * padded + col] = s.height;
    }
    if (row % SLICE_ROWS === 0) yield;
  }
  // Curvature reads ground CURVATURE_REACH away, beyond the tile: from a coarse grid round it.
  const coarseReach = Math.ceil(CURVATURE_REACH / CURVATURE_STEP) + 1;
  const coarseSize = Math.ceil(MAP_TILE_METRES / CURVATURE_STEP) + 1 + 2 * coarseReach;
  const coarse = new Float64Array(coarseSize * coarseSize);
  const cx0 = x0 - coarseReach * CURVATURE_STEP;
  const cz0 = z0 - coarseReach * CURVATURE_STEP;
  for (let row = 0; row < coarseSize; row++) {
    for (let col = 0; col < coarseSize; col++) coarse[row * coarseSize + col] = ground.sampleTerrain(cx0 + col * CURVATURE_STEP, cz0 + row * CURVATURE_STEP).height;
  }
  const coarseHeight = (x: number, z: number): number => {
    const fx = (x - cx0) / CURVATURE_STEP;
    const fz = (z - cz0) / CURVATURE_STEP;
    const c = Math.max(0, Math.min(coarseSize - 2, Math.floor(fx)));
    const r = Math.max(0, Math.min(coarseSize - 2, Math.floor(fz)));
    const u = fx - c;
    const v = fz - r;
    const i = r * coarseSize + c;
    return (coarse[i] * (1 - u) + coarse[i + 1] * u) * (1 - v) + (coarse[i + coarseSize] * (1 - u) + coarse[i + coarseSize + 1] * u) * v;
  };

  yield;
  const out = new Uint8ClampedArray(n * n * 4);
  const depth = new Float32Array(n * n);
  const colors = ground.groundColors;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = (row + 1) * padded + (col + 1);
      const sample = samples[i];
      const x = x0 + (col + 0.5) * step;
      const z = z0 + (row + 0.5) * step;
      let r: number;
      let g: number;
      let b: number;
      if (!sample.isLand || sample.height < SEA_LEVEL) {
        const t = Math.min(1, (SEA_LEVEL - sample.height) / DEEP);
        r = SHALLOW[0] + (OCEAN[0] - SHALLOW[0]) * t;
        g = SHALLOW[1] + (OCEAN[1] - SHALLOW[1]) * t;
        b = SHALLOW[2] + (OCEAN[2] - SHALLOW[2]) * t;
      } else {
        const dx = (heights[i + 1] - heights[i - 1]) / (2 * step);
        const dz = (heights[i + padded] - heights[i - padded]) / (2 * step);
        const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
        const nx = -dx * inv;
        const ny = inv;
        const nz = -dz * inv;
        const reliefCurvature =
          (coarseHeight(x - CURVATURE_REACH, z) + coarseHeight(x + CURVATURE_REACH, z) + coarseHeight(x, z - CURVATURE_REACH) + coarseHeight(x, z + CURVATURE_REACH)) / 4 - sample.height;
        // The chunks' own vertex context (materialContext.ts's buildVertexContext), field for field.
        const context: Record<string, number> = {
          treeCover: ground.treeCover ? ground.treeCover(x, z, { height: sample.height, surfaceHeight: sample.height, slope: Math.sqrt(Math.max(0, 1 - ny * ny)), sample }) : 0,
          height: sample.height,
          slope: ny,
          slopeFacing: -nz,
          landmass: sample.landmass,
          lakeFactor: sample.lakeFactor,
          riverGap: sample.riverGap,
          roadGap: sample.roadGap,
          roadMiddle: sample.roadMiddle,
          featureKind: sample.featureKind,
          featureGap: sample.featureGap,
          featureDepth: sample.featureDepth,
          spill: sample.spill,
          spillMaterial: sample.spillMaterial,
          reliefCurvature,
        };
        const blend = ground.buildMaterialBlend(x, z, context, sample.areaWeights);
        r = g = b = 0;
        let total = 0;
        for (const [material, weight] of blend) {
          const c = colors[material];
          if (!c) continue;
          r += c[0] * weight;
          g += c[1] * weight;
          b += c[2] * weight;
          total += weight;
        }
        if (total > 0) {
          r /= total;
          g /= total;
          b /= total;
        } else {
          r = g = b = 0.5;
        }
        // Lit relative to flat ground, so level land keeps its colour exactly.
        const lit = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
        const shade = 1 + (lit - LIGHT[1]) * SHADE;
        r *= shade;
        g *= shade;
        b *= shade;
      }
      depth[row * n + col] = Math.max(SEA_LEVEL, sample.height);
      const o = (row * n + col) * 4;
      out[o] = r * 255;
      out[o + 1] = g * 255;
      out[o + 2] = b * 255;
      out[o + 3] = 255;
    }
    if (row % SLICE_ROWS === SLICE_ROWS - 1) yield;
  }
  if (things) drawThings({ out, depth, size: n, x0, z0, step }, things);
  return out;
}
