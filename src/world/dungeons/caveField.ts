// The field builder (DUNGEONS.md, *Building it*): a cave's parts as shapes in one signed-distance
// field - chambers and tunnels, each part's sockets opened by a short stub of tunnel reaching past
// them, so joined parts' shapes overlap and blend with no seam - roughened by the style's noise,
// sampled in chunks round the parts only and meshed by surface nets. Pure: the server builds the
// same rock (its colliders) as the page draws.
import type { Aabb, Vec3 } from "../collision/vec";
import type { ShapeDesc } from "../collision/index";
import type { DungeonPartDef, DungeonStyleDef, SocketDef } from "./dungeonDefs";
import type { DungeonLayout, PlacedPart } from "./layout";
import { deriveSeed, mulberry32 } from "../rng";

/** A chamber: a dome on a flat floor, `radius` across (x, z) at the floor, `height` over it at the middle. */
export interface ChamberShape {
  kind: "chamber";
  at: Vec3;
  radius: [number, number];
  height: number;
}

/** A tunnel along floor-level `points`, `width` across at the floor and `height` high at its middle. */
export interface TunnelShape {
  kind: "tunnel";
  points: Vec3[];
  width: number;
  height: number;
}

export type FieldShape = ChamberShape | TunnelShape;

/** The rock's roughness: octaves of value noise, each `scale` (per metre) and `amount` (metres). */
export interface FieldNoise {
  scale: number;
  amount: number;
}

/** How far past a socket its stub reaches into the part beyond, and in from it into its own. */
const STUB_OUT = 3;
const STUB_IN = 6;
/** How softly shapes blend into each other, metres. */
const BLEND = 2.5;
/** What a point far from every shape reads: rock. */
const ROCK = 8;
/** A floor's own roughness, as a share of the walls'. */
const FLOOR_ROUGH = 0.15;
/** A dome's middle sits this share of its height over its floor (its lower part cut off by the floor). */
const DOME_DROP = 0.2;

// --- Noise ----------------------------------------------------------------------------------

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, -1 to 1. */
export function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const s = (t: number): number => t * t * (3 - 2 * t);
  const u = s(x - xi), v = s(y - yi), w = s(z - zi);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r * 2 - 1;
}

/** How far the noise may move a surface, at most. */
export const noiseReach = (noise: readonly FieldNoise[]): number => noise.reduce((s, n) => s + n.amount, 0);

const smoothMin = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smoothMax = (a: number, b: number, k: number): number => -smoothMin(-a, -b, k);

// --- Shapes ---------------------------------------------------------------------------------

/** A part's shapes with its sockets' stubs (all but a `surface` one), in its own frame; `out`, how
 *  far the stubs reach on past their sockets (none, for the part's own bounds). */
export function partShapes(part: Pick<DungeonPartDef, "field" | "sockets">, out = STUB_OUT): FieldShape[] {
  const shapes: FieldShape[] = [...(part.field ?? [])];
  for (const s of part.sockets) {
    if (s.type === "surface") continue;
    // A tunnel ending at the socket goes on past it itself (its floor as it is, sloping or not);
    // anything else - a chamber's wall - is opened by a stub.
    const i = shapes.findIndex((t) => t.kind === "tunnel" && [t.points[0], t.points[t.points.length - 1]].some((e) => Math.hypot(e.x - s.at.x, e.y - s.at.y, e.z - s.at.z) < 0.5));
    if (i < 0) {
      shapes.push(stubOf(s, out));
      continue;
    }
    if (out <= 0) continue;
    const t = shapes[i] as TunnelShape;
    const f = (s.facing * Math.PI) / 180;
    const past = { x: s.at.x + Math.sin(f) * out, y: s.at.y, z: s.at.z + Math.cos(f) * out };
    const atStart = Math.hypot(t.points[0].x - s.at.x, t.points[0].y - s.at.y, t.points[0].z - s.at.z) < 0.5;
    shapes[i] = { ...t, points: atStart ? [past, ...t.points] : [...t.points, past] };
  }
  return shapes;
}

/** A socket's stub: in from it along the floor, and out past it into the part beyond. */
function stubOf(s: SocketDef, out: number): TunnelShape {
  const f = (s.facing * Math.PI) / 180;
  const ox = Math.sin(f), oz = Math.cos(f);
  return {
    kind: "tunnel",
    points: [
      { x: s.at.x - ox * STUB_IN, y: s.at.y, z: s.at.z - oz * STUB_IN },
      { x: s.at.x + ox * out, y: s.at.y, z: s.at.z + oz * out },
    ],
    width: s.size[0],
    height: s.size[1],
  };
}

/**
 * A field part's bounds: round its shapes and stubs, grown by `grow`, but never past a socket's
 * plane (the part beyond starts there; what bulges over it blends into that part's stub).
 */
export function fieldPartBounds(part: Pick<DungeonPartDef, "field" | "sockets">, grow: number): Aabb {
  const b = fieldBounds(partShapes(part, 0), grow);
  for (const s of part.sockets) {
    const f = (s.facing * Math.PI) / 180;
    const ox = Math.round(Math.sin(f)), oz = Math.round(Math.cos(f));
    if (ox > 0) b.max.x = Math.min(b.max.x, s.at.x);
    if (ox < 0) b.min.x = Math.max(b.min.x, s.at.x);
    if (oz > 0) b.max.z = Math.min(b.max.z, s.at.z);
    if (oz < 0) b.min.z = Math.max(b.min.z, s.at.z);
  }
  return b;
}

/** The shapes' bounds, grown by the noise's reach. */
export function fieldBounds(shapes: readonly FieldShape[], grow: number): Aabb {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const take = (x: number, y: number, z: number): void => {
    min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
  };
  for (const s of shapes) {
    if (s.kind === "chamber") {
      take(s.at.x - s.radius[0] * 1.1, s.at.y - 1, s.at.z - s.radius[1] * 1.1);
      take(s.at.x + s.radius[0] * 1.1, s.at.y + s.height, s.at.z + s.radius[1] * 1.1);
    } else {
      const r = s.width * 0.55;
      for (const p of s.points) {
        take(p.x - r, p.y - 1, p.z - r);
        take(p.x + r, p.y + s.height, p.z + r);
      }
    }
  }
  return { min: { x: min.x - grow, y: min.y - grow, z: min.z - grow }, max: { x: max.x + grow, y: max.y + grow, z: max.z + grow } };
}

/** A compiled shape: its distance (positive in the rock) and its floor's height at a point. */
interface Compiled {
  box: Aabb;
  /** The open space's distance, before noise: [walls and vault, floor]. */
  eval: (x: number, y: number, z: number, out: [number, number]) => void;
}

function compile(shape: FieldShape): Compiled {
  if (shape.kind === "chamber") {
    const { at, radius, height } = shape;
    // An ellipsoid whose middle is a little over the floor, cut off by the floor: almost as wide at
    // the floor as at its widest, `height` over the floor at the middle.
    const ry = height * (1 - DOME_DROP);
    const cy = at.y + height * DOME_DROP;
    // Its radius at the floor is `radius`: the ellipsoid's is a little more.
    const k = 1 / Math.sqrt(1 - (DOME_DROP / (1 - DOME_DROP)) ** 2);
    const rx = radius[0] * k, rz = radius[1] * k;
    const least = Math.min(rx, ry, rz);
    return {
      box: fieldBounds([shape], BLEND + 1),
      eval(x, y, z, out) {
        const qx = (x - at.x) / rx, qy = (y - cy) / ry, qz = (z - at.z) / rz;
        out[0] = (Math.hypot(qx, qy, qz) - 1) * least;
        out[1] = at.y - y;
      },
    };
  }
  const { points, width, height } = shape;
  const ry = height * (1 - DOME_DROP);
  const rh = (width / 2) / Math.sqrt(1 - (DOME_DROP / (1 - DOME_DROP)) ** 2);
  const least = Math.min(rh, ry);
  return {
    box: fieldBounds([shape], BLEND + 1),
    eval(x, y, z, out) {
      // The nearest point of the floor line, across (x, z); its floor's height there.
      let best = Infinity, floor = 0, across = 0;
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i], b = points[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
        const px = a.x + dx * t, pz = a.z + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) {
          best = d;
          across = d;
          floor = a.y + (b.y - a.y) * t;
        }
      }
      const qh = across / rh, qy = (y - floor - height * DOME_DROP) / ry;
      out[0] = (Math.hypot(qh, qy) - 1) * least;
      out[1] = floor - y;
    },
  };
}

/** A part's shapes placed in the world. */
function placedFieldShapes(p: PlacedPart): FieldShape[] {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const at = (q: Vec3): Vec3 => ({ x: p.x + q.x * c + q.z * s, y: p.y + q.y, z: p.z - q.x * s + q.z * c });
  return partShapes(p.part).map((shape): FieldShape => {
    if (shape.kind === "tunnel") return { ...shape, points: shape.points.map(at) };
    // A chamber's radii turn with it only by quarter turns, as parts are placed.
    const quarter = Math.round(p.yaw / (Math.PI / 2)) % 2 !== 0;
    return { ...shape, at: at(shape.at), radius: quarter ? [shape.radius[1], shape.radius[0]] : shape.radius };
  });
}

// --- The field ------------------------------------------------------------------------------

export interface CaveField {
  /** Positive in the rock. */
  rock: (x: number, y: number, z: number) => number;
  /** Where there is any open space at all: the shapes' boxes (and a mouth's ground). */
  boxes: Aabb[];
  /** Whether a triangle with every corner here is left out: a mouth's copy of the world's own ground
   *  round it (the world draws and collides with that itself). */
  drop?: (x: number, y: number, z: number) => boolean;
}

/** The ground a mouth is cut into (the world's, or the workbench's made-up slope). */
export interface FieldGround {
  heightAt: (x: number, z: number) => number;
}

/** A mouth in the field (DUNGEONS.md, *Entrances*): the slip's air, open to the sky, its floor flat
 *  rock; the air over the ground round it; the big boulders on the slip's edges and round the way in. */
interface MouthField {
  /** Where its slip and boulders are; and further, past any chunk sampled round them, where the air
   *  over the ground is open (else the rock's default would close it at the region's edge). */
  region: Aabb;
  outer: Aabb;
  /** A point's place in the mouth's frame (x across, z back into the hill from the slip's foot, y
   *  over its floor). */
  local: (x: number, y: number, z: number) => [number, number, number];
  width: number;
  length: number;
  ground: (x: number, z: number) => number;
  boulders: { c: Vec3; r: [number, number, number]; box: Aabb }[];
}

/** How much a boulder's surface is roughened, as a share of the walls'; how softly boulders run into
 *  one another and the floor. */
const BOULDER_ROUGH = 0.6;
const BOULDER_BLEND = 1.4;
/** The way in through the ring: half its width and its height (a tunnel 9 by 8, and a little). */
const OPENING: [number, number] = [5, 8.6];
/** How far past a mouth's region the air over the ground reaches: more than a chunk and its border. */
const OUTER_GROW = 26;
/** How far the slip's floor, a slab of rock, reaches out past its foot, and how steeply it falls
 *  there (rise over run) to meet the slope. */
const SLAB_LIP = 4;
const SLAB_RAMP = 0.6;

/** The signed distance to a box (negative inside). */
function boxDistance(px: number, py: number, pz: number, c: [number, number, number], h: [number, number, number]): number {
  const qx = Math.abs(px - c[0]) - h[0], qy = Math.abs(py - c[1]) - h[1], qz = Math.abs(pz - c[2]) - h[2];
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

/** A placed mouth part's mouth: its boulders set against the ground (their stacks reach over the
 *  slip's cut edges, every opening in the ground covered), in the world. */
function placedMouth(p: PlacedPart, ground: FieldGround, seed: number): MouthField | null {
  const m = p.part.mouth;
  if (!m) return null;
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const world = (lx: number, ly: number, lz: number): Vec3 => ({ x: p.x + lx * c + lz * s, y: p.y + ly, z: p.z - lx * s + lz * c });
  const local = (x: number, y: number, z: number): [number, number, number] => {
    const dx = x - p.x, dz = z - p.z;
    return [dx * c - dz * s, y - p.y, dx * s + dz * c];
  };
  const heights = new Map<string, number>();
  const groundAt = (x: number, z: number): number => {
    const key = `${x},${z}`;
    let h = heights.get(key);
    if (h === undefined) heights.set(key, (h = ground.heightAt(x, z)));
    return h;
  };
  /** The ground over the floor at a point of the mouth's frame. */
  const edge = (lx: number, lz: number): number => {
    const w = world(lx, 0, lz);
    return groundAt(w.x, w.z) - p.y;
  };
  const random = mulberry32(deriveSeed(seed, 0xb01de5));
  const size = (): number => 3.2 + random() * 1.6;
  const placed: { at: [number, number, number]; r: number }[] = [];
  const hw = m.width / 2;
  // In the ring's arch - the way in - for a boulder of radius r there.
  const inArch = (x: number, y: number, r: number): boolean => (x / (OPENING[0] + r * 1.15 + 0.6)) ** 2 + (y / (OPENING[1] + r * 0.95 + 0.4)) ** 2 < 1;
  /** A column of boulders standing on the floor at (x, z), up over the ground there by a margin. */
  const column = (x: number, z: number, top: number, keepOut: boolean): void => {
    let y = 0;
    for (let k = 0; k < 12; k++) {
      const r = size();
      const at: [number, number, number] = [x + (random() - 0.5) * 0.8, y + r * 0.45, z + (random() - 0.5) * 0.8];
      y = at[1] + r * 0.6;
      if (!(keepOut && inArch(at[0], at[1], r))) placed.push({ at, r });
      if (at[1] + r * 0.75 > top) break;
    }
  };
  // Its sides: a column at every few metres along each cut edge, up over the ground there.
  for (const side of [-1, 1]) {
    for (let z = 1.2; z < m.length + 1; z += 4) {
      const top = Math.max(edge(side * hw, z), edge(side * (hw + 2), z)) + 0.9;
      column(side * (hw - 0.6), z, top, false);
    }
  }
  // Its back wall, under the ground over it - not in the way in.
  for (let x = -hw + 1; x <= hw - 1 + 1e-6; x += 4.2) {
    const top = Math.max(edge(x, m.length), edge(x, m.length + 2)) + 0.9;
    column(x, m.length - 0.8, top, true);
  }
  // The ring round the way in: each boulder clear of the opening by its own size.
  for (let k = 0; k <= 6; k++) {
    const t = (k / 6) * Math.PI;
    const r = size();
    const a = OPENING[0] + r * 1.1 + 0.8, b = OPENING[1] + r * 0.85 + 0.6;
    placed.push({ at: [Math.cos(t) * a, Math.max(r * 0.45, Math.sin(t) * b), m.length - 1.6 + (random() - 0.5) * 0.6], r });
  }
  const boulders = placed.map(({ at, r }) => {
    const rr: [number, number, number] = [r, r * 0.82, r * (0.9 + random() * 0.2)];
    const w = world(...at);
    const reach = r + 1.5;
    return { c: w, r: rr, box: { min: { x: w.x - reach, y: w.y - reach, z: w.z - reach }, max: { x: w.x + reach, y: w.y + reach, z: w.z + reach } } };
  });
  // Where the mouth has a say: the slip, its boulders and the ground round them.
  let top = 0;
  for (const b of placed) top = Math.max(top, b.at[1] + b.r);
  const corners: Vec3[] = [];
  for (const lx of [-hw - 8, hw + 8]) for (const lz of [-6, m.length + 8]) for (const ly of [-3, top + 4]) corners.push(world(lx, ly, lz));
  const region = {
    min: { x: Math.min(...corners.map((q) => q.x)), y: Math.min(...corners.map((q) => q.y)), z: Math.min(...corners.map((q) => q.z)) },
    max: { x: Math.max(...corners.map((q) => q.x)), y: Math.max(...corners.map((q) => q.y)), z: Math.max(...corners.map((q) => q.z)) },
  };
  const g = OUTER_GROW;
  const outer = { min: { x: region.min.x - g, y: region.min.y - g, z: region.min.z - g }, max: { x: region.max.x + g, y: region.max.y + g, z: region.max.z + g } };
  return { region, outer, local, width: m.width, length: m.length, ground: groundAt, boulders };
}

/** The rock round a set of shapes, roughened by `noise`, opened by any mouths. Shapes found by a grid of 16 m cells. */
export function fieldOf(shapes: readonly FieldShape[], noise: readonly FieldNoise[], mouths: readonly MouthField[] = []): CaveField {
  const compiled = shapes.map(compile);
  const CELL = 16;
  const grid = new Map<string, number[]>();
  compiled.forEach((c, i) => {
    for (let gx = Math.floor(c.box.min.x / CELL); gx <= Math.floor(c.box.max.x / CELL); gx++) {
      for (let gy = Math.floor(c.box.min.y / CELL); gy <= Math.floor(c.box.max.y / CELL); gy++) {
        for (let gz = Math.floor(c.box.min.z / CELL); gz <= Math.floor(c.box.max.z / CELL); gz++) {
          const key = `${gx},${gy},${gz}`;
          const list = grid.get(key);
          if (list) list.push(i);
          else grid.set(key, [i]);
        }
      }
    }
  });
  const out: [number, number] = [0, 0];
  const roughAt = (x: number, y: number, z: number): number => {
    let rough = 0;
    for (const n of noise) rough += valueNoise(x * n.scale + 17.3, y * n.scale, z * n.scale - 5.1) * n.amount;
    return rough;
  };
  const inBox = (b: Aabb, x: number, y: number, z: number): boolean => x >= b.min.x && x <= b.max.x && y >= b.min.y && y <= b.max.y && z >= b.min.z && z <= b.max.z;
  /** A mouth's say at a point, over the cave's own: open in its slip and over the ground, rock in its boulders. */
  const mouthed = (d: number, x: number, y: number, z: number, rough: number): number => {
    for (const m of mouths) {
      if (!inBox(m.outer, x, y, z)) continue;
      const [lx, ly, lz] = m.local(x, y, z);
      // The air over the ground - but never under the slip's floor, wherever the ground in front lies
      // lower than it: the floor is a slab of rock, running out past its foot as a ramp down onto the
      // slope, so it is walked onto, not climbed.
      const slab = lz < 0 ? lz * SLAB_RAMP : 0;
      const underSlip = ly < slab && lx > -m.width / 2 && lx < m.width / 2 && lz > -SLAB_LIP && lz < m.length;
      d = Math.min(d, underSlip ? Math.max(m.ground(x, z) - y, slab - ly) : m.ground(x, z) - y);
      if (!inBox(m.region, x, y, z)) continue;
      // The slip's air: its floor flat, open to the sky.
      d = Math.min(d, boxDistance(lx, ly, lz, [0, 60, m.length / 2], [m.width / 2, 60, m.length / 2]));
      for (const b of m.boulders) {
        if (!inBox(b.box, x, y, z)) continue;
        const qx = (x - b.c.x) / b.r[0], qy = (y - b.c.y) / b.r[1], qz = (z - b.c.z) / b.r[2];
        const inside = (1 - Math.hypot(qx, qy, qz)) * Math.min(b.r[0], b.r[1], b.r[2]) + rough * BOULDER_ROUGH;
        d = smoothMax(d, inside, BOULDER_BLEND);
      }
    }
    return d;
  };
  const inMouth = (x: number, y: number, z: number): boolean => mouths.some((m) => inBox(m.outer, x, y, z));
  const rock = (x: number, y: number, z: number): number => {
    const near = grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`);
    if (!near) return mouths.length > 0 && inMouth(x, y, z) ? mouthed(ROCK, x, y, z, roughAt(x, y, z)) : ROCK;
    const rough = roughAt(x, y, z);
    let d = ROCK;
    // The shape that opens the point most, and its floor: the walls blend, the floors do not -
    // blending two shapes' floors would sink it where they meet.
    let most = ROCK, floor = -Infinity;
    for (const i of near) {
      const c = compiled[i];
      const b = c.box;
      if (x < b.min.x || x > b.max.x || y < b.min.y || y > b.max.y || z < b.min.z || z > b.max.z) continue;
      c.eval(x, y, z, out);
      // Walls and vault rough; the floor nearly flat.
      const under = out[1] + rough * FLOOR_ROUGH;
      const e = Math.max(out[0] + rough, under);
      d = d === ROCK ? Math.min(d, e) : smoothMin(d, e, BLEND);
      if (e < most) [most, floor] = [e, under];
    }
    const cave = Math.max(d, floor);
    return mouths.length > 0 ? mouthed(cave, x, y, z, rough) : cave;
  };
  // A triangle on the world's own ground, outside the slip (the world draws and collides with that).
  const drop =
    mouths.length === 0
      ? undefined
      : (x: number, y: number, z: number): boolean => {
          for (const m of mouths) {
            if (!inBox(m.outer, x, y, z)) continue;
            const [lx, , lz] = m.local(x, y, z);
            const inSlip = lx > -m.width / 2 - 0.05 && lx < m.width / 2 + 0.05 && lz > -SLAB_LIP - 0.05 && lz < m.length + 0.05;
            if (!inSlip && Math.abs(m.ground(x, z) - y) < 0.7) return true;
          }
          return false;
        };
  return { rock, boxes: [...compiled.map((c) => c.box), ...mouths.map((m) => m.region)], drop };
}

/** A whole cave's field: every placed field part's shapes - and a mouth's, against `ground`. */
export function layoutField(layout: DungeonLayout, noise: readonly FieldNoise[], ground?: FieldGround): CaveField {
  const mouths = ground ? layout.parts.flatMap((p, i) => placedMouth(p, ground, deriveSeed(layout.seed, i)) ?? []) : [];
  return fieldOf(layout.parts.flatMap(placedFieldShapes), noise, mouths);
}

// --- Chunks ---------------------------------------------------------------------------------

/** A chunk's cells along each side. */
export const CHUNK_CELLS = 16;

export interface CaveChunk {
  /** Its grid's first point (the chunk's corner less a cell: it is sampled a cell over each side). */
  origin: [number, number, number];
  cell: number;
  /** Samples a side: CHUNK_CELLS + 3. */
  n: number;
  /** The field at its points, positive in the rock. */
  values: Float32Array;
  positions: Float32Array;
  /** The surface's normal at each vertex, out of the rock. */
  normals: Float32Array;
  /** Wound counter-clockwise seen from the open side. */
  indices: Uint32Array;
}

export interface CaveMesh {
  chunks: CaveChunk[];
  /** The field it was meshed from (to set things against its rock). */
  field?: CaveField;
  stats: { chunks: number; skipped: number; samples: number; triangles: number; ms: number };
}

/** The field sampled and meshed, chunk by chunk, wherever a shape's box reaches. */
export function meshField(field: CaveField, cell: number): CaveMesh {
  const started = performance.now();
  const size = CHUNK_CELLS * cell;
  const keys = new Set<string>();
  for (const b of field.boxes) {
    for (let cx = Math.floor(b.min.x / size); cx <= Math.floor(b.max.x / size); cx++) {
      for (let cy = Math.floor(b.min.y / size); cy <= Math.floor(b.max.y / size); cy++) {
        for (let cz = Math.floor(b.min.z / size); cz <= Math.floor(b.max.z / size); cz++) keys.add(`${cx},${cy},${cz}`);
      }
    }
  }
  const chunks: CaveChunk[] = [];
  let skipped = 0, samples = 0, triangles = 0;
  for (const key of [...keys].sort()) {
    const [cx, cy, cz] = key.split(",").map(Number);
    const chunk = meshChunk(field, cx, cy, cz, cell);
    samples += (CHUNK_CELLS + 3) ** 3;
    if (!chunk) { skipped++; continue; }
    triangles += chunk.indices.length / 3;
    chunks.push(chunk);
  }
  return { chunks, stats: { chunks: chunks.length, skipped, samples, triangles, ms: performance.now() - started } };
}

/** One chunk: sampled from a cell before it to two after (so the quads at its edges are its own and
 *  its neighbours' vertices are the same as theirs), meshed; null if the surface misses it. */
function meshChunk(field: CaveField, cx: number, cy: number, cz: number, cell: number): CaveChunk | null {
  const n = CHUNK_CELLS + 3;
  const origin: [number, number, number] = [(cx * CHUNK_CELLS - 1) * cell, (cy * CHUNK_CELLS - 1) * cell, (cz * CHUNK_CELLS - 1) * cell];
  const values = new Float32Array(n * n * n);
  let solid = 0;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = field.rock(origin[0] + i * cell, origin[1] + j * cell, origin[2] + k * cell);
    values[(k * n + j) * n + i] = v;
    if (v > 0) solid++;
  }
  if (solid === 0 || solid === n * n * n) return null;
  const at = (i: number, j: number, k: number): number => values[(k * n + j) * n + i];
  const cells = n - 1;
  const vertexOf = new Int32Array(cells * cells * cells).fill(-1);
  const cellIndex = (i: number, j: number, k: number): number => (k * cells + j) * cells + i;
  const positions: number[] = [];
  const normals: number[] = [];
  const corner = new Float64Array(8);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < cells; k++) for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    let mask = 0;
    for (let b = 0; b < 8; b++) {
      corner[b] = at(i + (b & 1), j + ((b >> 1) & 1), k + (b >> 2));
      if (corner[b] > 0) mask |= 1 << b;
    }
    if (mask === 0 || mask === 255) continue;
    let count = 0, px = 0, py = 0, pz = 0;
    for (const [a, b] of EDGES) {
      if (corner[a] > 0 === corner[b] > 0) continue;
      const t = corner[a] / (corner[a] - corner[b]);
      px += (a & 1) + t * ((b & 1) - (a & 1));
      py += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
      pz += (a >> 2) + t * ((b >> 2) - (a >> 2));
      count++;
    }
    px /= count; py /= count; pz /= count;
    vertexOf[cellIndex(i, j, k)] = positions.length / 3;
    positions.push(origin[0] + (i + px) * cell, origin[1] + (j + py) * cell, origin[2] + (k + pz) * cell);
    // The normal: the trilinear field's gradient in the cell, pointing out of the rock (down it).
    const u = px, v = py, w = pz;
    const c = corner;
    const gx = (c[1] - c[0]) * (1 - v) * (1 - w) + (c[3] - c[2]) * v * (1 - w) + (c[5] - c[4]) * (1 - v) * w + (c[7] - c[6]) * v * w;
    const gy = (c[2] - c[0]) * (1 - u) * (1 - w) + (c[3] - c[1]) * u * (1 - w) + (c[6] - c[4]) * (1 - u) * w + (c[7] - c[5]) * u * w;
    const gz = (c[4] - c[0]) * (1 - u) * (1 - v) + (c[5] - c[1]) * u * (1 - v) + (c[6] - c[2]) * (1 - u) * v + (c[7] - c[3]) * u * v;
    const l = Math.hypot(gx, gy, gz) || 1;
    normals.push(-gx / l, -gy / l, -gz / l);
  }
  const indices: number[] = [];
  const ids = [0, 0, 0, 0];
  const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // Only the grid edges from its own points (1 to CHUNK_CELLS along each axis): each edge in one chunk.
  for (let k = 1; k <= CHUNK_CELLS; k++) for (let j = 1; j <= CHUNK_CELLS; j++) for (let i = 1; i <= CHUNK_CELLS; i++) {
    const v0 = at(i, j, k);
    for (let axis = 0; axis < 3; axis++) {
      const di = axis === 0 ? 1 : 0, dj = axis === 1 ? 1 : 0, dk = axis === 2 ? 1 : 0;
      if (v0 > 0 === at(i + di, j + dj, k + dk) > 0) continue;
      const ua = axis === 0 ? [0, 1, 0] : axis === 1 ? [0, 0, 1] : [1, 0, 0];
      const ub = axis === 0 ? [0, 0, 1] : axis === 1 ? [1, 0, 0] : [0, 1, 0];
      let ok = true;
      for (let q = 0; q < 4 && ok; q++) {
        const a = i - ua[0] * quad[q][0] - ub[0] * quad[q][1];
        const b = j - ua[1] * quad[q][0] - ub[1] * quad[q][1];
        const c = k - ua[2] * quad[q][0] - ub[2] * quad[q][1];
        ids[q] = vertexOf[cellIndex(a, b, c)];
        if (ids[q] < 0) ok = false;
      }
      if (!ok) continue;
      if (v0 > 0) indices.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      else indices.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
    }
  }
  // Left out: a mouth's copy of the world's ground (every corner on it).
  let kept = indices;
  if (field.drop) {
    const off = new Uint8Array(positions.length / 3);
    for (let v = 0; v < off.length; v++) off[v] = field.drop(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]) ? 1 : 0;
    kept = [];
    for (let t = 0; t < indices.length; t += 3) if (!(off[indices[t]] && off[indices[t + 1]] && off[indices[t + 2]])) kept.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  if (kept.length === 0) return null;
  return { origin, cell, n, values, positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(kept) };
}

/** The field in a chunk at a point, trilinear; `outside` its grid (open, by default: a chunk's
 *  mesh, as a collider, says nothing of what lies beyond it - a neighbour's does). */
export function chunkFieldAt(chunk: CaveChunk, x: number, y: number, z: number, outside = -1): number {
  const { origin, cell, n, values } = chunk;
  const fx = (x - origin[0]) / cell, fy = (y - origin[1]) / cell, fz = (z - origin[2]) / cell;
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < n - 1 && fy < n - 1 && fz < n - 1)) return outside;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  const u = fx - i, v = fy - j, w = fz - k;
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    r += values[((k + dz) * n + j + dy) * n + i + dx] * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}

/** A cave's colliders: each chunk's mesh, its own field saying what is inside the rock. */
export function caveColliders(mesh: CaveMesh): ShapeDesc[] {
  return mesh.chunks.map((c): ShapeDesc => ({ kind: "mesh", positions: c.positions, indices: c.indices, inside: (p) => chunkFieldAt(c, p.x, p.y, p.z) > 0 }));
}

/** A field style's layout's rock, sampled and meshed (the same on the server and the page). */
export function buildCave(layout: DungeonLayout, style: Pick<DungeonStyleDef, "noise" | "voxel">, ground?: FieldGround): CaveMesh {
  const field = layoutField(layout, style.noise, ground);
  return { ...meshField(field, style.voxel), field };
}
