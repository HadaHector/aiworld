import { createTerrainSampler } from "./terrainSampler";
import { createMaterialBlender } from "../materials/materialBlend";
import { createBushScatter, createRockScatter, createTreeCover, createTreeScatter } from "../foliage/treeScatter";
import { buildChunkGeometry, type ChunkBuildContext, type ChunkBuildRequest, type ChunkGeometry } from "./chunkGeometry";
import type { WorldContent } from "../content/worldContent";
import { createWorldData } from "../worldData";
import { createMapTileMaker, type MapColors } from "../../map/maker";

/**
 * Builds terrain chunks off the main thread.
 *
 * The worker builds its own copy of the world from the seed and the loaded content - the terrain
 * sampler, the material blender, the tree scatter - rather than being sent one: the sampler is
 * closures, not data, and rebuilding it takes a few seconds once, at load, in parallel with
 * everything else. Everything in it is deterministic from the seed and the content, so a chunk comes
 * out identical to one built on the main thread.
 *
 * It also draws the map's tiles (MAP.md), from the same copy. Those wait behind chunks and are drawn
 * a slice at a time, so a chunk asked for while a tile is being drawn waits a slice, not a tile.
 */
export type ChunkWorkerMessage =
  | { type: "init"; seed: number; content: WorldContent }
  | { type: "groundColors"; colors: [number, number, number][] }
  | { type: "build"; jobId: number; request: ChunkBuildRequest }
  | { type: "mapColors"; colors: Omit<MapColors, "ground"> }
  | { type: "mapTile"; jobId: number; tx: number; tz: number };

export type ChunkWorkerResponse =
  | { type: "ready" }
  | { type: "built"; jobId: number; geometry: ChunkGeometry }
  | { type: "failed"; jobId: number; message: string }
  | { type: "mapTile"; jobId: number; pixels: Uint8ClampedArray }
  | { type: "mapFailed"; jobId: number; message: string };

let context: ChunkBuildContext | null = null;
let worldInit: { seed: number; content: WorldContent; terrain: ReturnType<typeof createTerrainSampler> } | null = null;
let mapColors: Omit<MapColors, "ground"> | null = null;
let makeTile: ReturnType<typeof createMapTileMaker> | null = null;
/** Map tiles asked for, oldest first; the one being drawn, and its slices still to go. */
const mapQueue: { jobId: number; tx: number; tz: number }[] = [];
let drawing: { jobId: number; steps: Generator<void, Uint8ClampedArray> } | null = null;
let pumping = false;

/** Draws one slice of the tile in hand (or starts the next), then lets any message waiting in -
 *  a chunk - run before the next slice. */
function pumpMap(): void {
  pumping = false;
  let jobId = drawing?.jobId ?? -1;
  try {
    if (!drawing) {
      const job = mapQueue.shift();
      if (!job) return;
      jobId = job.jobId;
      if (!context || !worldInit || !mapColors || !context.groundColors) throw new Error("Map tile asked for before the world's colours");
      if (!makeTile) {
        const { seed, content, terrain } = worldInit;
        const ctx = context;
        makeTile = createMapTileMaker(
          { seed, content, sampleTerrain: ctx.sampleTerrain, materialBlender: ctx.materialBlender, treeCover: ctx.treeCover, scatterTrees: ctx.scatterTrees, scatterBushes: ctx.scatterBushes, scatterRocks: ctx.scatterRocks, buildingGroups: () => createWorldData(seed, content, terrain).buildingGroups },
          { ...mapColors, ground: ctx.groundColors! },
        );
      }
      drawing = { jobId: job.jobId, steps: makeTile(job.tx, job.tz) };
    }
    const next = drawing.steps.next();
    if (next.done) {
      post({ type: "mapTile", jobId: drawing.jobId, pixels: next.value }, [next.value.buffer]);
      drawing = null;
    }
  } catch (error) {
    drawing = null;
    post({ type: "mapFailed", jobId, message: error instanceof Error ? error.message : String(error) });
  }
  schedulePump();
}

function schedulePump(): void {
  if (pumping || (!drawing && mapQueue.length === 0)) return;
  pumping = true;
  setTimeout(pumpMap, 0);
}

function post(response: ChunkWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(response, transfer);
}

self.onmessage = (event: MessageEvent<ChunkWorkerMessage>): void => {
  const message = event.data;
  if (message.type === "init") {
    const { seed, content } = message;
    const terrain = createTerrainSampler(seed, content);
    const { sampleTerrain, areaBiomes } = terrain;
    worldInit = { seed, content, terrain };
    context = {
      sampleTerrain,
      materialBlender: createMaterialBlender(seed, content, areaBiomes),
      scatterTrees: createTreeScatter(seed, content),
      scatterBushes: createBushScatter(seed, content, sampleTerrain),
      scatterRocks: createRockScatter(seed, content, sampleTerrain),
      treeCover: createTreeCover(seed, content),
      grassKinds: content.grassKinds,
      seed,
      groundColors: null,
    };
    post({ type: "ready" });
    return;
  }
  if (message.type === "groundColors") {
    // Known only once the main thread has baked the material textures; every build after this uses
    // them, since a worker handles its messages in order.
    if (context) context.groundColors = message.colors;
    return;
  }
  if (message.type === "mapColors") {
    mapColors = message.colors;
    return;
  }
  if (message.type === "mapTile") {
    mapQueue.push(message);
    schedulePump();
    return;
  }

  try {
    if (!context) throw new Error("Chunk build requested before init");
    const geometry = buildChunkGeometry(message.request, context);
    // Transferred, not copied: the arrays belong to the main thread from here on.
    post({ type: "built", jobId: message.jobId, geometry }, [
      geometry.positions.buffer,
      geometry.normals.buffer,
      geometry.matIndices.buffer,
      geometry.matWeights.buffer,
      geometry.indices.buffer,
      geometry.shadowPositions.buffer,
      geometry.shadowNormals.buffer,
      geometry.shadowIndices.buffer,
      ...(geometry.grass ? [geometry.grass.instances.buffer] : []),
    ]);
  } catch (error) {
    post({ type: "failed", jobId: message.jobId, message: error instanceof Error ? error.message : String(error) });
  }
};
