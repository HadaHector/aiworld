// The dungeon the player is in, as the page draws it (DUNGEONS.md): laid out again from what the
// server says - its style, size, seed and site - so it is the server's layout to the part; its
// parts drawn and baked; its colliders in the page's collision world (the camera's, and the rays
// that keep a torch from lighting the player through a wall); and the daylight fading out while the
// player is inside it.
import type { DungeonMessage } from "../sim/protocol";
import type { DungeonContent } from "../world/dungeons/dungeonDefs";
import { generateLayout, placedShapes, worldToFrame, type DungeonLayout } from "../world/dungeons/layout";
import { createDungeonMeshes, type DungeonMeshes } from "../world/dungeons/dungeonMeshes";
import { buildCave, caveColliders } from "../world/dungeons/caveField";
import { createCaveMeshes } from "../world/dungeons/caveMeshes";
import type { DimensionView } from "./dimensionView";
import type { PropEffects } from "../world/props/propEffects";

export interface DungeonPresence {
  /** The server's word on the dungeon the player is in: builds it - resolving once it is baked -
   *  or drops it. */
  receive: (message: DungeonMessage, onProgress: (phase: string, done: number, total: number) => void) => Promise<void>;
  /** Each frame: the light underground while the player is in it, the day's out of it. */
  update: (x: number, y: number, z: number) => void;
  /** Where the player is in what is drawn: its style, and whether in the boss's room - for the ambience and the music; null outside it. */
  readonly where: { style: string; boss: boolean } | null;
  /** What is drawn now, for the console. */
  readonly current: { id: string; layout: DungeonLayout; meshes: DungeonMeshes } | null;
  dispose: () => void;
}

export function createDungeonPresence(view: DimensionView, content: DungeonContent, flames?: PropEffects): DungeonPresence {
  const { world, scene } = view;
  let removeFlames: (() => void) | null = null;
  let current: { id: string; layout: DungeonLayout; meshes: DungeonMeshes; batch: number; ambient: [number, number, number]; inside: boolean } | null = null;

  function drop(): void {
    if (!current) return;
    current.meshes.dispose();
    world.collision.world.removeBatch(current.batch);
    world.setExtraLights(null);
    removeFlames?.();
    removeFlames = null;
    world.setUnderground(null, true);
    current = null;
  }

  function inside(layout: DungeonLayout, siteY: number, x: number, y: number, z: number): boolean {
    const { fx, fz } = worldToFrame(layout.frame, x, z);
    return layout.parts.some((p) => {
      const b = p.box;
      if (p.role === "entrance" && !p.part.exterior && y > siteY - 4) return false;
      return fx >= b.min.x - 0.5 && fx <= b.max.x + 0.5 && fz >= b.min.z - 0.5 && fz <= b.max.z + 0.5 && y >= b.min.y - 0.5 && y <= b.max.y + 0.5;
    });
  }

  let siteY = 0;
  let inBoss = false;
  /** Whether a point is in the boss's own part. */
  function inBossRoom(layout: DungeonLayout, x: number, y: number, z: number): boolean {
    const part = layout.parts[layout.boss];
    if (!part) return false;
    const { fx, fz } = worldToFrame(layout.frame, x, z);
    const b = part.box;
    return fx >= b.min.x && fx <= b.max.x && fz >= b.min.z && fz <= b.max.z && y >= b.min.y - 0.5 && y <= b.max.y + 0.5;
  }
  return {
    async receive(message, onProgress) {
      if (message.id === "") return drop();
      if (current?.id === message.id) return;
      drop();
      const style = content.styles.get(message.style);
      if (!style) throw new Error(`no dungeon style "${message.style}"`);
      onProgress(`Laying out the ${style.name.toLowerCase()}`, 0, 0);
      const site = { x: message.x, y: message.y, z: message.z, facing: message.facing, mouth: message.mouth };
      siteY = message.y;
      // The ground as the server's is: the same world, so the same layout.
      const ground = { heightAt: world.heightAt, builtAt: (x: number, z: number) => world.buildingAt(x, world.heightAt(x, z) + 0.5, z) !== undefined };
      const layout = generateLayout(content, message.style, message.size, message.seed, site, ground);
      let meshes: DungeonMeshes, batch: number;
      if (style.builder === "field") {
        // A cave: its rock meshed as a whole, drawn and collided with as that.
        onProgress(`Shaping the ${style.name.toLowerCase()}`, 0, 0);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const cave = buildCave(layout, style, ground);
        batch = world.collision.world.addBatch(caveColliders(cave));
        meshes = await createCaveMeshes(scene, layout, style, cave, {
          seed: view.seed,
          materials: view.content.materials,
          lit: world.materialLibrary.litShading,
          props: (id) => view.content.props.find((p) => p.id === id),
          building: world.buildingMaterial,
        });
      } else {
        batch = world.collision.world.addBatch(layout.parts.flatMap(placedShapes));
        const fixture = view.content.props.find((p) => p.id === style.light.fixture);
        if (!fixture) console.warn(`The dungeon style "${style.id}" names a fixture "${style.light.fixture}" that no pack has: it is unlit.`);
        const near = (): { x: number; y: number; z: number } => view.character.mesh.position;
        meshes = createDungeonMeshes(scene, layout, style, fixture, world.buildingMaterial, near, (done, total) => onProgress("Lighting the torches", done, total), (id) => view.content.props.find((p) => p.id === id));
      }
      world.setExtraLights(meshes.lights);
      removeFlames = flames?.add(meshes.effects, (x, y, z) => ({ x, y, z })) ?? null;
      // In it already (put at its foot), the day gone at once; else (near its mouth) as it is walked into.
      const at = view.character.mesh.position;
      const now = inside(layout, siteY, at.x, at.y, at.z);
      current = { id: message.id, layout, meshes, batch, ambient: style.light.ambient, inside: now };
      if (now) world.setUnderground(style.light.ambient, true);
      const baked = await meshes.baked;
      console.info(`dungeon ${message.id}: ${layout.parts.length} parts, ${meshes.stats.triangles} triangles built in ${meshes.stats.buildMs.toFixed(0)} ms, lit in ${baked.ms.toFixed(0)} ms (${baked.cached} parts from the cache)`);
    },
    update(x, y, z) {
      if (!current) return;
      const now = inside(current.layout, siteY, x, y, z);
      inBoss = now && inBossRoom(current.layout, x, y, z);
      if (now === current.inside) return;
      current.inside = now;
      world.setUnderground(now ? current.ambient : null);
    },
    get where() {
      return current?.inside ? { style: current.layout.style, boss: inBoss } : null;
    },
    get current() {
      return current && { id: current.id, layout: current.layout, meshes: current.meshes };
    },
    dispose: drop,
  };
}
