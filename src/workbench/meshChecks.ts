// Checks on a mesh's own buffers (SHOTS.md, the report): what is wrong with a generated model that a
// picture shows only if you know where to look. Pure functions - positions and indices in, counts out.

export interface MeshFacts {
  triangles: number;
  vertices: number;
  /** Triangles with (near) no area. */
  degenerate: number;
  /** Triangles on the same three points as another, facing the same way (one is drawn twice). */
  duplicates: number;
  /** Triangles in the same plane as another, facing the same way and overlapping it, but not the same
   *  triangle: z-fighting. */
  coplanar: number;
  /** Edges with one triangle (holes, or a sheet's rim) and with more than two (non-manifold). */
  openEdges: number;
  nonManifold: number;
  /** Triangles whose winding disagrees with their vertex normals, against the mesh's own majority. */
  flipped: number;
  /** Pieces, connected by shared points. */
  pieces: number;
}

/** A piece clear of every other piece: a part floating off the rest. */
export interface FloatingPiece {
  triangles: number;
  gap: number;
  at: [number, number, number];
}

/** Points closer than this are one point. */
const WELD = 1e-4;
/** A gap this wide or wider between a piece and the rest is floating. */
const FLOAT_GAP = 0.01;

const key3 = (x: number, y: number, z: number): string => `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;

export function checkMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, normals?: ArrayLike<number> | null): MeshFacts {
  const triCount = Math.floor(indices.length / 3);
  // Welded point ids: generated meshes split vertices at seams, so topology goes by position.
  const weld = new Map<string, number>();
  const pointOf = new Int32Array(positions.length / 3);
  for (let v = 0; v < pointOf.length; v++) {
    const k = key3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    let id = weld.get(k);
    if (id === undefined) weld.set(k, (id = weld.size));
    pointOf[v] = id;
  }

  let degenerate = 0;
  let duplicates = 0;
  let flipped = 0;
  let agree = 0;
  const seen = new Set<string>();
  const edges = new Map<string, number>();
  const faceNormal = new Float32Array(triCount * 3);
  const planes = new Map<string, number[]>();
  const p = (v: number, i: number): number => positions[v * 3 + i];

  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2);
    const vx = p(c, 0) - p(a, 0), vy = p(c, 1) - p(a, 1), vz = p(c, 2) - p(a, 2);
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    const pa = pointOf[a], pb = pointOf[b], pc = pointOf[c];
    if (area2 < 1e-9 || pa === pb || pb === pc || pa === pc) {
      degenerate++;
      continue;
    }
    faceNormal[t * 3] = nx / area2;
    faceNormal[t * 3 + 1] = ny / area2;
    faceNormal[t * 3 + 2] = nz / area2;
    // The same points in the same turn, wherever it starts.
    const turn = [pa, pb, pc];
    const lowest = turn.indexOf(Math.min(pa, pb, pc));
    const face = `${turn[lowest]},${turn[(lowest + 1) % 3]},${turn[(lowest + 2) % 3]}`;
    if (seen.has(face)) duplicates++;
    else seen.add(face);
    for (const [i, j] of [[pa, pb], [pb, pc], [pc, pa]]) {
      const e = i < j ? `${i},${j}` : `${j},${i}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
    if (normals) {
      const vn = [a, b, c].reduce((sum, v) => sum + normals[v * 3] * nx + normals[v * 3 + 1] * ny + normals[v * 3 + 2] * nz, 0);
      if (vn < 0) flipped++;
      else if (vn > 0) agree++;
    }
    // Plane buckets for the coplanar check: normal to 1/50, distance to 2 mm.
    const ux_ = faceNormal[t * 3], uy_ = faceNormal[t * 3 + 1], uz_ = faceNormal[t * 3 + 2];
    const d = ux_ * p(a, 0) + uy_ * p(a, 1) + uz_ * p(a, 2);
    const plane = `${Math.round(ux_ * 50)},${Math.round(uy_ * 50)},${Math.round(uz_ * 50)},${Math.round(d / 0.002)}`;
    const list = planes.get(plane);
    if (list) list.push(t);
    else planes.set(plane, [t]);
  }
  // Against the majority: a mesh wound the other way throughout is a convention, not a fault.
  if (flipped > agree) flipped = agree;

  let openEdges = 0;
  let nonManifold = 0;
  for (const count of edges.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifold++;
  }

  const coplanar = countCoplanar(planes, positions, indices, pointOf, faceNormal);
  const { pieces } = findFloating(positions, indices, pointOf, triCount);
  return { triangles: triCount, vertices: positions.length / 3, degenerate, duplicates, coplanar, openEdges, nonManifold, flipped, pieces };
}

/** Triangles in one plane bucket that overlap another there without being the same triangle. */
function countCoplanar(planes: Map<string, number[]>, positions: ArrayLike<number>, indices: ArrayLike<number>, pointOf: Int32Array, normal: Float32Array): number {
  const hit = new Set<number>();
  for (const list of planes.values()) {
    if (list.length < 2 || list.length > 400) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = list[i];
        const t = list[j];
        // Neighbours in one surface share points; overlap means one's centre inside the other.
        const ps = [pointOf[indices[s * 3]], pointOf[indices[s * 3 + 1]], pointOf[indices[s * 3 + 2]]];
        const pt = [pointOf[indices[t * 3]], pointOf[indices[t * 3 + 1]], pointOf[indices[t * 3 + 2]]];
        if (ps.filter((x) => pt.includes(x)).length === 3) continue;
        if (insideTriangle(centre(positions, indices, s), positions, indices, t, normal) || insideTriangle(centre(positions, indices, t), positions, indices, s, normal)) {
          hit.add(s);
          hit.add(t);
        }
      }
    }
  }
  return hit.size;
}

function centre(positions: ArrayLike<number>, indices: ArrayLike<number>, t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) out[i] += positions[indices[t * 3 + k] * 3 + i] / 3;
  return out;
}

/** Whether a point (in the triangle's plane) is inside it, short of its edges. */
function insideTriangle(q: [number, number, number], positions: ArrayLike<number>, indices: ArrayLike<number>, t: number, normal: Float32Array): boolean {
  const n = [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]];
  for (let k = 0; k < 3; k++) {
    const a = indices[t * 3 + k] * 3;
    const b = indices[t * 3 + ((k + 1) % 3)] * 3;
    const ex = positions[b] - positions[a], ey = positions[b + 1] - positions[a + 1], ez = positions[b + 2] - positions[a + 2];
    const qx = q[0] - positions[a], qy = q[1] - positions[a + 1], qz = q[2] - positions[a + 2];
    // (e x q) . n: which side of the edge.
    const side = (ey * qz - ez * qy) * n[0] + (ez * qx - ex * qz) * n[1] + (ex * qy - ey * qx) * n[2];
    if (side <= 1e-7) return false;
  }
  return true;
}

/** The pieces of a whole figure (all its meshes, posed, in one space) standing clear of every other. */
export function floatingPieces(positions: ArrayLike<number>, indices: ArrayLike<number>): FloatingPiece[] {
  const pointOf = new Int32Array(positions.length / 3);
  const weld = new Map<string, number>();
  for (let v = 0; v < pointOf.length; v++) {
    const k = key3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    let id = weld.get(k);
    if (id === undefined) weld.set(k, (id = weld.size));
    pointOf[v] = id;
  }
  return findFloating(positions, indices, pointOf, Math.floor(indices.length / 3)).floating;
}

/** Connected pieces, and those whose box stands clear of every other piece's box. */
function findFloating(positions: ArrayLike<number>, indices: ArrayLike<number>, pointOf: Int32Array, triCount: number): { pieces: number; floating: FloatingPiece[] } {
  const parent = new Int32Array(pointOf.reduce((m, x) => Math.max(m, x), -1) + 1).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < triCount; t++) {
    const a = find(pointOf[indices[t * 3]]);
    parent[find(pointOf[indices[t * 3 + 1]])] = a;
    parent[find(pointOf[indices[t * 3 + 2]])] = a;
  }
  const boxes = new Map<number, { min: number[]; max: number[]; triangles: number }>();
  for (let t = 0; t < triCount; t++) {
    const root = find(pointOf[indices[t * 3]]);
    let box = boxes.get(root);
    if (!box) boxes.set(root, (box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], triangles: 0 }));
    box.triangles++;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k] * 3;
      for (let i = 0; i < 3; i++) {
        box.min[i] = Math.min(box.min[i], positions[v + i]);
        box.max[i] = Math.max(box.max[i], positions[v + i]);
      }
    }
  }
  const list = [...boxes.values()];
  const floating: FloatingPiece[] = [];
  if (list.length > 1 && list.length <= 2000) {
    // The biggest piece is the body the rest float off, never the one floating.
    const body = list.reduce((a, b) => (b.triangles > a.triangles ? b : a));
    for (const box of list) {
      if (box === body) continue;
      let gap = Infinity;
      for (const other of list) {
        if (other === box) continue;
        let g = 0;
        for (let i = 0; i < 3; i++) g = Math.max(g, other.min[i] - box.max[i], box.min[i] - other.max[i]);
        gap = Math.min(gap, g);
      }
      if (gap >= FLOAT_GAP) floating.push({ triangles: box.triangles, gap, at: [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2) as [number, number, number] });
    }
  }
  return { pieces: list.length, floating };
}

/** A short hash of a mesh's data, for "same seed, same mesh". */
export function hashArrays(arrays: ArrayLike<number>[]): string {
  let h = 2166136261;
  for (const array of arrays) {
    for (let i = 0; i < array.length; i++) {
      // Rounded to 1e-5 so float noise in the last bit does not count.
      h ^= Math.round(array[i] * 1e5) | 0;
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
