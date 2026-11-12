// What a kit-built dungeon part is made of (DUNGEONS.md, *A part*): its colliders, written in the
// part's own frame as boxes, straight stairs and spiral stairs, and the lines its floor is walked
// along. Pure data in, collision shapes out - the generator moves them into the world.
import { quatFromEuler, vec3, type ShapeDesc, type Vec3 } from "../collision/index";

export type Polyline = Vec3[];

/** A part's colliders and walk lines, in its own frame. */
export interface KitGeometry {
  shapes: ShapeDesc[];
  paths: Polyline[];
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
    const vault = b1 <= a0 + 2 * Math.PI + 1e-9 ? cap : top + s.rise + s.ceiling;
    // Under the outer wall too, so a door through it has a floor.
    shapes.push(sector(b0, b1, s.inner * 0.98, s.outer + s.wall, top - 1, top));
    shapes.push(sector(b0, b1, s.inner * 0.98, s.outer + s.wall, vault, vault + 1));
    const c = (b0 + b1) / 2;
    const atDoor = Math.abs(c - doorStart) < door || Math.abs(c - doorEnd) < door;
    // The wall's inside a chord touching the outer radius at its middle, never inside it.
    if (!atDoor) shapes.push(sector(b0, b1, s.outer / Math.cos((b1 - b0) / 2), s.outer + s.wall, top - 1, vault + 1));
    path.push(point(c, mid, top));
  }
  // Where the top landing stops short of the stairwell: a stone railing across its end, just past
  // the doorway, low enough to jump over and drop to the stair below.
  const step = span / count;
  shapes.push(sector(a0 - Math.min(step, 0.6 / mid), a0, s.inner * 0.98, s.outer + s.wall, s.top - 0.5, s.top + RAILING));
  // Where the bottom landing stops, just past its doorway: a wall across, up under the lap above.
  const end = a0 + span;
  const over = Math.floor((end - 2 * Math.PI - a0) / step);
  const wallTop = over >= 0 ? heightOf(over) - 1 + 0.05 : s.top - s.drop + s.rise + s.ceiling + 1;
  shapes.push(sector(end, end + Math.min(step, 1 / mid), s.inner * 0.98, s.outer + s.wall, s.top - s.drop - 1, wallTop));
  path.push(point(doorEnd, mid, s.top - s.drop), point(doorEnd, s.outer + s.wall, s.top - s.drop));
  // The pillar: a twelve-sided prism inside the inner radius, so no flat of it narrows the way.
  const low = s.top - s.drop - 1, high = s.top + s.rise + s.ceiling + 1;
  const ring = Array.from({ length: 12 }, (_, k) => (k * Math.PI) / 6);
  shapes.push({ kind: "convex", points: [...ring.map((a) => point(a, s.inner, low)), ...ring.map((a) => point(a, s.inner, high))] });
  return { shapes, paths: [path] };
}

export const DOORWAY_KINDS = ["frame", "arch", "door"] as const;
export type DoorwayKind = (typeof DOORWAY_KINDS)[number];

export interface DoorwaySpec {
  kind: DoorwayKind;
  /** The way through it: its socket's width and height. */
  width: number;
  height: number;
  /** How far it reaches either side of the socket's plane, how far each jamb reaches out from the
   *  opening, how deep the lintel and the sill are; an arch's rise over the opening. */
  depth: number;
  jamb: number;
  lintel: number;
  rise: number;
}

/**
 * A doorway across a socket's plane (z 0), the way through it along z (DUNGEONS.md, *Doorways*):
 * jambs, a sill and a lintel thick enough to reach into both parts it joins - so it covers where
 * their walls meet, whatever their shapes - and, for an arch, the lintel's underside rising in a
 * curve; for a door, its two leaves standing open into +z (drawn, not in the way: `visuals`).
 */
export function doorwayGeometry(d: DoorwaySpec): { shapes: ShapeDesc[]; visuals: ShapeDesc[]; paths: Polyline[] } {
  const w = d.width / 2, h = d.height;
  const top = h + (d.kind === "arch" ? d.rise : 0) + d.lintel;
  const shapes: ShapeDesc[] = [
    boxShape(-w - d.jamb, -1, -d.depth, -w, top, d.depth),
    boxShape(w, -1, -d.depth, w + d.jamb, top, d.depth),
    boxShape(-w, -1, -d.depth, w, 0, d.depth),
  ];
  if (d.kind === "arch") {
    // A segmental arch springing at the opening's height: its underside a circle's arc through the
    // jambs' tops and `rise` over the middle, in pieces each solid up to the top.
    const r = (w * w + d.rise * d.rise) / (2 * d.rise), cy = h + d.rise - r;
    const pieces = 8;
    for (let i = 0; i < pieces; i++) {
      const x0 = -w + (2 * w * i) / pieces, x1 = -w + (2 * w * (i + 1)) / pieces;
      const y = (x: number): number => cy + Math.sqrt(Math.max(0, r * r - x * x));
      const points: Vec3[] = [];
      for (const z of [-d.depth, d.depth]) points.push(vec3(x0, y(x0), z), vec3(x1, y(x1), z), vec3(x0, top, z), vec3(x1, top, z));
      shapes.push({ kind: "convex", points });
    }
  } else {
    shapes.push(boxShape(-w, h, -d.depth, w, top, d.depth));
  }
  const visuals: ShapeDesc[] = [];
  if (d.kind === "door") {
    // Two leaves swung wide, back along the walls of the part beyond.
    const t = 0.15;
    visuals.push(boxShape(-w, 0.05, d.depth, -w + t, h - 0.1, d.depth + w), boxShape(w - t, 0.05, d.depth, w, h - 0.1, d.depth + w));
  }
  return { shapes, visuals, paths: [[vec3(0, 0, -d.depth), vec3(0, 0, d.depth)]] };
}
