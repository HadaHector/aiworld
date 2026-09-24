import type { ChunkBuildRequest, ChunkGeometry } from "./chunkGeometry";
import type { ChunkWorkerMessage, ChunkWorkerResponse } from "./chunkBuild.worker";

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
export function createChunkBuildPool(seed: number): ChunkBuildPool | null {
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
            outstanding.set(worker, outstanding.get(worker)! - 1);
            const job = pending.get(response.jobId);
            pending.delete(response.jobId);
            if (response.type === "built") job?.resolve(response.geometry);
            else job?.reject(new Error(response.message));
          };
          const init: ChunkWorkerMessage = { type: "init", seed };
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

  function dispose(): void {
    for (const worker of workers) worker.terminate();
    for (const job of pending.values()) job.reject(new Error("Chunk build pool disposed"));
    pending.clear();
  }

  return { ready, capacity: WORKER_COUNT * 2, build, dispose };
}
