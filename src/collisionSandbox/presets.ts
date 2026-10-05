// The collision sandbox's ready-made scenes - plain data, so the probe walks the same ones.
import { quatFromEuler, vec3, type ShapeDesc, type Vec3 } from "../world/collision/index";

export interface Preset {
  id: string;
  label: string;
  shapes: ShapeDesc[];
  /** Where the character starts, feet first. */
  spawn: Vec3;
  /** Which way it starts facing - and walks, in the probe. */
  heading: Vec3;
}

const GROUND_SIZE = 64;

/** Flat or rolling ground around the origin. */
export function ground(rolling = 0, cell = 2): ShapeDesc {
  const count = GROUND_SIZE / cell + 1;
  const heights: number[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const x = col * cell - GROUND_SIZE / 2, z = row * cell - GROUND_SIZE / 2;
      heights.push(rolling * (Math.sin(x * 0.21) * Math.cos(z * 0.17) + 0.5 * Math.sin(x * 0.53 + z * 0.41)));
    }
  }
  return { kind: "heightfield", originX: -GROUND_SIZE / 2, originZ: -GROUND_SIZE / 2, cell, columns: count, rows: count, heights };
}

/** A box standing on the ground at (x, z), `w` across x, `h` high, `d` along z, turned by `yaw`. */
export function block(x: number, z: number, w: number, h: number, d: number, yaw = 0, base = 0): ShapeDesc {
  return { kind: "box", center: vec3(x, base + h / 2, z), half: vec3(w / 2, h / 2, d / 2), rotation: quatFromEuler(yaw) };
}

/** A ramp along +x from (x0, z) rising to `rise` over `run`, `width` wide. */
export function ramp(x0: number, z: number, run: number, rise: number, width: number): ShapeDesc {
  const w = width / 2;
  return {
    kind: "convex",
    points: [vec3(x0, 0, z - w), vec3(x0, 0, z + w), vec3(x0 + run, 0, z - w), vec3(x0 + run, 0, z + w), vec3(x0 + run, rise, z - w), vec3(x0 + run, rise, z + w)],
  };
}

const east = vec3(1, 0, 0);

export const PRESETS: Preset[] = [
  {
    id: "wall",
    label: "A wall",
    shapes: [ground(), block(4, 0, 0.4, 3, 8)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "stair",
    label: "A stair",
    shapes: [ground(), ...Array.from({ length: 6 }, (_, i) => block(2 + i * 0.8 + 0.4, 0, 0.8, 0.4 * (i + 1), 3)), block(6.8 + 2, 0, 4, 2.4, 3)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "ledge",
    label: "A ledge too high",
    shapes: [ground(), block(4, 0, 4, 0.7, 4)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "steep",
    label: "A ramp too steep",
    shapes: [ground(), ramp(2, 0, 2.5, 4, 4)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "gentle",
    label: "A gentle ramp",
    shapes: [ground(), ramp(2, 0, 6, 2.2, 4), block(10, 0, 4, 2.2, 4)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "ceiling",
    label: "A low ceiling",
    shapes: [ground(), block(-1.5, 0, 0.4, 2.6, 6), block(1.5, 0, 0.4, 2.6, 6), block(0, 0, 3.4, 0.4, 6, 0, 2.6)],
    spawn: vec3(0, 0, 0),
    heading: vec3(0, 0, 1),
  },
  {
    id: "wedge",
    label: "Two walls in a wedge",
    shapes: [ground(), block(4, -1.2, 0.4, 3, 6, Math.PI / 2 - 0.5), block(4, 1.2, 0.4, 3, 6, Math.PI / 2 + 0.5)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "gap",
    label: "A gap too narrow",
    shapes: [ground(), block(4, -1.85, 0.6, 3, 3), block(4, 1.85, 0.6, 3, 3)],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "pile",
    label: "A pile of tilted shapes",
    shapes: [
      ground(),
      { kind: "box", center: vec3(4, 0.3, 0), half: vec3(1.2, 0.5, 1), rotation: quatFromEuler(0.4, 0.2, 0.15) },
      { kind: "box", center: vec3(5, 1.1, 0.6), half: vec3(0.8, 0.3, 0.8), rotation: quatFromEuler(1.1, -0.3, 0.25) },
      { kind: "sphere", center: vec3(3, 0.2, -2), radius: 0.9 },
      { kind: "capsule", a: vec3(2, 0.3, 2), b: vec3(6, 0.6, 3), radius: 0.35 },
      { kind: "convex", points: [vec3(6, 0, -2), vec3(7.5, 0, -2.5), vec3(7, 0, -0.5), vec3(6.6, 1.4, -1.6), vec3(7.2, 0.8, -1.2)] },
    ],
    spawn: vec3(0, 0, 0),
    heading: east,
  },
  {
    id: "hills",
    label: "Rolling ground",
    shapes: [ground(1)],
    spawn: vec3(0, 0.2, 0),
    heading: vec3(0.8, 0, 0.6),
  },
];
