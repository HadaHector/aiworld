import { gjkDistance, support, type PointSet } from "./gjk";
import { heightfieldTriangles } from "./raycast";
import { boxCorners, type Box, type Convex, type Heightfield, type Shape } from "./shapes";
import { aabbOfPoints, cross, dot, length, lengthSq, madd, normalize, scale, sub, vec3, type Aabb, type Vec3 } from "./vec";

/** What asks - a character, a probe: a sphere, or a capsule from `a` to `b`. */
export type QueryShape = { kind: "sphere"; center: Vec3; radius: number } | { kind: "capsule"; a: Vec3; b: Vec3; radius: number };

/** How a query shape stands to a shape. */
export interface Separation {
  /** The gap between them - negative when they overlap, by how deep. */
  distance: number;
  /** The way out of the shape toward the querier: moving the querier along it by -distance parts them. */
  normal: Vec3;
  /** The point of the shape's surface nearest the querier (or deepest in it). */
  point: Vec3;
}

export function queryCore(q: QueryShape): PointSet {
  return q.kind === "sphere" ? [q.center] : [q.a, q.b];
}

export function queryBounds(q: QueryShape, pad = 0): Aabb {
  return aabbOfPoints(queryCore(q), q.radius + pad);
}

/** A shape as a hull of points and a radius around it - its core. */
function shapeCore(shape: Exclude<Shape, Heightfield>): { points: PointSet; radius: number } {
  switch (shape.kind) {
    case "sphere":
      return { points: [shape.center], radius: shape.radius };
    case "capsule":
      return { points: [shape.a, shape.b], radius: shape.radius };
    case "box":
      return { points: polytopeOf(shape).points, radius: 0 };
    case "convex":
      return { points: shape.points, radius: 0 };
  }
}

/** A polytope's face normals and edge directions: the axes it can be separated along. */
interface Polytope {
  points: PointSet;
  faces: Vec3[];
  edges: Vec3[];
}

const polytopes = new WeakMap<Shape, Polytope>();

function polytopeOf(shape: Box | Convex): Polytope {
  let poly = polytopes.get(shape);
  if (poly) return poly;
  if (shape.kind === "box") {
    poly = { points: boxCorners(shape), faces: shape.axes, edges: shape.axes };
  } else {
    const edges: Vec3[] = [];
    const t = shape.triangles;
    for (let i = 0; i < t.length; i += 3) {
      for (const [u, v] of [[t[i], t[i + 1]], [t[i + 1], t[i + 2]], [t[i + 2], t[i]]]) {
        const dir = normalize(sub(shape.points[v], shape.points[u]));
        if (!edges.some((e) => Math.abs(dot(e, dir)) > 1 - 1e-9)) edges.push(dir);
      }
    }
    poly = { points: shape.points, faces: shape.planes.map((p) => p.normal), edges };
  }
  polytopes.set(shape, poly);
  return poly;
}

/**
 * How deep a point or segment sits inside a polytope, and the shortest way out: the separating-axis
 * test, over the polytope's face normals and the crosses of its edges with the segment. Exact for
 * convex polytopes, which is why the cores' overlap is settled this way rather than by EPA.
 */
function satPenetration(core: PointSet, poly: Polytope): { normal: Vec3; depth: number } {
  const axes = [...poly.faces];
  if (core.length === 2) {
    const along = sub(core[1], core[0]);
    if (lengthSq(along) > 1e-18) {
      for (const e of poly.edges) {
        const c = cross(along, e);
        if (lengthSq(c) > 1e-12 * lengthSq(along)) axes.push(normalize(c));
      }
    }
  }
  let best = { normal: vec3(0, 1, 0), depth: Infinity };
  for (const axis of axes) {
    let qMin = Infinity, qMax = -Infinity, pMin = Infinity, pMax = -Infinity;
    for (const p of core) { const d = dot(p, axis); qMin = Math.min(qMin, d); qMax = Math.max(qMax, d); }
    for (const p of poly.points) { const d = dot(p, axis); pMin = Math.min(pMin, d); pMax = Math.max(pMax, d); }
    const up = pMax - qMin;
    const down = qMax - pMin;
    if (up < best.depth) best = { normal: axis, depth: up };
    if (down < best.depth) best = { normal: scale(axis, -1), depth: down };
  }
  return best;
}

/** A query shape against any shape but a heightfield. */
export function separate(q: QueryShape, shape: Exclude<Shape, Heightfield>): Separation {
  const qCore = queryCore(q);
  const core = shapeCore(shape);
  const g = gjkDistance(qCore, core.points);
  if (g.distance > 0) {
    const normal = scale(sub(g.onA, g.onB), 1 / g.distance);
    return { distance: g.distance - q.radius - core.radius, normal, point: madd(g.onB, normal, core.radius) };
  }
  // The cores themselves overlap.
  if (shape.kind === "sphere" || shape.kind === "capsule") {
    // Two segments that cross: out along their common perpendicular, either way.
    const qAlong = qCore.length === 2 ? sub(qCore[1], qCore[0]) : vec3(0, 1, 0);
    const sAlong = core.points.length === 2 ? sub(core.points[1], core.points[0]) : vec3(1, 0, 0);
    let normal = cross(qAlong, sAlong);
    if (lengthSq(normal) < 1e-18) normal = cross(qAlong, Math.abs(qAlong.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0));
    normal = normalize(normal);
    return { distance: -(q.radius + core.radius), normal, point: g.onB };
  }
  const pen = satPenetration(qCore, polytopeOf(shape));
  const deepest = support(qCore, scale(pen.normal, -1));
  return { distance: -(pen.depth + q.radius), normal: pen.normal, point: madd(deepest, pen.normal, pen.depth) };
}

/**
 * A query shape against one triangle of the ground, which is solid below it only: what is under
 * the ground is pushed up through the triangle's face, never down. `underGround` says whether a
 * point is below the ground as a whole - lacking it, below the triangle's face.
 */
export function separateTriangle(q: QueryShape, tri: readonly [Vec3, Vec3, Vec3], underGround?: (p: Vec3) => boolean): Separation {
  const qCore = queryCore(q);
  const up = normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
  const g = gjkDistance(qCore, tri);
  if (g.distance > 0) {
    const gap = sub(g.onA, g.onB);
    if (dot(gap, up) < 0 && (underGround ? underGround(g.onA) : insideTriangle(g.onB, tri))) {
      // Under the ground: out through the top, as far as it is under this face's plane.
      return { distance: -(q.radius - dot(up, sub(g.onA, tri[0]))), normal: up, point: g.onB };
    }
    return { distance: g.distance - q.radius, normal: scale(gap, 1 / g.distance), point: g.onB };
  }
  let lowest = Infinity;
  for (const p of qCore) lowest = Math.min(lowest, dot(up, sub(p, tri[0])));
  return { distance: -(q.radius + Math.max(0, -lowest)), normal: up, point: g.onB };
}

/** Whether a point on a triangle's plane lies inside it, clear of its edges. */
function insideTriangle(p: Vec3, [a, b, c]: readonly [Vec3, Vec3, Vec3]): boolean {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  const margin = 1e-6 * Math.max(length(sub(b, a)), length(sub(c, a)));
  // How far in from each edge, in the plane.
  const inFrom = (u: Vec3, v: Vec3): number => dot(cross(sub(v, u), sub(p, u)), n) / length(sub(v, u));
  return inFrom(a, b) > margin && inFrom(b, c) > margin && inFrom(c, a) > margin;
}

/** Each triangle of a heightfield whose cell's ground overlaps a box (holes left out). */
export function forEachFieldTriangle(field: Heightfield, box: Aabb, visit: (tri: [Vec3, Vec3, Vec3]) => void): void {
  const cells = field.columns - 1;
  const c0 = Math.max(0, Math.floor((box.min.x - field.originX) / field.cell));
  const c1 = Math.min(cells - 1, Math.floor((box.max.x - field.originX) / field.cell));
  const r0 = Math.max(0, Math.floor((box.min.z - field.originZ) / field.cell));
  const r1 = Math.min(field.rows - 2, Math.floor((box.max.z - field.originZ) / field.cell));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (field.holes && field.holes[row * cells + col]) continue;
      for (const tri of heightfieldTriangles(field, col, row)) visit(tri);
    }
  }
}
