import type { CompoundLayout } from "../features/compound";
import type { TreeKindDef } from "./foliageConfig";
import type { TreePlacement, TreeScatter } from "./treeScatter";
import { areaFor } from "./treeScatter";

/**
 * Trees a feature plants, as opposed to the ones the scatter grows. A prop made by the `treeMarker`
 * generator (props/ancientOak.json5) stands for the tree kind with its own id: the compound places it
 * like any prop (footprint, spacing, ring), and this turns every such placed prop into a tree of the
 * tree field - a thin instance with hulls like any other tree - at its spot. Used by the druid grove
 * (SLICE.md W5) for its ring of ancient oaks; any feature can do the same with its own kind.
 *
 * Its size and facing are hashed from where it stands, so it is the same tree every time. Its colours (area, shade) wait for the ground it stands on: the scatter wrapper asks the chunk's probe (see `withPlantedTrees`).
 */
export interface PlantedTree {
  x: number;
  z: number;
  kind: string;
  scale: number;
  rotation: number;
  tint: number;
  areaRoll: number;
  shadeRoll: number;
  /** How far from its middle the scatter's own trees are kept off it: the trunk's foot, roots and all. */
  clearance: number;
}

/** A 0-1 hash of a position and a salt - fixed for the same place, for any build order. */
function hashed(x: number, z: number, salt: number): number {
  let h = (Math.imul(Math.floor(x * 16), 0x27d4eb2d) ^ Math.imul(Math.floor(z * 16), 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** How far a natural tree is kept from the trunk, per unit of scale: the trunk's radius, half-way into its flare. */
function footOf(kind: TreeKindDef): number {
  const shape = kind.shape;
  if (shape.model === "branching") return shape.trunk.radius * (1 + (shape.trunk.flare - 1) * 0.5);
  return 2;
}

/** Every tree the given compounds' marker props plant. */
export function plantedTrees(layouts: readonly Pick<CompoundLayout, "x" | "z" | "yard" | "props">[], treeKinds: readonly TreeKindDef[]): PlantedTree[] {
  const kinds = new Map(treeKinds.map((kind) => [kind.id, kind]));
  const planted: PlantedTree[] = [];
  const plant = (kind: TreeKindDef, x: number, z: number): void => {
    const scale = kind.scale[0] + (kind.scale[1] - kind.scale[0]) * hashed(x, z, 1);
    planted.push({ x, z, kind: kind.id, scale, rotation: hashed(x, z, 3) * Math.PI * 2, tint: hashed(x, z, 2), areaRoll: hashed(x, z, 4), shadeRoll: hashed(x, z, 5), clearance: footOf(kind) * scale });
  };
  for (const layout of layouts) {
    for (const placed of layout.props) {
      if (placed.prop.generator !== "treeMarker") continue;
      const kind = kinds.get(placed.prop.id);
      if (!kind) throw new Error(`Prop "${placed.prop.id}" is a tree marker, but there is no tree kind with that id`);
      const settings = placed.prop.settings;
      const [ringLo, ringHi] = settings.ring as [number, number];
      if (ringHi <= 0) {
        plant(kind, placed.x, placed.z);
        continue;
      }
      // A ring: evenly round the compound's middle, each tree nudged along it and in and out a little.
      const salt = hashed(layout.x, layout.z, 11);
      const count = Math.max(1, ringLo + Math.floor(salt * (ringHi - ringLo + 1)));
      const [reachLo, reachHi] = settings.reach as [number, number];
      const wander = settings.wander as unknown as number;
      const start = hashed(layout.x, layout.z, 12) * Math.PI * 2;
      for (let k = 0; k < count; k++) {
        const along = (k + (hashed(layout.x, layout.z, 20 + k) - 0.5) * 2 * wander) / count;
        const angle = start + along * Math.PI * 2;
        const out = layout.yard.radius + reachLo + (reachHi - reachLo) * hashed(layout.x, layout.z, 40 + k);
        plant(kind, layout.x + Math.cos(angle) * out, layout.z + Math.sin(angle) * out);
      }
    }
  }
  return planted;
}

/**
 * A scatter that also plants these trees, and keeps its own off their feet. A planted tree belongs to
 * the chunk its trunk stands in (the box's low edges included); where the probe has no ground for it
 * - outside the patch of world the caller can see - it is left to the chunk that can.
 */
export function withPlantedTrees(scatter: TreeScatter, planted: readonly PlantedTree[]): TreeScatter {
  if (planted.length === 0) return scatter;
  return (minX, minZ, maxX, maxZ, probe) => {
    const here = planted.filter((tree) => tree.x >= minX && tree.x < maxX && tree.z >= minZ && tree.z < maxZ);
    // Planted trees just outside the box still keep the scatter's trees from their feet.
    const near = planted.filter((tree) => tree.x >= minX - tree.clearance && tree.x < maxX + tree.clearance && tree.z >= minZ - tree.clearance && tree.z < maxZ + tree.clearance);
    const natural = scatter(minX, minZ, maxX, maxZ, probe);
    const kept = near.length === 0 ? natural : natural.filter((tree) => !near.some((p) => Math.hypot(tree.x - p.x, tree.z - p.z) < p.clearance));
    const added: TreePlacement[] = [];
    for (const tree of here) {
      const ground = probe(tree.x, tree.z);
      // Not into the water.
      if (!ground || !ground.sample.isLand || ground.sample.lakeFactor > 0.02) continue;
      added.push({
        x: tree.x,
        y: ground.surfaceHeight,
        z: tree.z,
        kind: tree.kind,
        scale: tree.scale,
        rotation: tree.rotation,
        tint: tree.tint,
        area: areaFor(ground.sample.areaWeights, tree.areaRoll),
        shade: tree.shadeRoll,
      });
    }
    return added.length === 0 ? kept : kept.concat(added);
  };
}
