import type { ModelLight } from "../buildings/buildingTypes";

/** What the bake needs of a model: its geometry, and what each vertex is made of (a slot into
 *  `materials`, -1 plain) - a BuildingModel is one, and so is a mesh's own vertex data. */
export interface BakeModel {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  materialSlots: ArrayLike<number>;
  materials: string[];
}

/**
 * A house's own lights baked into a lightmap, shadows and all (see LIGHTS.md): every face that a
 * light can reach gets a patch of texels of its own, laid flat in the face's plane and packed into
 * one atlas; each texel's light is worked out by rays from its point on the face to points across
 * each light, against the house's own triangles. Pure arithmetic over the model - no engine - so it
 * can run in a worker.
 */

/** Texels a metre: a texel 25 cm, fine enough for the oversized world. */
export const LIGHTMAP_DENSITY = 4;
/** Texels round each patch, baked from its face's edge, so filtering never reads its neighbour. */
const GUTTER = 1;
/** How far off its face a texel's ray starts, so it does not hit the face it starts from. */
const LIFT = 0.02;
/** Points across a light's source (a unit ball, scaled by its size) rays are cast to: the first
 *  few always, the rest only where those disagree - a shadow's soft edge. */
const SOURCE_POINTS = sourcePoints(16);
const FIRST_POINTS = 4;
/** A patch no brighter than this anywhere is dark; one varying less than this share of its
 *  brightest is even, and kept as one texel. */
const DARK = 0.004;
const EVEN = 0.04;

/** The light at a point `distance` from a light: its full strength at it, half a third of the way
 *  to its radius, and exactly nothing at its radius. */
export function falloff(light: { intensity: number; radius: number }, distance: number): number {
  const reach = Math.max(0, 1 - (distance / light.radius) ** 4);
  const far = (3 * distance) / light.radius;
  return (light.intensity * reach * reach) / (1 + far * far);
}

/** A lightmap's texels as half floats, as the GPU takes them. */
export function halfTexels(texels: Float32Array): Uint16Array {
  const half = new Uint16Array(texels.length);
  const f = new Float32Array(1);
  const bits = new Uint32Array(f.buffer);
  for (let i = 0; i < texels.length; i++) {
    f[0] = texels[i];
    const b = bits[0];
    const sign = (b >> 16) & 0x8000;
    const exponent = ((b >> 23) & 0xff) - 127 + 15;
    half[i] = exponent <= 0 ? sign : exponent >= 31 ? sign | 0x7bff : sign | (exponent << 10) | ((b >> 13) & 0x3ff);
  }
  return half;
}

export interface Lightmap {
  width: number;
  height: number;
  /** RGBA per texel, row by row: the light of the house's own lights, in their colours; and the
   *  strength of the daylight its windows let in, its colour the sky's as it is drawn. */
  texels: Float32Array;
  /** Per vertex of the model, where on the lightmap it is (0-1). Faces no light reaches all point at
   *  a patch of black. */
  uvs: Float32Array;
  /** Its faces; those a light was in reach of; those given a patch, and one texel; its texels. */
  stats: { faces: number; reached: number; patches: number; even: number; texels: number; rays: number; triangles: number };
}

/**
 * Bakes a model's lights - `lights` in the model's own space - into a lightmap. `occludes`: whether
 * a material casts shadow (a flame or a lit pane does not: its light comes from inside it).
 */
export function bakeLightmap(model: BakeModel, lights: ModelLight[], occludes: (material: string | null) => boolean): Lightmap {
  const P = model.positions;
  const vertexCount = P.length / 3;
  const uvs = new Float32Array(vertexCount * 2);

  // The faces: each a fan of triangles from its first corner, its corners its own.
  const faces: Face[] = [];
  const indices = model.indices;
  for (let t = 0; t < indices.length; ) {
    const first = indices[t];
    let end = t;
    while (end < indices.length && indices[end] === first) end += 3;
    faces.push(faceOf(P, model.normals, first, (end - t) / 3 + 2));
    t = end;
  }

  // Which lights reach each face: in its radius of the face, and in front of it.
  for (const face of faces) {
    if (face.area < 1e-6) continue;
    face.lights = lights.filter((light) => {
      const [lx, ly, lz] = light.position;
      const ahead = (lx - face.origin[0]) * face.n[0] + (ly - face.origin[1]) * face.n[1] + (lz - face.origin[2]) * face.n[2];
      if (ahead <= 0) return false;
      // The nearest the light comes to the face's patch (its bounding circle in its plane).
      const dx = lx - face.centre[0], dy = ly - face.centre[1], dz = lz - face.centre[2];
      const along = Math.max(0, Math.hypot(dx, dy, dz) - face.reach);
      return along < light.radius;
    });
  }

  // What casts shadow, in a tree of boxes.
  const tree = buildTree(model, occludes);

  // Each face in reach baked into a patch of its own, its gutter and all.
  let rays = 0;
  const point: number[] = [0, 0, 0];
  for (const face of faces) {
    if (face.lights.length === 0) continue;
    const w = Math.max(1, Math.ceil(face.size[0] * LIGHTMAP_DENSITY)) + GUTTER * 2;
    const h = Math.max(1, Math.ceil(face.size[1] * LIGHTMAP_DENSITY)) + GUTTER * 2;
    const patch = new Float32Array(w * h * 4);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        // The texel's middle on the face - or, in the gutter or past a slanted edge, the nearest
        // point of the face to it.
        const [u, v] = nearestIn(face.flat, face.min[0] + (i - GUTTER + 0.5) / LIGHTMAP_DENSITY, face.min[1] + (j - GUTTER + 0.5) / LIGHTMAP_DENSITY, face.inward);
        for (let k = 0; k < 3; k++) point[k] = face.origin[k] + face.u[k] * u + face.v[k] * v + face.n[k] * LIFT;
        let r = 0, g = 0, b = 0, sky = 0;
        for (const light of face.lights) {
          const [lx, ly, lz] = light.position;
          const dx = lx - point[0], dy = ly - point[1], dz = lz - point[2];
          const distance = Math.hypot(dx, dy, dz);
          if (distance >= light.radius) continue;
          const facing = (dx * face.n[0] + dy * face.n[1] + dz * face.n[2]) / Math.max(distance, 1e-4);
          if (facing <= 0) continue;
          // A light that shines one way (a window) shines most straight ahead, nothing back.
          const ahead = light.facing ? -(dx * light.facing[0] + dy * light.facing[1] + dz * light.facing[2]) / Math.max(distance, 1e-4) : 1;
          if (ahead <= 0) continue;
          const amount = falloff(light, distance) * facing * ahead;
          // How much of the light's source the point sees.
          const spread = light.size / 2;
          let seen = 0;
          let cast = 0;
          for (let n = 0; n < SOURCE_POINTS.length; n++) {
            if (n === FIRST_POINTS && (seen === 0 || seen === FIRST_POINTS)) break;
            const q = SOURCE_POINTS[n];
            cast++;
            if (tree.clear(point, [lx + q[0] * spread, ly + q[1] * spread, lz + q[2] * spread])) seen++;
          }
          rays += cast;
          if (seen === 0) continue;
          const visible = (amount * seen) / cast;
          if (light.sky) sky += visible;
          else {
            r += visible * light.color[0];
            g += visible * light.color[1];
            b += visible * light.color[2];
          }
        }
        patch.set([r, g, b, sky], (j * w + i) * 4);
      }
    }
    // Dark all over (every ray blocked - the room next door's light): it takes the black texel.
    // Even all over (within a shade): one texel.
    let most = 0;
    let least = Infinity;
    for (let t = 0; t < w * h; t++) {
      const level = patch[t * 4] + patch[t * 4 + 1] + patch[t * 4 + 2] + patch[t * 4 + 3];
      most = Math.max(most, level);
      least = Math.min(least, level);
    }
    if (most < DARK) continue;
    if (most - least < EVEN * most) {
      face.patch = patch.slice(0, 4);
      face.w = face.h = 1;
      face.even = true;
    } else {
      face.patch = patch;
      face.w = w;
      face.h = h;
    }
  }

  // The patches, packed onto shelves, tallest first, after one black texel for the unlit.
  const kept = faces.filter((face) => face.patch !== null);
  let area = 1;
  let widest = 1;
  for (const face of kept) {
    area += face.w * face.h;
    widest = Math.max(widest, face.w);
  }
  let width = 16;
  while (width < Math.max(widest, Math.sqrt(area) * 1.1)) width *= 2;
  let x = 1, y = 0, shelf = 1;
  for (const face of [...kept].sort((a, b) => b.h - a.h)) {
    if (x + face.w > width) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    face.x = x;
    face.y = y;
    x += face.w;
    shelf = Math.max(shelf, face.h);
  }
  const height = Math.max(4, Math.ceil((y + shelf) / 4) * 4);
  const texels = new Float32Array(width * height * 4);
  for (const face of kept) {
    for (let j = 0; j < face.h; j++) texels.set(face.patch!.subarray(j * face.w * 4, (j + 1) * face.w * 4), ((face.y + j) * width + face.x) * 4);
  }

  // Each corner's place on it: on its patch; at the middle of its one texel; at the black one.
  for (const face of faces) {
    for (let c = 0; c < face.count; c++) {
      const v = face.first + c;
      if (face.patch === null || face.even) {
        uvs[v * 2] = (face.x + 0.5) / width;
        uvs[v * 2 + 1] = (face.y + 0.5) / height;
      } else {
        const [u, w] = face.flat[c];
        uvs[v * 2] = (face.x + GUTTER + (u - face.min[0]) * LIGHTMAP_DENSITY) / width;
        uvs[v * 2 + 1] = (face.y + GUTTER + (w - face.min[1]) * LIGHTMAP_DENSITY) / height;
      }
    }
  }

  return {
    width,
    height,
    texels,
    uvs,
    stats: { faces: faces.length, reached: faces.filter((face) => face.lights.length > 0).length, patches: kept.filter((face) => !face.even).length, even: kept.filter((face) => face.even).length, texels: width * height, rays, triangles: tree.triangles },
  };
}

/** A face of the model, laid flat in its own plane. */
interface Face {
  first: number;
  count: number;
  /** Its plane: a corner, its normal, and two directions across it (u along its first edge). */
  origin: number[];
  n: number[];
  u: number[];
  v: number[];
  /** Its corners in (u, v), metres from `origin`; their least (u, v) and its extent. */
  flat: [number, number][];
  min: [number, number];
  size: [number, number];
  /** Whether its corners run counter-clockwise in (u, v) - which side of an edge is in. */
  inward: number;
  centre: number[];
  /** How far its corners reach from its centre. */
  reach: number;
  area: number;
  lights: ModelLight[];
  /** Its baked texels (w x h), and where on the lightmap they went - or none: it is dark. */
  patch: Float32Array | null;
  /** Lit the same all over: one texel. */
  even: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

function faceOf(P: ArrayLike<number>, N: ArrayLike<number>, first: number, count: number): Face {
  const corner = (c: number): number[] => [P[(first + c) * 3], P[(first + c) * 3 + 1], P[(first + c) * 3 + 2]];
  const corners = Array.from({ length: count }, (_, c) => corner(c));
  // Its normal by Newell's sum - right for a polygon a little bent too - and its area.
  const n = [0, 0, 0];
  for (let c = 0; c < count; c++) {
    const a = corners[c], b = corners[(c + 1) % count];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(n[0], n[1], n[2]);
  const area = length / 2;
  // Turned to the side its own normal says it faces: corners are not always wound one way (the
  // shader draws both sides).
  const facing = n[0] * N[first * 3] + n[1] * N[first * 3 + 1] + n[2] * N[first * 3 + 2] < 0 ? -1 : 1;
  if (length > 0) for (let i = 0; i < 3; i++) n[i] *= facing / length;
  // u along its longest edge (the patch then lies square to it), v across.
  let longest = 0;
  let u = [1, 0, 0];
  for (let c = 0; c < count; c++) {
    const a = corners[c], b = corners[(c + 1) % count];
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const d = e[0] * n[0] + e[1] * n[1] + e[2] * n[2];
    const along = [e[0] - n[0] * d, e[1] - n[1] * d, e[2] - n[2] * d];
    const l = Math.hypot(along[0], along[1], along[2]);
    if (l > longest) {
      longest = l;
      u = along.map((x) => x / l);
    }
  }
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const origin = corners[0];
  const flat = corners.map((p): [number, number] => {
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    return [d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * v[0] + d[1] * v[1] + d[2] * v[2]];
  });
  const min: [number, number] = [Math.min(...flat.map((p) => p[0])), Math.min(...flat.map((p) => p[1]))];
  const size: [number, number] = [Math.max(...flat.map((p) => p[0])) - min[0], Math.max(...flat.map((p) => p[1])) - min[1]];
  let signed = 0;
  for (let c = 0; c < count; c++) {
    const a = flat[c], b = flat[(c + 1) % count];
    signed += a[0] * b[1] - b[0] * a[1];
  }
  const centre = [0, 0, 0];
  for (const p of corners) for (let i = 0; i < 3; i++) centre[i] += p[i] / count;
  const reach = Math.max(...corners.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])));
  return { first, count, origin, n, u, v, flat, min, size, inward: signed >= 0 ? 1 : -1, centre, reach, area, lights: [], patch: null, even: false, x: 0, y: 0, w: 0, h: 0 };
}

/** The point of a convex polygon (in 2D) nearest (u, v): itself if it is inside. */
function nearestIn(poly: [number, number][], u: number, v: number, inward: number): [number, number] {
  let inside = true;
  for (let c = 0; c < poly.length; c++) {
    const a = poly[c], b = poly[(c + 1) % poly.length];
    if (((b[0] - a[0]) * (v - a[1]) - (b[1] - a[1]) * (u - a[0])) * inward < 0) {
      inside = false;
      break;
    }
  }
  if (inside) return [u, v];
  let best: [number, number] = poly[0];
  let bestD = Infinity;
  for (let c = 0; c < poly.length; c++) {
    const a = poly[c], b = poly[(c + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((u - a[0]) * ex + (v - a[1]) * ey) / (ex * ex + ey * ey || 1)));
    const px = a[0] + ex * t, py = a[1] + ey * t;
    const d = (px - u) ** 2 + (py - v) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [px, py];
    }
  }
  return best;
}

/** Points spread evenly through a unit ball (a Fibonacci spiral, at radii filling it evenly), the
 *  first few spread widest. */
function sourcePoints(count: number): number[][] {
  const points: number[][] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const turn = i * 2.399963;
    const r = Math.cbrt((((i * 7) % count) + 0.5) / count);
    points.push([Math.cos(turn) * ring * r, y * r, Math.sin(turn) * ring * r]);
  }
  return points;
}

interface Tree {
  triangles: number;
  /** Whether nothing that casts shadow lies between two points. */
  clear(from: number[], to: number[]): boolean;
}

/** The triangles that cast shadow, in a tree of boxes - each split where the two halves' boxes
 *  cost a ray least to pass (their surface areas times what is in them, over a dozen trial cuts
 *  along each axis) - for rays to be tested against only those whose boxes they pass through. */
function buildTree(model: BakeModel, occludes: (material: string | null) => boolean): Tree {
  const P = model.positions;
  const I = model.indices;
  const tris: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const slot = model.materialSlots[I[t]];
    if (!occludes(slot < 0 ? null : model.materials[slot])) continue;
    tris.push(t);
  }
  const count = tris.length;
  // Each triangle's corners, flat; its box; and its box's middle, to split by.
  const V = new Float32Array(count * 9);
  const lo = new Float32Array(count * 3);
  const hi = new Float32Array(count * 3);
  const mid = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const t = tris[k];
    for (let c = 0; c < 3; c++) for (let i = 0; i < 3; i++) V[k * 9 + c * 3 + i] = P[I[t + c] * 3 + i];
    for (let i = 0; i < 3; i++) {
      lo[k * 3 + i] = Math.min(V[k * 9 + i], V[k * 9 + 3 + i], V[k * 9 + 6 + i]);
      hi[k * 3 + i] = Math.max(V[k * 9 + i], V[k * 9 + 3 + i], V[k * 9 + 6 + i]);
      mid[k * 3 + i] = (lo[k * 3 + i] + hi[k * 3 + i]) / 2;
    }
  }
  const order = new Uint32Array(count).map((_, k) => k);
  // Nodes: box (6), then either children (left, right) or a leaf's run of `order` (-1, start, count).
  const boxes: number[] = [];
  const links: number[] = [];
  const BINS = 12;
  const MAX_LEAF = 8;
  const surface = (b: number[]): number => {
    const x = b[3] - b[0], y = b[4] - b[1], z = b[5] - b[2];
    return x < 0 ? 0 : x * y + y * z + z * x;
  };
  const binBox = new Float64Array(BINS * 6);
  const binCount = new Int32Array(BINS);
  const build = (start: number, end: number): number => {
    const node = boxes.length / 6;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = start; k < end; k++) {
      const o = order[k] * 3;
      for (let i = 0; i < 3; i++) {
        box[i] = Math.min(box[i], lo[o + i]);
        box[3 + i] = Math.max(box[3 + i], hi[o + i]);
        cb[i] = Math.min(cb[i], mid[o + i]);
        cb[3 + i] = Math.max(cb[3 + i], mid[o + i]);
      }
    }
    boxes.push(...box);
    links.push(-1, start, end - start);
    const n = end - start;
    if (n <= 2) return node;
    // The cheapest cut.
    let bestCost = n * surface(box);
    let bestAxis = -1;
    let bestBin = 0;
    for (let axis = 0; axis < 3; axis++) {
      const span = cb[3 + axis] - cb[axis];
      if (span < 1e-6) continue;
      binCount.fill(0);
      for (let b = 0; b < BINS; b++) binBox.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
      for (let k = start; k < end; k++) {
        const o = order[k] * 3;
        const b = Math.min(BINS - 1, Math.floor(((mid[o + axis] - cb[axis]) / span) * BINS));
        binCount[b]++;
        for (let i = 0; i < 3; i++) {
          binBox[b * 6 + i] = Math.min(binBox[b * 6 + i], lo[o + i]);
          binBox[b * 6 + 3 + i] = Math.max(binBox[b * 6 + 3 + i], hi[o + i]);
        }
      }
      // Areas and counts swept from the right, then cuts tried from the left.
      const rightArea = new Float64Array(BINS);
      const rightCount = new Int32Array(BINS);
      const acc = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      let accCount = 0;
      for (let b = BINS - 1; b > 0; b--) {
        for (let i = 0; i < 3; i++) {
          acc[i] = Math.min(acc[i], binBox[b * 6 + i]);
          acc[3 + i] = Math.max(acc[3 + i], binBox[b * 6 + 3 + i]);
        }
        accCount += binCount[b];
        rightArea[b] = surface(acc);
        rightCount[b] = accCount;
      }
      const left = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      let leftCount = 0;
      for (let b = 0; b < BINS - 1; b++) {
        for (let i = 0; i < 3; i++) {
          left[i] = Math.min(left[i], binBox[b * 6 + i]);
          left[3 + i] = Math.max(left[3 + i], binBox[b * 6 + 3 + i]);
        }
        leftCount += binCount[b];
        if (leftCount === 0 || rightCount[b + 1] === 0) continue;
        const cost = surface(box) * 0.5 + leftCount * surface(left) + rightCount[b + 1] * rightArea[b + 1];
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = b;
        }
      }
    }
    if (bestAxis < 0) {
      if (n <= MAX_LEAF) return node;
      // Nothing cheaper, but too many for a leaf: halve along the longest side.
      bestAxis = [0, 1, 2].reduce((a, b) => (cb[3 + b] - cb[b] > cb[3 + a] - cb[a] ? b : a));
      bestBin = BINS / 2 - 1;
    }
    // Those left of the cut first.
    const span = cb[3 + bestAxis] - cb[bestAxis];
    const leftOf = (k: number): boolean => span < 1e-6 ? false : Math.min(BINS - 1, Math.floor(((mid[order[k] * 3 + bestAxis] - cb[bestAxis]) / span) * BINS)) <= bestBin;
    let i = start, j = end - 1;
    while (i <= j) {
      if (leftOf(i)) i++;
      else {
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
        j--;
      }
    }
    let half = i;
    if (half === start || half === end) half = (start + end) >> 1;
    const left = build(start, half);
    const right = build(half, end);
    links[node * 3] = left;
    links[node * 3 + 1] = right;
    links[node * 3 + 2] = 0;
    return node;
  };
  if (count > 0) build(0, count);
  const B = new Float32Array(boxes);
  const L = new Int32Array(links);
  const stack = new Int32Array(64);

  return {
    triangles: count,
    clear(from, to) {
      if (count === 0) return true;
      const ox = from[0], oy = from[1], oz = from[2];
      let dx = to[0] - ox, dy = to[1] - oy, dz = to[2] - oz;
      const length = Math.hypot(dx, dy, dz);
      dx /= length;
      dy /= length;
      dz /= length;
      const far = length - 0.01;
      const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const node = stack[--top];
        const b = node * 6;
        // The ray through the node's box (slabs)?
        let t0 = 0, t1 = far;
        let ta = (B[b] - ox) * ix, tb = (B[b + 3] - ox) * ix;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
        ta = (B[b + 1] - oy) * iy;
        tb = (B[b + 4] - oy) * iy;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
        ta = (B[b + 2] - oz) * iz;
        tb = (B[b + 5] - oz) * iz;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
        if (t0 > t1) continue;
        if (L[node * 3] >= 0) {
          stack[top++] = L[node * 3];
          stack[top++] = L[node * 3 + 1];
          continue;
        }
        const start = L[node * 3 + 1], end = start + L[node * 3 + 2];
        for (let k = start; k < end; k++) {
          // Moller-Trumbore, either side of the triangle.
          const o = order[k] * 9;
          const e1x = V[o + 3] - V[o], e1y = V[o + 4] - V[o + 1], e1z = V[o + 5] - V[o + 2];
          const e2x = V[o + 6] - V[o], e2y = V[o + 7] - V[o + 1], e2z = V[o + 8] - V[o + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det;
          const sx = ox - V[o], sy = oy - V[o + 1], sz = oz - V[o + 2];
          const a = (sx * px + sy * py + sz * pz) * inv;
          if (a < 0 || a > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const c = (dx * qx + dy * qy + dz * qz) * inv;
          if (c < 0 || a + c > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > 1e-4 && t < far) return false;
        }
      }
      return true;
    },
  };
}
