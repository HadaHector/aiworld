import { createTerrainSampler } from "./terrainSampler";
import { createMaterialBlender } from "../materials/materialBlend";
import { createTreeScatter } from "../foliage/treeScatter";
import { buildChunkGeometry, type ChunkBuildContext, type ChunkBuildRequest, type ChunkGeometry } from "./chunkGeometry";

/**
 * Builds terrain chunks off the main thread.
 *
 * The worker builds its own copy of the world from the seed - the terrain sampler, the material
 * blender, the tree scatter - rather than being sent one: the sampler is closures, not data, and
 * rebuilding it takes a few seconds once, at load, in parallel with everything else. Everything in
 * it is deterministic from the seed, so a chunk comes out identical to one built on the main thread.
 */
export type ChunkWorkerMessage =
  | { type: "init"; seed: number }
  | { type: "groundColors"; colors: [number, number, number][] }
  | { type: "build"; jobId: number; request: ChunkBuildRequest };

export type ChunkWorkerResponse =
  | { type: "ready" }
  | { type: "built"; jobId: number; geometry: ChunkGeometry }
  | { type: "failed"; jobId: number; message: string };

let context: ChunkBuildContext | null = null;

function post(response: ChunkWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(response, transfer);
}

self.onmessage = (event: MessageEvent<ChunkWorkerMessage>): void => {
  const message = event.data;
  if (message.type === "init") {
    context = {
      sampleTerrain: createTerrainSampler(message.seed).sampleTerrain,
      materialBlender: createMaterialBlender(message.seed),
      scatterTrees: createTreeScatter(message.seed),
      seed: message.seed,
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
