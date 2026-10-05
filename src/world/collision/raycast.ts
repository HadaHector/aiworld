import { dirFromBoxFrame, dirToBoxFrame, heightfieldHeight, toBoxFrame, type Box, type Capsule, type Convex, type Heightfield, type Shape, type Sphere } from "./shapes";
import { cross, dot, inverseDirection, madd, normalize, rayAabb, scale, sub, vec3, type Vec3 } from "./vec";

/** Where a ray meets a shape: how far along it, and the surface's normal there, facing the ray. */
export interface RayContact {
  t: number;
  normal: Vec3;
}

/**
 * The first point a ray (`dir` of unit length) enters a shape, no further than `maxT`. A ray that
 * starts inside a shape never hits it - it can only leave - so a ray cast from within a bush, or
 * from a point on a wall, sees past it.
 */
export function rayShape(shape: Shape, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  switch (shape.kind) {
    case "sphere":
      return raySphere(shape, origin, dir, maxT);
    case "capsule":
      return rayCapsule(shape, origin, dir, maxT);
    case "box":
      return rayBox(shape, origin, dir, maxT);
    case "convex":
      return rayConvex(shape, origin, dir, maxT);
    case "heightfield":
      return rayHeightfield(shape, origin, dir, maxT);
  }
}

function raySphereAt(center: Vec3, radius: number, origin: Vec3, dir: Vec3, maxT: number): number | null {
  const m = sub(origin, center);
  const b = dot(m, dir);
  const c = dot(m, m) - radius * radius;
  if (c < 0 || b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxT ? t : null;
}

function raySphere(sphere: Sphere, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  const t = raySphereAt(sphere.center, sphere.radius, origin, dir, maxT);
  if (t === null) return null;
  return { t, normal: normalize(sub(madd(origin, dir, t), sphere.center)) };
}

function rayCapsule(capsule: Capsule, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  const { a, b, radius } = capsule;
  const ba = sub(b, a);
  const oa = sub(origin, a);
  const baba = dot(ba, ba);
  // Starting inside: no hit.
  const along = baba > 0 ? Math.min(1, Math.max(0, dot(oa, ba) / baba)) : 0;
  const offAxis = sub(oa, scale(ba, along));
  if (dot(offAxis, offAxis) < radius * radius) return null;

  let best: RayContact | null = null;
  // The round side: the infinite cylinder, kept only between the ends.
  if (baba > 0) {
    const bard = dot(ba, dir);
    const baoa = dot(ba, oa);
    const k2 = baba - bard * bard;
    const k1 = baba * dot(oa, dir) - baoa * bard;
    const k0 = baba * dot(oa, oa) - baoa * baoa - radius * radius * baba;
    const h = k1 * k1 - k2 * k0;
    if (k2 > 1e-12 && h >= 0) {
      const t = (-k1 - Math.sqrt(h)) / k2;
      const y = baoa + t * bard;
      if (t >= 0 && t <= maxT && y > 0 && y < baba) {
        const p = madd(origin, dir, t);
        best = { t, normal: normalize(sub(sub(p, a), scale(ba, y / baba))) };
      }
    }
  }
  // The round ends.
  for (const end of [a, b]) {
    const t = raySphereAt(end, radius, origin, dir, best ? best.t : maxT);
    if (t !== null && (!best || t < best.t)) best = { t, normal: normalize(sub(madd(origin, dir, t), end)) };
  }
  return best;
}

function rayBox(box: Box, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  const o = toBoxFrame(box, origin);
  const d = dirToBoxFrame(box, dir);
  if (Math.abs(o.x) < box.half.x && Math.abs(o.y) < box.half.y && Math.abs(o.z) < box.half.z) return null;
  let enter = -Infinity;
  let exit = Infinity;
  let normal = vec3();
  for (const axis of ["x", "y", "z"] as const) {
    const h = box.half[axis];
    if (Math.abs(d[axis]) < 1e-12) {
      if (o[axis] < -h || o[axis] > h) return null;
      continue;
    }
    const inv = 1 / d[axis];
    let near = (-h - o[axis]) * inv;
    let far = (h - o[axis]) * inv;
    let sign = -1;
    if (near > far) { [near, far] = [far, near]; sign = 1; }
    if (near > enter) { enter = near; normal = vec3(); normal[axis] = sign; }
    if (far < exit) exit = far;
    if (enter > exit) return null;
  }
  if (enter < 0 || enter > maxT) return null;
  return { t: enter, normal: dirFromBoxFrame(box, normal) };
}

function rayConvex(shape: Convex, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  let enter = -Infinity;
  let exit = Infinity;
  let normal = vec3();
  for (const plane of shape.planes) {
    const dist = dot(plane.normal, origin) - plane.d;
    const denom = dot(plane.normal, dir);
    if (Math.abs(denom) < 1e-12) {
      if (dist > 0) return null;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > enter) { enter = t; normal = plane.normal; }
    } else if (t < exit) {
      exit = t;
    }
    if (enter > exit) return null;
  }
  // No plane it comes in through, or one behind it: it starts inside.
  if (enter < 0 || enter > maxT) return null;
  return { t: enter, normal: { ...normal } };
}

/** A ray against one triangle, from its front (counter-clockwise seen from where the ray comes). */
function rayTriangle(p0: Vec3, p1: Vec3, p2: Vec3, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  const e1 = sub(p1, p0);
  const e2 = sub(p2, p0);
  const n = cross(e1, e2);
  if (dot(n, dir) >= 0) return null;
  const pv = cross(dir, e2);
  const det = dot(e1, pv);
  const inv = 1 / det;
  const tv = sub(origin, p0);
  const u = dot(tv, pv) * inv;
  if (u < 0 || u > 1) return null;
  const qv = cross(tv, e1);
  const v = dot(dir, qv) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, qv) * inv;
  if (t < 0 || t > maxT) return null;
  return { t, normal: normalize(n) };
}

/** A heightfield cell's two triangles, upward facing, in the world. */
export function heightfieldTriangles(field: Heightfield, col: number, row: number): [Vec3, Vec3, Vec3][] {
  const corner = (c: number, r: number): Vec3 =>
    vec3(field.originX + (col + c) * field.cell, field.heights[(row + r) * field.columns + col + c], field.originZ + (row + r) * field.cell);
  const p00 = corner(0, 0), p10 = corner(1, 0), p11 = corner(1, 1), p01 = corner(0, 1);
  // Wound so each faces up (+y), split along (0,0)-(1,1) as heightfieldHeight is.
  return [[p00, p11, p10], [p00, p01, p11]];
}

/** Walks the cells under the ray in order, and tests each cell's two triangles. */
function rayHeightfield(field: Heightfield, origin: Vec3, dir: Vec3, maxT: number): RayContact | null {
  // Starting under the ground: no hit.
  const under = heightfieldHeight(field, origin.x, origin.z);
  if (under !== null && origin.y < under) return null;
  const tStart = rayAabb(origin, inverseDirection(dir), field.bounds, maxT);
  if (tStart === Infinity) return null;
  const start = madd(origin, dir, tStart);
  const cells = field.columns - 1;
  let col = Math.min(Math.max(Math.floor((start.x - field.originX) / field.cell), 0), cells - 1);
  let row = Math.min(Math.max(Math.floor((start.z - field.originZ) / field.cell), 0), field.rows - 2);
  const stepX = dir.x > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;
  const deltaX = dir.x !== 0 ? field.cell / Math.abs(dir.x) : Infinity;
  const deltaZ = dir.z !== 0 ? field.cell / Math.abs(dir.z) : Infinity;
  const nextBoundary = (p: number, origin0: number, cell: number, d: number): number => {
    if (d === 0) return Infinity;
    const edge = origin0 + (cell + (d > 0 ? 1 : 0)) * field.cell;
    return (edge - p) / d;
  };
  let tMaxX = tStart + nextBoundary(start.x, field.originX, col, dir.x);
  let tMaxZ = tStart + nextBoundary(start.z, field.originZ, row, dir.z);
  for (;;) {
    if (!field.holes || !field.holes[row * cells + col]) {
      let best: RayContact | null = null;
      for (const [p0, p1, p2] of heightfieldTriangles(field, col, row)) {
        const hit = rayTriangle(p0, p1, p2, origin, dir, best ? best.t : maxT);
        if (hit) best = hit;
      }
      if (best) return best;
    }
    if (Math.min(tMaxX, tMaxZ) > maxT) return null;
    if (tMaxX < tMaxZ) {
      col += stepX;
      if (col < 0 || col >= cells) return null;
      tMaxX += deltaX;
    } else {
      row += stepZ;
      if (row < 0 || row >= field.rows - 1) return null;
      tMaxZ += deltaZ;
    }
  }
}
