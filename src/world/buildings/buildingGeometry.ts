import type { BuildingModel, Paint, Rgb } from "./buildingTypes";

/** How far below its floor a building reaches, so it never stands on air at the edge of its plot. */
export const FOUNDATION_DEPTH = 1.2;

export type Vec3 = [number, number, number];

const UP: Vec3 = [0, 1, 0];

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
/** `a` with its part along unit `n` taken out: what of it lies in the plane `n` is normal to. */
const inPlane = (a: Vec3, n: Vec3): Vec3 => {
  const d = dot(a, n);
  return [a[0] - n[0] * d, a[1] - n[1] * d, a[2] - n[2] * d];
};

/**
 * Geometry being built up by a generator, and its extent so far.
 *
 * Every face is textured in metres. Its v runs "up" it: up a wall, up a roof's slope (so roof tiles
 * lie in rows along the eaves) - or along `grain` where a face is given one, which is how a beam's
 * wood runs along the beam, whichever way it lies. A level face with no grain runs v along z.
 */
export class ModelBuilder {
  positions: number[] = [];
  normals: number[] = [];
  tangents: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  materialSlots: number[] = [];
  materials: string[] = [];
  indices: number[] = [];
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  maxY = 0;

  private slotOf(material: string | null): number {
    if (material === null) return -1;
    let slot = this.materials.indexOf(material);
    if (slot < 0) {
      slot = this.materials.length;
      this.materials.push(material);
    }
    return slot;
  }

  /** A flat polygon (corners in order, convex) with the given normal. */
  face(corners: Vec3[], normal: Vec3, paint: Paint, grain?: Vec3): void {
    this.surface(corners, corners.map(() => normal), normal, paint, grain);
  }

  /**
   * A polygon that may be a little bent - a cell of a sagging roof - shaded by a normal per corner,
   * but textured in the frame of `frame` (the normal of the flat surface it is bent from), so the
   * cells of one surface share one frame and its texture runs across them unbroken.
   */
  surface(corners: Vec3[], normals: Vec3[], frame: Vec3, paint: Paint, grain?: Vec3): void {
    let v = grain ? inPlane(grain, frame) : inPlane(UP, frame);
    if (Math.hypot(...v) < 1e-3) v = inPlane(grain ? UP : [0, 0, 1], frame);
    if (Math.hypot(...v) < 1e-3) v = inPlane([0, 0, 1], frame);
    v = normalize(v);
    const u = normalize(cross(v, frame));
    const slot = this.slotOf(paint.material);
    const base = this.positions.length / 3;
    for (let i = 0; i < corners.length; i++) {
      const corner = corners[i];
      const [x, y, z] = corner;
      this.positions.push(x, y, z);
      this.normals.push(...normals[i]);
      this.tangents.push(...u);
      this.uvs.push(dot(corner, u), dot(corner, v));
      this.colors.push(paint.tint[0], paint.tint[1], paint.tint[2], 1);
      this.materialSlots.push(slot);
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z);
      this.maxZ = Math.max(this.maxZ, z);
      this.maxY = Math.max(this.maxY, y);
    }
    for (let i = 1; i < corners.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
  }

  /** A flat polygon whose normal is worked out from its corners, turned to face `towards`'s side
   *  (up, for a roof). */
  faceToward(corners: Vec3[], towards: Vec3, paint: Paint, grain?: Vec3): void {
    const [a, b, c] = corners;
    let n = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    if (dot(n, towards) < 0) n = [-n[0], -n[1], -n[2]];
    this.face(corners, n, paint, grain);
  }

  /**
   * An axis-aligned box from (x0, y0, z0) to (x1, y1, z1): its four sides and, by `ends`, its top -
   * no bottom, it stands on something - its bottom and no top (it hangs under something), or both
   * (it floats). Its texture runs along its longest side: a post's grain up it, a sill's or a
   * lintel's along it. `top` defaults to the sides' paint.
   */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, paint: Paint, top: Paint = paint, ends: "top" | "bottom" | "both" = "top"): void {
    const sizes = [x1 - x0, y1 - y0, z1 - z0];
    const longest = sizes.indexOf(Math.max(...sizes));
    const grain: Vec3 = longest === 0 ? [1, 0, 0] : longest === 1 ? [0, 1, 0] : [0, 0, 1];
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], paint, grain);
    this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], paint, grain);
    this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], paint, grain);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], paint, grain);
    if (ends !== "bottom") this.face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], top, grain);
    if (ends !== "top") this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], paint, grain);
  }

  finish(door: { x: number; z: number }, tiles?: BuildingModel["tiles"]): BuildingModel {
    return {
      positions: this.positions,
      normals: this.normals,
      tangents: this.tangents,
      uvs: this.uvs,
      colors: this.colors,
      materialSlots: this.materialSlots,
      materials: this.materials,
      indices: this.indices,
      halfWidth: Math.max(Math.abs(this.minX), Math.abs(this.maxX)),
      halfDepth: Math.max(Math.abs(this.minZ), Math.abs(this.maxZ)),
      door,
      height: this.maxY,
      tiles,
    };
  }
}

/** A plain colour, no material. */
export function plain(color: Rgb): Paint {
  return { material: null, tint: color };
}

export function roll(range: [number, number], rng: () => number): number {
  return range[0] + (range[1] - range[0]) * rng();
}

/** A whole number from a range, every one in it equally likely. */
export function rollInt(range: [number, number], rng: () => number): number {
  const lo = Math.round(range[0]);
  const hi = Math.round(range[1]);
  return lo + Math.min(hi - lo, Math.floor(rng() * (hi - lo + 1)));
}

export function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length) % list.length];
}
