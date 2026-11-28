import { joinPath, Reader, type RawObject } from "../../world/content/contentReader";
import type { BalanceRules } from "./balanceRules";
import { defenceFor } from "./defenceRules";
import type { GameRules } from "./gameRules";

// The item ladder (SLICE.md 3b and task I8; ITEMS.md, *The ladder*): every item type - an armour type in
// a slot, a weapon family - is six items over levels 1-10, one per rung of `rules/itemLayout.json5`
// (start, loot, shop, quest, loot, loot), plus grey trash at a few levels between. Their numbers all
// come from the balance curves:
// - stat points: `itemBudget(level, slot, rarity)`, split by the line's stat weights;
// - armour: the share of a set's armour the defence rules want for the player's mitigation curve at
//   the level, by the slot's weight among the armour slots and the armour type's factor;
// - weapon damage: the line's share of the player's dps curve, a swing every `speed` seconds;
// - block (shields): a curve from the layout;
// - price: `value: "balance"` (level, slot, rarity), as any item.
// A template marks only what the item is (slot, line, names, looks per rung); the rest is generated.

export interface Rung {
  id: string;
  role: string;
  level: number;
  rarity: string;
}

export interface LadderLine {
  /** A set's armour share: 1 is the armour the defence rules want from a full set. */
  armour: number;
  /** Stat id to weight: how the stat points split. */
  stats: Record<string, number>;
  durability: number;
  /** Weapons: seconds a swing, and the share of the player's dps curve its swings make. */
  speed: number;
  dps: number;
  /** Shields: block chance and value (stat points) at levels 1 and 10. */
  block: { chance: [number, number]; value: [number, number] } | null;
  /** Stats every item of the line has as they are, whatever its level (a bow's attack range). */
  fixed: Record<string, number>;
}

export interface ItemLayout {
  rungs: Rung[];
  /** `value`: a share of the price a ladder item of its level, slot and rarity would have. */
  trash: { levels: number[]; rarity: string; role: string; names: string[]; value: number };
  /** Worn from this many levels under the item's. */
  below: number;
  /** A rolled stat runs from (1 - spread) of its value to its value. */
  spread: number;
  /** The slots a set's armour is shared among, by their balance slot weights. */
  armourSlots: string[];
  lines: Map<string, LadderLine>;
}

const LINE_KEYS = ["armour", "stats", "durability", "speed", "dps", "block", "fixed"];

/** Reads `rules/itemLayout.json5`. */
export function readItemLayout(data: unknown, reader: Reader, rarityIds: ReadonlySet<string>, game: GameRules): ItemLayout {
  const obj = reader.object(data, "");
  reader.onlyKeys(obj, "", ["rungs", "trash", "below", "spread", "armourSlots", "lines"]);
  const rungs: Rung[] = reader.array(obj, "rungs", "").map((v, i) => {
    const path = `rungs[${i}]`;
    const raw = reader.object(v, path);
    reader.onlyKeys(raw, path, ["id", "role", "level", "rarity"]);
    const rarity = reader.string(raw, "rarity", path);
    if (!rarityIds.has(rarity)) reader.fail(`${path}.rarity`, `no rarity "${rarity}"`);
    return { id: reader.string(raw, "id", path), role: reader.string(raw, "role", path), level: reader.number(raw, "level", path, { min: 1, integer: true }), rarity };
  });
  const trashRaw = reader.object(obj.trash ?? {}, "trash");
  reader.onlyKeys(trashRaw, "trash", ["levels", "rarity", "role", "names", "value"]);
  const trashRarity = reader.optionalString(trashRaw, "rarity", "trash") ?? "poor";
  if (!rarityIds.has(trashRarity)) reader.fail("trash.rarity", `no rarity "${trashRarity}"`);
  const trashLevels = (trashRaw.levels === undefined ? [] : reader.array(trashRaw, "levels", "trash")).map((l, i) => (typeof l === "number" && Number.isInteger(l) && l >= 1 ? l : (reader.fail(`trash.levels[${i}]`, "a level"), 1)));
  const names = trashRaw.names === undefined ? [] : reader.stringList(trashRaw, "names", "trash");
  if (names.length < trashLevels.length) reader.fail("trash.names", "a name word for each trash level");
  const lines = new Map<string, LadderLine>();
  const linesRaw = reader.object(obj.lines ?? {}, "lines");
  for (const id of Object.keys(linesRaw)) {
    const path = `lines.${id}`;
    const raw = reader.object(linesRaw[id], path);
    reader.onlyKeys(raw, path, LINE_KEYS);
    const stats = reader.object(raw.stats ?? {}, `${path}.stats`);
    const weights: Record<string, number> = {};
    for (const s of Object.keys(stats)) {
      if (!game.statIndex.has(s)) reader.fail(`${path}.stats.${s}`, `no stat "${s}"`);
      weights[s] = reader.number(stats, s, `${path}.stats`, { min: 0 });
    }
    let block: LadderLine["block"] = null;
    if (raw.block !== undefined) {
      const b = reader.object(raw.block, `${path}.block`);
      reader.onlyKeys(b, `${path}.block`, ["chance", "value"]);
      block = { chance: reader.range(b, "chance", `${path}.block`, { allowEqual: true }), value: reader.range(b, "value", `${path}.block`, { allowEqual: true }) };
    }
    const fixedRaw = reader.object(raw.fixed ?? {}, `${path}.fixed`);
    const fixed: Record<string, number> = {};
    for (const s of Object.keys(fixedRaw)) {
      if (!game.statIndex.has(s)) reader.fail(`${path}.fixed.${s}`, `no stat "${s}"`);
      fixed[s] = reader.number(fixedRaw, s, `${path}.fixed`);
    }
    lines.set(id, {
      fixed,
      armour: reader.optionalNumber(raw, "armour", path, 0, { min: 0 }),
      stats: weights,
      durability: reader.optionalNumber(raw, "durability", path, 0, { min: 0, integer: true }),
      speed: reader.optionalNumber(raw, "speed", path, 0, { min: 0 }),
      dps: reader.optionalNumber(raw, "dps", path, 0, { min: 0 }),
      block,
    });
  }
  return {
    rungs,
    trash: { levels: trashLevels, rarity: trashRarity, role: reader.optionalString(trashRaw, "role", "trash") ?? "trash", names, value: reader.optionalNumber(trashRaw, "value", "trash", 1, { min: 0 }) },
    below: reader.optionalNumber(obj, "below", "", 1, { min: 0, integer: true }),
    spread: reader.optionalNumber(obj, "spread", "", 0.2, { min: 0, max: 0.9 }),
    armourSlots: obj.armourSlots === undefined ? [] : reader.stringList(obj, "armourSlots", ""),
    lines,
  };
}

/** The keys a ladder template may have besides an item's. */
export const LADDER_KEYS = ["ladder", "tiers", "rungs"];

/** What the curves say an item of a line at a level, slot and rarity budget carries: the numbers a
 *  ladder item is made of, and what the probe checks every generated item against. */
export interface LadderBudget {
  /** Stat points, split by the line's weights (whole numbers, largest share first). */
  points: number;
  stats: Record<string, number>;
  armor: number;
  /** Weapons: the hit's low and high (the item's own, over bare hands). */
  weaponMin: number;
  weaponMax: number;
  weaponSpeed: number;
  blockChance: number;
  blockValue: number;
}

export function ladderBudget(layout: ItemLayout, line: LadderLine, game: GameRules, balance: BalanceRules, level: number, slots: string[], rarityBudget: number): LadderBudget {
  const slot = slots[0] ?? "";
  // Two-handed: both slots' budgets.
  const points = slots.reduce((sum, s) => sum + balance.itemBudget(level, s, rarityBudget), 0);
  const stats: Record<string, number> = {};
  const weights = Object.entries(line.stats);
  const total = weights.reduce((a, [, w]) => a + w, 0);
  if (total > 0) {
    // Whole points by weight: a point at a time to the stat furthest behind its share.
    const whole = Math.max(0, Math.round(points));
    for (const [s] of weights) stats[s] = 0;
    for (let n = 1; n <= whole; n++) {
      let best = weights[0][0];
      let gap = -Infinity;
      for (const [s, w] of weights) {
        const g = (w / total) * n - stats[s];
        if (g > gap + 1e-9) {
          gap = g;
          best = s;
        }
      }
      stats[best] += 1;
    }
  }
  // Armour: what the defence rules want of a whole set for the player's mitigation at the level,
  // this slot's share of it, times the line's factor and the rarity.
  let armor = 0;
  if (line.armour > 0) {
    const want = defenceFor(game.combat.defence, level, 1 / (1 - balance.curve("playerMitigation", level)), { health: balance.curve("playerHealth", level) });
    const setArmour = want.armor ?? 0;
    const weightSum = layout.armourSlots.reduce((a, s) => a + balance.slotWeights.get(s)!, 0) || 1;
    const share = layout.armourSlots.includes(slot) ? (balance.slotWeights.get(slot) ?? 0) / weightSum : 1;
    armor = setArmour * share * line.armour * rarityBudget;
  }
  // Weapon damage: the line's share of the dps curve, one swing every `speed` seconds, 80-120%.
  let weaponMin = 0;
  let weaponMax = 0;
  let weaponSpeed = 0;
  if (line.speed > 0) {
    const base = (id: string): number => game.stats[game.statIndex.get(id) ?? -1]?.default ?? 0;
    const mean = balance.curve("playerDps", level) * line.dps * rarityBudget * line.speed;
    weaponMin = Math.max(0, mean * 0.8 - base("weaponMin"));
    weaponMax = Math.max(weaponMin, mean * 1.2 - base("weaponMax"));
    weaponSpeed = line.speed - base("weaponSpeed");
  }
  const at = (r: [number, number]): number => r[0] + ((r[1] - r[0]) * (Math.min(10, Math.max(1, level)) - 1)) / 9;
  return {
    points,
    stats,
    armor,
    weaponMin,
    weaponMax,
    weaponSpeed,
    blockChance: line.block ? at(line.block.chance) * rarityBudget : 0,
    blockValue: line.block ? at(line.block.value) * rarityBudget : 0,
  };
}

/**
 * The item types a ladder template makes: one per rung, and one per trash level, with ids
 * `<template>.<rung>` and `<template>.trash<level>`, their stats from the curves (`ladderBudget`),
 * `parts: { rung, role }` for loot tables, shops and quests to choose by.
 */
export function generateLadder(
  templateId: string,
  obj: RawObject,
  reader: Reader,
  layout: ItemLayout | null,
  balance: BalanceRules | null,
  game: GameRules,
  rarityBudget: ReadonlyMap<string, number>,
): { id: string; obj: RawObject; template: string; parts: Record<string, string> }[] {
  if (!layout || !balance) {
    reader.fail("ladder", "a ladder template needs rules/itemLayout.json5 and rules/balance.json5");
    return [];
  }
  const lineId = reader.string(obj, "ladder", "");
  const line = layout.lines.get(lineId);
  if (!line) {
    reader.fail("ladder", `no line "${lineId}" in rules/itemLayout.json5 (known: ${[...layout.lines.keys()].join(", ")})`);
    return [];
  }
  const name = reader.string(obj, "name", "");
  const tiers = reader.object(obj.tiers ?? {}, "tiers");
  const perRung = reader.object(obj.rungs ?? {}, "rungs");
  const slotIds = typeof obj.slot === "string" ? [obj.slot] : Array.isArray(obj.slot) ? obj.slot.map(String) : [];
  const fills = Array.isArray(obj.fills) ? obj.fills.map(String) : [];
  const base: RawObject = {};
  for (const [key, value] of Object.entries(obj)) if (!LADDER_KEYS.includes(key) && key !== "stats") base[key] = value;
  const made: { id: string; obj: RawObject; template: string; parts: Record<string, string> }[] = [];
  const all = [
    ...layout.rungs.map((r) => ({ id: r.id, role: r.role, level: r.level, rarity: r.rarity, word: tiers[r.id] })),
    ...layout.trash.levels.map((level, i) => ({ id: `trash${level}`, role: layout.trash.role, level, rarity: layout.trash.rarity, word: tiers.trash ?? layout.trash.names[i] })),
  ];
  for (const rung of all) {
    if (typeof rung.word !== "string") {
      reader.fail(joinPath("tiers", rung.id), `a name word for the ${rung.id} rung ("{tier}" in the name)`);
      continue;
    }
    const budget = ladderBudget(layout, line, game, balance, rung.level, [...slotIds, ...fills], rarityBudget.get(rung.rarity) ?? 1);
    const range = (v: number): [number, number] => {
      const hi = Math.round(v);
      return [Math.max(0, Math.round(v * (1 - layout.spread))), hi];
    };
    const stats: RawObject = {};
    for (const [s, v] of Object.entries(budget.stats)) if (v > 0) stats[s] = range(v);
    if (budget.armor > 0) stats.armor = range(budget.armor);
    if (line.speed > 0) {
      stats.weaponMin = range(budget.weaponMin);
      stats.weaponMax = [Math.max(range(budget.weaponMin)[1], range(budget.weaponMax)[0]), Math.max(range(budget.weaponMin)[1], Math.round(budget.weaponMax))];
      stats.weaponSpeed = Math.round(budget.weaponSpeed * 100) / 100;
    }
    for (const [s, v] of Object.entries(line.fixed)) stats[s] = v;
    if (line.block) {
      stats.blockChance = Math.round(budget.blockChance * 10) / 10;
      stats.blockValue = range(budget.blockValue);
    }
    const item: RawObject = {
      ...base,
      name: name.split("{tier}").join(rung.word),
      rarity: rung.rarity,
      level: rung.level,
      stats,
      requires: { ge: ["level", { sub: ["itemLevel", layout.below] }] },
      value: rung.role === layout.trash.role ? Math.max(1, Math.round(balance.itemPrice(rung.level, slotIds[0] ?? "", rarityBudget.get(rung.rarity) ?? 1) * layout.trash.value)) : "balance",
    };
    if (line.durability > 0 && item.durability === undefined) item.durability = line.durability;
    const own = perRung[rung.id] ?? (rung.role === layout.trash.role ? perRung.trash : undefined);
    if (own !== undefined) for (const [k, v] of Object.entries(reader.object(own, joinPath("rungs", rung.id)))) item[k] = v;
    made.push({ id: `${templateId}.${rung.id}`, obj: item, template: templateId, parts: { rung: rung.id, role: rung.role, line: lineId } });
  }
  return made;
}
