import type { BodyGeometry, BodyRegion } from "./bodyMesh";
import { add, cross, dot, frameFor, length, normalize, scale, sub, type Vec } from "./skeleton";

/**
 * A body unrolled into one square texture (CHARACTERS.md, *Texture: a painted atlas*). Each region
 * - the torso, the head, an arm, a hand, a leg, a foot - is a cylinder round its axis: unrolled,
 * round it runs across its rectangle (its front in the middle, the seam at its back) and along it
 * runs down. Rectangles are sized by the surface they hold, so a texel covers about as much body
 * everywhere - the face a little less, for its features.
 */
export interface AtlasLayout {
  size: number;
  /** Per triangle corner (triangle × 3 + corner): where in the texture, 0-1 across and down. */
  uvs: Float32Array;
  rects: AtlasRect[];
  /** Texels per metre along the body. */
  density: number;
  /** Per texel, what the body is there - for painting (paint.ts). */
  texels: AtlasTexels;
}

export interface AtlasRect {
  region: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What each texel of the atlas covers, in the bind pose: -1 region where none. */
export interface AtlasTexels {
  region: Int16Array;
  /** Where on the body, and its smooth normal: three floats a texel. */
  position: Float32Array;
  normal: Float32Array;
  /** Round the region (metres along its surface from its front) and along it (metres): two a texel. */
  surface: Float32Array;
}

/** Extra texels per metre, by region, for the parts that carry fine detail. */
const DENSITY_BOOST: Record<string, number> = { head: 1.7, handR: 1.2, handL: 1.2 };
const PAD = 2;

export function layoutAtlas(body: BodyGeometry, size: number): AtlasLayout {
  const P = body.positions;
  const I = body.indices;
  const at = (i: number): Vec => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const triangles = I.length / 3;

  // Every corner's place on its region's cylinder: round it (0-1, front at 0.5) and along it, and
  // how far off the axis it stands.
  const round = new Float32Array(triangles * 3);
  const along = new Float32Array(triangles * 3);
  const radius = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const r = body.regions[body.triangleRegions[t]];
    for (let k = 0; k < 3; k++) {
      const c = cylinderOf(r, at(I[t * 3 + k]));
      round[t * 3 + k] = c.round;
      along[t * 3 + k] = c.along;
      radius[t * 3 + k] = c.radius;
    }
    unwrap(round, radius, t * 3);
  }

  // Each region's extent: the widest it gets round, how far the seam's triangles run past it, and
  // its length.
  const extents = body.regions.map(() => ({ circumference: 0, roundMax: 1, alongMin: Infinity, alongMax: -Infinity }));
  for (let t = 0; t < triangles; t++) {
    const e = extents[body.triangleRegions[t]];
    for (let k = t * 3; k < t * 3 + 3; k++) {
      e.circumference = Math.max(e.circumference, 2 * Math.PI * radius[k]);
      e.roundMax = Math.max(e.roundMax, round[k]);
      e.alongMin = Math.min(e.alongMin, along[k]);
      e.alongMax = Math.max(e.alongMax, along[k]);
    }
  }
  const boost = (r: BodyRegion): number => DENSITY_BOOST[r.name] ?? 1;
  const sizes = (density: number): { width: number; height: number }[] =>
    body.regions.map((r, i) => {
      const e = extents[i];
      const d = density * boost(r);
      return { width: Math.ceil(e.circumference * e.roundMax * d) + PAD * 2, height: Math.ceil((e.alongMax - e.alongMin) * d) + PAD * 2 };
    });
  // The densest that fits, found by halving.
  let low = 1;
  let high = size * 4;
  let rects = pack(sizes(low), size)!;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    const tried = pack(sizes(mid), size);
    if (tried) {
      low = mid;
      rects = tried;
    } else high = mid;
  }
  const density = low;

  const uvs = new Float32Array(triangles * 6);
  const surface = new Float32Array(triangles * 6);
  for (let t = 0; t < triangles; t++) {
    const region = body.triangleRegions[t];
    const rect = rects[region];
    const e = extents[region];
    const d = density * boost(body.regions[region]);
    for (let k = t * 3; k < t * 3 + 3; k++) {
      uvs[k * 2] = (rect.x + PAD + round[k] * e.circumference * d) / size;
      uvs[k * 2 + 1] = (rect.y + PAD + (along[k] - e.alongMin) * d) / size;
      surface[k * 2] = (round[k] - 0.5) * 2 * Math.PI * radius[k];
      surface[k * 2 + 1] = along[k];
    }
  }
  return { size, uvs, rects, density, texels: rasterize(body, uvs, surface, size) };
}

/** Where a point is on a region's cylinder: the nearest place on its axis (running on past either
 *  end), the angle round from the region's front, and how far out. */
function cylinderOf(region: BodyRegion, p: Vec): { round: number; along: number; radius: number } {
  const axis = region.axis;
  let best = { distance: Infinity, along: 0, from: axis[0], direction: [0, 1, 0] as Vec };
  let walked = 0;
  for (let i = 0; i + 1 < axis.length; i++) {
    const a = axis[i];
    const ab = sub(axis[i + 1], a);
    const span = length(ab);
    let t = dot(sub(p, a), ab) / Math.max(1e-9, span * span);
    if (i > 0) t = Math.max(0, t);
    if (i + 2 < axis.length) t = Math.min(1, t);
    const foot = add(a, scale(ab, t));
    const distance = length(sub(p, foot));
    if (distance < best.distance) best = { distance, along: walked + t * span, from: foot, direction: ab };
    walked += span;
  }
  const frame = frameFor(best.direction, region.reference);
  const off = sub(p, best.from);
  let angle = Math.atan2(dot(off, frame.side), dot(off, frame.front));
  if (region.side < 0) angle = -angle;
  return { round: angle / (2 * Math.PI) + 0.5, along: best.along, radius: best.distance };
}

/** A triangle across the seam at the back gets its low side carried round past 1, so it does not
 *  stretch across the whole rectangle; a corner on the axis itself (a cap's tip) takes the others'
 *  angle, having none of its own. */
function unwrap(round: Float32Array, radius: Float32Array, first: number): void {
  const corners = [first, first + 1, first + 2];
  const widest = Math.max(...corners.map((k) => radius[k]));
  const onAxis = corners.filter((k) => radius[k] < widest * 0.12);
  const rest = corners.filter((k) => !onAxis.includes(k));
  const lowest = Math.min(...rest.map((k) => round[k]));
  const highest = Math.max(...rest.map((k) => round[k]));
  if (highest - lowest > 0.5) for (const k of rest) if (round[k] < 0.5) round[k] += 1;
  const mean = rest.reduce((sum, k) => sum + round[k], 0) / Math.max(1, rest.length);
  for (const k of onAxis) round[k] = mean;
}

/** Shelves, tallest first: null if the rectangles do not fit. */
function pack(sizes: { width: number; height: number }[], size: number): AtlasRect[] | null {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].height - sizes[a].height);
  const rects: AtlasRect[] = new Array(sizes.length);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const i of order) {
    const { width, height } = sizes[i];
    if (width > size) return null;
    if (x + width > size) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + height > size) return null;
    rects[i] = { region: i, x, y, width, height };
    x += width;
    shelf = Math.max(shelf, height);
  }
  return rects;
}

/** Every texel a triangle covers, told where on the body it is. */
function rasterize(body: BodyGeometry, uvs: Float32Array, surface: Float32Array, size: number): AtlasTexels {
  const P = body.positions;
  const I = body.indices;
  const normals = smoothNormals(body);
  const texels: AtlasTexels = {
    region: new Int16Array(size * size).fill(-1),
    position: new Float32Array(size * size * 3),
    normal: new Float32Array(size * size * 3),
    surface: new Float32Array(size * size * 2),
  };
  for (let t = 0; t < I.length / 3; t++) {
    const xs = [0, 1, 2].map((k) => uvs[(t * 3 + k) * 2] * size);
    const ys = [0, 1, 2].map((k) => uvs[(t * 3 + k) * 2 + 1] * size);
    const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / area;
        const w1 = ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        const o = y * size + x;
        texels.region[o] = body.triangleRegions[t];
        const w = [w0, w1, w2];
        for (let c = 0; c < 3; c++) {
          let p = 0;
          let n = 0;
          for (let k = 0; k < 3; k++) {
            const v = I[t * 3 + k];
            p += P[v * 3 + c] * w[k];
            n += normals[v * 3 + c] * w[k];
          }
          texels.position[o * 3 + c] = p;
          texels.normal[o * 3 + c] = n;
        }
        const n = normalize([texels.normal[o * 3], texels.normal[o * 3 + 1], texels.normal[o * 3 + 2]]);
        texels.normal.set(n, o * 3);
        for (let c = 0; c < 2; c++) texels.surface[o * 2 + c] = w.reduce((sum, wk, k) => sum + surface[(t * 3 + k) * 2 + c] * wk, 0);
      }
    }
  }
  return texels;
}

/** Each vertex's normal as the faces round it lean, by area - the shape a painted light follows,
 *  where the drawn mesh shows its facets. */
export function smoothNormals(body: BodyGeometry): Float32Array {
  const P = body.positions;
  const I = body.indices;
  const normals = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
    const pa: Vec = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const n = cross(sub([P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], pa), sub([P[c * 3], P[c * 3 + 1], P[c * 3 + 2]], pa));
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k] += n[k];
  }
  for (let v = 0; v < P.length / 3; v++) normals.set(normalize([normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]]), v * 3);
  return normals;
}
