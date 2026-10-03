import { deriveSeed, mulberry32 } from "../rng";
import type { BoxesSpec, BuildingDef, BuildingModel, Rgb } from "./buildingTypes";
import { FOUNDATION_DEPTH, ModelBuilder, pick, roll } from "./buildingGeometry";
import { buildHouse } from "./houseGenerator";

/** The placeholder: a main box, a door-sized dark patch in the middle of its front, and smaller
 *  boxes against its sides and back. */
function buildBoxes(spec: BoxesSpec, rng: () => number): BuildingModel {
  const b = new ModelBuilder();
  const hw = roll(spec.width, rng) / 2;
  const hd = roll(spec.depth, rng) / 2;
  const height = roll(spec.height, rng);
  b.box(-hw, -FOUNDATION_DEPTH, -hd, hw, height, hd, pick(spec.walls, rng), pick(spec.tops, rng));

  // The door: just proud of the front, so it is never lost in the wall.
  const door: Rgb = [0.18, 0.13, 0.1];
  const doorHalf = Math.min(0.55, hw * 0.3);
  const doorTop = Math.min(2.2, height - 0.3);
  b.face([[-doorHalf, 0, hd + 0.03], [doorHalf, 0, hd + 0.03], [doorHalf, doorTop, hd + 0.03], [-doorHalf, doorTop, hd + 0.03]], [0, 0, 1], door);

  // Annexes on the left, right and back - never the front, which the door and the street have.
  const count = Math.round(roll(spec.annexes, rng));
  const sides = [0, 1, 2];
  for (let i = sides.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sides[i], sides[j]] = [sides[j], sides[i]];
  }
  sides.length = Math.min(3, count);
  for (const side of sides) {
    const share = roll(spec.annexSize, rng);
    const annexHeight = height * roll([0.45, 0.8], rng);
    const wall = pick(spec.walls, rng);
    const top = pick(spec.tops, rng);
    if (side === 2) {
      // Back: as wide as a share of the main box, sliding along it.
      const w = hw * share;
      const d = hd * share;
      const at = (rng() * 2 - 1) * (hw - w);
      b.box(at - w, -FOUNDATION_DEPTH, -hd - d * 2, at + w, annexHeight, -hd, wall, top);
    } else {
      const sign = side === 0 ? -1 : 1;
      const w = hw * share;
      const d = hd * share;
      const at = (rng() * 2 - 1) * (hd - d);
      const inner = sign * hw;
      const outer = sign * (hw + w * 2);
      b.box(Math.min(inner, outer), -FOUNDATION_DEPTH, at - d, Math.max(inner, outer), annexHeight, at + d, wall, top);
    }
  }
  return b.finish({ x: 0, z: hd });
}

/**
 * Builds one variant of a building. The same building, seed and variant always give the same
 * model, wherever it is asked for - the workbench and the world agree.
 */
export function generateBuilding(def: BuildingDef, seed: number, variant: number): BuildingModel {
  let hash = 0;
  for (let i = 0; i < def.id.length; i++) hash = (Math.imul(hash, 31) + def.id.charCodeAt(i)) | 0;
  const rng = mulberry32(deriveSeed(deriveSeed(seed, hash), variant));
  switch (def.generator) {
    case "boxes":
      return buildBoxes(def.boxes!, rng);
    case "house":
      return buildHouse(def.house!, rng);
  }
}
