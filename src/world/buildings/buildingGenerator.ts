import { deriveSeed, mulberry32 } from "../rng";
import type { BoxesSpec, BuildingDef, BuildingModel, Rgb } from "./buildingTypes";

/** How far below its floor a building reaches, so it never stands on air at the edge of its plot. */
export const FOUNDATION_DEPTH = 1.2;

/** Geometry being built up, and its extent so far. */
class ModelBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;
  maxY = 0;

  quad(corners: [number, number, number][], normal: [number, number, number], color: Rgb): void {
    const base = this.positions.length / 3;
    for (const [x, y, z] of corners) {
      this.positions.push(x, y, z);
      this.normals.push(...normal);
      this.colors.push(color[0], color[1], color[2], 1);
      this.minX = Math.min(this.minX, x);
      this.maxX = Math.max(this.maxX, x);
      this.minZ = Math.min(this.minZ, z);
      this.maxZ = Math.max(this.maxZ, z);
      this.maxY = Math.max(this.maxY, y);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** An axis-aligned box from (x0, y0, z0) to (x1, y1, z1): its four sides and its top, each
   *  wound to face outward. No bottom - it stands in the ground. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wall: Rgb, top: Rgb): void {
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], wall);
    this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], wall);
    this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], wall);
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], wall);
    this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], top);
  }

  finish(door: { x: number; z: number }): BuildingModel {
    return {
      positions: this.positions,
      normals: this.normals,
      colors: this.colors,
      indices: this.indices,
      halfWidth: Math.max(Math.abs(this.minX), Math.abs(this.maxX)),
      halfDepth: Math.max(Math.abs(this.minZ), Math.abs(this.maxZ)),
      door,
      height: this.maxY,
    };
  }
}

function roll(range: [number, number], rng: () => number): number {
  return range[0] + (range[1] - range[0]) * rng();
}

function pick<T>(list: T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

/** The placeholder: a main box, a door-sized dark patch in the middle of its front, and smaller
 *  boxes against its sides and back. */
function buildBoxes(spec: BoxesSpec, rng: () => number): BuildingModel {
  const b = new ModelBuilder();
  const hw = roll(spec.width, rng) / 2;
  const hd = roll(spec.depth, rng) / 2;
  const height = roll(spec.height, rng);
  b.box(-hw, -FOUNDATION_DEPTH, -hd, hw, height, hd, pick(spec.walls, rng), pick(spec.tops, rng));

  // The door: just proud of the front, so it is never lost in the wall.
  const door: Rgb = [0.18, 0.13, 0.1];
  const doorHalf = Math.min(0.55, hw * 0.3);
  const doorTop = Math.min(2.2, height - 0.3);
  b.quad([[-doorHalf, 0, hd + 0.03], [doorHalf, 0, hd + 0.03], [doorHalf, doorTop, hd + 0.03], [-doorHalf, doorTop, hd + 0.03]], [0, 0, 1], door);

  // Annexes on the left, right and back - never the front, which the door and the street have.
  const count = Math.round(roll(spec.annexes, rng));
  const sides = [0, 1, 2];
  for (let i = sides.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sides[i], sides[j]] = [sides[j], sides[i]];
  }
  sides.length = Math.min(3, count);
  for (const side of sides) {
    const share = roll(spec.annexSize, rng);
    const annexHeight = height * roll([0.45, 0.8], rng);
    const wall = pick(spec.walls, rng);
    const top = pick(spec.tops, rng);
    if (side === 2) {
      // Back: as wide as a share of the main box, sliding along it.
      const w = hw * share;
      const d = hd * share;
      const at = (rng() * 2 - 1) * (hw - w);
      b.box(at - w, -FOUNDATION_DEPTH, -hd - d * 2, at + w, annexHeight, -hd, wall, top);
    } else {
      const sign = side === 0 ? -1 : 1;
      const w = hw * share;
      const d = hd * share;
      const at = (rng() * 2 - 1) * (hd - d);
      const inner = sign * hw;
      const outer = sign * (hw + w * 2);
      b.box(Math.min(inner, outer), -FOUNDATION_DEPTH, at - d, Math.max(inner, outer), annexHeight, at + d, wall, top);
    }
  }
  return b.finish({ x: 0, z: hd });
}

/**
 * Builds one variant of a building. The same building, seed and variant always give the same
 * model, wherever it is asked for - the workbench and the world agree.
 */
export function generateBuilding(def: BuildingDef, seed: number, variant: number): BuildingModel {
  let hash = 0;
  for (let i = 0; i < def.id.length; i++) hash = (Math.imul(hash, 31) + def.id.charCodeAt(i)) | 0;
  const rng = mulberry32(deriveSeed(deriveSeed(seed, hash), variant));
  switch (def.generator) {
    case "boxes":
      return buildBoxes(def.boxes!, rng);
  }
}
