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
  for (let i = 0; i < count; i++) {
    const b0 = angleOf(i), b1 = angleOf(i + 1);
    const top = heightOf(i);
    // Under the outer wall too, so a door through it has a floor.
    shapes.push(sector(b0, b1, s.inner * 0.98, s.outer + s.wall, top - 1, top));
    shapes.push(sector(b0, b1, s.inner * 0.98, s.outer + s.wall, top + s.rise + s.ceiling, top + s.rise + s.ceiling + 1));
    const c = (b0 + b1) / 2;
    const atDoor = Math.abs(c - doorStart) < door || Math.abs(c - doorEnd) < door;
    // The wall's inside a chord touching the outer radius at its middle, never inside it.
    if (!atDoor) shapes.push(sector(b0, b1, s.outer / Math.cos((b1 - b0) / 2), s.outer + s.wall, top - 1, top + s.rise + s.ceiling + 1));
    path.push(point(c, mid, top));
  }
  path.push(point(doorEnd, mid, s.top - s.drop), point(doorEnd, s.outer + s.wall, s.top - s.drop));
  // The pillar: a twelve-sided prism inside the inner radius, so no flat of it narrows the way.
  const low = s.top - s.drop - 1, high = s.top + s.rise + s.ceiling + 1;
  const ring = Array.from({ length: 12 }, (_, k) => (k * Math.PI) / 6);
  shapes.push({ kind: "convex", points: [...ring.map((a) => point(a, s.inner, low)), ...ring.map((a) => point(a, s.inner, high))] });
  return { shapes, paths: [path] };
}
