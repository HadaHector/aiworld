import { buildAabbTree, type AabbTree } from "./aabbTree";
import { forEachFieldTriangle, queryBounds, separate, separateTriangle, type QueryShape, type Separation } from "./narrowphase";
import { rayShape } from "./raycast";
import { collisionStats } from "./stats";
import { createShape, DEFAULT_LAYERS, heightfieldHeight, type Shape, type ShapeDesc } from "./shapes";
import { aabbOverlaps, aabbUnion, add, dot, emptyAabb, inverseDirection, length, madd, rayAabb, scale, type Aabb, type Vec3 } from "./vec";

/** Where a ray first met something. */
export interface RayHit {
  /** How far along the ray. */
  distance: number;
  point: Vec3;
  /** The surface's normal there, facing back along the ray. */
  normal: Vec3;
  shape: Shape;
}

/** A query shape overlapping a shape. */
export interface Contact {
  shape: Shape;
  /** The way out of the shape. */
  normal: Vec3;
  /** How far along `normal` the querier must move to be clear of it. */
  depth: number;
  /** The shape's surface point deepest in the querier. */
  point: Vec3;
}

/** The nearest shape to a query shape. */
export interface Nearest extends Separation {
  shape: Shape;
}

/** Where a moving sphere or capsule first touches something. */
export interface SweepHit extends Separation {
  shape: Shape;
  /** How far it got along the move before touching. */
  distance: number;
  /** The same, as a fraction of the whole move. */
  fraction: number;
  /** It was already overlapping at the start: `distance` is 0, `normal` the way out. */
  startedInside: boolean;
}

/** How close counts as touching, for a sweep. */
export const SWEEP_TOLERANCE = 1e-4;
const MAX_ADVANCES = 48;

/** Shapes added and removed together - a chunk, a settlement - with a tree of their own. */
interface Batch {
  shapes: Shape[];
  /** Over every shape but the heightfields, which are searched cell by cell instead. */
  tree: AabbTree;
  treeShapes: Shape[];
  fields: Shape[];
  bounds: Aabb;
}

export interface CollisionWorld {
  /** Adds shapes that stay put until removed together; returns the batch's id. */
  addBatch(descs: readonly ShapeDesc[]): number;
  removeBatch(batch: number): void;
  /** The shapes a batch was made of. */
  batchShapes(batch: number): readonly Shape[];
  /** One shape on its own - one that will move, or come and go. Returns its id. */
  add(desc: ShapeDesc): number;
  /** Removes a shape added on its own. */
  remove(shape: number): void;
  shape(id: number): Shape | undefined;
  /** The first shape on any of `mask`'s layers a ray enters, within `maxDistance`. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, mask?: number): RayHit | null;
  /** Whether a ray enters anything on `mask`'s layers within `maxDistance` - a line of sight. */
  raycastAny(origin: Vec3, direction: Vec3, maxDistance: number, mask?: number): boolean;
  /** Every shape on `mask`'s layers whose bounds overlap `box`. */
  forEachShapeInBounds(box: Aabb, mask: number, visit: (shape: Shape) => void): void;
  /** Every shape on `mask`'s layers a sphere or capsule is inside of, and the way out of each. */
  overlap(query: QueryShape, mask?: number): Contact[];
  /**
   * The shape on `mask`'s layers nearest a sphere or capsule, within `maxDistance` - with the gap,
   * negative if it overlaps - or null if none is that near.
   */
  nearest(query: QueryShape, maxDistance: number, mask?: number): Nearest | null;
  /**
   * Moves a sphere or capsule along `delta` and reports the first shape on `mask`'s layers it
   * touches, or null if it moves the whole way clear.
   */
  sweep(query: QueryShape, delta: Vec3, mask?: number): SweepHit | null;
  /** How a query shape stands to each shape near it (within `pad`), heightfields as triangles. */
  forEachSeparation(query: QueryShape, pad: number, mask: number, visit: (shape: Shape, separation: Separation) => void): void;
}

export function translateQuery(q: QueryShape, by: Vec3): QueryShape {
  return q.kind === "sphere" ? { ...q, center: add(q.center, by) } : { ...q, a: add(q.a, by), b: add(q.b, by) };
}

export function createCollisionWorld(): CollisionWorld {
  let nextShape = 1;
  let nextBatch = 1;
  const batches = new Map<number, Batch>();
  const shapes = new Map<number, Shape>();
  /** Shapes added one at a time; few, so searched one by one. */
  const loose = new Map<number, Shape>();

  function addBatch(descs: readonly ShapeDesc[]): number {
    const started = performance.now();
    const made = descs.map((desc) => createShape(desc, nextShape++));
    for (const s of made) shapes.set(s.id, s);
    const treeShapes = made.filter((s) => s.kind !== "heightfield");
    const fields = made.filter((s) => s.kind === "heightfield");
    let bounds = emptyAabb();
    for (const s of made) bounds = aabbUnion(bounds, s.bounds);
    const id = nextBatch++;
    batches.set(id, { shapes: made, tree: buildAabbTree(treeShapes.map((s) => s.bounds)), treeShapes, fields, bounds });
    collisionStats.batchesAdded++;
    collisionStats.batchMs += performance.now() - started;
    return id;
  }

  function removeBatch(id: number): void {
    const batch = batches.get(id);
    if (!batch) return;
    for (const s of batch.shapes) shapes.delete(s.id);
    batches.delete(id);
  }

  function add(desc: ShapeDesc): number {
    const s = createShape(desc, nextShape++);
    shapes.set(s.id, s);
    loose.set(s.id, s);
    return s.id;
  }

  function remove(id: number): void {
    if (loose.delete(id)) shapes.delete(id);
  }

  /**
   * Every shape a ray might enter, nearer batches' and nodes' first; `visit` returns how far the ray
   * may still reach, or a negative number to stop.
   */
  function walkRay(origin: Vec3, dir: Vec3, maxT: number, mask: number, visit: (shape: Shape, maxT: number) => number): void {
    const inv = inverseDirection(dir);
    let reach = maxT;
    const test = (s: Shape): boolean => {
      if (!(s.layers & mask)) return true;
      if (rayAabb(origin, inv, s.bounds, reach) === Infinity) return true;
      reach = visit(s, reach);
      return reach >= 0;
    };
    for (const s of loose.values()) if (!test(s)) return;
    for (const batch of batches.values()) {
      if (rayAabb(origin, inv, batch.bounds, reach) === Infinity) continue;
      for (const s of batch.fields) if (!test(s)) return;
      let stopped = false;
      batch.tree.raycast(origin, inv, reach, (item, treeReach) => {
        const s = batch.treeShapes[item];
        if (!(s.layers & mask)) return treeReach;
        reach = visit(s, Math.min(reach, treeReach));
        if (reach < 0) stopped = true;
        return reach;
      });
      if (stopped) return;
    }
  }

  function raycast(origin: Vec3, direction: Vec3, maxDistance: number, mask = DEFAULT_LAYERS): RayHit | null {
    collisionStats.rays++;
    const l = length(direction);
    if (l === 0) return null;
    const dir = scale(direction, 1 / l);
    let best: RayHit | null = null;
    walkRay(origin, dir, maxDistance, mask, (s, reach) => {
      const hit = rayShape(s, origin, dir, reach);
      if (!hit) return reach;
      best = { distance: hit.t, point: madd(origin, dir, hit.t), normal: hit.normal, shape: s };
      return hit.t;
    });
    return best;
  }

  function raycastAny(origin: Vec3, direction: Vec3, maxDistance: number, mask = DEFAULT_LAYERS): boolean {
    collisionStats.rays++;
    const l = length(direction);
    if (l === 0) return false;
    const dir = scale(direction, 1 / l);
    let found = false;
    walkRay(origin, dir, maxDistance, mask, (s, reach) => {
      if (!rayShape(s, origin, dir, reach)) return reach;
      found = true;
      return -1;
    });
    return found;
  }

  function forEachShapeInBounds(box: Aabb, mask: number, visit: (shape: Shape) => void): void {
    for (const s of loose.values()) if (s.layers & mask && aabbOverlaps(s.bounds, box)) visit(s);
    for (const batch of batches.values()) {
      if (!aabbOverlaps(batch.bounds, box)) continue;
      for (const s of batch.fields) if (s.layers & mask && aabbOverlaps(s.bounds, box)) visit(s);
      batch.tree.query(box, (item) => {
        const s = batch.treeShapes[item];
        if (s.layers & mask) visit(s);
      });
    }
  }

  function forEachSeparation(query: QueryShape, pad: number, mask: number, visit: (shape: Shape, separation: Separation) => void): void {
    const box = queryBounds(query, pad);
    forEachShapeInBounds(box, mask, (s) => {
      if (s.kind === "heightfield") {
        const under = (p: Vec3): boolean => {
          const h = heightfieldHeight(s, p.x, p.z);
          return h !== null && p.y < h;
        };
        forEachFieldTriangle(s, box, (tri) => {
          collisionStats.pairs++;
          visit(s, separateTriangle(query, tri, under));
        });
      }
      else {
        collisionStats.pairs++;
        visit(s, separate(query, s));
      }
    });
  }

  function overlap(query: QueryShape, mask = DEFAULT_LAYERS): Contact[] {
    collisionStats.overlaps++;
    const contacts: Contact[] = [];
    forEachSeparation(query, 0, mask, (shape, sep) => {
      if (sep.distance < 0) contacts.push({ shape, normal: sep.normal, depth: -sep.distance, point: sep.point });
    });
    return contacts;
  }

  function nearest(query: QueryShape, maxDistance: number, mask = DEFAULT_LAYERS): Nearest | null {
    collisionStats.nearests++;
    let best: Nearest | null = null;
    forEachSeparation(query, maxDistance, mask, (shape, sep) => {
      if (sep.distance <= maxDistance && (!best || sep.distance < best.distance)) best = { ...sep, shape };
    });
    return best;
  }

  /**
   * Conservative advancement: move by the gap over the speed toward the shape, again and again,
   * until within tolerance - never past a contact, since a convex gap shrinks no faster than that.
   */
  function sweep(query: QueryShape, delta: Vec3, mask = DEFAULT_LAYERS): SweepHit | null {
    collisionStats.sweeps++;
    const total = length(delta);
    const startBox = queryBounds(query, SWEEP_TOLERANCE);
    const endBox = queryBounds(translateQuery(query, delta), SWEEP_TOLERANCE);
    const box = aabbUnion(startBox, endBox);
    const dir = total > 0 ? scale(delta, 1 / total) : delta;
    let best: SweepHit | null = null;

    const advance = (shape: Shape, separation: (q: QueryShape) => Separation): void => {
      collisionStats.pairs++;
      let t = 0;
      for (let i = 0; i < MAX_ADVANCES; i++) {
        collisionStats.advances++;
        const sep = separation(t === 0 ? query : translateQuery(query, scale(dir, t)));
        const closing = -dot(sep.normal, dir);
        // Touching at the start but moving along it or away: it never gets in the way.
        if (t === 0 && sep.distance >= 0 && sep.distance <= SWEEP_TOLERANCE && closing <= 1e-9) return;
        if (sep.distance <= SWEEP_TOLERANCE) {
          const startedInside = t === 0 && sep.distance < 0;
          if (!best || t < best.distance) {
            best = { ...sep, shape, distance: t, fraction: total > 0 ? t / total : 0, startedInside };
          }
          return;
        }
        if (closing <= 1e-9) return;
        t += (sep.distance - SWEEP_TOLERANCE / 2) / closing;
        if (t > total || (best && t >= best.distance)) return;
      }
    };

    forEachShapeInBounds(box, mask, (s) => {
      if (s.kind === "heightfield") {
        const under = (p: Vec3): boolean => {
          const h = heightfieldHeight(s, p.x, p.z);
          return h !== null && p.y < h;
        };
        forEachFieldTriangle(s, box, (tri) => advance(s, (q) => separateTriangle(q, tri, under)));
      } else {
        advance(s, (q) => separate(q, s));
      }
    });
    return best;
  }

  return { addBatch, batchShapes: (id) => batches.get(id)?.shapes ?? [], sweep, removeBatch, add, remove, shape: (id) => shapes.get(id), raycast, raycastAny, forEachShapeInBounds, overlap, nearest, forEachSeparation };
}
