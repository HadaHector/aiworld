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
}

export type HeightfieldSplit = "diagonal" | "centre";

export type ShapeDesc = SphereDesc | CapsuleDesc | BoxDesc | ConvexDesc | HeightfieldDesc;

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
}

export type Shape = Sphere | Capsule | Box | Convex | Heightfield;

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
      let high = -Infinity;
      for (const h of heights) high = Math.max(high, h);
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
        bounds: {
          // All the way down: everything under the ground is in it.
          min: vec3(desc.originX, -Infinity, desc.originZ),
          max: vec3(desc.originX + (desc.columns - 1) * desc.cell, high, desc.originZ + (desc.rows - 1) * desc.cell),
        },
      };
    }
  }
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
    case "heightfield": {
      const h = heightfieldHeight(shape, p.x, p.z);
      return h !== null && p.y < h;
    }
  }
}
