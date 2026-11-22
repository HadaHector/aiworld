// A cave's fixtures (DUNGEONS.md, *Light*): at its parts' `light` spots, the style's share of them
// lit, each one of the style's fixtures by weight - crystals grown at the foot of a wall, a campfire
// on the floor, a torch on the wall - set against the cave's own rock (its field). Pure: their
// model, their lights and their flames, in the world.
import type { BuildingModel, ModelEffect, ModelLight } from "../buildings/buildingTypes";
import { ModelBuilder } from "../buildings/buildingGeometry";
import { generateProp, measureProp } from "../props/propGenerator";
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

/** How far a way's width is looked for either side, and how wide a frame it may span. */
const SPAN_REACH = 8;

/** The open width through (x, y, z) along an angle: both ways to the rock, and the middle of the gap; null if either side is open past the reach. */
function gapAlong(field: CaveField, x: number, y: number, z: number, angle: number): { width: number; mid: [number, number] } | null {
  const dx = Math.sin(angle), dz = Math.cos(angle);
  const reach = (sign: number): number | null => {
    for (let t = 0.25; t < SPAN_REACH; t += 0.25) if (field.rock(x + sign * dx * t, y, z + sign * dz * t) > 0) return t;
    return null;
  };
  const a = reach(1), b = reach(-1);
  if (a === null || b === null) return null;
  return { width: a + b, mid: [x + dx * (a - b) / 2, z + dz * (a - b) / 2] };
}

/** Whether a prop's footprint (a square of `r` half-side) round (x, z) stands in open air at the floor. */
function clearOf(field: CaveField, x: number, floor: number, z: number, r: number): boolean {
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
    if (field.rock(x + ox, floor + 0.7, z + oz) > 0 || field.rock(x + ox, floor + 1.8, z + oz) > 0) return false;
  }
  return true;
}

/**
 * A style's dressing (`light.dressing`): props set about each part's light spots besides the lit
 * fixture - supports across the way, shoring against its walls, rails along it, carts, tools and ore
 * on the floor. Their models appended to `b`; they give no light.
 */
function dress(b: ModelBuilder, layout: DungeonLayout, style: DungeonStyleDef, field: CaveField, props: (id: string) => PropDef | undefined): number {
  const entries = (style.light.dressing ?? []).map((d) => ({ ...d, def: props(d.prop) })).filter((d): d is typeof d & { def: PropDef } => !!d.def);
  let placed = 0;
  layout.parts.forEach((p, index) => {
    const random = mulberry32(deriveSeed(layout.seed, index * 6271 + 41));
    placedSpots(p, "light").forEach((spot, i) => {
      const floor0 = floorUnder(field, spot.x, spot.y + 2, spot.z);
      if (floor0 === null) return;
      // The way's direction here: the narrowest of eight crossings is across it.
      let across = 0, narrowest = Infinity;
      for (let k = 0; k < 8; k++) {
        const g = gapAlong(field, spot.x, floor0 + 1.5, spot.z, (k * Math.PI) / 8);
        if (g && g.width < narrowest) { narrowest = g.width; across = (k * Math.PI) / 8; }
      }
      const taken: [number, number][] = [[spot.x, spot.z]];
      const seen = new Set<string>();
      entries.forEach((d, e) => {
        if (d.parts.length > 0 && !d.parts.some((t) => p.part.tags.includes(t))) return;
        // A group (spans of several widths) is rolled once, by its first entry.
        if (d.group) {
          if (seen.has(d.group)) return;
          seen.add(d.group);
        }
        if (random() >= d.chance) return;
        const seed = deriveSeed(layout.seed, index * 131 + i * 17 + e);
        const put = (def: PropDef, x: number, y: number, z: number, fx: number, fz: number, variant: number): void => {
          b.appendFurniture(generateProp(def, seed, variant), x, y, z, fx, fz);
          placed++;
        };
        const variant = Math.floor(random() * 6);
        if (d.place === "span") {
          if (!isFinite(narrowest)) return;
          // The member of its group that fits the gap best.
          const members = d.group ? entries.filter((m) => m.group === d.group && (m.parts.length === 0 || m.parts.some((t) => p.part.tags.includes(t)))) : [d];
          const alongX = Math.cos(across), alongZ = -Math.sin(across);
          for (let n = 0; n < d.run; n++) {
            const shift = (n - (d.run - 1) / 2) * 5.5 + (random() - 0.5) * 1.5;
            const x = spot.x + alongX * shift, z = spot.z + alongZ * shift;
            const f = floorUnder(field, x, floor0 + 2, z);
            if (f === null) continue;
            const g = gapAlong(field, x, f + 1.5, z, across);
            if (!g) continue;
            const best = members.reduce((a, m) => (Math.abs(measureProp(m.def, seed, variant).halfWidth * 2 - g.width) < Math.abs(measureProp(a.def, seed, variant).halfWidth * 2 - g.width) ? m : a));
            // Its feet on the lower of the floor under either post.
            const lo = Math.min(f, floorUnder(field, g.mid[0] + Math.sin(across) * g.width * 0.45, f + 2, g.mid[1] + Math.cos(across) * g.width * 0.45) ?? f, floorUnder(field, g.mid[0] - Math.sin(across) * g.width * 0.45, f + 2, g.mid[1] - Math.cos(across) * g.width * 0.45) ?? f);
            put(best.def, g.mid[0], lo - 0.05, g.mid[1], alongX, alongZ, variant);
          }
          return;
        }
        if (d.place === "along") {
          const alongX = Math.cos(across), alongZ = -Math.sin(across);
          const length = measureProp(d.def, seed, variant).halfDepth * 2;
          const start = (random() - 0.5) * 4;
          for (let n = 0; n < d.run; n++) {
            const shift = start + (n - (d.run - 1) / 2) * length;
            const x = spot.x + alongX * shift, z = spot.z + alongZ * shift;
            const f = floorUnder(field, x, floor0 + 2, z);
            if (f === null || !clearOf(field, x, f, z, 1.3)) break;
            put(d.def, x, f - 0.03, z, alongX, alongZ, variant);
          }
          return;
        }
        if (d.place === "against") {
          const wall = nearestWall(field, spot.x, floor0 + 1.2, spot.z, random() * Math.PI * 2);
          if (!wall) return;
          const hx = wall.x + wall.out[0] * 0.6, hz = wall.z + wall.out[1] * 0.6;
          const f = floorUnder(field, hx, floor0 + 2, hz);
          if (f === null || taken.some(([tx, tz]) => Math.hypot(tx - wall.x, tz - wall.z) < 3)) return;
          taken.push([wall.x, wall.z]);
          put(d.def, wall.x - wall.out[0] * 0.15, f - 0.05, wall.z - wall.out[1] * 0.15, wall.out[0], wall.out[1], variant);
          return;
        }
        // On the floor, a few metres from the spot, turned any way.
        for (let attempt = 0; attempt < 6; attempt++) {
          const a = random() * Math.PI * 2, r = 2 + random() * 2.5;
          const x = spot.x + Math.sin(a) * r, z = spot.z + Math.cos(a) * r;
          const f = floorUnder(field, x, floor0 + 2, z);
          if (f === null || !clearOf(field, x, f, z, 1.1) || taken.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 2.6)) continue;
          taken.push([x, z]);
          const t = random() * Math.PI * 2;
          put(d.def, x, f - 0.03, z, Math.sin(t), Math.cos(t), variant);
          break;
        }
      });
    });
  });
  return placed;
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
  placed += dress(b, layout, style, field, props);
  const model = placed > 0 ? b.finish({ x: 0, z: 0 }) : null;
  return { model, lights: model?.lights ?? [], effects: model?.effects ?? [] };
}
