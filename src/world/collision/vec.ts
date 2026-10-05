// The little vector maths the collision system runs on - kept here so the system needs nothing from
// Babylon, and runs the same in Node probes and workers.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A rotation, as a unit quaternion. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
/** a + b * s */
export const madd = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));
export const distanceSq = (a: Vec3, b: Vec3): number => lengthSq(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}

export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quatAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(angle / 2);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) };
}

/** a then b: rotating by the result is rotating by `b`, then by `a`. */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Yaw about Y, then pitch about X, then roll about Z - as Babylon's rotation.y/x/z do. */
export function quatFromEuler(yaw: number, pitch = 0, roll = 0): Quat {
  return quatMul(quatAxisAngle({ x: 0, y: 1, z: 0 }, yaw), quatMul(quatAxisAngle({ x: 1, y: 0, z: 0 }, pitch), quatAxisAngle({ x: 0, y: 0, z: 1 }, roll)));
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  // v + 2w(q × v) + 2(q × (q × v))
  const u = { x: q.x, y: q.y, z: q.z };
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}

export function emptyAabb(): Aabb {
  return { min: vec3(Infinity, Infinity, Infinity), max: vec3(-Infinity, -Infinity, -Infinity) };
}

export function aabbOfPoints(points: readonly Vec3[], pad = 0): Aabb {
  const box = emptyAabb();
  for (const p of points) aabbAddPoint(box, p);
  return aabbPad(box, pad);
}

export function aabbAddPoint(box: Aabb, p: Vec3): void {
  box.min.x = Math.min(box.min.x, p.x); box.min.y = Math.min(box.min.y, p.y); box.min.z = Math.min(box.min.z, p.z);
  box.max.x = Math.max(box.max.x, p.x); box.max.y = Math.max(box.max.y, p.y); box.max.z = Math.max(box.max.z, p.z);
}

export function aabbPad(box: Aabb, pad: number): Aabb {
  return { min: vec3(box.min.x - pad, box.min.y - pad, box.min.z - pad), max: vec3(box.max.x + pad, box.max.y + pad, box.max.z + pad) };
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return {
    min: vec3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
    max: vec3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
  };
}

export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

/** Where a ray (with `inv` = 1 / its direction, per axis) enters the box, if it does before
 *  `maxT` - 0 if it starts inside - or Infinity if it misses. */
export function rayAabb(origin: Vec3, inv: Vec3, box: Aabb, maxT: number): number {
  let t0 = 0;
  let t1 = maxT;
  for (const axis of ["x", "y", "z"] as const) {
    let near = (box.min[axis] - origin[axis]) * inv[axis];
    let far = (box.max[axis] - origin[axis]) * inv[axis];
    // 0 * Infinity: the ray runs along a face's plane - in the slab if it lies within it.
    if (Number.isNaN(near) || Number.isNaN(far)) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return Infinity;
      continue;
    }
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

export function inverseDirection(dir: Vec3): Vec3 {
  return { x: 1 / dir.x, y: 1 / dir.y, z: 1 / dir.z };
}
