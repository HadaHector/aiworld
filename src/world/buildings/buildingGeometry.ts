import type { BuildingModel, Rgb } from "./buildingTypes";

/** How far below its floor a building reaches, so it never stands on air at the edge of its plot. */
export const FOUNDATION_DEPTH = 1.2;

export type Vec3 = [number, number, number];

/** Geometry being built up by a generator, and its extent so far. */
export class ModelBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  maxY = 0;

  private vertex([x, y, z]: Vec3, normal: Vec3, color: Rgb): void {
    this.positions.push(x, y, z);
    this.normals.push(...normal);
    this.colors.push(color[0], color[1], color[2], 1);
    this.minX = Math.min(this.minX, x);
    this.maxX = Math.max(this.maxX, x);
    this.minZ = Math.min(this.minZ, z);
    this.maxZ = Math.max(this.maxZ, z);
    this.maxY = Math.max(this.maxY, y);
  }

  /** A flat polygon (a triangle or a quad, corners in order) with the given normal. */
  face(corners: Vec3[], normal: Vec3, color: Rgb): void {
    const base = this.positions.length / 3;
    for (const corner of corners) this.vertex(corner, normal, color);
    for (let i = 1; i < corners.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
  }

  /** A flat polygon whose normal is worked out from its corners, turned to face `towards`'s side
   *  (up, for a roof). */
  faceToward(corners: Vec3[], towards: Vec3, color: Rgb): void {
    const [a, b, c] = corners;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n) || 1;
    n = [n[0] / length, n[1] / length, n[2] / length];
    if (n[0] * towards[0] + n[1] * towards[1] + n[2] * towards[2] < 0) n = [-n[0], -n[1], -n[2]];
    this.face(corners, n, color);
  }

  /** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1): its four sides and its top. No bottom -
   *  it stands on something. `top` defaults to the sides' colour. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: Rgb, top: Rgb = wall): void {
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], wall);
    this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], wall);
    this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], wall);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], wall);
    this.face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], top);
  }

  finish(door: { x: number; z: number }, tiles?: BuildingModel["tiles"]): BuildingModel {
    return {
      positions: this.positions,
      normals: this.normals,
      colors: this.colors,
      indices: this.indices,
      halfWidth: Math.max(Math.abs(this.minX), Math.abs(this.maxX)),
      halfDepth: Math.max(Math.abs(this.minZ), Math.abs(this.maxZ)),
      door,
      height: this.maxY,
      tiles,
    };
  }
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
