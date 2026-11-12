// What a kit-built dungeon part is made of (DUNGEONS.md, *A part*): its colliders, written in the
// part's own frame as boxes, straight stairs and spiral stairs, and the lines its floor is walked
// along. Pure data in, collision shapes out - the generator moves them into the world.
import { quatFromEuler, vec3, type ShapeDesc, type Vec3 } from "../collision/index";

export type Polyline = Vec3[];

/** A part's colliders and walk lines, in its own frame. */
export interface KitGeometry {
  shapes: ShapeDesc[];
  paths: Polyline[];
  /** Which of `shapes` are drawn whole, uncut by the others (a spiral's pillar). */
  whole?: number[];
  /** Which are wall all over, whatever their shape (a railing - not a step for being narrow). */
  plain?: number[];
}

/** A box between two corners. */
export function boxShape(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ShapeDesc {
  return {
    kind: "box",
    center: vec3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    half: vec3(Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2),
  };
}

export interface StairSpec {
  /** The top and the foot of the flight, on its centre line; either may be the higher. */
  from: Vec3;
  to: Vec3;
  width: number;
  /** Each step's height. */
  rise: number;
  /** Clear height over each step, its vault one metre thick; 0 for none. */
  ceiling: number;
  /** Walls one metre thick down both sides, from under the lower end to over the higher's vault. */
  walls: boolean;
}

/** A straight flight: a box a step, down to a metre under its lower end, and a vault over each. */
export function stairGeometry(s: StairSpec): KitGeometry {
  const dx = s.to.x - s.from.x, dz = s.to.z - s.from.z, run = Math.hypot(dx, dz);
  const drop = s.to.y - s.from.y;
  const steps = Math.max(1, Math.round(Math.abs(drop) / s.rise));
  const yaw = Math.atan2(dx, dz);
  const rotation = quatFromEuler(yaw);
  const base = Math.min(s.from.y, s.to.y) - 1;
  const tread = run / steps;
  const shapes: ShapeDesc[] = [];
  const path: Polyline = [];
  for (let i = 0; i < steps; i++) {
    // Each step's top: the higher end's height for a flight going down from `from`, stepping down.
    const top = drop < 0 ? s.from.y + (drop * i) / steps : s.from.y + (drop * (i + 1)) / steps;
    const along = (i + 0.5) * tread;
    const cx = s.from.x + (dx / run) * along, cz = s.from.z + (dz / run) * along;
    shapes.push({ kind: "box", center: vec3(cx, (top + base) / 2, cz), half: vec3(s.width / 2, (top - base) / 2, tread / 2 + 0.01), rotation });
    if (s.ceiling > 0) shapes.push({ kind: "box", center: vec3(cx, top + s.rise + s.ceiling + 0.5, cz), half: vec3(s.width / 2 + (s.walls ? 1 : 0), 0.5, tread / 2 + 0.01), rotation });
    path.push(vec3(cx, top, cz));
  }
  if (s.walls) {
    const high = Math.max(s.from.y, s.to.y) + s.rise + s.ceiling + 1;
    for (const side of [-1, 1]) {
      // Across: to the right of the way down the flight.
      const ox = (dz / run) * side * (s.width / 2 + 0.5), oz = (-dx / run) * side * (s.width / 2 + 0.5);
      shapes.push({ kind: "box", center: vec3((s.from.x + s.to.x) / 2 + ox, (high + base) / 2, (s.from.z + s.to.z) / 2 + oz), half: vec3(0.5, (high - base) / 2, run / 2), rotation });
    }
  }
  return { shapes, paths: [path] };
}

/** How far into the pillar the steps and vaults reach: inside its flats (12 sides: cos 15 deg). */
const IN_PILLAR = 0.95;

/** How far each landing runs on past its doorway before its railing or end wall, degrees. */
const LANDING_ON = 12;

/** A railing's height over the floor: a stop to walking off, not to jumping. */
const RAILING = 1.1;

export interface SpiralSpec {
  /** Its axis, in x and z; `top` the floor's height where it starts. */
  centre: [number, number];
  top: number;
  /** The way round: from the pillar (`inner`) to the outer wall's inside (`outer`); the wall `wall` thick. */
  inner: number;
  outer: number;
  wall: number;
  /** Where it starts, as a facing from the centre (0 north, +z; 90 east, +x), and how far round it goes. */
  start: number;
  turns: number;
  /** How far down it goes, a whole number of steps. */
  drop: number;
  rise: number;
  ceiling: number;
  /** Degrees kept level at each end, either side of its door - the door's width at the outer wall. */
  flat: number;
}

/**
 * A spiral stair round a pillar: wedge-shaped steps (each a convex piece, so the treads tile with no
 * gaps), a vault over each, the outer wall a piece a step - left out at its two doors - and the
 * pillar. It goes round clockwise seen from above (facing angles growing). Throws if its laps are
 * too close for the vault over one and the floor of the next.
 */
export function spiralGeometry(s: SpiralSpec): KitGeometry {
  const geometryWhole: number[] = [];
  const geometryPlain: number[] = [];
  const deg = Math.PI / 180;
  const flat = s.flat * deg;
  const a0 = s.start * deg - flat;
  const span = s.turns * 2 * Math.PI + 2 * flat;
  const descending = span - 4 * flat;
  if (descending <= 0) throw new Error("a spiral needs to turn further than its level ends");
  // Laps' separation at the same angle, the tightest being where a level end meets the next lap.
  const perRadian = s.drop / descending;
  const separation = perRadian * (2 * Math.PI - 2 * flat);
  if (s.turns >= 1 && separation < s.ceiling + s.rise + 1) {
    throw new Error(`its laps are ${separation.toFixed(2)} m apart, under the ${s.ceiling + s.rise + 1} m a vault and a floor need: drop more or turn less`);
  }
  const steps = Math.round(s.drop / s.rise);
  const stepAngle = descending / steps;
  const flatSteps = Math.max(1, Math.round((2 * flat) / stepAngle));
  const count = steps + 2 * flatSteps;
  const angleOf = (i: number): number => a0 + (i * span) / count;
  const point = (angle: number, r: number, y: number): Vec3 => vec3(s.centre[0] + r * Math.sin(angle), y, s.centre[1] + r * Math.cos(angle));
  const heightOf = (i: number): number => {
    if (i < flatSteps) return s.top;
    if (i >= count - flatSteps) return s.top - s.drop;
    return s.top - (i - flatSteps + 1) * s.rise;
  };
  /** A ring sector between two angles and radii, from y0 to y1, as a convex piece. */
  const sector = (b0: number, b1: number, r0: number, r1: number, y0: number, y1: number): ShapeDesc => {
    const points: Vec3[] = [];
    const mid = (b0 + b1) / 2;
    for (const y of [y0, y1]) {
      points.push(point(b0, r0, y), point(b1, r0, y), point(b0, r1, y), point(mid, r1 / Math.cos((b1 - b0) / 2), y), point(b1, r1, y));
    }
    return { kind: "convex", points };
  };
  const shapes: ShapeDesc[] = [];
  const path: Polyline = [];
  const door = Math.asin(Math.min(1, (s.outer - s.inner) / 2 / s.outer));
  const doorStart = s.start * deg, doorEnd = s.start * deg + s.turns * 2 * Math.PI;
  const mid = (s.inner + s.outer) / 2;
  // In through the door straight, out through the other the same way.
  path.push(point(doorStart, s.outer + s.wall, s.top), point(doorStart, mid, s.top));
  // The first turn has no lap over it: its vault is the top landing's, all the way round - a
  // stairwell open from the top landing down to where the second lap passes under it.
  const cap = s.top + s.rise + s.ceiling;
  for (let i = 0; i < count; i++) {
    const b0 = angleOf(i), b1 = angleOf(i + 1);
    const top = heightOf(i);
    // Any step reaching back into the first turn: the one straddling its end too, or the ceiling
    // over the railing would have a gap.
    const vault = b0 < a0 + 2 * Math.PI - 1e-9 ? cap : top + s.rise + s.ceiling;
    // Under the outer wall too, so a door through it has a floor.
    shapes.push(sector(b0, b1, s.inner * IN_PILLAR, s.outer + s.wall, top - 1, top));
    shapes.push(sector(b0, b1, s.inner * IN_PILLAR, s.outer + s.wall, vault, vault + 1));
    const c = (b0 + b1) / 2;
    const atDoor = Math.abs(c - doorStart) < door || Math.abs(c - doorEnd) < door;
    // The wall's inside a chord touching the outer radius at its middle, never inside it.
    // Raised to the top's vault, but under a doorway (a turn round from it): only up to its own vault,
    // so it never stands in the doorway above it.
    const turnsAway = (x: number): number => Math.abs(((((x - doorStart) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    const wallTop = vault === cap && Math.min(turnsAway(b0), turnsAway(c), turnsAway(b1)) < door ? top + s.rise + s.ceiling + 1 : vault + 1;
    if (!atDoor) shapes.push(sector(b0, b1, s.outer / Math.cos((b1 - b0) / 2), s.outer + s.wall, top - 1, wallTop));
    path.push(point(c, mid, top));
  }
  // Each landing runs on past its doorway by LANDING_ON - far enough that the way in, straight to
  // the middle of the stair, keeps its full width (at half the width, a door's half-width off its
  // line is 30 degrees round) - and stops at a railing over the stairwell at the top, a wall at the
  // bottom.
  const step = span / count;
  const on = LANDING_ON * deg;
  const railAt = a0 - on;
  shapes.push(sector(railAt, a0, s.inner * IN_PILLAR, s.outer + s.wall, s.top - 1, s.top));
  shapes.push(sector(railAt - Math.min(step, 0.6 / mid), railAt, s.inner * IN_PILLAR, s.outer + s.wall, s.top - 0.5, s.top + RAILING));
  geometryPlain.push(shapes.length - 1);
  const end = a0 + span, bottom = s.top - s.drop, bottomVault = bottom + s.rise + s.ceiling;
  // Roofed by the lap over it (more than a vault's height up: the laps are that far apart), or by a
  // vault of its own where there is none.
  const wallAt = end + on;
  const over = Math.floor((wallAt - 2 * Math.PI - a0) / step);
  const wallTop = over >= 0 ? heightOf(over) - 1 + 0.05 : bottomVault + 1;
  shapes.push(sector(end, end + on, s.inner * IN_PILLAR, s.outer + s.wall, bottom - 1, bottom));
  if (over < 0) shapes.push(sector(end, end + on, s.inner * IN_PILLAR, s.outer + s.wall, bottomVault, bottomVault + 1));
  shapes.push(sector(end, end + on, s.outer, s.outer + s.wall, bottom - 1, wallTop));
  shapes.push(sector(wallAt, wallAt + Math.min(step, 1 / mid), s.inner * IN_PILLAR, s.outer + s.wall, bottom - 1, wallTop));
  path.push(point(doorEnd, mid, s.top - s.drop), point(doorEnd, s.outer + s.wall, s.top - s.drop));
  // The pillar: a twelve-sided prism inside the inner radius, so no flat of it narrows the way.
  const low = s.top - s.drop - 1, high = s.top + s.rise + s.ceiling + 1;
  const ring = Array.from({ length: 12 }, (_, k) => (k * Math.PI) / 6);
  shapes.push({ kind: "convex", points: [...ring.map((a) => point(a, s.inner, low)), ...ring.map((a) => point(a, s.inner, high))] });
  // The pillar is drawn whole, a round column from bottom to top (what of it is behind the steps
  // does not matter).
  geometryWhole.push(shapes.length - 1);
  return { shapes, paths: [path], whole: geometryWhole, plain: geometryPlain };
}

export const DOORWAY_KINDS = ["frame", "arch", "door"] as const;

/** How far a doorway's stop stands in from its opening, how far either side of its socket's plane it
 *  reaches, and how far its keystone rises over the ring and stands forward of it. Doorways may be narrower than the
 *  rules' least way through by the stop (DUNGEONS.md, *Doorways*). */
const INSET = 0.3;
const STOP = 0.25;
const KEYSTONE = 0.4;
const KEYSTONE_FORWARD = 0.15;
/** A threshold's height, and how far it reaches either side of the socket's plane. */
const THRESHOLD = [0.15, 0.35] as const;
export type DoorwayKind = (typeof DOORWAY_KINDS)[number];

export interface DoorwaySpec {
  kind: DoorwayKind;
  /** The way through it: its socket's width and height. */
  width: number;
  height: number;
  /** How far it reaches into the part behind its socket (-z) and the part in front (+z) - each
   *  part's socket says how far it may (`reach`) - how far each jamb reaches out from the opening,
   *  how deep the lintel is; an arch's rise over the opening. */
  back: number;
  front: number;
  /** How far its lintel (or arch) reaches into each: no further than the walls, where something passes
   *  over the doorway close above (a spiral's next lap). */
  backOver: number;
  frontOver: number;
  jamb: number;
  lintel: number;
  rise: number;
}

/**
 * A doorway across a socket's plane (z 0), the way through it along z (DUNGEONS.md, *Doorways*):
 * jambs and a sill thick enough to reach into both parts it joins - so it covers where their walls
 * meet, whatever their shapes - and over the opening a lintel, or for an arch a ring of voussoirs
 * on the jambs with a keystone at its crown; a stop round the opening at its middle, inset from it,
 * and a threshold across it;
 * for a door, its two leaves standing open into +z (drawn, not in the way: `visuals`).
 */
/** One stone of an arch: which shape it is, the ring it is part of (round (0, cy), from radius r0 to
 *  r1, angles a0 to a1) and its course counted from the springing - so it is textured as one block. */
export interface Voussoir {
  shape: number;
  cy: number;
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  course: number;
}

export function doorwayGeometry(d: DoorwaySpec): { shapes: ShapeDesc[]; visuals: ShapeDesc[]; paths: Polyline[]; voussoirs: Voussoir[] } {
  const w = d.width / 2, h = d.height, t = d.jamb;
  const voussoirs: Voussoir[] = [];
  // The sill, and on it a threshold across the opening at the stop - low enough to step over.
  const shapes: ShapeDesc[] = [boxShape(-w, -1, -d.back, w, 0, d.front), boxShape(-w, 0, -THRESHOLD[1], w, THRESHOLD[0], THRESHOLD[1])];
  /** A piece between two angles of a ring round (0, cy), from radius r0 to r1, z0 to z1 - plus any extra points. */
  const ringPiece = (cy: number, a0: number, a1: number, r0: number, r1: number, z0: number, z1: number, extra: [number, number][] = []): ShapeDesc => {
    const points: Vec3[] = [];
    for (const z of [z0, z1]) {
      for (const a of [a0, a1]) for (const r of [r0, r1]) points.push(vec3(Math.cos(a) * r, cy + Math.sin(a) * r, z));
      for (const [x, y] of extra) points.push(vec3(x, y, z));
    }
    return { kind: "convex", points };
  };
  if (d.kind === "arch") {
    // Straight jambs to the springing, then a ring of voussoirs over the opening - its crown at the
    // opening's height, `rise` over the springing - a keystone at the top standing proud of the rest.
    const spring = h - d.rise;
    const r = (w * w + d.rise * d.rise) / (2 * d.rise), cy = h - r;
    const from = Math.atan2(spring - cy, w), to = Math.PI - from;
    // Each jamb's top a skewback: cut on the slope of the arch's first stone, from the opening's edge
    // at the springing out to where the ring's outside meets the jamb's - so the ring sits on it
    // whole and every stone of it is a whole block.
    const outer = r + t;
    const onRing: [number, number] = [Math.cos(from) * outer, cy + Math.sin(from) * outer];
    const atSide = cy + Math.sqrt(Math.max(0, outer * outer - (w + t) * (w + t)));
    for (const side of [1, -1]) {
      const points: Vec3[] = [];
      for (const z of [-d.back, d.front]) {
        for (const [x, y] of [[w, -1], [w + t, -1], [w + t, Math.max(spring, atSide)], [onRing[0], onRing[1]], [w, spring]] as [number, number][]) points.push(vec3(side * x, y, z));
      }
      shapes.push({ kind: "convex", points });
    }
    const pieces = 9, key = Math.floor(pieces / 2);
    for (let i = 0; i < pieces; i++) {
      const a0 = from + ((to - from) * i) / pieces, a1 = from + ((to - from) * (i + 1)) / pieces;
      const extra: [number, number][] = [];
      // The keystone rises over the ring, and stands forward of it - but not on a side whose lintel
      // is kept short (a spiral's: its next lap passes over).
      const keystone = i === key;
      const rise = keystone ? KEYSTONE : 0;
      const back = d.backOver + (keystone && d.backOver >= d.back ? KEYSTONE_FORWARD : 0);
      const front = d.frontOver + (keystone && d.frontOver >= d.front ? KEYSTONE_FORWARD : 0);
      voussoirs.push({ shape: shapes.length, cy, r0: r, r1: r + t + rise, a0, a1, course: Math.min(i, pieces - 1 - i) });
      shapes.push(ringPiece(cy, a0, a1, r, r + t + rise, -back, front, extra));
    }
    // The inset: a stop round the opening at its middle, following the arch.
    shapes.push(boxShape(-w, 0, -STOP, -w + INSET, spring, STOP), boxShape(w - INSET, 0, -STOP, w, spring, STOP));
    for (let i = 0; i < pieces; i++) {
      const a0 = from + ((to - from) * i) / pieces, a1 = from + ((to - from) * (i + 1)) / pieces;
      voussoirs.push({ shape: shapes.length, cy, r0: r - INSET, r1: r, a0, a1, course: Math.min(i, pieces - 1 - i) });
      shapes.push(ringPiece(cy, a0, a1, r - INSET, r, -STOP, STOP));
    }
  } else {
    shapes.push(
      boxShape(-w - t, -1, -d.back, -w, h + d.lintel, d.front),
      boxShape(w, -1, -d.back, w + t, h + d.lintel, d.front),
      boxShape(-w, h, -d.backOver, w, h + d.lintel, d.frontOver),
      // The inset: a stop round the opening at its middle.
      boxShape(-w, 0, -STOP, -w + INSET, h, STOP),
      boxShape(w - INSET, 0, -STOP, w, h, STOP),
      boxShape(-w, h - INSET, -STOP, w, h, STOP),
    );
  }
  const visuals: ShapeDesc[] = [];
  if (d.kind === "door") {
    // Two leaves swung wide, back along the walls of the part beyond.
    const leaf = 0.15;
    visuals.push(boxShape(-w + INSET, 0.05, STOP, -w + INSET + leaf, h - INSET - 0.05, STOP + w - INSET), boxShape(w - INSET - leaf, 0.05, STOP, w - INSET, h - INSET - 0.05, STOP + w - INSET));
  }
  return { shapes, visuals, paths: [[vec3(0, 0, -d.back), vec3(0, 0, d.front)]], voussoirs };
}
