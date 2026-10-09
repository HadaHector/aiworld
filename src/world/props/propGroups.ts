import { roll } from "../buildings/buildingGeometry";
import { measureProp } from "./propGenerator";
import type { PropDef, PropGroupDef } from "./propTypes";

/** A prop variant is drawn from this many, as a building's is. */
const PROP_VARIANT_SPACE = 1 << 20;

/**
 * A prop set down somewhere, in a layout's own space: where it stands (x, z), which way it faces
 * (its front, +z of its model, toward (frontX, frontZ)), and - for one stood on another - that one
 * and how high its top is (`lift`), so its height is found from the ground under that one once the
 * ground is final. `y` is filled in then.
 */
export interface PlacedProp {
  prop: PropDef;
  variant: number;
  x: number;
  z: number;
  y: number;
  frontX: number;
  frontZ: number;
  /** What it stands on: the ground (null), or another prop's top, `lift` over that one's foot. */
  on: PlacedProp | null;
  lift: number;
  /** How far it reaches from its middle, any way - for keeping things apart - and its half-extents
   *  across its front and front to back, for the level ground under it. */
  reach: number;
  halfWidth: number;
  halfDepth: number;
  /** Which set-down it was part of - a group's members stand level with each other. */
  group: number;
  /** Which way its up points: straight up, or - for one lying on the slope - the ground's normal
   *  under it. Filled in with its height. */
  up: [number, number, number];
}

/** A group's (or a lone prop's) members, rolled, in the group's own space - its front toward +z -
 *  how far they reach from its middle altogether, and the box they fill: its middle (cx, cz) and
 *  half-extents across (hw) and front to back (hd), in the group's space. */
export interface Arranged {
  members: PlacedProp[];
  reach: number;
  box: { cx: number; cz: number; hw: number; hd: number };
}

/** The box a group's members fill, each its own footprint turned as it is. */
function boxOf(members: PlacedProp[]): Arranged["box"] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const m of members) {
    // Its model's +x runs (frontZ, -frontX), its +z (frontX, frontZ).
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const u = a * m.halfWidth;
      const w = b * m.halfDepth;
      const x = m.x + m.frontZ * u + m.frontX * w;
      const z = m.z - m.frontX * u + m.frontZ * w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
  }
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2 };
}

/** One prop set down on its own, as a group of one. */
export function arrangeProp(prop: PropDef, seed: number, rng: () => number): Arranged {
  const variant = Math.floor(rng() * PROP_VARIANT_SPACE);
  const size = measureProp(prop, seed, variant);
  const reach = Math.hypot(size.halfWidth, size.halfDepth);
  return { members: [{ prop, variant, x: 0, z: 0, y: 0, frontX: 0, frontZ: 1, on: null, lift: 0, reach, halfWidth: size.halfWidth, halfDepth: size.halfDepth, group: 0, up: [0, 1, 0] }], reach, box: { cx: 0, cz: 0, hw: size.halfWidth, hd: size.halfDepth } };
}

/**
 * A group's members, each rolled - left out by its chance (and with it any member on it), turned by
 * its rolled turn, set at its place or on the top of the member it stands on.
 */
export function arrangeGroup(group: PropGroupDef, seed: number, rng: () => number): Arranged {
  const placed: (PlacedProp | null)[] = [];
  let reach = 0;
  for (const member of group.members) {
    const base = member.on === null ? null : placed[member.on];
    if ((member.on !== null && !base) || rng() >= member.chance) {
      placed.push(null);
      continue;
    }
    const variant = Math.floor(rng() * PROP_VARIANT_SPACE);
    const size = measureProp(member.prop, seed, variant);
    const turn = (roll(member.turn, rng) * Math.PI) / 180;
    const x = base ? base.x + member.at[0] : member.at[0];
    const z = base ? base.z + member.at[1] : member.at[1];
    const own = Math.hypot(size.halfWidth, size.halfDepth);
    const baseHeight = base ? measureProp(base.prop, seed, base.variant).height : 0;
    placed.push({ prop: member.prop, variant, x, z, y: 0, frontX: Math.sin(turn), frontZ: Math.cos(turn), on: base, lift: baseHeight, reach: own, halfWidth: size.halfWidth, halfDepth: size.halfDepth, group: 0, up: [0, 1, 0] });
    reach = Math.max(reach, Math.hypot(x, z) + own);
  }
  const members = placed.filter((p): p is PlacedProp => p !== null);
  return { members, reach, box: boxOf(members) };
}

/** An arrangement set down at (x, z), its front turned toward (frontX, frontZ): its members in the
 *  layout's space. */
export function setDown(arranged: Arranged, x: number, z: number, frontX: number, frontZ: number, group: number): PlacedProp[] {
  // Its +z turns to (frontX, frontZ), its +x to (frontZ, -frontX) - as a house is turned.
  const map = new Map<PlacedProp, PlacedProp>();
  return arranged.members.map((m) => {
    const placed: PlacedProp = {
      ...m,
      x: x + frontZ * m.x + frontX * m.z,
      z: z - frontX * m.x + frontZ * m.z,
      frontX: frontZ * m.frontX + frontX * m.frontZ,
      frontZ: -frontX * m.frontX + frontZ * m.frontZ,
      on: m.on ? map.get(m.on)! : null,
      group,
    };
    map.set(m, placed);
    return placed;
  });
}
