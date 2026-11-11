import { buildAabbTree, type AabbTree } from "./aabbTree";
import { convexHull, hullOfTriangles, type Plane } from "./hull";
import { aabbOfPoints, add, dot, IDENTITY, length, madd, rotate, sub, vec3, type Aabb, type Quat, type Vec3 } from "./vec";

/**
 * What a shape stands in the way of - a bit mask - and what a query looks for. A hedge might
 * block sight but not movement; a pane of glass, movement but not sight.
 */
export const Layers = {
  /** Stops a moving character. */
  solid: 1 << 0,
  /** Stops a line of sight. */
  sight: 1 << 1,
  /** Stops a shot. */
  shot: 1 << 2,
  /** May be walked on - a floor, as navigation sees it. */
  walkable: 1 << 3,
} as const;

export type LayerName = keyof typeof Layers;

/** What a shape is unless told otherwise: in the way of everything. */
export const DEFAULT_LAYERS = Layers.solid | Layers.sight | Layers.shot;

export function layerMask(names: readonly LayerName[]): number {
  return names.reduce((mask, name) => mask | Layers[name], 0);
}

// ---------------------------------------------------------------------------------------------
// What a caller describes.

interface DescBase {
  layers?: number;
  /** What the shape is part of - a house, a tree - reported with every hit on it. */
  group?: number;
}

export interface SphereDesc extends DescBase {
  kind: "sphere";
  center: Vec3;
  radius: number;
}

/** A segment from `a` to `b`, thickened by `radius`: a cylinder with round ends. */
export interface CapsuleDesc extends DescBase {
  kind: "capsule";
  a: Vec3;
  b: Vec3;
  radius: number;
}

export interface BoxDesc extends DescBase {
  kind: "box";
  center: Vec3;
  /** Half its size along each of its own axes. */
  half: Vec3;
  rotation?: Quat;
}

export interface ConvexDesc extends DescBase {
  kind: "convex";
  /** Any points; the shape is their hull. They must have volume. */
  points: Vec3[];
  /**
   * When the points are already a hull - every one a corner - its faces as triangles, wound
   * counter-clockwise seen from outside: the hull is not worked out again. A hull moved, turned or
   * scaled evenly is still one, with the same triangles, which is what makes this worth having.
   */
  triangles?: ArrayLike<number>;
}

/**
 * Ground as a grid of heights: `heights[row * columns + col]` stands at
 * (originX + col * cell, originZ + row * cell). Each cell is two triangles, split along the
 * diagonal from its (col, row) corner to its (col + 1, row + 1) corner - or, `split: "centre"`,
 * four, meeting at its middle at the average of its corners' heights (as the game's terrain is
 * drawn). A cell can be left out (a hole) - say under a cellar.
 */
export interface HeightfieldDesc extends DescBase {
  kind: "heightfield";
  originX: number;
  originZ: number;
  cell: number;
  columns: number;
  rows: number;
  heights: Float32Array | number[];
  /** One per cell ((columns - 1) * (rows - 1)), 1 where the cell is a hole. */
  holes?: Uint8Array;
  split?: HeightfieldSplit;
  /**
   * How far under its surface the ground is solid - a slab, open below, so a cave under it is not
   * in the ground. Lacking it, all the way down: everything under the ground is in it.
   */
  depth?: number;
}

/**
 * Triangles as a one-sided surface: each faces (counter-clockwise seen from) the open side, and
 * what lies behind it is solid - a cave's rock. Anything behind a face is pushed out through it.
 */
export interface MeshDesc extends DescBase {
  kind: "mesh";
  /** x, y, z of each vertex. */
  positions: Float32Array | number[];
  /** Three vertex indices a triangle. */
  indices: Uint32Array | number[];
  /**
   * Whether a point is in the solid - say a cave's distance field. Lacking it, the faces say: a
   * point is in when the first face straight above it is one it sees from behind (`behindMesh`),
   * right for any surface closed above, as a cave's is.
   */
  inside?: (p: Vec3) => boolean;
}

export type HeightfieldSplit = "diagonal" | "centre";

export type ShapeDesc = SphereDesc | CapsuleDesc | BoxDesc | ConvexDesc | HeightfieldDesc | MeshDesc;

// ---------------------------------------------------------------------------------------------
// What the world keeps: the description, worked out for queries.

interface ShapeBase {
  id: number;
  layers: number;
  group: number;
  bounds: Aabb;
}

export interface Sphere extends ShapeBase {
  kind: "sphere";
  center: Vec3;
  radius: number;
}

export interface Capsule extends ShapeBase {
  kind: "capsule";
  a: Vec3;
  b: Vec3;
  radius: number;
}

export interface Box extends ShapeBase {
  kind: "box";
  center: Vec3;
  half: Vec3;
  rotation: Quat;
  /** Its own x, y and z axes in the world. */
  axes: [Vec3, Vec3, Vec3];
}

export interface Convex extends ShapeBase {
  kind: "convex";
  points: Vec3[];
  triangles: number[];
  planes: Plane[];
}

export interface Heightfield extends ShapeBase {
  kind: "heightfield";
  originX: number;
  originZ: number;
  cell: number;
  columns: number;
  rows: number;
  heights: Float32Array;
  holes: Uint8Array | null;
  split: HeightfieldSplit;
  /** Infinity: solid all the way down. */
  depth: number;
}

export interface TriangleMesh extends ShapeBase {
  kind: "mesh";
  positions: Float32Array;
  /** The triangles kept (none without area), three indices each. */
  indices: Uint32Array;
  /** Over the triangles, numbered by their place in `indices` (triangle t at 3t). */
  tree: AabbTree;
  inside: ((p: Vec3) => boolean) | null;
}

export type Shape = Sphere | Capsule | Box | Convex | Heightfield | TriangleMesh;

export function createShape(desc: ShapeDesc, id: number): Shape {
  const base = { id, layers: desc.layers ?? DEFAULT_LAYERS, group: desc.group ?? -1 };
  switch (desc.kind) {
    case "sphere":
      return { ...base, kind: "sphere", center: { ...desc.center }, radius: desc.radius, bounds: aabbOfPoints([desc.center], desc.radius) };
    case "capsule":
      return { ...base, kind: "capsule", a: { ...desc.a }, b: { ...desc.b }, radius: desc.radius, bounds: aabbOfPoints([desc.a, desc.b], desc.radius) };
    case "box": {
      const rotation = desc.rotation ?? IDENTITY;
      const axes: [Vec3, Vec3, Vec3] = [rotate(rotation, vec3(1, 0, 0)), rotate(rotation, vec3(0, 1, 0)), rotate(rotation, vec3(0, 0, 1))];
      const box: Box = { ...base, kind: "box", center: { ...desc.center }, half: { ...desc.half }, rotation, axes, bounds: aabbOfPoints([]) };
      box.bounds = aabbOfPoints(boxCorners(box));
      return box;
    }
    case "convex": {
      const hull = desc.triangles ? hullOfTriangles(desc.points, desc.triangles) : convexHull(desc.points);
      return { ...base, kind: "convex", points: hull.points, triangles: hull.triangles, planes: hull.planes, bounds: aabbOfPoints(hull.points) };
    }
    case "heightfield": {
      const heights = Float32Array.from(desc.heights);
      if (heights.length !== desc.columns * desc.rows) throw new Error("A heightfield needs columns * rows heights");
      const depth = desc.depth ?? Infinity;
      if (!(depth > 0)) throw new Error("A heightfield's depth must be above 0");
      let high = -Infinity, low = Infinity;
      for (const h of heights) { high = Math.max(high, h); low = Math.min(low, h); }
      return {
        ...base,
        kind: "heightfield",
        originX: desc.originX,
        originZ: desc.originZ,
        cell: desc.cell,
        columns: desc.columns,
        rows: desc.rows,
        heights,
        holes: desc.holes ?? null,
        split: desc.split ?? "diagonal",
        depth,
        bounds: {
          // Down to its depth - all the way, lacking one.
          min: vec3(desc.originX, low - depth, desc.originZ),
          max: vec3(desc.originX + (desc.columns - 1) * desc.cell, high, desc.originZ + (desc.rows - 1) * desc.cell),
        },
      };
    }
    case "mesh":
      return createTriangleMesh(desc, base);
  }
}

function createTriangleMesh(desc: MeshDesc, base: { id: number; layers: number; group: number }): TriangleMesh {
  const positions = Float32Array.from(desc.positions);
  const all = desc.indices;
  if (all.length % 3 !== 0) throw new Error("A mesh needs three indices a triangle");
  const kept: number[] = [];
  const boxes: Aabb[] = [];
  for (let t = 0; t < all.length; t += 3) {
    const a = all[t] * 3, b = all[t + 1] * 3, c = all[t + 2] * 3;
    if (Math.max(a, b, c) + 2 >= positions.length) throw new Error("A mesh's index is past its positions");
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    // No area: no face to be behind, nothing to push out through.
    if (nx * nx + ny * ny + nz * nz < 1e-18) continue;
    kept.push(all[t], all[t + 1], all[t + 2]);
    boxes.push({
      min: vec3(Math.min(positions[a], positions[b], positions[c]), Math.min(positions[a + 1], positions[b + 1], positions[c + 1]), Math.min(positions[a + 2], positions[b + 2], positions[c + 2])),
      max: vec3(Math.max(positions[a], positions[b], positions[c]), Math.max(positions[a + 1], positions[b + 1], positions[c + 1]), Math.max(positions[a + 2], positions[b + 2], positions[c + 2])),
    });
  }
  const tree = buildAabbTree(boxes);
  return { ...base, kind: "mesh", positions, indices: Uint32Array.from(kept), tree, inside: desc.inside ?? null, bounds: boxes.length > 0 ? tree.bounds : aabbOfPoints([]) };
}

/** A mesh's triangle `t` (its place in the tree), as three points. */
export function meshTriangle(mesh: TriangleMesh, t: number): [Vec3, Vec3, Vec3] {
  const p = mesh.positions, i = mesh.indices;
  const a = i[3 * t] * 3, b = i[3 * t + 1] * 3, c = i[3 * t + 2] * 3;
  return [vec3(p[a], p[a + 1], p[a + 2]), vec3(p[b], p[b + 1], p[b + 2]), vec3(p[c], p[c + 1], p[c + 2])];
}

/** Whether a point is in a heightfield's ground: under its surface, above its depth. */
export function inHeightfield(field: Heightfield, p: Vec3): boolean {
  const h = heightfieldHeight(field, p.x, p.z);
  return h !== null && p.y < h && p.y > h - field.depth;
}

export function boxCorners(box: Box): Vec3[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    let p = madd(box.center, box.axes[0], sx * box.half.x);
    p = madd(p, box.axes[1], sy * box.half.y);
    corners.push(madd(p, box.axes[2], sz * box.half.z));
  }
  return corners;
}

/** A point given in the world, in a box's own frame (its centre the origin). */
export function toBoxFrame(box: Box, p: Vec3): Vec3 {
  const d = sub(p, box.center);
  return vec3(dot(d, box.axes[0]), dot(d, box.axes[1]), dot(d, box.axes[2]));
}

/** A direction given in the world, in a box's own frame. */
export function dirToBoxFrame(box: Box, d: Vec3): Vec3 {
  return vec3(dot(d, box.axes[0]), dot(d, box.axes[1]), dot(d, box.axes[2]));
}

/** A direction given in a box's own frame, in the world. */
export function dirFromBoxFrame(box: Box, d: Vec3): Vec3 {
  return add(add(madd(vec3(), box.axes[0], d.x), madd(vec3(), box.axes[1], d.y)), madd(vec3(), box.axes[2], d.z));
}

/** The point on a segment closest to p, as how far along it (0 at a, 1 at b). */
export function segmentParam(a: Vec3, b: Vec3, p: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  return l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
}

/** A heightfield's height at a point, or null if the point is off it or over a hole. */
export function heightfieldHeight(field: Heightfield, x: number, z: number): number | null {
  const fx = (x - field.originX) / field.cell;
  const fz = (z - field.originZ) / field.cell;
  if (fx < 0 || fz < 0 || fx > field.columns - 1 || fz > field.rows - 1) return null;
  const col = Math.min(Math.floor(fx), field.columns - 2);
  const row = Math.min(Math.floor(fz), field.rows - 2);
  if (field.holes && field.holes[row * (field.columns - 1) + col]) return null;
  const u = fx - col, v = fz - row;
  const h = (c: number, r: number): number => field.heights[(row + r) * field.columns + col + c];
  if (field.split === "centre") {
    // Four triangles about the middle: whichever quarter the point is in, between two corners and it.
    const mid = (h(0, 0) + h(1, 0) + h(0, 1) + h(1, 1)) / 4;
    const below = v < u, belowOther = v < 1 - u;
    const [c0, c1] = below && belowOther ? [[0, 0], [1, 0]] : !below && !belowOther ? [[1, 1], [0, 1]] : below ? [[1, 0], [1, 1]] : [[0, 1], [0, 0]];
    return planeHeight([c0[0], c0[1], h(c0[0], c0[1])], [c1[0], c1[1], h(c1[0], c1[1])], [0.5, 0.5, mid], u, v);
  }
  // Split along (0,0)-(1,1): below it (u > v) the triangle (0,0),(1,0),(1,1); above, (0,0),(1,1),(0,1).
  return u > v ? h(0, 0) + u * (h(1, 0) - h(0, 0)) + v * (h(1, 1) - h(1, 0)) : h(0, 0) + v * (h(0, 1) - h(0, 0)) + u * (h(1, 1) - h(0, 1));
}

/** The height at (u, v) of the plane through three (u, v, height) points. */
function planeHeight(a: number[], b: number[], c: number[], u: number, v: number): number {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nh = e1[0] * e2[1] - e1[1] * e2[0];
  return a[2] - (nx * (u - a[0]) + ny * (v - a[1])) / nh;
}

/** Whether a point is inside a shape - under the ground, for a heightfield. */
export function containsPoint(shape: Shape, p: Vec3): boolean {
  switch (shape.kind) {
    case "sphere":
      return length(sub(p, shape.center)) < shape.radius;
    case "capsule": {
      const t = segmentParam(shape.a, shape.b, p);
      return length(sub(p, madd(shape.a, sub(shape.b, shape.a), t))) < shape.radius;
    }
    case "box": {
      const local = toBoxFrame(shape, p);
      return Math.abs(local.x) < shape.half.x && Math.abs(local.y) < shape.half.y && Math.abs(local.z) < shape.half.z;
    }
    case "convex":
      return shape.planes.every((plane) => dot(plane.normal, p) < plane.d);
    case "heightfield":
      return inHeightfield(shape, p);
    case "mesh":
      return shape.inside ? shape.inside(p) : behindMesh(shape, p);
  }
}

/**
 * Whether a point is behind a mesh's surface, lacking a test of its own: the first face straight
 * above it, whichever way it faces, is one it sees from behind. Right for any surface closed above.
 */
export function behindMesh(mesh: TriangleMesh, p: Vec3): boolean {
  let nearest = Infinity, behind = false;
  const column = { min: vec3(p.x, p.y, p.z), max: vec3(p.x, Math.max(p.y, mesh.bounds.max.y), p.z) };
  mesh.tree.query(column, (t) => {
    const [a, b, c] = meshTriangle(mesh, t);
    // Where the vertical line through p crosses the triangle, if it does: barycentrics in x and z.
    const d = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
    if (Math.abs(d) < 1e-15) return;
    const u = ((p.x - a.x) * (c.z - a.z) - (c.x - a.x) * (p.z - a.z)) / d;
    const v = ((b.x - a.x) * (p.z - a.z) - (p.x - a.x) * (b.z - a.z)) / d;
    if (u < 0 || v < 0 || u + v > 1) return;
    const y = a.y + u * (b.y - a.y) + v * (c.y - a.y);
    if (y < p.y || y >= nearest) return;
    nearest = y;
    // The normal's y is -d (cross of the edges, x-z part), so d < 0 faces up: p is under its back.
    behind = d < 0;
  });
  return behind;
}
