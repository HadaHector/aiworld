import type { WorldContent } from "../world/content/worldContent";
import type { FeatureKindDef } from "../world/features/featureTypes";
import type { BuildingModel } from "../world/buildings/buildingTypes";
import type { BiomeDefinition } from "../world/biomes/biomeTypes";
import type { TerrainSample, TerrainSampler } from "../world/terrain/terrainSampler";
import type { RoadLine } from "../world/roads/roadField";
import type { SettlementGate } from "../world/settlements/gates";
import { createTreeCover, createTreeScatter, type TreeGround, type TreePlacement } from "../world/foliage/treeScatter";
import { compoundGap, layoutCompound, planCompound, settleProps, settleOnGround, wallStretches, type CompoundLayout } from "../world/features/compound";
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
  placed: { x: number; y: number; z: number; frontX: number; frontZ: number; up?: [number, number, number]; model: BuildingModel }[];
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
/** How many places in the world are tried for the patch's wood (see buildFeaturePreview). */
const COVER_TRIES = 200;
/** How far inland (metres above the sea) the wood round the patch is judged as growing. */
const INLAND = 25;
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
  // A roadside one stands on a road running straight through it, across the patch.
  const roadside = kind.compound.arrangement === "roadside";
  const through = rng() * Math.PI;
  const site = { ...planned, x: 0, z: 0, height: baseHeight(0, 0), roadAngles: roadside ? [through, through + Math.PI] : [] };
  // Out past its clearing, where the wood stands as thick as it grows, and a margin of that.
  const size = Math.ceil((Math.max(site.radius, site.yardRadius + kind.clearing[1]) + WOOD_MARGIN) * 2 / 10) * 10;
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
  const links = roadside ? 0 : kind.road ? Math.max(1, Math.round(kind.road.links[0] + rng() * (kind.road.links[1] - kind.road.links[0]))) : 1;
  const first = rng() * Math.PI * 2;
  const gates: SettlementGate[] = [];
  const roads: RoadLine[] = [];
  if (roadside) {
    const ex = Math.cos(through) * half * 1.5;
    const ez = Math.sin(through) * half * 1.5;
    roads.push({ points: [{ x: -ex, z: -ez }, { x: ex, z: ez }], heights: [baseHeight(-ex, -ez), baseHeight(ex, ez)] });
  }
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
  settleOnGround([layout], sampleTerrain);

  const placed: FeaturePreview["placed"] = [
    ...layout.buildings.map((house) => ({ x: house.x, y: house.y, z: house.z, frontX: house.frontX, frontZ: house.frontZ, model: generateBuilding(house.building, seed, house.variant, far) })),
    ...layout.props.map((prop) => ({ x: prop.x, y: prop.y, z: prop.z, frontX: prop.frontX, frontZ: prop.frontZ, up: prop.up, model: generateProp(prop.prop, seed, prop.variant, far) })),
    ...layout.walls.flatMap((run) => wallStretches(run, seed).map((stretch) => ({ ...stretch, model: stretch.model(far) }))),
  ];
  const lines: FeaturePreview["lines"] = [
    ...roads.map((line) => ({ points: line.points, width: ROAD_HALF * 2, kind: "road" as const })),
    ...layout.lanes.map((line) => ({ points: line.points, width: ROAD_HALF * 2 * (line.widthScale ?? 1), kind: "lane" as const })),
    ...layout.trails.map((line) => ({ points: line.points, width: ROAD_HALF * 2 * (line.widthScale ?? 1), kind: "trail" as const })),
  ];

  // The wood: the biome that grows this feature, scattered by the world's own tree scatter on the
  // ground as the world would give it - the feature's clearing (and its stumps), the pads, the roads,
  // lanes and trails each by their own width - so it grows as thick, and thins the same way.
  const biome = content.biomes.find((b) => b.features.some((chance) => chance.featureId === kind.id)) ?? null;
  const trees: TreePlacement[] = [];
  const farTrees: TreePlacement[] = [];
  if (biome) {
    const kindIndex = content.featureKinds.indexOf(kind);
    const [inner, outer] = kind.clearing;
    const areaWeights = [{ areaId: 0, biome, weight: 1 }];
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
    const sampleAt = (x: number, z: number): TerrainSample => {
      const natural = baseHeight(x, z);
      const levelled = pads?.level(x, z, natural, 1) ?? null;
      // Its clearing, as featureField gives it.
      const gap = compoundGap(site, x, z);
      const inReach = gap < outer;
      return {
        height: levelled?.height ?? natural,
        primaryAreaId: 0,
        primaryBiome: biome,
        secondaryBiome: biome,
        biomeBlend: 0,
        areaWeights,
        isLand: true,
        landmass: 1,
        lakeFactor: 0,
        isRiverEdge: false,
        areaBorderGap: Infinity,
        riverGap: Infinity,
        // In each line's own widths (a path half a road's width keeps trees half as far).
        roadGap: Math.min(Infinity, ...lines.map((line) => distanceToLine(line.points, x, z) / (line.width / (ROAD_HALF * 2)))),
        featureKind: inReach ? kindIndex : -1,
        featureGap: inReach ? gap : Infinity,
        featureDepth: 0,
        featureClear: inReach ? 1 - smoothstep(inner, outer, gap) : 0,
        featureStumps: inReach && gap > site.radius - site.yardRadius ? kind.stumps : 0,
        featureStumpAge: inReach ? 1 - smoothstep(site.radius - site.yardRadius, outer, gap) : 0,
        padGap: levelled?.edge ?? Infinity,
        spill: 0,
        spillMaterial: -1,
      } as TerrainSample;
    };
    // The patch's ground lies near sea level, where the zones' shore rule thins every wood: the
    // scatter decides as if inland, by INLAND metres higher, and plants on the ground as it is.
    // Its woods' noises vary across the world: the patch is grown where the world's wood is as thick
    // round it as the kind's siting asks (its site.cover - judged out where the world judges it),
    // as the world would only have put it there.
    const treeCover = createTreeCover(seed, content);
    // (On open ground: no clearing, pad or road of its own in the way.)
    const open: TerrainSample = { ...sampleAt(half, half), featureKind: -1, featureGap: Infinity, featureClear: 0, featureStumps: 0, featureStumpAge: 0, padGap: Infinity, roadGap: Infinity };
    open.height += INLAND;
    const coverAt = (x: number, z: number): number => treeCover(x, z, { height: open.height, surfaceHeight: open.height, slope: 0, sample: open });
    const [lo, hi] = kind.compound!.site.cover;
    const wanted = (lo + Math.min(1, hi)) / 2;
    let offset = { x: 0, z: 0, off: Infinity };
    for (let k = 0; k < COVER_TRIES && offset.off > 0.02; k++) {
      const ox = (rng() - 0.5) * 40000;
      const oz = (rng() - 0.5) * 40000;
      let cover = 0;
      for (let n = 0; n < 8; n++) cover += coverAt(ox + Math.cos((n / 8) * Math.PI * 2) * site.radius * 1.8, oz + Math.sin((n / 8) * Math.PI * 2) * site.radius * 1.8) / 8;
      if (cover >= lo && Math.abs(cover - wanted) < offset.off) offset = { x: ox, z: oz, off: Math.abs(cover - wanted) };
    }
    // The world's point the scatter sees for one of the patch's, and back.
    const probe = (wx: number, wz: number): TreeGround | null => {
      const x = wx - offset.x;
      const z = wz - offset.z;
      if (Math.abs(x) > half || Math.abs(z) > half) return null;
      const sample = sampleAt(x, z);
      const surface = sample.height;
      sample.height += INLAND;
      const gx = (heightAt(x + 1, z) - heightAt(x - 1, z)) / 2;
      const gz = (heightAt(x, z + 1) - heightAt(x, z - 1)) / 2;
      const g = Math.hypot(gx, gz);
      return { height: sample.height, surfaceHeight: surface, slope: g / Math.sqrt(1 + g * g), sample };
    };
    const full = site.radius - site.yardRadius + outer;
    if (!Number.isFinite(offset.off)) offset = { x: 0, z: 0, off: 0 };
    for (const tree of createTreeScatter(seed, content)(offset.x - half, offset.z - half, offset.x + half, offset.z + half, probe)) {
      tree.x -= offset.x;
      tree.z -= offset.z;
      (Math.hypot(tree.x, tree.z) < site.yardRadius + full + NEAR_WOOD ? trees : farTrees).push(tree);
    }
  }
  return { size, heightAt, placed, lines, pads: padList, yards: layout.yard.level > 0 ? [{ x: layout.yard.x, z: layout.yard.z, radius: layout.yard.level }] : [], trees, farTrees, biome, layout };
}
