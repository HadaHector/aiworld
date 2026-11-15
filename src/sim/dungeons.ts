// Dungeons on the server (DUNGEONS.md): each lies where it is generated, under its entrance in the
// dimension it belongs to - its layout from its style, size, seed and site, the same on every side -
// its colliders a batch in the dimension's collision world. Whether it is entered seamlessly or
// through the loading screen is the client's affair: here both are the same.
import type { WorldData } from "../world/worldData";
import type { CollisionWorld } from "../world/collision/index";
import type { DungeonContent } from "../world/dungeons/dungeonDefs";
import { generateLayout, placedPaths, placedShapes, worldToFrame, type DungeonLayout, type DungeonSite } from "../world/dungeons/layout";

/** A dungeon placed in a dimension. */
export interface PlacedDungeon {
  /** Its owner's key, and the dungeon's (DUNGEONS.md, *Entrances*). */
  id: string;
  style: string;
  size: string;
  seed: number;
  site: DungeonSite;
  entry: "seamless" | "space";
  layout: DungeonLayout;
  /** Where a body arrives inside - at the foot of the entrance - and which way it looks. */
  arrival: { x: number; y: number; z: number; facing: number };
  /** Where it comes out: on the ground before the door. */
  exit: { x: number; z: number };
  /** Its colliders' batch in the dimension's collision world. */
  batch: number;
}

export interface DimensionDungeons {
  readonly placed: Map<string, PlacedDungeon>;
  /** Lays a dungeon out and puts it in the collision world - or the one already there by that id. */
  open: (id: string, style: string, size: string, seed: number, site: DungeonSite) => PlacedDungeon;
  /** The dungeon a point is inside (in a part's box, a little grown), if any. */
  at: (x: number, y: number, z: number) => PlacedDungeon | undefined;
  /** Takes a dungeon's colliders back out. */
  close: (id: string) => void;
}

/** The dungeons of one dimension, laid out against its ground. */
export function createDimensionDungeons(world: WorldData, collision: CollisionWorld, content: DungeonContent): DimensionDungeons {
  const placed = new Map<string, PlacedDungeon>();
  const ground = {
    heightAt: (x: number, z: number) => world.heightAt(x, z),
    builtAt: (x: number, z: number) => world.buildingAt(x, world.heightAt(x, z) + 0.5, z) !== undefined,
  };
  return {
    placed,
    open(id, style, size, seed, site) {
      const known = placed.get(id);
      if (known) return known;
      const def = content.styles.get(style);
      if (!def) throw new Error(`no dungeon style "${style}"`);
      const sizeDef = def.sizes[size];
      if (!sizeDef) throw new Error(`the dungeon style "${style}" has no size "${size}"`);
      const layout = generateLayout(content, style, size, seed, site, ground);
      const batch = collision.addBatch(layout.parts.flatMap(placedShapes));
      // The foot of the entrance's stair: its walk line's last point inside, looking on out.
      const line = placedPaths(layout.parts[0])[0];
      const foot = line[line.length - 2], door = line[line.length - 1];
      const facing = Math.atan2(door.x - foot.x, door.z - foot.z);
      const out = (site.facing * Math.PI) / 180;
      const dungeon: PlacedDungeon = {
        id,
        style,
        size,
        seed,
        site,
        entry: sizeDef.entry,
        layout,
        arrival: { x: foot.x, y: foot.y, z: foot.z, facing },
        exit: { x: site.x + Math.sin(out) * 4, z: site.z + Math.cos(out) * 4 },
        batch,
      };
      placed.set(id, dungeon);
      return dungeon;
    },
    at(x, y, z) {
      for (const dungeon of placed.values()) {
        const { frame } = dungeon.layout;
        const { fx, fz } = worldToFrame(frame, x, z);
        // The entrance's top reaches the surface: from a little under it, the dungeon's.
        for (const p of dungeon.layout.parts) {
          const b = p.box;
          if (fx >= b.min.x - 0.5 && fx <= b.max.x + 0.5 && fz >= b.min.z - 0.5 && fz <= b.max.z + 0.5 && y >= b.min.y - 0.5 && y <= b.max.y + 0.5) {
            if (p.role === "entrance" && y > dungeon.site.y - 4) continue;
            return dungeon;
          }
        }
      }
      return undefined;
    },
    close(id) {
      const dungeon = placed.get(id);
      if (!dungeon) return;
      collision.removeBatch(dungeon.batch);
      placed.delete(id);
    },
  };
}

/** A placed building that is a dungeon's mouth (a churchyard's mausoleum): where its door is, on
 *  the ground, and which way it faces - the dungeon's site. Null for any other building. */
export function mouthSite(world: WorldData, b: { building: { mouth: { depth: number; door: [number, number] } | null }; x: number; z: number; frontX: number; frontZ: number }): DungeonSite | null {
  const m = b.building.mouth;
  if (!m) return null;
  // Its +x is (frontZ, -frontX) to its front.
  const x = b.x + b.frontZ * m.door[0] + b.frontX * (m.depth / 2), z = b.z - b.frontX * m.door[0] + b.frontZ * (m.depth / 2);
  return { x, y: world.heightAt(x, z), z, facing: (Math.atan2(b.frontX, b.frontZ) * 180) / Math.PI };
}

/**
 * Where a dungeon could open near a point (step 5 sites them for real): the nearest cemetery's crypt
 * within `reach`, its door its facing; else the nearest hillside the probe would take - rising 5 m
 * within 20 m and 12 m within 40 m behind the door - facing down the slope, the dungeon running in
 * under the rise.
 */
export function dungeonSiteNear(world: WorldData, x: number, z: number, reach = 1500): (DungeonSite & { kind: "crypt" | "slope" }) | null {
  let best: (DungeonSite & { kind: "crypt" | "slope" }) | null = null;
  let bestDistance = reach;
  for (const layout of world.compoundLayouts) {
    for (const b of layout.buildings) {
      const site = mouthSite(world, b);
      if (!site) continue;
      const d = Math.hypot(site.x - x, site.z - z);
      if (d >= bestDistance) continue;
      bestDistance = d;
      best = { kind: "crypt", ...site };
    }
  }
  if (best) return best;
  // Rings outward from the point, every 20 m, 24 directions a ring.
  for (let r = 0; r <= reach; r += 20) {
    for (let k = 0; k < (r === 0 ? 1 : 24); k++) {
      const a = (k / 24) * Math.PI * 2;
      const sx = x + Math.sin(a) * r, sz = z + Math.cos(a) * r;
      if (world.waterAt(sx, sz).depth > 0) continue;
      const h = world.heightAt(sx, sz);
      const gx = world.heightAt(sx + 20, sz) - world.heightAt(sx - 20, sz), gz = world.heightAt(sx, sz + 20) - world.heightAt(sx, sz - 20);
      const g = Math.hypot(gx, gz);
      if (g / 40 < 0.1) continue;
      const ux = gx / g, uz = gz / g;
      if (world.heightAt(sx + ux * 20, sz + uz * 20) < h + 5 || world.heightAt(sx + ux * 40, sz + uz * 40) < h + 12) continue;
      return { kind: "slope", x: sx, y: h, z: sz, facing: (Math.atan2(-gx, -gz) * 180) / Math.PI };
    }
  }
  return null;
}
