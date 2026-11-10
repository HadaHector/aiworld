import type { PackSource } from "../world/content/resolveContent";
import { Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";
import type { ColorTuple } from "../world/terrain/pipeline/pipelineTypes";
import { characterEntries } from "./raceDef";

/**
 * A weapon family (weapons/<id>.json5, see CHARACTERS.md, *Weapons and shields*): how it is held,
 * and its tiers - crude, standard, ornate - each a list of parts laid along the weapon's own axis.
 * Every tier becomes a gear piece of its own, `<id>.<tier>` ("sword.ornate"), for items to name; the
 * item's tint colours its `metal` parts, so one model serves bronze, iron and steel.
 */
export interface WeaponFamily {
  id: string;
  name: string;
  grip: WeaponGrip;
  /** The colours its parts take by slot. */
  colours: Record<WeaponSlot, { material: string; tint: ColorTuple }>;
  /** The slot an item's tint colours: `metal` for a sword's bronze or iron, `wood` for an oak or
   *  ash staff. */
  tinted: WeaponSlot;
  tiers: Record<string, WeaponPart[]>;
}

/** How it is held: in the right fist, both hands, upright in the left fist (a bow), on the left
 *  forearm (a shield), in the left fist (an off-hand dagger, a wand). */
export type WeaponGrip = "mainHand" | "twoHand" | "bow" | "shield" | "offHand";
export const WEAPON_GRIPS: readonly WeaponGrip[] = ["mainHand", "twoHand", "bow", "shield", "offHand"];

export type WeaponSlot = "metal" | "wood" | "grip" | "trim" | "dark" | "gem";
export const WEAPON_SLOTS: readonly WeaponSlot[] = ["metal", "wood", "grip", "trim", "dark", "gem"];

/**
 * One part: a prism along the weapon's axis from `from` to `to` metres (0 is the middle of the
 * grip, the blade's way positive), its cross-section `shape` - "round" (a tube, a knob), "box" (a
 * guard), "diamond" (a blade), "facet" (a gem) - sized by `profile` points [t, width, thickness]
 * along it (width across the blade's flat, thickness through it; both 0 at a point). `spin` turns it
 * round the axis, `out` sets it off the axis that way (an axe's bit), `tilt` leans it out from the
 * axis (a spike), and `copies` repeats it evenly round (a mace's flanges).
 */
export interface WeaponPart {
  shape: "round" | "box" | "diamond" | "facet";
  from: number;
  to: number;
  profile: [number, number, number][];
  slot: WeaponSlot;
  spin: number;
  out: number;
  tilt: number;
  copies: number;
}

export const WEAPON_TIERS = ["crude", "standard", "ornate"] as const;

const DEFAULT_COLOURS: Record<WeaponSlot, { material: string; tint: ColorTuple }> = {
  metal: { material: "plate", tint: [0.84, 0.85, 0.88] },
  wood: { material: "leather", tint: [0.48, 0.33, 0.19] },
  grip: { material: "leather", tint: [0.23, 0.15, 0.09] },
  trim: { material: "plate", tint: [0.85, 0.66, 0.3] },
  dark: { material: "plate", tint: [0.32, 0.33, 0.36] },
  gem: { material: "plate", tint: [0.25, 0.45, 0.85] },
};

export function resolveWeapons(packs: PackSource[], issues: ContentIssue[]): Map<string, WeaponFamily> {
  const families = new Map<string, WeaponFamily>();
  for (const [id, entry] of characterEntries(packs, "weapons", issues)) families.set(id, readFamily(id, entry.data, new Reader(issues, entry.file)));
  return families;
}

function readFamily(id: string, data: unknown, reader: Reader): WeaponFamily {
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["name", "grip", "tinted", "colours", "tiers"]);
  const rawColours: RawObject = obj.colours === undefined ? {} : reader.object(obj.colours, "colours");
  reader.onlyKeys(rawColours, "colours", WEAPON_SLOTS);
  const colours = { ...DEFAULT_COLOURS };
  for (const slot of WEAPON_SLOTS) {
    if (rawColours[slot] === undefined) continue;
    const c = reader.object(rawColours[slot], `colours.${slot}`);
    reader.onlyKeys(c, `colours.${slot}`, ["material", "tint"]);
    colours[slot] = { material: reader.optionalString(c, "material", `colours.${slot}`) ?? DEFAULT_COLOURS[slot].material, tint: c.tint === undefined ? DEFAULT_COLOURS[slot].tint : reader.color(c, "tint", `colours.${slot}`) };
  }
  const rawTiers = reader.object(obj.tiers, "tiers");
  reader.onlyKeys(rawTiers, "tiers", WEAPON_TIERS);
  const tiers: Record<string, WeaponPart[]> = {};
  for (const tier of WEAPON_TIERS) {
    if (rawTiers[tier] === undefined) {
      reader.fail(`tiers.${tier}`, "every family has the three tiers: crude, standard, ornate");
      continue;
    }
    const t = reader.object(rawTiers[tier], `tiers.${tier}`);
    reader.onlyKeys(t, `tiers.${tier}`, ["parts"]);
    tiers[tier] = reader.array(t, "parts", `tiers.${tier}`).map((raw, i) => readPart(reader.object(raw, `tiers.${tier}.parts[${i}]`), `tiers.${tier}.parts[${i}]`, reader));
  }
  return { id, name: reader.optionalString(obj, "name", "") ?? id, grip: obj.grip === undefined ? "mainHand" : reader.oneOf(obj, "grip", "", WEAPON_GRIPS), tinted: obj.tinted === undefined ? "metal" : reader.oneOf(obj, "tinted", "", WEAPON_SLOTS), colours, tiers };
}

function readPart(obj: RawObject, path: string, reader: Reader): WeaponPart {
  reader.onlyKeys(obj, path, ["shape", "from", "to", "profile", "slot", "spin", "out", "tilt", "copies"]);
  const profile: [number, number, number][] = reader.array(obj, "profile", path).map((p, i) => {
    if (Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return p as [number, number, number];
    reader.fail(`${path}.profile[${i}]`, "expected [t, width, thickness], none below 0");
    return [0, 0.01, 0.01];
  });
  if (profile.length < 2) reader.fail(`${path}.profile`, "needs at least two points");
  if (typeof obj.from === "number" && typeof obj.to === "number" && obj.to <= obj.from) reader.fail(`${path}.to`, "must be beyond from: parts run out from the grip");
  return {
    shape: obj.shape === undefined ? "round" : reader.oneOf(obj, "shape", path, ["round", "box", "diamond", "facet"] as const),
    from: reader.number(obj, "from", path, { min: -3, max: 3 }),
    to: reader.number(obj, "to", path, { min: -3, max: 3 }),
    profile,
    slot: obj.slot === undefined ? "metal" : reader.oneOf(obj, "slot", path, WEAPON_SLOTS),
    spin: reader.optionalNumber(obj, "spin", path, 0),
    out: reader.optionalNumber(obj, "out", path, 0, { min: -1, max: 1 }),
    tilt: reader.optionalNumber(obj, "tilt", path, 0, { min: -180, max: 180 }),
    copies: reader.optionalNumber(obj, "copies", path, 1, { min: 1, max: 12, integer: true }),
  };
}
