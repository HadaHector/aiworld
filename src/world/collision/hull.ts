import { cross, dot, length, normalize, scale, sub, type Vec3 } from "./vec";

/** A face's plane: the points p with dot(normal, p) = d; outside is where it is greater. */
export interface Plane {
  normal: Vec3;
  d: number;
}

export interface Hull {
  /** The hull's corners - the points given, less any inside it. */
  points: Vec3[];
  /** Its faces as triangles, wound counter-clockwise seen from outside, by index into `points`. */
  triangles: number[];
  /** One plane per flat side - triangles in the same plane share it. */
  planes: Plane[];
}

interface Face {
  a: number;
  b: number;
  c: number;
  normal: Vec3;
  d: number;
  alive: boolean;
}

/**
 * The convex hull of some points, built a point at a time: each point outside the hull so far
 * removes the faces it sees and closes the hole with faces to itself. Quadratic, which is plenty for
 * the handful of points a collider has. Throws if the points have no volume (all in one plane).
 */
export function convexHull(input: readonly Vec3[]): Hull {
  if (input.length < 4) throw new Error("A convex shape needs at least 4 points");
  let extent = 0;
  for (const p of input) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  const eps = Math.max(extent, 1) * 1e-9;

  // A first tetrahedron from points far apart.
  let i0 = 0, i1 = 0;
  for (let i = 1; i < input.length; i++) {
    if (input[i].x < input[i0].x) i0 = i;
    if (input[i].x > input[i1].x) i1 = i;
  }
  if (i0 === i1) i1 = input.findIndex((p) => length(sub(p, input[i0])) > eps);
  if (i1 < 0) throw new Error("A convex shape's points are all the same point");
  const axis = sub(input[i1], input[i0]);
  let i2 = -1, best = eps;
  for (let i = 0; i < input.length; i++) {
    const off = length(cross(axis, sub(input[i], input[i0])));
    if (off > best) { best = off; i2 = i; }
  }
  if (i2 < 0) throw new Error("A convex shape's points are all in one line");
  const baseNormal = cross(sub(input[i1], input[i0]), sub(input[i2], input[i0]));
  let i3 = -1;
  best = eps * length(baseNormal);
  for (let i = 0; i < input.length; i++) {
    const off = Math.abs(dot(baseNormal, sub(input[i], input[i0])));
    if (off > best) { best = off; i3 = i; }
  }
  if (i3 < 0) throw new Error("A convex shape's points are all in one plane");

  const faces: Face[] = [];
  const edgeFace = new Map<string, number>();
  const key = (a: number, b: number): string => `${a},${b}`;
  function addFace(a: number, b: number, c: number): void {
    const n = cross(sub(input[b], input[a]), sub(input[c], input[a]));
    const normal = normalize(n);
    faces.push({ a, b, c, normal, d: dot(normal, input[a]), alive: true });
    const f = faces.length - 1;
    edgeFace.set(key(a, b), f); edgeFace.set(key(b, c), f); edgeFace.set(key(c, a), f);
  }
  // Wind the tetrahedron so its fourth point is behind the first face.
  if (dot(baseNormal, sub(input[i3], input[i0])) > 0) {
    addFace(i0, i2, i1); addFace(i0, i1, i3); addFace(i1, i2, i3); addFace(i2, i0, i3);
  } else {
    addFace(i0, i1, i2); addFace(i0, i3, i1); addFace(i1, i3, i2); addFace(i2, i3, i0);
  }

  const used = new Set([i0, i1, i2, i3]);
  for (let p = 0; p < input.length; p++) {
    if (used.has(p)) continue;
    const point = input[p];
    const visible: number[] = [];
    for (let f = 0; f < faces.length; f++) {
      if (faces[f].alive && dot(faces[f].normal, point) - faces[f].d > eps) visible.push(f);
    }
    if (visible.length === 0) continue;
    const seen = new Set(visible);
    // The horizon: edges of seen faces whose other side is a face not seen.
    const horizon: [number, number][] = [];
    for (const f of visible) {
      const { a, b, c } = faces[f];
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const other = edgeFace.get(key(v, u));
        if (other === undefined || !seen.has(other)) horizon.push([u, v]);
      }
    }
    for (const f of visible) {
      const { a, b, c } = faces[f];
      faces[f].alive = false;
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) if (edgeFace.get(key(u, v)) === f) edgeFace.delete(key(u, v));
    }
    for (const [u, v] of horizon) addFace(u, v, p);
    used.add(p);
  }

  // Keep only the corners still on a face, renumbered.
  const alive = faces.filter((f) => f.alive);
  const remap = new Map<number, number>();
  const points: Vec3[] = [];
  const triangles: number[] = [];
  for (const f of alive) {
    for (const i of [f.a, f.b, f.c]) {
      if (!remap.has(i)) { remap.set(i, points.length); points.push({ ...input[i] }); }
      triangles.push(remap.get(i)!);
    }
  }
  const planes: Plane[] = [];
  const planeEps = Math.max(extent, 1) * 1e-6;
  for (const f of alive) {
    if (!planes.some((q) => dot(q.normal, f.normal) > 1 - 1e-9 && Math.abs(q.d - f.d) < planeEps)) planes.push({ normal: scale(f.normal, 1), d: f.d });
  }
  return { points, triangles, planes };
}
