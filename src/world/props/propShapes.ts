import type { ModelBuilder, Vec3 } from "../buildings/buildingGeometry";
import type { ColliderBuilder } from "../buildings/buildingColliders";
import type { Paint } from "../buildings/buildingTypes";

/**
 * The shapes props are made of - boxes, beams, round logs and turned shapes - each laid in a local
 * frame, so a generator builds a piece where it wants it, turned as it likes, without working out a
 * single world coordinate. Every shape can put itself in the way (a collision hull of its own
 * corners) and draws itself coarser in a far model.
 *
 * Textures follow the wood: a log's bark wraps round it without a seam and runs along it, its cut
 * ends show end grain centred on its heart; a box or a beam has its grain along its longest side.
 *
 * Two pieces must never have faces in one plane where they overlap - a batten's top level with the
 * crate's lid, a board's foot on the ground - or the two flicker through each other (z-fighting),
 * worse with distance. A piece laid on another stands PROUD of it on every side they share, and a
 * piece standing on the ground leaves its underside out (`bottom: false`).
 */

/** Where a piece stands and how it is turned: an origin and three unit axes. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const ORIGIN: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** How far a piece laid on another stands out of it, so their faces never share a plane - enough
 *  to hold apart in the depth buffer at a distance, too little to see as a gap. */
export const PROUD = 0.02;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

/** A point given in a frame, in its parent's space. */
export function at(f: Frame, [a, b, c]: Vec3): Vec3 {
  return [f.origin[0] + f.x[0] * a + f.y[0] * b + f.z[0] * c, f.origin[1] + f.x[1] * a + f.y[1] * b + f.z[1] * c, f.origin[2] + f.x[2] * a + f.y[2] * b + f.z[2] * c];
}

/** A direction given in a frame, in its parent's space. */
export function along(f: Frame, [a, b, c]: Vec3): Vec3 {
  return [f.x[0] * a + f.y[0] * b + f.z[0] * c, f.x[1] * a + f.y[1] * b + f.z[1] * c, f.x[2] * a + f.y[2] * b + f.z[2] * c];
}

/** The frame moved by `by`, given in its own axes. */
export function moved(f: Frame, by: Vec3): Frame {
  return { ...f, origin: at(f, by) };
}

/** The frame turned by `angle` (radians, right-handed) about one of its own axes. */
export function turned(f: Frame, axis: "x" | "y" | "z", angle: number): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const spin = (p: Vec3, q: Vec3): [Vec3, Vec3] => [add(scale(p, c), scale(q, s)), add(scale(q, c), scale(p, -s))];
  if (axis === "x") {
    const [y, z] = spin(f.y, f.z);
    return { ...f, y, z };
  }
  if (axis === "y") {
    const [z, x] = spin(f.z, f.x);
    return { ...f, z, x };
  }
  const [x, y] = spin(f.x, f.y);
  return { ...f, x, y };
}

/**
 * A frame at `from` (in f), its z running to `to`, its y as near `up` (in f; f's own y if left out)
 * as it can be - for a piece reaching between two points: a leg, a rail, a log.
 */
export function between(f: Frame, from: Vec3, to: Vec3, up: Vec3 = [0, 1, 0]): Frame {
  const z = normalize(along(f, sub(to, from)));
  let upward = along(f, up);
  if (Math.abs(dot(normalize(upward), z)) > 0.99) upward = Math.abs(z[0]) < 0.9 ? along(f, [1, 0, 0]) : along(f, [0, 0, 1]);
  const x = normalize(cross(upward, z));
  const y = cross(z, x);
  return { origin: at(f, from), x, y, z };
}

/** How far apart two points are, in a frame. */
export function distance(a: Vec3, b: Vec3): number {
  return length(sub(b, a));
}

/** How a shape is made beyond its size: whether it is in the way, and its paints. */
export interface ShapeOptions {
  /** Put a collision hull of its corners in the way (default: no). */
  collide?: boolean;
}

/** A log's or a stake's two ends. */
export interface EndOptions extends ShapeOptions {
  /** The paint of its cut ends (null: left open - an end out of sight). */
  ends?: Paint | null;
  /** Which ends are drawn: the start (z 0), the end (z = length), or both (the default). */
  caps?: "both" | "start" | "end" | "none";
  /** Where the end grain's heart is on each end, off its middle (metres across, in the log's x/y). */
  heart?: [number, number];
  /** How far its far end is cut aslant: its end face tilted this many radians about the log's x. */
  slant?: number;
}

/**
 * Lays shapes into a model (and its colliders, where it has them). `far`: the shapes are drawn
 * coarser - fewer sides round a log.
 */
export class Shaper {
  readonly b: ModelBuilder;
  readonly colliders: ColliderBuilder | null;
  readonly far: boolean;

  constructor(b: ModelBuilder, colliders: ColliderBuilder | null, far: boolean) {
    this.b = b;
    this.colliders = colliders;
    this.far = far;
  }

  /** How many sides a round shape of radius `r` gets: enough to look round near, fewer far. */
  sidesFor(r: number, near = 10): number {
    const sides = Math.round(Math.max(5, Math.min(near, 5 + r * 8)));
    return this.far ? Math.max(4, Math.round(sides / 2)) : sides;
  }

  /** Puts a hull of these points (in the model's space) in the way. */
  solid(points: Vec3[]): void {
    this.colliders?.hull(points);
  }

  /**
   * A box centred on the frame's origin, `half` its half-extents along the frame's axes. Its grain
   * runs along its longest side. `top` paints its top (default: the same); `bottom: false` leaves
   * its underside out, where it stands on something.
   *
   * `taper: [low, high]` narrows it along `taperAxis` (y by default): its face at that axis's low
   * end scaled across by `low`, its high end's by `high` - a leg slimming to its foot, a post to its
   * head. The same eight corners, so no more polygons, but it reads as shaped rather than sawn
   * square. Its sides then lean, and are lit as they lean.
   *
   * `grain` lays its texture's grain along one of its axes rather than its longest (see above).
 *
 * `bevel` (metres) cuts every edge off at 45 degrees with a face of its own, and every corner with
   * a small triangle - 26 faces rather than 6: worn timber, dressed stone, a cushion's roll. It goes
   * with `taper` too.
   */
  box(f: Frame, half: Vec3, paint: Paint, options: ShapeOptions & { top?: Paint; bottom?: boolean; taper?: [number, number]; taperAxis?: "y" | "z"; bevel?: number; grain?: "x" | "y" | "z" } = {}): void {
    const [hx, hy, hz] = half;
    // Its texture's grain: along its longest side - or the way it is told (masonry: up it, so its
    // courses lie level however it is shaped).
    const longest = options.grain ? f[options.grain] : hx >= hy && hx >= hz ? f.x : hy >= hz ? f.y : f.z;
    const [low, high] = options.taper ?? [1, 1];
    const alongZ = options.taperAxis === "z";
    // A point in the box's own half-extent space, tapered by which end of the taper's axis it is at.
    const point = (x: number, y: number, z: number): Vec3 => {
      const scale = (alongZ ? z : y) < 0 ? low : high;
      return alongZ ? at(f, [x * scale, y * scale, z]) : at(f, [x * scale, y, z * scale]);
    };
    const corner = (sx: number, sy: number, sz: number): Vec3 => point(sx * hx, sy * hy, sz * hz);
    const bevel = Math.min(options.bevel ?? 0, Math.min(hx, hy, hz) * 0.45);
    if (bevel > 0) {
      this.bevelled(f, half, bevel, point, longest, paint, options);
      if (options.collide) {
        const points: Vec3[] = [];
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) points.push(corner(sx, sy, sz));
        this.solid(points);
      }
      return;
    }
    const tapered = low !== 1 || high !== 1;
    // A face's normal: square to the axis it faces - or, where the box tapers, from its own corners,
    // turned the way the axis faces.
    const quad = (n: Vec3, corners: Vec3[], p: Paint): void => {
      let normal = n;
      if (tapered) {
        const own = normalize(cross(sub(corners[1], corners[0]), sub(corners[3], corners[0])));
        normal = dot(own, n) < 0 ? scale(own, -1) : own;
      }
      this.b.face(corners, normal, p, longest);
    };
    quad(f.z, [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)], paint);
    quad(scale(f.z, -1), [corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1)], paint);
    quad(f.x, [corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1)], paint);
    quad(scale(f.x, -1), [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)], paint);
    quad(f.y, [corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)], options.top ?? paint);
    if (options.bottom !== false) quad(scale(f.y, -1), [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)], paint);
    if (options.collide) {
      const points: Vec3[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) points.push(corner(sx, sy, sz));
      this.solid(points);
    }
  }

  /**
   * A box's faces with its edges and corners cut off (see box's `bevel`): each face shrunk in by
   * `bevel`, a strip across each edge between the two faces it parts, a triangle at each corner.
   * Every face's normal from its own corners, so it shades as it leans.
   */
  private bevelled(f: Frame, half: Vec3, bevel: number, point: (x: number, y: number, z: number) => Vec3, grain: Vec3, paint: Paint, options: { top?: Paint; bottom?: boolean }): void {
    const axes: Vec3[] = [f.x, f.y, f.z];
    // Corner (sx, sy, sz)'s point on the face square to `axis`: full out along that axis, cut back
    // by the bevel along the other two.
    const vertex = (axis: number, signs: [number, number, number]): Vec3 =>
      point(...([0, 1, 2].map((k) => signs[k] * (k === axis ? half[k] : half[k] - bevel)) as [number, number, number]));
    const polygon = (corners: Vec3[], out: Vec3, p: Paint): void => {
      const own = normalize(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])));
      this.b.face(corners, dot(own, out) < 0 ? scale(own, -1) : own, p, grain);
    };
    const outward = (signs: [number, number, number]): Vec3 => normalize(add(add(scale(axes[0], signs[0]), scale(axes[1], signs[1])), scale(axes[2], signs[2])));
    const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    // The faces.
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        if (axis === 1 && sign < 0 && options.bottom === false) continue;
        const [u, v] = [0, 1, 2].filter((k) => k !== axis);
        const corners = ring.map(([a, b]) => {
          const signs: [number, number, number] = [0, 0, 0];
          signs[axis] = sign;
          signs[u] = a;
          signs[v] = b;
          return vertex(axis, signs);
        });
        const out: [number, number, number] = [0, 0, 0];
        out[axis] = sign;
        polygon(corners, outward(out), axis === 1 && sign > 0 ? (options.top ?? paint) : paint);
      }
    }
    // The edges: along each axis, one between each pair of faces it parts.
    for (let axis = 0; axis < 3; axis++) {
      const [p, q] = [0, 1, 2].filter((k) => k !== axis);
      for (const sp of [-1, 1]) {
        for (const sq of [-1, 1]) {
          const at = (along: number, face: number): Vec3 => {
            const signs: [number, number, number] = [0, 0, 0];
            signs[axis] = along;
            signs[p] = sp;
            signs[q] = sq;
            return vertex(face, signs);
          };
          const out: [number, number, number] = [0, 0, 0];
          out[p] = sp;
          out[q] = sq;
          polygon([at(-1, p), at(1, p), at(1, q), at(-1, q)], outward(out), paint);
        }
      }
    }
    // The corners.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const signs: [number, number, number] = [sx, sy, sz];
          polygon([vertex(0, signs), vertex(1, signs), vertex(2, signs)], outward(signs), paint);
        }
      }
    }
  }

  /** A squared timber from `from` to `to` (in f), `width` across and `height` deep, its depth as
   *  near `up` as it can be - a leg, a rail, a handle. `taper: [atFrom, atTo]` narrows it toward
   *  either end, `bevel` cuts its edges off (see box). */
  beam(f: Frame, from: Vec3, to: Vec3, width: number, height: number, paint: Paint, options: ShapeOptions & { up?: Vec3; taper?: [number, number]; bevel?: number } = {}): void {
    const frame = between(f, from, to, options.up);
    const half = distance(from, to) / 2;
    this.box(moved(frame, [0, 0, half]), [width / 2, height / 2, half], paint, { ...options, taperAxis: "z" });
  }

  /**
   * A round log along the frame's z, from 0 to `length`: its radius `radius` at the start, or
   * [start, end] tapering. Smooth-shaded, its side painted (bark, wood) wrapping round it, its ends
   * as `options` says - the end grain's rings centred on its heart. `sides` round it (default: by
   * its size); with four or fewer it is a squared or split piece, its sides flat and its edges hard.
   */
  cylinder(f: Frame, length: number, radius: number | [number, number], side: Paint, options: EndOptions & { sides?: number } = {}): void {
    const [r0, r1] = typeof radius === "number" ? [radius, radius] : radius;
    const sides = options.sides ?? this.sidesFor(Math.max(r0, r1));
    const slant = options.slant ?? 0;
    // Each ring's points: round the frame's x and y; the far ring along a tilted end face.
    const ring = (r: number, z: number, tilt: number): Vec3[] =>
      Array.from({ length: sides }, (_, k) => {
        const a = (k / sides) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        return at(f, [x, y, z + Math.tan(tilt) * y]);
      });
    const start = ring(r0, 0, 0);
    const end = ring(r1, length, slant);
    // Smooth normals, leaning out by the taper - or, for a flat-sided piece, each side's own.
    const lean = (r0 - r1) / length;
    const faceted = sides <= 4;
    const normalAt = (a: number): Vec3 => normalize(along(f, [Math.cos(a), Math.sin(a), lean]));
    const normal = (k: number): Vec3 => normalAt((k / sides) * Math.PI * 2);
    const tangent = (k: number): Vec3 => {
      const a = (k / sides) * Math.PI * 2;
      return along(f, [-Math.sin(a), Math.cos(a), 0]);
    };
    // The bark's u round it (metres round its middle girth), v along it.
    const girth = ((r0 + r1) / 2) * Math.PI * 2;
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      const u0 = (k / sides) * girth;
      const u1 = ((k + 1) / sides) * girth;
      const flat = normalAt(((k + 0.5) / sides) * Math.PI * 2);
      this.b.raw(
        [start[k], start[n], end[n], end[k]],
        faceted ? [flat, flat, flat, flat] : [normal(k), normal(k + 1), normal(k + 1), normal(k)],
        [tangent(k), tangent(k + 1), tangent(k + 1), tangent(k)],
        [[u0, 0], [u1, 0], [u1, length], [u0, length]],
        side,
      );
    }
    const caps = options.caps ?? "both";
    const ends = options.ends;
    if (ends) {
      const [hx, hy] = options.heart ?? [0, 0];
      if (caps === "both" || caps === "start") this.b.face([...start].reverse(), scale(f.z, -1), ends, f.y, at(f, [hx, hy, 0]));
      if (caps === "both" || caps === "end") {
        const n = normalize(along(f, [0, -Math.sin(slant), Math.cos(slant)]));
        this.b.face(end, n, ends, f.y, at(f, [hx, hy, length]));
      }
    }
    if (options.collide) this.solid([...start, ...end]);
  }

  /**
   * A turned shape round the frame's y: `profile` its outline, [radius, height] from the bottom up -
   * a barrel's bulge, a bucket, a pot. Smooth-shaded, painted `side`; `top` and `bottom` close its
   * ends where given. Its texture's u runs round it and its v up it - or, `turned`, the other way
   * about: a board material's boards (along its u) standing up it as staves.
   */
  lathe(f: Frame, profile: [number, number][], side: Paint, options: ShapeOptions & { top?: Paint; bottom?: Paint; sides?: number; turned?: boolean } = {}): void {
    const widest = Math.max(...profile.map(([r]) => r));
    const sides = options.sides ?? this.sidesFor(widest, 14);
    const point = ([r, y]: [number, number], k: number): Vec3 => {
      const a = (k / sides) * Math.PI * 2;
      return at(f, [Math.cos(a) * r, y, Math.sin(a) * r]);
    };
    // The texture's u round its widest girth, v up its outline.
    const girth = widest * Math.PI * 2;
    const heights = [0];
    for (let i = 1; i < profile.length; i++) heights.push(heights[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
    // Each profile point's normal: out from the axis, tipped by the outline's slope there.
    const slopeAt = (i: number): [number, number] => {
      const p = profile[Math.max(0, i - 1)];
      const q = profile[Math.min(profile.length - 1, i + 1)];
      return [q[0] - p[0], q[1] - p[1]];
    };
    const normal = (i: number, k: number): Vec3 => {
      const [dr, dy] = slopeAt(i);
      const out = dy;
      const upward = -dr;
      const a = (k / sides) * Math.PI * 2;
      return normalize(along(f, [Math.cos(a) * out, upward, Math.sin(a) * out]));
    };
    const tangent = (k: number): Vec3 => {
      if (options.turned) return f.y;
      const a = (k / sides) * Math.PI * 2;
      return along(f, [-Math.sin(a), 0, Math.cos(a)]);
    };
    const uv = (u: number, v: number): [number, number] => (options.turned ? [v, u] : [u, v]);
    for (let i = 0; i + 1 < profile.length; i++) {
      for (let k = 0; k < sides; k++) {
        const n = (k + 1) % sides;
        const u0 = (k / sides) * girth;
        const u1 = ((k + 1) / sides) * girth;
        this.b.raw(
          [point(profile[i], k), point(profile[i + 1], k), point(profile[i + 1], n), point(profile[i], n)],
          [normal(i, k), normal(i + 1, k), normal(i + 1, k + 1), normal(i, k + 1)],
          [tangent(k), tangent(k), tangent(k + 1), tangent(k + 1)],
          [uv(u0, heights[i]), uv(u0, heights[i + 1]), uv(u1, heights[i + 1]), uv(u1, heights[i])],
          side,
        );
      }
    }
    const disc = (p: [number, number], up: boolean, paint: Paint): void => {
      const corners = Array.from({ length: sides }, (_, k) => point(p, k));
      this.b.face(up ? corners.reverse() : corners, up ? f.y : scale(f.y, -1), paint, f.z, at(f, [0, p[1], 0]));
    };
    if (options.top) disc(profile[profile.length - 1], true, options.top);
    if (options.bottom) disc(profile[0], false, options.bottom);
    if (options.collide) this.solid(profile.flatMap((p) => Array.from({ length: sides }, (_, k) => point(p, k))));
  }
}
