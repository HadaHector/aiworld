import type { ColorTuple } from "../../world/terrain/pipeline/pipelineTypes";
import { withVariant, type BeastDef } from "./beastDef";
import { buildBeast, type BeastGeometry } from "./beastBuild";
import { paintBeast, type PaintedBeast } from "./beastPaint";
import { bakeGaits, type BakedGaits } from "./beastAnim";
import { sliceBreak } from "../workSlicer";
import type { BeastRequest, BeastResponse } from "./beastBuild.worker";

/**
 * A beast's making (BEASTS.md, *Performance*): its body, its painted atlas and card texture, and its
 * gaits baked - all plain numbers from plain data, so a worker makes it and the page only draws it.
 * Kept by plan, variant, seed, traits, tint and atlas size, so a pack of one kind seen again (or many
 * beasts sharing a look) costs nothing; bounded, least recently used out first.
 */
export interface MadeBeast {
  /** The plan as its variant has it. */
  def: BeastDef;
  body: BeastGeometry;
  painted: PaintedBeast;
  baked: BakedGaits;
}

export interface BeastRecipe {
  variant: string;
  seed: number;
  traits: string[];
  /** The kind's colour, for a variant the plan has no palette for. */
  tint?: ColorTuple;
  atlas: number;
}

/** Makes it, with no waiting: what a worker does, and the page when there are none. */
export function makeBeastNow(def: BeastDef, recipe: BeastRecipe): MadeBeast {
  const shaped = withVariant(def, recipe.variant);
  const tint = recipe.variant && !def.variants.has(recipe.variant) ? recipe.tint : undefined;
  const body = buildBeast(shaped, { seed: recipe.seed, traits: recipe.traits, atlas: recipe.atlas });
  const painted = paintBeast(shaped, body, { seed: recipe.seed, tint });
  const baked = bakeGaits(shaped, body);
  return { def: shaped, body, painted, baked };
}

// ---- The cache.
const CACHE_LIMIT = 64;
const cache = new Map<string, Promise<MadeBeast>>();
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
const stats = { made: 0, hits: 0, inWorker: 0, inPage: 0, ms: 0 };

function keyOf(def: BeastDef, recipe: BeastRecipe): string {
  let id = identities.get(def);
  if (!id) identities.set(def, (id = nextIdentity++));
  return [def.id, id, recipe.variant, recipe.seed, [...recipe.traits].sort().join("+"), recipe.tint?.map((c) => c.toFixed(3)).join(",") ?? "", recipe.atlas].join("|");
}

/** A beast made, from the cache or a worker (or the page, sliced, when there are no workers). */
export function makeBeast(def: BeastDef, recipe: BeastRecipe): Promise<MadeBeast> {
  const key = keyOf(def, recipe);
  const found = cache.get(key);
  if (found) {
    stats.hits++;
    cache.delete(key);
    cache.set(key, found);
    return found;
  }
  const started = performance.now();
  const made = (async (): Promise<MadeBeast> => {
    const fromWorker = await makeInWorker(def, recipe);
    if (fromWorker) {
      stats.inWorker++;
      return fromWorker;
    }
    stats.inPage++;
    // In place: a slice for the body, one for the paint, one for the gaits.
    await sliceBreak();
    const shaped = withVariant(def, recipe.variant);
    const tint = recipe.variant && !def.variants.has(recipe.variant) ? recipe.tint : undefined;
    const body = buildBeast(shaped, { seed: recipe.seed, traits: recipe.traits, atlas: recipe.atlas });
    await sliceBreak();
    const painted = paintBeast(shaped, body, { seed: recipe.seed, tint });
    await sliceBreak();
    return { def: shaped, body, painted, baked: bakeGaits(shaped, body) };
  })();
  made.then(() => {
    stats.made++;
    stats.ms += performance.now() - started;
  }, () => cache.delete(key));
  cache.set(key, made);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return made;
}

export function beastCacheStats(): typeof stats & { kept: number } {
  return { ...stats, kept: cache.size };
}

export function clearBeastCache(): void {
  cache.clear();
}

// ---- The workers.
const MAX_WORKERS = 2;
interface Slot {
  worker: Worker;
  busy: { request: BeastRequest; resolve: (r: BeastResponse | null) => void } | null;
}
let slots: Slot[] | null = null;
let broken = typeof Worker === "undefined";
const queue: { request: BeastRequest; resolve: (r: BeastResponse | null) => void }[] = [];
let nextId = 1;

function start(): Slot[] {
  const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 4) - 3));
  return Array.from({ length: count }, () => {
    const worker = new Worker(new URL("./beastBuild.worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { worker, busy: null };
    worker.onmessage = (event: MessageEvent<BeastResponse>): void => {
      const job = slot.busy;
      slot.busy = null;
      job?.resolve(event.data);
      pump();
    };
    worker.onerror = (): void => fail();
    return slot;
  });
}

function fail(): void {
  broken = true;
  for (const slot of slots ?? []) {
    slot.busy?.resolve(null);
    slot.worker.terminate();
  }
  slots = null;
  for (const job of queue.splice(0)) job.resolve(null);
}

function pump(): void {
  if (!slots) return;
  for (const slot of slots) {
    if (slot.busy) continue;
    const job = queue.shift();
    if (!job) return;
    slot.busy = job;
    slot.worker.postMessage(job.request);
  }
}

async function makeInWorker(def: BeastDef, recipe: BeastRecipe): Promise<MadeBeast | null> {
  if (broken) return null;
  try {
    slots ??= start();
  } catch {
    fail();
    return null;
  }
  const request: BeastRequest = { id: nextId++, def, recipe };
  const response = await new Promise<BeastResponse | null>((resolve) => {
    queue.push({ request, resolve });
    pump();
  });
  if (!response || response.error || !response.made) return null;
  return response.made;
}
