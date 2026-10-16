import type { LightBakeRequest, LightBakeResponse } from "./lightBake.worker";
import { trackBuffers } from "../../debug/memoryTracker";

/** How many houses bake at once - few, so they never crowd out the chunks being built. */
const WORKERS = 2;

export interface LightBakePool {
  /** Bakes a house's lights; of those waiting, the one whose `priority` is lowest (the nearest)
   *  goes next, asked as a worker comes free. */
  bake(request: Omit<LightBakeRequest, "id">, priority: () => number): Promise<LightBakeResponse>;
  /** Stops the workers; bakes not done yet never finish. */
  dispose(): void;
}

interface Job {
  request: LightBakeRequest;
  priority: () => number;
  resolve: (response: LightBakeResponse) => void;
  reject: (error: Error) => void;
}

/** A few workers baking houses' lights (lightBake.worker.ts), started on the first bake. */
export function createLightBakePool(): LightBakePool {
  let workers: Worker[] | null = null;
  const idle: Worker[] = [];
  const waiting: Job[] = [];
  const running = new Map<number, Job>();
  let nextId = 0;

  const start = (): void => {
    workers = Array.from({ length: WORKERS }, () => {
      const worker = new Worker(new URL("./lightBake.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<LightBakeResponse>): void => {
        // Cloned in from the worker, so no constructor here saw them made.
        trackBuffers("house lightmaps (from workers)", event.data.half, event.data.uvs);
        const job = running.get(event.data.id);
        running.delete(event.data.id);
        idle.push(worker);
        job?.resolve(event.data);
        dispatch();
      };
      worker.onerror = (event): void => {
        for (const job of running.values()) job.reject(new Error(`Light bake worker failed: ${event.message}`));
        running.clear();
      };
      return worker;
    });
    idle.push(...workers);
  };

  const dispatch = (): void => {
    while (idle.length > 0 && waiting.length > 0) {
      let best = 0;
      let bestPriority = Infinity;
      waiting.forEach((job, i) => {
        const priority = job.priority();
        if (priority < bestPriority) {
          bestPriority = priority;
          best = i;
        }
      });
      const [job] = waiting.splice(best, 1);
      const worker = idle.pop()!;
      running.set(job.request.id, job);
      const { positions, normals, indices, layers } = job.request;
      worker.postMessage(job.request, [positions.buffer, normals.buffer, indices.buffer, layers.buffer]);
    }
  };

  return {
    bake(request, priority) {
      if (!workers) start();
      return new Promise((resolve, reject) => {
        waiting.push({ request: { ...request, id: nextId++ }, priority, resolve, reject });
        dispatch();
      });
    },
    dispose() {
      for (const worker of workers ?? []) worker.terminate();
      workers = null;
      idle.length = 0;
      waiting.length = 0;
      running.clear();
    },
  };
}
