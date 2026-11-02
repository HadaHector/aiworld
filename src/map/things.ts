import { placedAxes, type BuildingGroup, type Placed } from "../world/buildings/buildingCollision";
import type { BuildingModel } from "../world/buildings/buildingTypes";
import type { TreeKindDef } from "../world/foliage/foliageConfig";
import type { TreeGroundProbe, TreePlacement, TreeScatter } from "../world/foliage/treeScatter";
import { generateTreeGeometry, kindSeed } from "../world/foliage/treeColliders";
import { generateBush } from "../world/foliage/treeGenerator";
import { generateBoulder } from "../world/foliage/boulderGenerator";
import { deriveSeed } from "../world/rng";
import type { Rgb } from "./tiles";

/**
 * The map's second pass (MAP.md, *Drawing a tile*): everything set down in the world, seen from
 * straight above with everything more than `cut` metres over its foot cut away - buildings and props
 * as their triangles, trees, bushes and rocks as their crowns' cross-sections.
 */
export interface MapThings {
  /** Every building, prop, wall, fence, bridge and sign, in their groups (WorldData.buildingGroups). */
  groups: readonly BuildingGroup[];
  /** Building materials' average colours, 0-1, by id; a missing one is drawn grey. */
  buildingColors: Readonly<Record<string, Rgb>>;
  scatterTrees?: TreeScatter;
  scatterBushes?: TreeScatter;
  scatterRocks?: TreeScatter;
  /** The probe the scatters ask about the ground (treeScatter.ts's samplerGround). */
  treeGround?: TreeGroundProbe;
  treeKinds: readonly TreeKindDef[];
  /** Each tree kind's leaves' and wood's average colours (a boulder's stone is its `leaves`). */
  treeColors: Readonly<Record<string, { leaves: Rgb; wood: Rgb }>>;
  seed: number;
  /** How high over a thing's foot it is cut, in metres. */
  cut: number;
  /** The same for trees, bushes and rocks - left out, `cut`. */
  treeCut?: number;
  /** Whether buildings are drawn from their near models (rooms and furniture) or their far ones. */
  near: boolean;
}

/** Where a tile's pixels are and what is already drawn in them. */
export interface MapCanvas {
  out: Uint8ClampedArray;
  /** The height of what is drawn at each pixel - the ground's own wherever nothing stands. */
  depth: Float32Array;
  size: number;
  x0: number;
  z0: number;
  step: number;
}

const GREY: Rgb = [0.6, 0.6, 0.6];
const LIGHT = normalize(-0.5, 1.4, -0.5);
/** Faces steeper than this (their normal's y below it) are walls: drawn as their top edge. */
const WALL = 0.25;
/** How far past a tile's edge a building may reach and still be looked at, before its model says. */
const HOUSE_REACH = 30;
/** How far past a tile's edge trees are scattered, so a crown over the edge is drawn on both sides. */
const CROWN_REACH = 45;
/** Generated models kept between tiles: neighbouring tiles share their houses. */
const MODEL_CACHE = 400;

function normalize(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

const models = new Map<Placed, BuildingModel>();
function modelOf(house: Placed, near: boolean): BuildingModel {
  let model = models.get(house);
  if (model) {
    // Most recent last, so the oldest goes first.
    models.delete(house);
  } else {
    model = house.model(!near);
    if (models.size >= MODEL_CACHE) models.delete(models.keys().next().value!);
  }
  models.set(house, model);
  return model;
}

/** Draws everything set down in the tile over what is drawn there. */
export function drawThings(canvas: MapCanvas, things: MapThings): void {
  const { x0, z0, step, size } = canvas;
  const x1 = x0 + size * step;
  const z1 = z0 + size * step;
  for (const group of things.groups) {
    for (const house of group.houses) {
      if (house.x < x0 - HOUSE_REACH || house.x > x1 + HOUSE_REACH || house.z < z0 - HOUSE_REACH || house.z > z1 + HOUSE_REACH) continue;
      const model = modelOf(house, things.near);
      const reach = Math.hypot(model.halfWidth, model.halfDepth) + 2;
      if (house.x < x0 - reach || house.x > x1 + reach || house.z < z0 - reach || house.z > z1 + reach) continue;
      drawModel(canvas, house, model, things);
    }
  }
  const probe = things.treeGround;
  if (!probe) return;
  const kinds = new Map(things.treeKinds.map((k) => [k.id, k]));
  for (const scatter of [things.scatterRocks, things.scatterBushes, things.scatterTrees]) {
    if (!scatter) continue;
    for (const tree of scatter(x0 - CROWN_REACH, z0 - CROWN_REACH, x1 + CROWN_REACH, z1 + CROWN_REACH, probe)) {
      const kind = kinds.get(tree.kind);
      if (kind) drawTree(canvas, tree, kind, things);
    }
  }
}

/** One model's triangles, from above, cut `things.cut` over its foot. */
function drawModel(canvas: MapCanvas, house: Placed, model: BuildingModel, things: MapThings): void {
  const axes = placedAxes(house);
  const p = model.positions;
  const count = p.length / 3;
  const wx = new Float64Array(count);
  const wy = new Float64Array(count);
  const wz = new Float64Array(count);
  for (let v = 0; v < count; v++) {
    const lx = p[v * 3];
    const ly = p[v * 3 + 1];
    const lz = p[v * 3 + 2];
    wx[v] = house.x + axes.x.x * lx + axes.y.x * ly + axes.z.x * lz;
    wy[v] = house.y + axes.x.y * lx + axes.y.y * ly + axes.z.y * lz;
    wz[v] = house.z + axes.x.z * lx + axes.y.z * ly + axes.z.z * lz;
  }
  const cutY = house.y + things.cut;
  const idx = model.indices;
  const poly: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    if (wy[a] > cutY && wy[b] > cutY && wy[c] > cutY) continue;
    // Its colour: the first corner's tint times its material's.
    const slot = model.materialSlots[a];
    const base = slot >= 0 ? (things.buildingColors[model.materials[slot]] ?? GREY) : [1, 1, 1];
    const cr = base[0] * model.colors[a * 4];
    const cg = base[1] * model.colors[a * 4 + 1];
    const cb = base[2] * model.colors[a * 4 + 2];
    // The face's normal, from its corners: which way it faces decides how it is lit, and whether it
    // is a wall.
    const ux = wx[b] - wx[a];
    const uy = wy[b] - wy[a];
    const uz = wz[b] - wz[a];
    const vx = wx[c] - wx[a];
    const vy = wy[c] - wy[a];
    const vz = wz[c] - wz[a];
    const [nx, ny, nz] = normalize(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const up = Math.abs(ny);
    clipBelow(poly, wx, wy, wz, a, b, c, cutY);
    if (poly.length < 9) continue;
    if (up < WALL) {
      const shade = 0.8;
      drawWallTop(canvas, poly, cr * shade, cg * shade, cb * shade);
    } else {
      // Lit as seen from above whichever way it was wound.
      const sign = ny < 0 ? -1 : 1;
      const lit = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) * sign;
      const shade = 1 + (lit - LIGHT[1]) * 0.9;
      for (let k = 3; k + 3 < poly.length; k += 3) fillTriangle(canvas, poly, 0, k, k + 3, cr * shade, cg * shade, cb * shade);
    }
  }
}

/** The triangle a, b, c clipped to y <= cutY, as a flat list of x, y, z into `poly`. */
function clipBelow(poly: number[], wx: Float64Array, wy: Float64Array, wz: Float64Array, a: number, b: number, c: number, cutY: number): void {
  poly.length = 0;
  const corners = [a, b, c];
  for (let k = 0; k < 3; k++) {
    const i = corners[k];
    const j = corners[(k + 1) % 3];
    const iIn = wy[i] <= cutY;
    const jIn = wy[j] <= cutY;
    if (iIn) poly.push(wx[i], wy[i], wz[i]);
    if (iIn !== jIn) {
      const t = (cutY - wy[i]) / (wy[j] - wy[i]);
      poly.push(wx[i] + (wx[j] - wx[i]) * t, cutY, wz[i] + (wz[j] - wz[i]) * t);
    }
  }
}

function put(canvas: MapCanvas, px: number, py: number, height: number, r: number, g: number, b: number): void {
  if (px < 0 || py < 0 || px >= canvas.size || py >= canvas.size) return;
  const i = py * canvas.size + px;
  if (height < canvas.depth[i]) return;
  canvas.depth[i] = height;
  const o = i * 4;
  canvas.out[o] = r * 255;
  canvas.out[o + 1] = g * 255;
  canvas.out[o + 2] = b * 255;
}

/** A triangle of `poly`'s corners i, j, k (offsets), each pixel whose centre it covers set where it
 *  stands higher than what is there. */
function fillTriangle(canvas: MapCanvas, poly: number[], i: number, j: number, k: number, r: number, g: number, b: number): void {
  const { x0, z0, step } = canvas;
  const ax = (poly[i] - x0) / step;
  const az = (poly[i + 2] - z0) / step;
  const bx = (poly[j] - x0) / step;
  const bz = (poly[j + 2] - z0) / step;
  const cx = (poly[k] - x0) / step;
  const cz = (poly[k + 2] - z0) / step;
  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(canvas.size - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minZ = Math.max(0, Math.floor(Math.min(az, bz, cz)));
  const maxZ = Math.min(canvas.size - 1, Math.ceil(Math.max(az, bz, cz)));
  for (let py = minZ; py <= maxZ; py++) {
    const sz = py + 0.5;
    for (let px = minX; px <= maxX; px++) {
      const sx = px + 0.5;
      const w0 = ((bx - sx) * (cz - sz) - (bz - sz) * (cx - sx)) / area;
      const w1 = ((cx - sx) * (az - sz) - (cz - sz) * (ax - sx)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      put(canvas, px, py, w0 * poly[i + 1] + w1 * poly[j + 1] + w2 * poly[k + 1], r, g, b);
    }
  }
}

/** A wall, which has no area from above: the line its clipped face makes on the ground, at least a
 *  pixel wide, as high as the face's top. */
function drawWallTop(canvas: MapCanvas, poly: number[], r: number, g: number, b: number): void {
  // The two corners furthest apart across the ground are the line's ends.
  let best = -1;
  let ea = 0;
  let eb = 0;
  let top = -Infinity;
  for (let i = 0; i < poly.length; i += 3) {
    if (poly[i + 1] > top) top = poly[i + 1];
    for (let j = i + 3; j < poly.length; j += 3) {
      const d = (poly[i] - poly[j]) ** 2 + (poly[i + 2] - poly[j + 2]) ** 2;
      if (d > best) {
        best = d;
        ea = i;
        eb = j;
      }
    }
  }
  const { x0, z0, step } = canvas;
  const ax = (poly[ea] - x0) / step;
  const az = (poly[ea + 2] - z0) / step;
  const bx = (poly[eb] - x0) / step;
  const bz = (poly[eb + 2] - z0) / step;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) * 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    put(canvas, Math.floor(ax + (bx - ax) * t), Math.floor(az + (bz - az) * t), top, r, g, b);
  }
}

/** A kind's crown seen from above under a cut: how wide its leaves and its wood reach out from the
 *  trunk below each height, in its model's own units. */
interface CrownProfile {
  /** Bins of BIN model units from the foot: the widest any leaf (wood) reaches at or below it. */
  leaves: Float32Array;
  wood: Float32Array;
}
const BIN = 0.25;
/** The share of a crown's leaves its drawn width takes in. */
const CROWN_SHARE = 0.95;
/** How far above and below a height (model units) wood counts towards its width there. */
const WOOD_BAND = 1;
const profiles = new Map<string, CrownProfile | null>();

function profileOf(kind: TreeKindDef, seed: number): CrownProfile | null {
  const cached = profiles.get(kind.id);
  if (cached !== undefined) return cached;
  const shape = kind.shape;
  const variantSeed = deriveSeed(kindSeed(seed, kind.id), 1);
  // Leaves as their cards' middles: a card's corners reach far past the crown it stands for. Wood
  // as its vertices; a stone as its corners.
  let leaves: number[] = [];
  let wood: ArrayLike<number> = [];
  if (shape.model === "branching" || shape.model === "conifer") {
    const geometry = generateTreeGeometry(shape, variantSeed, "near");
    leaves = middles(geometry.leaves.positions, geometry.leaves.indices);
    wood = geometry.wood.positions;
  } else if (shape.model === "bush") {
    const geometry = generateBush(shape, variantSeed, 0, "near");
    leaves = middles(geometry.leaves.positions, geometry.leaves.indices);
  } else if (shape.model === "boulder") {
    leaves = Array.from(generateBoulder(shape, variantSeed, "far").positions);
  }
  let top = 0;
  for (const list of [leaves, wood]) for (let i = 1; i < list.length; i += 3) top = Math.max(top, list[i]);
  if (top <= 0) {
    profiles.set(kind.id, null);
    return null;
  }
  const bins = Math.ceil(top / BIN) + 1;
  // Leaves: how far nearly all of them (CROWN_SHARE) reach at or below each height - a stray card
  // low down does not make a crown - never narrowing going up, since what is seen from above is
  // everything under the cut.
  const leafReach = new Float32Array(bins);
  const byHeight: number[][] = Array.from({ length: bins }, () => []);
  for (let i = 0; i < leaves.length; i += 3) byHeight[Math.max(0, Math.min(bins - 1, Math.floor(leaves[i + 1] / BIN)))].push(Math.hypot(leaves[i], leaves[i + 2]));
  const below: number[] = [];
  for (let b = 0; b < bins; b++) {
    below.push(...byHeight[b]);
    below.sort((p, q) => p - q);
    const share = below.length ? below[Math.min(below.length - 1, Math.floor(below.length * CROWN_SHARE))] : 0;
    leafReach[b] = Math.max(share, b > 0 ? leafReach[b - 1] : 0);
  }
  // Wood: the trunk's (or the limbs') width right at each height - the middle of the wood's reach
  // there, so roots spread on the ground and a limb reaching out do not count.
  const woodReach = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const y = (b + 0.5) * BIN;
    const near: number[] = [];
    for (let i = 0; i < wood.length; i += 3) if (Math.abs(wood[i + 1] - y) < WOOD_BAND) near.push(Math.hypot(wood[i], wood[i + 2]));
    near.sort((p, q) => p - q);
    woodReach[b] = near.length ? near[near.length >> 1] : 0;
  }
  const profile = { leaves: leafReach, wood: woodReach };
  profiles.set(kind.id, profile);
  return profile;
}

/** Each triangle's middle, as x, y, z in turn. */
function middles(positions: ArrayLike<number>, indices: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    out.push((positions[a] + positions[b] + positions[c]) / 3, (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3, (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3);
  }
  return out;
}

/** A tree, bush or rock: its wood's disc, then its leaves' over it, each as wide as it reaches under
 *  the cut, shaded as a dome so a wood reads as many crowns. */
function drawTree(canvas: MapCanvas, tree: TreePlacement, kind: TreeKindDef, things: MapThings): void {
  const profile = profileOf(kind, things.seed);
  if (!profile) return;
  const scale = tree.scale;
  const cut = things.treeCut ?? things.cut;
  const bin = Math.min(profile.leaves.length - 1, Math.floor(cut / scale / BIN));
  const colors = things.treeColors[kind.id] ?? { leaves: [0.3, 0.45, 0.22], wood: [0.35, 0.27, 0.2] };
  const top = Math.min(tree.y + cut, tree.y + (profile.leaves.length - 1) * BIN * scale);
  const tint = kind.tint[0].map((c, i) => c + (kind.tint[1][i] - c) * tree.tint) as unknown as Rgb;
  if (tree.stump) {
    drawDisc(canvas, tree.x, tree.z, Math.max(profile.wood[1] ?? 0, 0.2) * scale, tree.y + 0.5, colors.wood, [1, 1, 1]);
    return;
  }
  const wood = profile.wood[bin] * scale;
  if (wood > 0) drawDisc(canvas, tree.x, tree.z, wood, top - 0.01, colors.wood, [1, 1, 1]);
  const leaves = profile.leaves[bin] * scale;
  if (leaves > 0) drawDisc(canvas, tree.x, tree.z, leaves, top, colors.leaves, tint);
}

function drawDisc(canvas: MapCanvas, x: number, z: number, radius: number, height: number, color: Rgb, tint: Rgb): void {
  const { x0, z0, step } = canvas;
  const cx = (x - x0) / step;
  const cz = (z - z0) / step;
  const rp = Math.max(0.5, radius / step);
  const minX = Math.max(0, Math.floor(cx - rp));
  const maxX = Math.min(canvas.size - 1, Math.ceil(cx + rp));
  const minZ = Math.max(0, Math.floor(cz - rp));
  const maxZ = Math.min(canvas.size - 1, Math.ceil(cz + rp));
  for (let py = minZ; py <= maxZ; py++) {
    for (let px = minX; px <= maxX; px++) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cz) / rp;
      if (d > 1) continue;
      // A dome lit from the north-west: brighter towards the light, darker at the rim.
      const lx = (px + 0.5 - cx) / rp;
      const lz = (py + 0.5 - cz) / rp;
      const dome = Math.sqrt(1 - d * d);
      const shade = 0.62 + 0.38 * dome - 0.18 * (lx + lz) * 0.5;
      put(canvas, px, py, height - (1 - dome) * radius * 0.5, color[0] * tint[0] * shade, color[1] * tint[1] * shade, color[2] * tint[2] * shade);
    }
  }
}
