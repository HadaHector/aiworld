import type { TreeKindDef } from "./foliageConfig";
import type { TreePlacement } from "./treeScatter";
import { generateConifer, generateTree, type TreeDetail, type TreeGeometry } from "./treeGenerator";
import { deriveSeed } from "../rng";
import { convexHull } from "../collision/hull";
import { Layers, type ConvexDesc } from "../collision/shapes";
import type { Vec3 } from "../collision/vec";

/**
 * What trees put in the way, without drawing them - shared by the drawn trees (treeField.ts) and
 * the simulation, which has no Babylon (see SIMULATION.md). The hulls come from the same generator
 * the drawn models do, so both halves collide with the same trees.
 */

/** One convex piece of a tree: its hull's corners (x, y, z in turn) and triangles, counter-clockwise
 *  seen from outside. */
export interface TreeCollider {
  corners: Float32Array;
  triangles: Uint16Array;
}

/** One variant's pieces, in tree space: standing, and felled to its stump. */
export interface VariantHulls {
  near: TreeCollider[];
  stump: TreeCollider[];
}

/** Every kind with collision's variants' hulls, by kind id. Kinds that are not here stand in nobody's way. */
export type TreeHulls = Map<string, VariantHulls[]>;

/** How high a tree is sawn off, in metres - about the knee, at the world's twice life size. */
export const STUMP_HEIGHT = 0.9;

/** The seed a kind's models are generated from. */
export function kindSeed(seed: number, id: string): number {
  return deriveSeed(seed, [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7));
}

/** Where a kind's stump is cut, as a share of its model's own height. */
export function stumpCut(def: TreeKindDef): number {
  return Math.max(0.15, STUMP_HEIGHT / ((def.scale[0] + def.scale[1]) / 2));
}

/** A generated (branching or conifer) kind's geometry; with `cut`, its stump, sawn off that high. */
export function generateTreeGeometry(
  shape: Extract<TreeKindDef["shape"], { model: "branching" | "conifer" }>,
  seed: number,
  detail: TreeDetail,
  cut?: number,
): TreeGeometry {
  return shape.model === "conifer" ? generateConifer(shape, seed, detail, cut ?? null) : generateTree(shape, seed, detail, cut ?? null);
}

/** A piece's hull, worked out once so a tree placed in the world only has to move its corners. */
export function hullPiece(corners: Float32Array): TreeCollider {
  const points = [];
  for (let i = 0; i < corners.length; i += 3) points.push({ x: corners[i], y: corners[i + 1], z: corners[i + 2] });
  const hull = convexHull(points);
  return { corners: new Float32Array(hull.points.flatMap((p) => [p.x, p.y, p.z])), triangles: Uint16Array.from(hull.triangles) };
}

/**
 * Every generated kind's hulls, generated here - for whoever has no drawn models to take them from
 * (the simulation). Bushes, boulders and primitive trees have none.
 */
export function generateTreeHulls(treeKinds: readonly TreeKindDef[], seed: number): TreeHulls {
  const hulls: TreeHulls = new Map();
  for (const def of treeKinds) {
    const shape = def.shape;
    if (shape.model !== "branching" && shape.model !== "conifer") continue;
    const ownSeed = kindSeed(seed, def.id);
    const cut = stumpCut(def);
    const variants: VariantHulls[] = [];
    for (let variant = 0; variant < shape.variants; variant++) {
      const variantSeed = deriveSeed(ownSeed, variant + 1);
      variants.push({
        near: generateTreeGeometry(shape, variantSeed, "near").colliders.map(hullPiece),
        stump: generateTreeGeometry(shape, variantSeed, "near", cut).colliders.map(hullPiece),
      });
    }
    hulls.set(def.id, variants);
  }
  return hulls;
}

/** Which of `variants` models a tree is: its own, or hashed from where it stands, so it is the same
 *  tree every time its chunk is built. The drawn trees pick theirs the same way (treeField.ts). */
export function treeVariant(tree: TreePlacement, variants: number): number {
  if (tree.variant !== undefined) return tree.variant % variants;
  if (variants === 1) return 0;
  const hash = (Math.imul(Math.floor(tree.x * 8), 0x27d4eb2d) ^ Math.imul(Math.floor(tree.z * 8), 0x165667b1)) >>> 0;
  return (hash >>> 7) % variants;
}

/**
 * A tree's transform as a function on points of its model: scaled, spun about Y, tipped onto the
 * slope if it leans, and moved into place - the same transform it is drawn with.
 */
export function treeTransform(tree: TreePlacement): (x: number, y: number, z: number) => Vec3 {
  // The spin about Y, as a quaternion (0, sy, 0, cy).
  const sy = Math.sin(tree.rotation / 2);
  const cy = Math.cos(tree.rotation / 2);
  let qx = 0;
  let qy = sy;
  let qz = 0;
  let qw = cy;
  if (tree.lean) {
    // The turn taking up (0, 1, 0) to the ground's normal - about (nz, 0, -nx) - applied after the spin.
    let nx = -tree.lean[0];
    let ny = 1;
    let nz = -tree.lean[1];
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    let tx = nz;
    let tz = -nx;
    let tw = 1 + ny;
    const tl = Math.hypot(tx, tz, tw);
    tx /= tl;
    tz /= tl;
    tw /= tl;
    // t * q, with t = (tx, 0, tz, tw) and q = (0, sy, 0, cy).
    qx = tw * 0 + tx * cy + 0 * 0 - tz * sy;
    qy = tw * sy - tx * 0 + 0 * cy + tz * 0;
    qz = tw * 0 + tx * sy - 0 * 0 + tz * cy;
    qw = tw * cy - tx * 0 - 0 * sy - tz * 0;
  }
  const s = tree.scale;
  const m00 = (1 - 2 * (qy * qy + qz * qz)) * s;
  const m01 = 2 * (qx * qy - qz * qw) * s;
  const m02 = 2 * (qx * qz + qy * qw) * s;
  const m10 = 2 * (qx * qy + qz * qw) * s;
  const m11 = (1 - 2 * (qx * qx + qz * qz)) * s;
  const m12 = 2 * (qy * qz - qx * qw) * s;
  const m20 = 2 * (qx * qz - qy * qw) * s;
  const m21 = 2 * (qy * qz + qx * qw) * s;
  const m22 = (1 - 2 * (qx * qx + qy * qy)) * s;
  return (x, y, z) => ({
    x: m00 * x + m01 * y + m02 * z + tree.x,
    y: m10 * x + m11 * y + m12 * z + tree.y,
    z: m20 * x + m21 * y + m22 * z + tree.z,
  });
}

/** What these trees put in the way, in world space: each tree's convex pieces, ready for a collision
 *  world. A felled tree is its stump's pieces. */
export function treeColliders(hulls: TreeHulls, trees: readonly TreePlacement[]): ConvexDesc[] {
  const pieces: ConvexDesc[] = [];
  for (const tree of trees) {
    const variants = hulls.get(tree.kind);
    if (!variants || variants.length === 0) continue;
    const variant = variants[treeVariant(tree, variants.length)];
    const own = tree.stump ? variant.stump : variant.near;
    if (own.length === 0) continue;
    const place = treeTransform(tree);
    for (const hull of own) {
      const points: Vec3[] = [];
      for (let i = 0; i < hull.corners.length; i += 3) points.push(place(hull.corners[i], hull.corners[i + 1], hull.corners[i + 2]));
      // Moved, turned and scaled evenly, a hull is still one, with the same faces. Trees stop a body
      // and a shot but not sight: a spell can be aimed through a wood (see ABILITIES.md, *Casting*).
      pieces.push({ kind: "convex", points, triangles: hull.triangles, layers: Layers.solid | Layers.shot });
    }
  }
  return pieces;
}
