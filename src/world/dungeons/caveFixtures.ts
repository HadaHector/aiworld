// A cave's fixtures (DUNGEONS.md, *Light*): at its parts' `light` spots, the style's share of them
// lit, each one of the style's fixtures by weight - crystals grown at the foot of a wall, a campfire
// on the floor, a torch on the wall - set against the cave's own rock (its field). Pure: their
// model, their lights and their flames, in the world.
import type { BuildingModel, ModelEffect, ModelLight } from "../buildings/buildingTypes";
import { ModelBuilder } from "../buildings/buildingGeometry";
import { generateProp } from "../props/propGenerator";
import type { PropDef } from "../props/propTypes";
import { deriveSeed, mulberry32 } from "../rng";
import type { DungeonStyleDef } from "./dungeonDefs";
import { placedSpots, type DungeonLayout } from "./layout";
import type { CaveField } from "./caveField";

export interface CaveFixtures {
  model: BuildingModel | null;
  lights: ModelLight[];
  effects: ModelEffect[];
}

/** How far a fixture looks for a wall round its spot. */
const WALL_REACH = 24;
/** A torch's flame over the floor. */
const TORCH_HEIGHT = 3.2;

/** The open space's floor under a point: down from it to the rock (null: none within 12 m). */
function floorUnder(field: CaveField, x: number, y: number, z: number): number | null {
  if (field.rock(x, y, z) > 0) return null;
  for (let d = 0; d < 12; d += 0.25) {
    if (field.rock(x, y - d, z) > 0) {
      // Halve the last step for where it crosses.
      let lo = y - d, hi = y - d + 0.25;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        if (field.rock(x, mid, z) > 0) lo = mid;
        else hi = mid;
      }
      return hi;
    }
  }
  return null;
}

/** The nearest rock round a point, level with it, looked for in 16 ways: where, and which way out of it. */
function nearestWall(field: CaveField, x: number, y: number, z: number, start: number): { x: number; z: number; out: [number, number]; distance: number } | null {
  let best: { x: number; z: number; out: [number, number]; distance: number } | null = null;
  for (let k = 0; k < 16; k++) {
    const a = start + (k * Math.PI) / 8;
    const dx = Math.sin(a), dz = Math.cos(a);
    for (let t = 0.5; t < WALL_REACH; t += 0.25) {
      if (field.rock(x + dx * t, y, z + dz * t) <= 0) continue;
      if (!best || t < best.distance) best = { x: x + dx * t, z: z + dz * t, out: [-dx, -dz], distance: t };
      break;
    }
  }
  if (!best) return null;
  // Out of the rock along its gradient, level.
  const e = 0.3;
  const gx = field.rock(best.x + e, y, best.z) - field.rock(best.x - e, y, best.z);
  const gz = field.rock(best.x, y, best.z + e) - field.rock(best.x, y, best.z - e);
  const l = Math.hypot(gx, gz);
  if (l > 1e-6) best.out = [-gx / l, -gz / l];
  return best;
}

/** The fixtures at a cave's light spots: their models together, their lights and flames. */
export function caveFixtures(layout: DungeonLayout, style: DungeonStyleDef, field: CaveField, props: (id: string) => PropDef | undefined): CaveFixtures {
  const options = (style.light.fixtures ?? [{ prop: style.light.fixture, weight: 1, place: "wall" as const }])
    .map((f) => ({ ...f, def: props(f.prop) }))
    .filter((f): f is typeof f & { def: PropDef } => {
      if (!f.def) console.warn(`The dungeon style "${style.id}" names a fixture "${f.prop}" that no pack has.`);
      return !!f.def;
    });
  const b = new ModelBuilder();
  let placed = 0;
  if (options.length > 0) {
    const total = options.reduce((s, o) => s + o.weight, 0);
    layout.parts.forEach((p, index) => {
      const random = mulberry32(deriveSeed(layout.seed, index * 7919 + 13));
      placedSpots(p, "light").forEach((spot, i) => {
        if (random() >= style.light.lit) return;
        let r = random() * total;
        const option = options.find((o) => (r -= o.weight) < 0) ?? options[options.length - 1];
        const model = generateProp(option.def, deriveSeed(layout.seed, index * 131 + i), i);
        const start = random() * Math.PI * 2;
        const floor = floorUnder(field, spot.x, spot.y + 2, spot.z);
        if (floor === null) return;
        if (option.place === "floor") {
          // On the floor where the spot is, turned any way.
          b.appendFurniture(model, spot.x, floor, spot.z, Math.sin(start), Math.cos(start));
          placed++;
          return;
        }
        const level = option.place === "wall" ? floor + TORCH_HEIGHT : floor + 1;
        const wall = nearestWall(field, spot.x, level, spot.z, start);
        if (!wall) return;
        if (option.place === "wall") {
          // Its back on the rock (the prop's back 0.35 m behind its origin), facing out; its flame at the height.
          const flame = model.lights?.[0]?.position[1] ?? 0;
          b.appendFurniture(model, wall.x + wall.out[0] * 0.3, level - flame, wall.z + wall.out[1] * 0.3, wall.out[0], wall.out[1]);
        } else {
          // At the wall's foot: a little out from where the rock rises, on the floor there.
          const x = wall.x + wall.out[0] * 1.2, z = wall.z + wall.out[1] * 1.2;
          const foot = floorUnder(field, x, floor + 2, z);
          if (foot === null) return;
          b.appendFurniture(model, x, foot - 0.05, z, wall.out[0], wall.out[1]);
        }
        placed++;
      });
    });
  }
  const model = placed > 0 ? b.finish({ x: 0, z: 0 }) : null;
  return { model, lights: model?.lights ?? [], effects: model?.effects ?? [] };
}
