// A cave in the workbench (DUNGEONS.md, *Dev pages*): one field part on its own, or a whole cave
// of a field style, drawn by the game's own code (caveField.ts, caveMeshes.ts) - its rock in the
// cave shader, its fixtures set against it and their light baked in - moved to stand on the grid,
// its middle over the origin.
import type { Scene } from "@babylonjs/core";
import type { WorldContent } from "../world/content/worldContent";
import type { DungeonStyleDef } from "../world/dungeons/dungeonDefs";
import type { DungeonLayout } from "../world/dungeons/layout";
import { buildCave } from "../world/dungeons/caveField";
import { createCaveMeshes } from "../world/dungeons/caveMeshes";
import type { LitShading } from "../world/materials/litShading";
import type { BuildingMaterial } from "../world/buildings/buildingMesh";

/** The layout moved by (dx, dy, dz): every part, its box and its bounds. */
function moveLayout(layout: DungeonLayout, dx: number, dy: number, dz: number): DungeonLayout {
  const box = (b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) => ({
    min: { x: b.min.x + dx, y: b.min.y + dy, z: b.min.z + dz },
    max: { x: b.max.x + dx, y: b.max.y + dy, z: b.max.z + dz },
  });
  return {
    ...layout,
    frame: { ...layout.frame, x: layout.frame.x + dx, z: layout.frame.z + dz },
    parts: layout.parts.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz, bounds: box(p.bounds) })),
  };
}

/** How far a cave is moved to stand on the grid, its middle over the origin; and how big it is. */
export function caveOffset(layout: DungeonLayout): { by: [number, number, number]; width: number; height: number } {
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const p of layout.parts) {
    b.x0 = Math.min(b.x0, p.bounds.min.x); b.y0 = Math.min(b.y0, p.bounds.min.y); b.z0 = Math.min(b.z0, p.bounds.min.z);
    b.x1 = Math.max(b.x1, p.bounds.max.x); b.y1 = Math.max(b.y1, p.bounds.max.y); b.z1 = Math.max(b.z1, p.bounds.max.z);
  }
  return { by: [-(b.x0 + b.x1) / 2, -b.y0 + 1, -(b.z0 + b.z1) / 2], width: Math.max(b.x1 - b.x0, b.z1 - b.z0), height: b.y1 - b.y0 };
}

/** What the stage's `drawn` hook runs for a cave: it built, moved by `caveOffset`, and how big it is. */
export function caveDrawn(layout: DungeonLayout, style: DungeonStyleDef, content: WorldContent, seed: number, report: (facts: string) => void) {
  return async (scene: Scene, world: { lit: LitShading; building: BuildingMaterial }): Promise<{ width: number; height: number }> => {
    const offset = caveOffset(layout);
    const moved = moveLayout(layout, ...offset.by);
    const cave = buildCave(moved, style);
    const meshes = await createCaveMeshes(scene, moved, style, cave, {
      seed,
      materials: content.materials,
      lit: world.lit,
      props: (id) => content.props.find((p) => p.id === id),
      building: world.building,
    });
    await meshes.baked;
    report(`${cave.chunks.length} chunks, ${meshes.stats.triangles} triangles, ${meshes.lights.length} lights; sampled and meshed in ${cave.stats.ms.toFixed(0)} ms, drawn and lit in ${(meshes.stats.buildMs - cave.stats.ms).toFixed(0)} ms`);
    return { width: offset.width, height: offset.height };
  };
}
