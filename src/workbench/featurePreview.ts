import type { WorldContent } from "../world/content/worldContent";
import type { FeatureKindDef } from "../world/features/featureTypes";
import type { BuildingModel } from "../world/buildings/buildingTypes";
import type { BiomeDefinition } from "../world/biomes/biomeTypes";
import type { TerrainSample, TerrainSampler } from "../world/terrain/terrainSampler";
import type { RoadLine } from "../world/roads/roadField";
import type { SettlementGate } from "../world/settlements/gates";
import type { TreePlacement } from "../world/foliage/treeScatter";
import { layoutCompound, planCompound, settleProps, type CompoundLayout } from "../world/features/compound";
import { compoundPads, createPadField, propPads, type Pad, type PadField } from "../world/settlements/padField";
import { generateBuilding } from "../world/buildings/buildingGenerator";
import { generateProp } from "../world/props/propGenerator";
import { deriveSeed, mulberry32 } from "../world/rng";
import { smoothstep } from "../world/mathUtils";

/**
 * A feature (a compound - a logging camp) on its own on a patch of ground, for the workbench: sited
 * at the patch's middle, its roads coming in from the patch's edge to gates at rolled angles - in
 * place of the world's road network - and laid out by the world's own code, its yard and pads
 * levelled into the ground as in the world, its buildings and props standing where it put them, the
 * wood round it of the biome it grows in, thinning to its clearing.
 */
export interface FeaturePreview {
  /** The patch's side (metres), and the ground's height on it, levelled as the world levels it. */
  size: number;
  heightAt: (x: number, z: number) => number;
  /** Its buildings and props: where each stands, which way it faces, and its model. */
  placed: { x: number; y: number; z: number; frontX: number; frontZ: number; model: BuildingModel }[];
  /** Its roads, lanes and trails, to draw on the ground: their points and how wide. */
  lines: { points: { x: number; z: number }[]; width: number; kind: "road" | "lane" | "trail" }[];
  /** Its pads - the level ground under its yard, buildings and props - for drawing. */
  pads: Pad[];
  /** Its yard, trodden out to its level ground's edge. */
  yards: { x: number; z: number; radius: number }[];
  /** The wood round it: near the clearing in full, further out as the world draws distant trees. */
  trees: TreePlacement[];
  farTrees: TreePlacement[];
  /** The biome it grows in - its light, its trees. */
  biome: BiomeDefinition | null;
  layout: CompoundLayout;
}

/** A road's half-width on the ground, at widthScale 1. */
const ROAD_HALF = 4;
/** Room round the camp's circle for the wood, out to the patch's edge. */
const WOOD_MARGIN = 45;
/** Trees stand on a jittered lattice this far apart - sparser than the world's, as the wood is only
 *  a frame round the place. */
const TREE_SPACING = 10;
/** Trees further than this past the clearing's edge are drawn as the world draws distant ones. */
const NEAR_WOOD = 20;

export function buildFeaturePreview(
  kind: FeatureKindDef,
  content: WorldContent,
  seed: number,
  variant: number,
  far: boolean,
  baseHeight: (x: number, z: number) => number,
): FeaturePreview | null {
  if (!kind.compound) return null;
  const rng = mulberry32(deriveSeed(seed, 0x5eed + variant));
  const planned = planCompound(kind, seed, rng);
  const site = { ...planned, x: 0, z: 0, height: baseHeight(0, 0) };
  const size = Math.ceil((site.radius + WOOD_MARGIN) * 2 / 10) * 10;
  const half = size / 2;

  // The ground as a sampler for the world's layout code: dry land everywhere, at the patch's
  // height - levelled by `pads` once there are some.
  let pads: PadField | null = null;
  const heightAt = (x: number, z: number): number => {
    const height = baseHeight(x, z);
    return pads?.level(x, z, height, 1)?.height ?? height;
  };
  const sample = (x: number, z: number): TerrainSample => ({ height: heightAt(x, z), isLand: true, lakeFactor: 0 }) as unknown as TerrainSample;
  const sampleTerrain: TerrainSampler = sample;

  // Its roads: in from the patch's edge, straight to gates on its circle at rolled angles, spread
  // round it - as many as it takes at most.
  const links = kind.road ? Math.max(1, Math.round(kind.road.links[0] + rng() * (kind.road.links[1] - kind.road.links[0]))) : 1;
  const first = rng() * Math.PI * 2;
  const gates: SettlementGate[] = [];
  const roads: RoadLine[] = [];
  for (let n = 0; n < links; n++) {
    const angle = first + (n / links) * Math.PI * 2 + (rng() - 0.5) * 0.6;
    const gx = Math.cos(angle) * site.radius;
    const gz = Math.sin(angle) * site.radius;
    gates.push({ x: gx, z: gz, angle, approachX: gx * 1.2, approachZ: gz * 1.2, roadHeight: baseHeight(gx, gz) });
    const ex = Math.cos(angle) * half * 1.5;
    const ez = Math.sin(angle) * half * 1.5;
    roads.push({ points: [{ x: ex, z: ez }, { x: gx, z: gz }], heights: [baseHeight(ex, ez), baseHeight(gx, gz)] });
  }

  const layout = layoutCompound(0, kind, site, gates, roads, sampleTerrain, seed);
  // Levelled as the world levels it: the yard and the buildings' pads, then each prop's on them.
  pads = createPadField(compoundPads([layout]));
  settleProps([layout], sampleTerrain);
  const padList = [...propPads([layout]), ...compoundPads([layout])];
  pads = createPadField(padList);

  const placed: FeaturePreview["placed"] = [
    ...layout.buildings.map((house) => ({ x: house.x, y: house.y, z: house.z, frontX: house.frontX, frontZ: house.frontZ, model: generateBuilding(house.building, seed, house.variant, far) })),
    ...layout.props.map((prop) => ({ x: prop.x, y: prop.y, z: prop.z, frontX: prop.frontX, frontZ: prop.frontZ, model: generateProp(prop.prop, seed, prop.variant, far) })),
  ];
  const lines: FeaturePreview["lines"] = [
    ...roads.map((line) => ({ points: line.points, width: ROAD_HALF * 2, kind: "road" as const })),
    ...layout.lanes.map((line) => ({ points: line.points, width: ROAD_HALF * 2 * (line.widthScale ?? 1), kind: "lane" as const })),
    ...layout.trails.map((line) => ({ points: line.points, width: ROAD_HALF * 2 * (line.widthScale ?? 1), kind: "trail" as const })),
  ];

  // The wood: the biome that grows this feature, its trees thinning in to its clearing, off the
  // roads and the trails.
  const biome = content.biomes.find((b) => b.features.some((chance) => chance.featureId === kind.id)) ?? null;
  const kinds = biome?.outputs.foliage?.outputs ? Object.keys(biome.outputs.foliage.outputs).filter((id) => content.treeKinds.some((t) => t.id === id)) : [];
  const trees: TreePlacement[] = [];
  const farTrees: TreePlacement[] = [];
  if (kinds.length > 0) {
    const clear = site.radius + kind.clearing[0] * 0.2;
    const full = clear + kind.clearing[1] * 0.5;
    const distanceToLine = (points: { x: number; z: number }[], x: number, z: number): number => {
      let best = Infinity;
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.z - t * dz));
      }
      return best;
    };
    for (let gx = -half + TREE_SPACING / 2; gx < half; gx += TREE_SPACING) {
      for (let gz = -half + TREE_SPACING / 2; gz < half; gz += TREE_SPACING) {
        const x = gx + (rng() - 0.5) * TREE_SPACING * 0.8;
        const z = gz + (rng() - 0.5) * TREE_SPACING * 0.8;
        if (Math.abs(x) > half - 2 || Math.abs(z) > half - 2) continue;
        if (rng() > smoothstep(clear, full, Math.hypot(x, z))) continue;
        if (lines.some((line) => distanceToLine(line.points, x, z) < line.width / 2 + 3)) continue;
        const tree = { kind: kinds[Math.floor(rng() * kinds.length)], scale: 0.85 + rng() * 0.3, x, y: heightAt(x, z), z, rotation: rng() * Math.PI * 2, tint: rng() };
        (Math.hypot(x, z) < full + NEAR_WOOD ? trees : farTrees).push(tree);
      }
    }
  }
  return { size, heightAt, placed, lines, pads: padList, yards: [{ x: layout.yard.x, z: layout.yard.z, radius: layout.yard.level }], trees, farTrees, biome, layout };
}
