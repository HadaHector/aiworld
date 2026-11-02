import type { ChunkBuildRequest, ChunkGeometry } from "./chunkGeometry";
import type { ChunkWorkerMessage, ChunkWorkerResponse } from "./chunkBuild.worker";
import type { WorldContent } from "../content/worldContent";
import type { MapColors } from "../../map/maker";
import { trackBuffers, typedArraysOf } from "../../debug/memoryTracker";

/**
 * Walking around needs a few chunks a second, and each worker holds its own copy of the world
 * (see chunkBuild.worker.ts), so a couple is plenty - more buys faster catch-up after a teleport
 * or a draw-distance change at the cost of that memory.
 */
const WORKER_COUNT = 2;

export interface ChunkBuildPool {
  /** Resolves once every worker has built its world and can take jobs. */
  ready: Promise<void>;
  /** How many builds can usefully be in flight at once - enough to keep every worker busy
   *  without queueing so far ahead that a job is stale by the time it runs. */
  capacity: number;
  build: (request: ChunkBuildRequest) => Promise<ChunkGeometry>;
  /** Hands every worker the materials' average colours (see ChunkBuildContext.groundColors). */
  setGroundColors: (colors: [number, number, number][]) => void;
  /** Hands every worker the rest of the map's colours (see map/maker.ts); tiles can be asked for after. */
  setMapColors: (colors: Omit<MapColors, "ground">) => void;
  /** A map tile's pixels (MAP.md), drawn behind any chunks in a worker. */
  buildMapTile: (tx: number, tz: number) => Promise<Uint8ClampedArray>;
  dispose: () => void;
}

interface PendingJob {
  resolve: (geometry: ChunkGeometry) => void;
  reject: (error: Error) => void;
}

/**
 * Builds terrain chunks across a few workers. Returns null if workers cannot be created here, and
 * the chunk manager then builds on the main thread as before.
 *
 * Jobs go to whichever worker has the fewest outstanding, so a slow full-detail chunk does not
 * hold up the coarse ones queued behind it on the same worker.
 */
export function createChunkBuildPool(seed: number, content: WorldContent): ChunkBuildPool | null {
  let workers: Worker[];
  try {
    workers = Array.from(
      { length: WORKER_COUNT },
      () => new Worker(new URL("./chunkBuild.worker.ts", import.meta.url), { type: "module" }),
    );
  } catch {
    return null;
  }

  const pending = new Map<number, PendingJob>();
  const mapPending = new Map<number, { resolve: (pixels: Uint8ClampedArray) => void; reject: (error: Error) => void }>();
  const outstanding = new Map<Worker, number>(workers.map((worker) => [worker, 0]));
  let nextJobId = 0;

  const ready = Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve, reject) => {
          worker.onerror = (event): void => reject(new Error(`Chunk build worker failed: ${event.message}`));
          worker.onmessage = (event: MessageEvent<ChunkWorkerResponse>): void => {
            const response = event.data;
            if (response.type === "ready") {
              resolve();
              return;
            }
            if (response.type === "mapTile" || response.type === "mapFailed") {
              const job = mapPending.get(response.jobId);
              mapPending.delete(response.jobId);
              if (response.type === "mapTile") job?.resolve(response.pixels);
              else job?.reject(new Error(response.message));
              return;
            }
            outstanding.set(worker, outstanding.get(worker)! - 1);
            const job = pending.get(response.jobId);
            pending.delete(response.jobId);
            if (response.type === "built") {
              // Cloned in from the worker, so no constructor here saw them made.
              trackBuffers("chunk geometry (from workers)", ...typedArraysOf(response.geometry));
              job?.resolve(response.geometry);
            }
            else job?.reject(new Error(response.message));
          };
          const init: ChunkWorkerMessage = { type: "init", seed, content };
          worker.postMessage(init);
        }),
    ),
  ).then(() => undefined);

  function build(request: ChunkBuildRequest): Promise<ChunkGeometry> {
    let target = workers[0];
    for (const worker of workers) {
      if (outstanding.get(worker)! < outstanding.get(target)!) target = worker;
    }
    outstanding.set(target, outstanding.get(target)! + 1);
    const jobId = nextJobId++;
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject });
      const message: ChunkWorkerMessage = { type: "build", jobId, request };
      target.postMessage(message);
    });
  }

  function setGroundColors(colors: [number, number, number][]): void {
    const message: ChunkWorkerMessage = { type: "groundColors", colors };
    for (const worker of workers) worker.postMessage(message);
  }

  function setMapColors(colors: Omit<MapColors, "ground">): void {
    const message: ChunkWorkerMessage = { type: "mapColors", colors };
    for (const worker of workers) worker.postMessage(message);
  }

  /** Map tiles take turns between the workers. */
  let nextMapWorker = 0;
  function buildMapTile(tx: number, tz: number): Promise<Uint8ClampedArray> {
    const jobId = nextJobId++;
    const worker = workers[nextMapWorker++ % workers.length];
    return new Promise((resolve, reject) => {
      mapPending.set(jobId, { resolve, reject });
      const message: ChunkWorkerMessage = { type: "mapTile", jobId, tx, tz };
      worker.postMessage(message);
    });
  }

  function dispose(): void {
    for (const worker of workers) worker.terminate();
    for (const job of pending.values()) job.reject(new Error("Chunk build pool disposed"));
    pending.clear();
    for (const job of mapPending.values()) job.reject(new Error("Chunk build pool disposed"));
    mapPending.clear();
  }

  return { ready, capacity: WORKER_COUNT * 2, build, setGroundColors, setMapColors, buildMapTile, dispose };
}
