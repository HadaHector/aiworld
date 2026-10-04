import type { BuildingPartDef, HousePlanSettings, HouseSpec, TowerPlanSettings } from "./buildingTypes";
import { pick, rollInt } from "./buildingGeometry";
import { isRoof, pickPart } from "./buildingParts";

/**
 * A house's plan generators: how its tiles are laid out round the main block, which storeys each
 * block of them stands through, and what tops each - a roof (and how its ends meet its neighbours')
 * or a terrace. The house (houseGenerator.ts) builds whatever plan it is handed: walls, framing,
 * parts, roofs and terraces all follow from it.
 *
 * Tiles: i along x, j along z, the front to +z.
 */

/** A rectangle of tiles, from (i0, j0) up to (not including) (i1, j1). */
export interface Block {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/** A block of tiles standing from storey `from` up to (not including) storey `to`. */
export interface Mass {
  rect: Block;
  from: number;
  to: number;
}

/** A roof block's end: free (the roof's own shape there), a gable whatever its shape, or attached to
 *  a taller or crossing block - stopping at the block's own end, or with `into` its ridge running on
 *  half its span into the roof it meets. */
export type PlanEnd = { kind: "free" } | { kind: "gable" } | { kind: "attached"; into: boolean };

/** A block a roof covers, its ridge along x or z, and how each end of it ends (start: the low end). */
export interface PlanRoofBlock {
  rect: Block;
  alongX: boolean;
  start: PlanEnd;
  end: PlanEnd;
}

/** A roof over some blocks, on top of storey `level`. */
export interface PlanRoof {
  part: BuildingPartDef;
  level: number;
  blocks: PlanRoofBlock[];
}

export interface HousePlan {
  /** Every block the house stands on - the plan's tiles. */
  blocks: Block[];
  masses: Mass[];
  /** How many storeys the tallest mass stands. */
  storeys: number;
  /** The block whose front the door goes in - at its foremost wall on the ground storey. */
  entrance: Block;
  /** The roofs, the main one first; and the terraces, each topping a mass. */
  roofs: PlanRoof[];
  terraces: { part: BuildingPartDef; mass: Mass }[];
  /** What stands under a storey over open ground - an arcade's posts - or none. */
  support: BuildingPartDef | null;
}

export const inRect = (r: Block, i: number, j: number): boolean => i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1;

/** A house's plan, by its generator: the main block `storeys` tall. */
export function planHouse(spec: HouseSpec, storeys: number, rng: () => number): HousePlan {
  switch (spec.plan.type) {
    case "house":
      return housePlan(spec, spec.plan.house, storeys, rng);
    case "tower":
      return towerPlan(spec, spec.plan.tower, storeys, rng);
  }
}

/**
 * The `house` plan: a main block, maybe a wing out of the back (a T or an L) and one out of a side,
 * each as tall as the main block or lower under a top of its own; the main block's front row maybe
 * open on the ground storey (an arcade) and stood back on the top one (a setback, behind a terrace).
 */
function housePlan(spec: HouseSpec, settings: HousePlanSettings, storeys: number, rng: () => number): HousePlan {
  const W = rollInt(spec.width, rng);
  const D = rollInt(spec.depth, rng);
  const main: Block = { i0: 0, i1: W, j0: 0, j1: D };
  let back: Block | null = null;
  let side: (Block & { left: boolean }) | null = null;

  // A wing's width, from the range, held under the most its block allows. Where the block allows
  // less than the range's least, there is no wing at all rather than a sliver of one.
  const [widthMin, widthMax] = settings.wingWidth;
  const wingWidth = (most: number): number => rollInt([widthMin, Math.min(widthMax, most)], rng);
  // A wing out of the back: narrower than the main block's front, and no wider than it is deep, so
  // its ridge never stands above the main ridge.
  const backWidthMax = Math.min(W - 1, D);
  if (backWidthMax >= widthMin && rng() < settings.backWing) {
    const w = wingWidth(backWidthMax);
    const offset = pick([0, Math.floor((W - w) / 2), W - w], rng);
    back = { i0: offset, i1: offset + w, j0: -rollInt(settings.wingLength, rng), j1: 0 };
  }
  // A wing out of one side: shallower than the main block, so its ridge is lower.
  if (D - 1 >= widthMin && rng() < settings.sideWing) {
    const d = wingWidth(D - 1);
    const left = rng() < 0.5;
    let offset = pick([0, Math.floor((D - d) / 2), D - d], rng);
    // Flush with the back where a back wing is flush with the same end, the two would touch at
    // just a corner: then it goes flush with the front instead.
    if (offset === 0 && back && (left ? back.i0 === 0 : back.i1 === W)) offset = D - d;
    const length = rollInt(settings.wingLength, rng);
    side = left ? { i0: -length, i1: 0, j0: offset, j1: offset + d, left } : { i0: W, i1: W + length, j0: offset, j1: offset + d, left };
  }
  const blocks = [main, ...(back ? [back] : []), ...(side ? [side] : [])];

  // The masses. A wing may stand lower than the main block; the main block's front row of tiles may
  // be open on the ground storey (an arcade) and stand back on the top one (a setback).
  const wingStoreys = (): number => (settings.wingStoreys ? Math.min(storeys, rollInt(settings.wingStoreys, rng)) : storeys);
  const backStoreys = back ? wingStoreys() : 0;
  const sideStoreys = side ? wingStoreys() : 0;
  const deep = D >= 2;
  const arcade = settings.arcade !== null && storeys >= 2 && deep && rng() < settings.arcade.chance;
  const setback = settings.setback !== null && storeys >= (arcade ? 3 : 2) && deep && rng() < settings.setback.chance;
  const frontRow: Block = { i0: main.i0, i1: main.i1, j0: main.j1 - 1, j1: main.j1 };
  const rest: Block = { ...main, j1: main.j1 - 1 };
  const masses: Mass[] = [];
  if (arcade || setback) {
    masses.push({ rect: rest, from: 0, to: storeys });
    masses.push({ rect: frontRow, from: arcade ? 1 : 0, to: setback ? storeys - 1 : storeys });
  } else {
    masses.push({ rect: main, from: 0, to: storeys });
  }
  if (back) masses.push({ rect: back, from: 0, to: backStoreys });
  if (side) masses.push({ rect: side, from: 0, to: sideStoreys });

  // What tops each mass: those reaching the top storey share the house's roof - a wing's ridge
  // running into the main one's, the main block gabled where a wing is flush with its end; a lower
  // wing has a roof stopping at the main block's wall, or a terrace; a setback strip, a terrace.
  const joined = (storeysOf: number): boolean => storeysOf === storeys;
  const free: PlanEnd = { kind: "free" };
  const backFlushLeft = back !== null && joined(backStoreys) && back.i0 === 0;
  const backFlushRight = back !== null && joined(backStoreys) && back.i1 === W;
  const mainEnd = (left: boolean): PlanEnd => {
    const wingHere = side !== null && joined(sideStoreys) && side.left === left;
    return wingHere || (left ? backFlushLeft : backFlushRight) ? { kind: "gable" } : free;
  };
  const roofs: PlanRoof[] = [];
  const terraces: HousePlan["terraces"] = [];
  const mainRoof: PlanRoof = { part: spec.roof, level: storeys - 1, blocks: [{ rect: setback ? rest : main, alongX: true, start: mainEnd(true), end: mainEnd(false) }] };
  if (back && joined(backStoreys)) mainRoof.blocks.push({ rect: back, alongX: false, start: free, end: { kind: "attached", into: true } });
  if (side && joined(sideStoreys)) {
    const attached: PlanEnd = { kind: "attached", into: false };
    mainRoof.blocks.push({ rect: side, alongX: true, start: side.left ? free : attached, end: side.left ? attached : free });
  }
  roofs.push(mainRoof);
  if (setback) terraces.push({ part: pickPart(settings.setback!.terraces, rng)!, mass: masses[1] });
  for (const [wing, storeysOf, isBack] of [[back, backStoreys, true], [side, sideStoreys, false]] as const) {
    if (!wing || joined(storeysOf)) continue;
    const mass = masses.find((m) => m.rect === wing)!;
    const part = pickPart(settings.lowTops, rng) ?? spec.roof;
    if (!isRoof(part)) {
      terraces.push({ part, mass });
      continue;
    }
    const attached: PlanEnd = { kind: "attached", into: false };
    const left = !isBack && (wing as NonNullable<typeof side>).left;
    roofs.push({
      part,
      level: storeysOf - 1,
      blocks: [isBack ? { rect: wing, alongX: false, start: free, end: attached } : { rect: wing, alongX: true, start: left ? free : attached, end: left ? attached : free }],
    });
  }
  return { blocks, masses, storeys, entrance: main, roofs, terraces, support: arcade ? settings.arcade!.support : null };
}

/**
 * The `tower` plan: the main block - its ridge running back from the front, a chapel's nave - with a
 * square tower centred against its front or its back end, standing storeys taller under its own roof.
 * The main block's roof stops against the tower where the tower is as wide as it, and is gabled
 * behind it where the tower is narrower. With the tower at the front, the door is in its foot.
 */
function towerPlan(spec: HouseSpec, settings: TowerPlanSettings, storeys: number, rng: () => number): HousePlan {
  const W = rollInt(spec.width, rng);
  const D = rollInt(spec.depth, rng);
  const main: Block = { i0: 0, i1: W, j0: 0, j1: D };
  // As wide as rolled, held to the main block's width, and a width that centres on it.
  let side = Math.min(W, rollInt(settings.width, rng));
  if ((W - side) % 2 !== 0) side = side + 1 <= W ? side + 1 : side - 1;
  if (side < 1) side = W;
  const offset = (W - side) / 2;
  const atFront = pick(settings.ends, rng) === "front";
  const tower: Block = atFront ? { i0: offset, i1: offset + side, j0: D, j1: D + side } : { i0: offset, i1: offset + side, j0: -side, j1: 0 };
  const towerStoreys = storeys + rollInt(settings.storeys, rng);
  const masses: Mass[] = [
    { rect: main, from: 0, to: storeys },
    { rect: tower, from: 0, to: towerStoreys },
  ];
  const free: PlanEnd = { kind: "free" };
  const againstTower: PlanEnd = side === W ? { kind: "attached", into: false } : { kind: "gable" };
  return {
    blocks: [main, tower],
    masses,
    storeys: towerStoreys,
    entrance: atFront ? tower : main,
    roofs: [
      { part: spec.roof, level: storeys - 1, blocks: [{ rect: main, alongX: false, start: atFront ? free : againstTower, end: atFront ? againstTower : free }] },
      { part: settings.roof, level: towerStoreys - 1, blocks: [{ rect: tower, alongX: true, start: free, end: free }] },
    ],
    terraces: [],
    support: null,
  };
}
