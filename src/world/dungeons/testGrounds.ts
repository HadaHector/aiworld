// Made-up ground to lay dungeons out under on the dev pages (dungeons.html, the collision sandbox's
// dungeon scene): the entrance at the origin, its door facing south, the dungeon running north.
// The real terrain is the probe's (scripts/probe/dungeons.mjs).
import type { ShapeDesc } from "../collision/index";
import type { DungeonGround, DungeonSite } from "./layout";

export interface TestGround {
  id: string;
  label: string;
  heightAt: (x: number, z: number) => number;
}

export const TEST_GROUNDS: TestGround[] = [
  { id: "flat", label: "Flat (a churchyard)", heightAt: () => 0 },
  // Rising north from the door, levelling off 30 m up.
  { id: "hill", label: "A hillside", heightAt: (x, z) => 30 * Math.tanh(Math.max(0, z) / 70) + 2 * Math.sin(x * 0.03) },
  // A ridge 40 m wide just behind the door, falling away beyond.
  { id: "ridge", label: "Below a ridge", heightAt: (x, z) => 26 * Math.exp(-(((z - 30) / 32) ** 2)) + 1.5 * Math.sin(x * 0.04) },
  // A hillside with a valley across it 90 m in.
  { id: "valley", label: "A valley behind", heightAt: (_x, z) => 30 * Math.tanh(Math.max(0, z) / 70) - 24 * Math.exp(-(((z - 90) / 18) ** 2)) },
];

export function testGround(id: string): TestGround {
  return TEST_GROUNDS.find((g) => g.id === id) ?? TEST_GROUNDS[0];
}

/** The ground as the generator sees it - nothing built on it. */
export function asDungeonGround(g: TestGround): DungeonGround {
  return { heightAt: g.heightAt, builtAt: () => false };
}

/** The entrance's site on a test ground: at the origin, the door facing south. */
export function testSite(g: TestGround): DungeonSite {
  return { x: 0, y: g.heightAt(0, 0), z: 0, facing: 180 };
}

/**
 * The ground as a heightfield over a square, a slab `depth` deep, with holes where `open` says - over
 * an entrance, which stands in a pit cut into the ground (DUNGEONS.md, *Entrances*).
 */
export function groundShape(g: TestGround, centreX: number, centreZ: number, size: number, cell: number, depth: number, open: (x: number, z: number) => boolean): ShapeDesc {
  const count = Math.ceil(size / cell) + 1;
  const originX = centreX - size / 2, originZ = centreZ - size / 2;
  const heights: number[] = [];
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) heights.push(g.heightAt(originX + col * cell, originZ + row * cell));
  const holes = new Uint8Array((count - 1) * (count - 1));
  for (let row = 0; row < count - 1; row++) for (let col = 0; col < count - 1; col++) {
    if (open(originX + (col + 0.5) * cell, originZ + (row + 0.5) * cell)) holes[row * (count - 1) + col] = 1;
  }
  return { kind: "heightfield", originX, originZ, cell, columns: count, rows: count, heights, holes, depth };
}
