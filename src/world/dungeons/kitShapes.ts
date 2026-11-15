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
  /** Clear height over each step, its vault one metre thick - one sloping slab over the flight, its
   *  underside on the line through the steps' middles that high over them; 0 for none. */
  ceiling: number;
  /** Walls one metre thick down both sides, from under the lower end to over the higher's vault. */
  walls: boolean;
  /** Railings down both sides, on the flight's edges (a flight standing free in a hall). */
  railings?: boolean;
}

/** A railing's thickness. */
const RAILING_WIDTH = 0.6;

/** A straight flight: a box a step, down to a metre under its lower end, and a vault sloping over them. */
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
    path.push(vec3(cx, top, cz));
  }
  if (s.ceiling > 0) {
    // Its underside on the line through the steps' middles, `ceiling` over them and a step more
    // (as a vault over each step was): a flat sloping soffit, not a stair of vaults.
    const ux = dx / run, uz = dz / run, ax = uz, az = -ux;
    const first = drop < 0 ? s.from.y : s.from.y + drop / steps, last = drop < 0 ? s.from.y + (drop * (steps - 1)) / steps : s.to.y;
    const slope = steps > 1 ? (last - first) / (run - tread) : 0;
    const half = s.width / 2 + (s.walls ? 1 : 0);
    const corners: Vec3[] = [];
    for (const along of [-0.01, run + 0.01]) {
      const y = first + slope * (along - tread / 2) + s.rise + s.ceiling;
      for (const across of [-half, half]) {
        const x = s.from.x + ux * along + ax * across, z = s.from.z + uz * along + az * across;
        corners.push(vec3(x, y, z), vec3(x, y + 1, z));
      }
    }
    shapes.push({ kind: "convex", points: corners });
  }
  const plain: number[] = [];
  if (s.railings) {
    // Each a slab sloping with the flight, its top a railing's height over the line of the steps'
    // fronts, its foot sunk into them: across the flight, from its edge in by a railing's thickness.
    const ux = dx / run, uz = dz / run, ax = uz, az = -ux;
    for (const side of [-1, 1]) {
      const corners: Vec3[] = [];
      for (const [along, y] of [[0, s.from.y], [run, s.to.y]] as [number, number][]) {
        // Its outer side a hand past the steps' ends, so their sides do not show through it.
        for (const across of [s.width / 2 - RAILING_WIDTH, s.width / 2 + 0.05]) {
          const x = s.from.x + ux * along + ax * across * side, z = s.from.z + uz * along + az * across * side;
          corners.push(vec3(x, y - 1, z), vec3(x, y + RAILING, z));
        }
      }
      plain.push(shapes.length);
      shapes.push({ kind: "convex", points: corners });
    }
  }
  if (s.walls) {
    const high = Math.max(s.from.y, s.to.y) + s.rise + s.ceiling + 1;
    for (const side of [-1, 1]) {
      // Across: to the right of the way down the flight.
      const ox = (dz / run) * side * (s.width / 2 + 0.5), oz = (-dx / run) * side * (s.width / 2 + 0.5);
      shapes.push({ kind: "box", center: vec3((s.from.x + s.to.x) / 2 + ox, (high + base) / 2, (s.from.z + s.to.z) / 2 + oz), half: vec3(0.5, (high - base) / 2, run / 2), rotation });
    }
  }
  return { shapes, paths: [path], plain };
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

export interface RotundaSpec {
  /** Its middle (x, z), the floor's height there, its radius inside and its wall's thickness. */
  centre: [number, number];
  floor: number;
  radius: number;
  wall: number;
  /** Clear height inside, to its vault. */
  height: number;
  /** Its doorways: facing out (degrees, 0 = +z), each as wide and high as its socket - and how long
   *  a straight tunnel runs out from the round wall to it, its socket at the tunnel's end. */
  doors: { facing: number; width: number; height: number; tunnel: number }[];
  /** Round pillars: at these facings, this far out from the middle, this thick. */
  pillars: { facings: number[]; ring: number; radius: number };
}

/**
 * A round room (DUNGEONS.md, *A part*): its floor and vault in wedges from its middle, its wall a
 * ring of pieces whose insides are chords touching the radius at their middles - open where a door
 * is, a lintel over it - and round pillars, each a twelve-sided prism, drawn whole.
 */
export function rotundaGeometry(r: RotundaSpec): KitGeometry {
  const deg = Math.PI / 180;
  const pieces = 48;
  const [cx, cz] = r.centre;
  const point = (a: number, rad: number, y: number): Vec3 => vec3(cx + rad * Math.sin(a), y, cz + rad * Math.cos(a));
  const wedge = (a0: number, a1: number, r0: number, r1: number, y0: number, y1: number): ShapeDesc => {
    const mid = (a0 + a1) / 2, half = (a1 - a0) / 2;
    const points: Vec3[] = [];
    for (const y of [y0, y1]) {
      if (r0 > 0) points.push(point(a0, r0, y), point(a1, r0, y));
      else points.push(vec3(cx, y, cz));
      points.push(point(a0, r1, y), point(mid, r1 / Math.cos(half), y), point(a1, r1, y));
    }
    return { kind: "convex", points };
  };
  const shapes: ShapeDesc[] = [];
  const whole: number[] = [];
  const outer = r.radius + r.wall;
  const top = r.floor + r.height;
  for (let i = 0; i < pieces; i++) {
    // Turned half a piece, so the ways through (on the axes) cross wedges' middles, not their seams.
    const a0 = ((i + 0.5) / pieces) * 2 * Math.PI, a1 = ((i + 1.5) / pieces) * 2 * Math.PI;
    shapes.push(wedge(a0, a1, 0, outer, r.floor - 1, r.floor));
    shapes.push(wedge(a0, a1, 0, outer, top, top + 1));
    // The wall, but where a door is: there only a lintel over it.
    const mid = (a0 + a1) / 2;
    const door = r.doors.find((d) => {
      const away = Math.abs(((((mid - d.facing * deg) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return away < Math.asin(Math.min(1, d.width / 2 / r.radius)) + (a1 - a0) / 2;
    });
    const inner = r.radius / Math.cos((a1 - a0) / 2);
    if (!door) shapes.push(wedge(a0, a1, inner, outer, r.floor - 1, top + 1));
    else if (r.floor + door.height < top) shapes.push(wedge(a0, a1, inner, outer, r.floor + door.height, top + 1));
  }
  // Each way in a straight tunnel from the round wall out to its doorway: its walls 3 m thick, from
  // the wall's inside curve (so no gap opens where the wall curves away from the opening) out to the
  // doorway; a floor and a vault from the circle out.
  const plain: number[] = [];
  const side = 3;
  for (const d of r.doors) {
    if (d.tunnel <= 0) continue;
    const f = d.facing * deg, w = d.width / 2, far = r.radius + d.tunnel;
    const at = (u: number, v: number, y: number): Vec3 => vec3(cx + v * Math.sin(f) + u * Math.cos(f), y, cz + v * Math.cos(f) - u * Math.sin(f));
    const prism = (corners: [number, number][], y0: number, y1: number): ShapeDesc => ({ kind: "convex", points: [...corners.map(([u, v]) => at(u, v, y0)), ...corners.map(([u, v]) => at(u, v, y1))] });
    const circle = (u: number): number => Math.sqrt(Math.max(0, r.radius * r.radius - u * u));
    shapes.push(prism([[-w - side, r.radius - 1], [w + side, r.radius - 1], [w + side, far], [-w - side, far]], r.floor - 1, r.floor));
    for (const s of [1, -1]) {
      plain.push(shapes.length);
      shapes.push(prism([[s * w, circle(w)], [s * (w + side), circle(w + side)], [s * (w + side), far], [s * w, far]], r.floor - 1, r.floor + d.height + 1));
    }
    // From just behind the round wall's face (its chords reach out to radius / cos of half a piece),
    // so it never cuts that face into a sliver ending under it.
    const behind = r.radius / Math.cos(Math.PI / pieces) + 0.01;
    shapes.push(prism([[-w - side, behind], [w + side, behind], [w + side, far], [-w - side, far]], r.floor + d.height, r.floor + d.height + 1));
  }
  const ring = Array.from({ length: 12 }, (_, k) => (k * Math.PI) / 6);
  for (const f of r.pillars.facings) {
    const px = cx + r.pillars.ring * Math.sin(f * deg), pz = cz + r.pillars.ring * Math.cos(f * deg);
    const at = (a: number, y: number): Vec3 => vec3(px + r.pillars.radius * Math.sin(a), y, pz + r.pillars.radius * Math.cos(a));
    whole.push(shapes.length);
    shapes.push({ kind: "convex", points: [...ring.map((a) => at(a, r.floor - 1)), ...ring.map((a) => at(a, top + 1))] });
  }
  return { shapes, paths: [], whole, plain };
}
