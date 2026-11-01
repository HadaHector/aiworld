import type { BodyRecipe } from "./bodyMake";
import type { BodyGeometry } from "./bodyMesh";
import type { AtlasLayout } from "./atlas";
import type { PaintBase } from "./paint";
import type { BuildRequest, BuildResponse } from "./bodyBuild.worker";

/**
 * A few workers that build bodies (bodyBuild.worker.ts), a body to a worker at a time, the rest
 * waiting. Made when the first body is asked for; if they cannot be made, or one fails, `buildInWorker`
 * answers null from then on and the page builds in place.
 */
const MAX_WORKERS = 3;

interface Job {
  request: BuildRequest;
  resolve: (made: BuildResponse | null) => void;
}

interface Slot {
  worker: Worker;
  busy: Job | null;
  /** The material bakes it has been sent. */
  sent: Set<string>;
}

let slots: Slot[] | null = null;
let broken = typeof Worker === "undefined";
const queue: Job[] = [];
let nextId = 1;

function start(): Slot[] {
  const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 4) - 2));
  return Array.from({ length: count }, () => {
    const worker = new Worker(new URL("./bodyBuild.worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { worker, busy: null, sent: new Set() };
    worker.onmessage = (event: MessageEvent<BuildResponse>): void => {
      const job = slot.busy;
      slot.busy = null;
      job?.resolve(event.data);
      pump();
    };
    worker.onerror = (): void => fail();
    return slot;
  });
}

/** Gives up on workers: everything waiting, and anything later, is built in place. */
function fail(): void {
  broken = true;
  for (const slot of slots ?? []) {
    slot.busy?.resolve(null);
    slot.busy = null;
    slot.worker.terminate();
  }
  slots = null;
  for (const job of queue.splice(0)) job.resolve(null);
}

function pump(): void {
  if (!slots) return;
  for (const slot of slots) {
    const job = slot.busy ? undefined : queue.shift();
    if (!job) continue;
    slot.busy = job;
    // A bake the worker has not been sent goes with the request; one it has, as its key alone.
    job.request.materials = job.request.materials.map((m) => {
      const first = !slot.sent.has(m.key);
      slot.sent.add(m.key);
      return { ...m, color: first ? m.color : null };
    });
    slot.worker.postMessage(job.request);
  }
}

/** What a worker made of a recipe: null when there are no workers (or they failed) and the page
 *  should build it itself. */
export async function buildInWorker(recipe: BodyRecipe, race: BodyRecipe["race"], materials: { key: string; size: number; color: Uint8Array; id?: string }[]): Promise<{ body: BodyGeometry; layout: AtlasLayout | null; base: PaintBase | null } | null> {
  if (broken) return null;
  try {
    slots ??= start();
  } catch {
    fail();
    return null;
  }
  const request: BuildRequest = { id: nextId++, recipe, race, materials: materials.map((m) => ({ id: m.id ?? "", key: m.key, size: m.size, color: m.color })) };
  const response = await new Promise<BuildResponse | null>((resolve) => {
    queue.push({ request, resolve });
    pump();
  });
  if (!response || response.error || !response.body) return null;
  return { body: response.body, layout: response.layout ?? null, base: response.base ?? null };
}
