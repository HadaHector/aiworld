// Two underground scenes for the collision sandbox and its probe (DUNGEONS.md, step 1): a cave of
// two chambers and a tunnel down between them, meshed from a distance field, and a crypt corridor
// of boxes with a stair down - both under a slab of ground, 3 m deep, as the game's will be.
import { vec3, type ShapeDesc } from "../world/collision/index";
import { fieldAt, sampleField, surfaceNets, type SampledField } from "../world/dungeons/surfaceNets";

/** The ground's depth over a dungeon: solid only this far under its surface. */
export const SLAB_DEPTH = 3;

/** Ground at about y = 0, a slab `SLAB_DEPTH` deep, `size` metres square about (cx, cz). */
export function slabGround(size: number, cx = 0, cz = 0, cell = 4): ShapeDesc {
  const count = size / cell + 1;
  const heights: number[] = [];
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    const x = cx - size / 2 + col * cell, z = cz - size / 2 + row * cell;
    heights.push(Math.sin(x * 0.05) * Math.cos(z * 0.04) * 1.5);
  }
  return { kind: "heightfield", originX: cx - size / 2, originZ: cz - size / 2, cell, columns: count, rows: count, heights, depth: SLAB_DEPTH };
}

// --- The cave -------------------------------------------------------------------------------

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const s = (t: number): number => t * t * (3 - 2 * t);
  const u = s(x - xi), v = s(y - yi), w = s(z - zi);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r * 2 - 1;
}

const smoothMin = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

interface Chamber { c: [number, number, number]; r: [number, number, number] }
const CHAMBERS: Chamber[] = [
  { c: [0, -22, 0], r: [14, 9, 12] },
  { c: [48, -30, 4], r: [16, 10, 14] },
];
const floorOf = (ch: Chamber): number => ch.c[1] - ch.r[1] * 0.55;
const TUNNEL_RADIUS = 4.2;
/** On a chamber's floor most of the way to its wall, toward another point: where a tunnel joins it. */
function socket(ch: Chamber, toward: readonly number[]): [number, number, number] {
  const dx = toward[0] - ch.c[0], dz = toward[2] - ch.c[2], l = Math.hypot(dx, dz);
  return [ch.c[0] + (dx / l) * ch.r[0] * 0.75, floorOf(ch) + TUNNEL_RADIUS * 0.7, ch.c[2] + (dz / l) * ch.r[2] * 0.75];
}
const TUNNEL = [socket(CHAMBERS[0], CHAMBERS[1].c), socket(CHAMBERS[1], CHAMBERS[0].c)];

/** Feet a little over the first chamber's floor; the second chamber's floor, along +x from it. */
export const CAVE_START = vec3(0, floorOf(CHAMBERS[0]) + 1.5, 0);
export const CAVE_END = vec3(48, floorOf(CHAMBERS[1]), 4);

/** The rock's distance: positive in the rock. */
function rock(x: number, y: number, z: number): number {
  let d = Infinity;
  for (const ch of CHAMBERS) {
    const qx = (x - ch.c[0]) / ch.r[0], qy = (y - ch.c[1]) / ch.r[1], qz = (z - ch.c[2]) / ch.r[2];
    const e = Math.max((Math.hypot(qx, qy, qz) - 1) * Math.min(...ch.r), floorOf(ch) - y);
    d = smoothMin(d, e, 3);
  }
  const [a, b] = TUNNEL;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
  const px = a[0] + ab[0] * t, py = a[1] + ab[1] * t, pz = a[2] + ab[2] * t;
  const tunnel = Math.max(Math.hypot(x - px, y - py, z - pz) - TUNNEL_RADIUS, py - TUNNEL_RADIUS * 0.6 - y);
  d = smoothMin(d, tunnel, 2.5);
  // Rough walls: two octaves, under a metre.
  return d + valueNoise(x * 0.35, y * 0.35, z * 0.35) * 0.6 + valueNoise(x * 1.1, y * 1.1, z * 1.1) * 0.2;
}

export interface CaveScene {
  shapes: ShapeDesc[];
  field: SampledField;
  /** How long sampling and meshing took. */
  ms: number;
}

let cave: CaveScene | null = null;

/** The cave, made once: the rock's mesh (with the sampled field as its inside test) under the ground. */
export function caveScene(voxel = 0.75): CaveScene {
  if (cave && cave.field.cell === voxel) return cave;
  const started = performance.now();
  const field = sampleField(rock, [-20, -45, -18], [70, -9, 24], voxel);
  const mesh = surfaceNets(field);
  const shapes: ShapeDesc[] = [
    slabGround(160, 24, 3),
    { kind: "mesh", positions: mesh.positions, indices: mesh.indices, inside: (p) => fieldAt(field, p.x, p.y, p.z) > 0 },
  ];
  cave = { shapes, field, ms: performance.now() - started };
  return cave;
}

// --- The crypt corridor ---------------------------------------------------------------------

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ShapeDesc => ({
  kind: "box",
  center: vec3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
  half: vec3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2),
});

/** The crypt's floor before and after the stair, and where the corridor ends. */
export const CRYPT = { top: -12, bottom: -15, stairFrom: 24, stairTo: 30, end: 44, halfWidth: 3, height: 6 };

/**
 * A corridor 6 m wide and 6 m high along +x, twelve steps of 0.25 m down half-way: floor, walls,
 * vault and ends as boxes, as a kit-built part's colliders will be.
 */
export function cryptScene(): ShapeDesc[] {
  const { top, bottom, stairFrom, stairTo, end, halfWidth: w, height: h } = CRYPT;
  const shapes: ShapeDesc[] = [slabGround(100, 20, 0)];
  shapes.push(box(-6, top - 1, -w, stairFrom, top, w), box(stairTo, bottom - 1, -w, end, bottom, w));
  const steps = 12, rise = (top - bottom) / steps, tread = (stairTo - stairFrom) / steps;
  for (let s = 0; s < steps; s++) {
    const y = top - (s + 1) * rise;
    shapes.push(box(stairFrom + s * tread, bottom - 1, -w, stairFrom + (s + 1) * tread, y, w));
  }
  for (const side of [-1, 1]) shapes.push(box(-7, bottom - 1, side > 0 ? w : -w - 1, end + 1, top + h + 1, side > 0 ? w + 1 : -w));
  // The vault steps down where the stair ends, never less than 6 m over the floor.
  shapes.push(box(-6, top + h, -w, stairTo, top + h + 1, w));
  shapes.push(box(stairTo, bottom + h, -w, end, top + h + 1, w));
  shapes.push(box(-7, bottom - 1, -w, -6, top + h + 1, w), box(end, bottom - 1, -w, end + 1, top + h + 1, w));
  return shapes;
}
