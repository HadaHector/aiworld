import type { BuildingModel, ModelLight, Paint, Rgb } from "./buildingTypes";

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
  lights: ModelLight[] = [];
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  maxY = 0;

  /** `measure`: only how far it reaches is kept - no geometry - for a house measured for its plot
   *  before it is built. */
  /** Only measuring: how far it reaches is kept, no geometry (see the constructor). */
  readonly measure: boolean;

  constructor(measure = false) {
    this.measure = measure;
  }

  private slotOf(material: string | null): number {
    if (material === null) return -1;
    let slot = this.materials.indexOf(material);
    if (slot < 0) {
      slot = this.materials.length;
      this.materials.push(material);
    }
    return slot;
  }

  /** A flat polygon (corners in order, convex) with the given normal. Its texture is laid from
   *  `origin` (the world's origin, if none) - a beam's cut end centred on the beam. */
  face(corners: Vec3[], normal: Vec3, paint: Paint, grain?: Vec3, origin?: Vec3): void {
    this.surface(corners, corners.map(() => normal), normal, paint, grain, origin);
  }

  /** A flat polygon whose texture is laid by hand: `uvs`, one per corner, in its material's own
   *  units (a material one unit across: 0-1 over the texture once) - a door leaf, its texture drawn
   *  to fit it whatever its size. */
  mapped(corners: Vec3[], normal: Vec3, paint: Paint, uvs: [number, number][]): void {
    const start = this.positions.length / 3;
    this.face(corners, normal, paint);
    if (this.measure) return;
    for (let i = 0; i < corners.length; i++) {
      this.uvs[(start + i) * 2] = uvs[i][0];
      this.uvs[(start + i) * 2 + 1] = uvs[i][1];
    }
  }

  /**
   * A polygon laid entirely by hand: a normal, a tangent (the way its texture's u runs) and texture
   * coordinates (metres, as everywhere else) per corner - a strip of a round log, shaded smooth
   * round it and its bark wrapped round it without a seam.
   */
  raw(corners: Vec3[], normals: Vec3[], tangents: Vec3[], uvs: [number, number][], paint: Paint): void {
    for (const [x, y, z] of corners) {
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z);
      this.maxZ = Math.max(this.maxZ, z);
      this.maxY = Math.max(this.maxY, y);
    }
    if (this.measure) return;
    const slot = this.slotOf(paint.material);
    const base = this.positions.length / 3;
    for (let i = 0; i < corners.length; i++) {
      this.positions.push(...corners[i]);
      this.normals.push(...normals[i]);
      this.tangents.push(...tangents[i]);
      this.uvs.push(uvs[i][0], uvs[i][1]);
      this.colors.push(paint.tint[0], paint.tint[1], paint.tint[2], 1);
      this.materialSlots.push(slot);
    }
    this.fan(base, corners, normals);
  }

  /**
   * A polygon's triangles, a fan from its first corner - wound counter-clockwise seen from the side
   * its normals face, whichever way round its corners were given, so every face is wound the same
   * way - so the faces could be drawn one-sided. (A polygon a little concave - a log wall's gable
   * piece - still leaves one backward sliver of its fan.)
   */
  private fan(base: number, corners: Vec3[], normals: Vec3[]): void {
    // Its corners' own turn (Newell's sum), against the way its normals say it faces.
    let turn = 0;
    const facing: Vec3 = [0, 0, 0];
    for (const n of normals) for (let k = 0; k < 3; k++) facing[k] += n[k];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      turn += (a[1] - b[1]) * (a[2] + b[2]) * facing[0] + (a[2] - b[2]) * (a[0] + b[0]) * facing[1] + (a[0] - b[0]) * (a[1] + b[1]) * facing[2];
    }
    for (let i = 1; i < corners.length - 1; i++) {
      if (turn >= 0) this.indices.push(base, base + i, base + i + 1);
      else this.indices.push(base, base + i + 1, base + i);
    }
  }

  /**
   * A polygon that may be a little bent - a cell of a sagging roof - shaded by a normal per corner,
   * but textured in the frame of `frame` (the normal of the flat surface it is bent from), so the
   * cells of one surface share one frame and its texture runs across them unbroken.
   */
  surface(corners: Vec3[], normals: Vec3[], frame: Vec3, paint: Paint, grain?: Vec3, origin?: Vec3): void {
    if (this.measure) {
      for (const [x, y, z] of corners) {
        this.minX = Math.min(this.minX, x);
        this.maxX = Math.max(this.maxX, x);
        this.minZ = Math.min(this.minZ, z);
        this.maxZ = Math.max(this.maxZ, z);
        this.maxY = Math.max(this.maxY, y);
      }
      return;
    }
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
      const from: Vec3 = origin ? [x - origin[0], y - origin[1], z - origin[2]] : corner;
      this.uvs.push(dot(from, u), dot(from, v));
      this.colors.push(paint.tint[0], paint.tint[1], paint.tint[2], 1);
      this.materialSlots.push(slot);
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z);
      this.maxZ = Math.max(this.maxZ, z);
      this.maxY = Math.max(this.maxY, y);
    }
    this.fan(base, corners, normals);
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

  /**
   * Another model laid into this one: stood at (x, y, z), its front (+z) turned toward (frontX,
   * frontZ) - its +x to (frontZ, -frontX), as a house is turned - its materials joined to this one's.
   * How a piece of furniture becomes part of the house it stands in.
   */
  append(model: BuildingModel, x: number, y: number, z: number, frontX: number, frontZ: number): void {
    const place = (px: number, py: number, pz: number): Vec3 => [x + frontZ * px + frontX * pz, y + py, z - frontX * px + frontZ * pz];
    const turn = (dx: number, dy: number, dz: number): Vec3 => [frontZ * dx + frontX * dz, dy, -frontX * dx + frontZ * dz];
    const base = this.positions.length / 3;
    const count = model.positions.length / 3;
    for (let v = 0; v < count; v++) {
      const [px, py, pz] = place(model.positions[v * 3], model.positions[v * 3 + 1], model.positions[v * 3 + 2]);
      this.minX = Math.min(this.minX, px);
      this.maxX = Math.max(this.maxX, px);
      this.minZ = Math.min(this.minZ, pz);
      this.maxZ = Math.max(this.maxZ, pz);
      this.maxY = Math.max(this.maxY, py);
      if (this.measure) continue;
      this.positions.push(px, py, pz);
      this.normals.push(...turn(model.normals[v * 3], model.normals[v * 3 + 1], model.normals[v * 3 + 2]));
      this.tangents.push(...turn(model.tangents[v * 3], model.tangents[v * 3 + 1], model.tangents[v * 3 + 2]));
      this.uvs.push(model.uvs[v * 2], model.uvs[v * 2 + 1]);
      this.colors.push(model.colors[v * 4], model.colors[v * 4 + 1], model.colors[v * 4 + 2], model.colors[v * 4 + 3]);
      const slot = model.materialSlots[v];
      this.materialSlots.push(slot < 0 ? -1 : this.slotOf(model.materials[slot]));
    }
    if (this.measure) return;
    for (const index of model.indices) this.indices.push(base + index);
    for (const light of model.lights ?? []) this.lights.push({ ...light, position: place(...light.position) });
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
      ...(this.lights.length ? { lights: this.lights } : {}),
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
