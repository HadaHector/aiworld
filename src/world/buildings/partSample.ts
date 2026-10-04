import type { BuildingDef, BuildingModel, BuildingPartDef, HouseSpec, Paint } from "./buildingTypes";
import { HOUSE_PARTS } from "./buildingTypes";
import { FOUNDATION_DEPTH, ModelBuilder, plain } from "./buildingGeometry";
import { buildWallPart, partSpan, type PartPaints } from "./buildingParts";
import { mulberry32 } from "../rng";

/** Plain colours for a part with no house to borrow paints from. */
const FALLBACK: PartPaints = {
  walls: plain([0.85, 0.82, 0.75]),
  timber: plain([0.36, 0.26, 0.18]),
  roof: plain([0.6, 0.3, 0.2]),
  plinth: plain([0.55, 0.53, 0.5]),
  door: plain([0.3, 0.22, 0.15]),
  glass: plain([0.25, 0.32, 0.38]),
};

/** The first house that uses a part - whose look a sample of it borrows. */
export function houseUsing(part: BuildingPartDef, buildings: BuildingDef[]): BuildingDef | undefined {
  return buildings.find((def) => def.house && [...def.house.doors, ...def.house.wallExtras].some((use) => use.part.id === part.id));
}

/**
 * A building part on a stretch of wall, for the workbench: a bay of wall either side of it, on a
 * plinth, between two corner posts - painted, sized and spaced like `house` (a house that uses it)
 * would, or in plain colours at a middling size if no house does. There is no roof: a chimney rises
 * past where the ridge would be.
 */
export function buildPartSample(part: BuildingPartDef, house: HouseSpec | null): BuildingModel {
  const b = new ModelBuilder();
  const mid = (range: [number, number] | undefined, otherwise: number): number => (range ? (range[0] + range[1]) / 2 : otherwise);
  const tile = mid(house?.tile, 2.8);
  const plinth = mid(house?.plinth, 0.45);
  const eaves = plinth + mid(house?.wallHeight, 4.5);
  const post = mid(house?.post, 0.7);
  const outset = house?.plinthOutset ?? 0.5;
  const paints: PartPaints = house
    ? (Object.fromEntries(HOUSE_PARTS.map((name): [string, Paint] => [name, { material: house.parts[name].material, tint: house.parts[name].tints[0] }])) as PartPaints)
    : FALLBACK;

  const span = partSpan(part);
  const half = ((span + 2) * tile) / 2;
  const thick = 0.4;
  // The wall: a slab with its face at z 0, on a plinth standing out from it.
  b.box(-half - outset, -FOUNDATION_DEPTH, -thick - outset, half + outset, plinth, outset, paints.plinth);
  b.box(-half, plinth, -thick, half, eaves, 0, paints.walls);
  for (const x of [-half, half]) b.box(x - post / 2, plinth, -thick - post / 2, x + post / 2, eaves, post / 2, paints.timber);

  buildWallPart(
    part,
    {
      floor: plinth,
      top: eaves - 0.25,
      ridge: eaves + 2.5,
      plinthOutset: outset,
      halfRoom: (span * tile) / 2 - 0.05,
      wall: "side",
      innerCorner: false,
      box: (a0, a1, y0, y1, out0, out1, paint) => b.box(a0, y0, out0, a1, y1, out1, paint),
      face: (corners, towards, paint) => b.faceToward(corners, towards, paint),
    },
    paints,
    mulberry32(1),
  );
  return b.finish({ x: 0, z: outset });
}
