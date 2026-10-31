import { deriveSeed, mulberry32 } from "../../world/rng";
import { hashString } from "../../world/content/dimensions";
import { personName, type Voice } from "../../world/naming/nameGenerator";
import type { SettlementLayout } from "../../world/settlements/settlementLayout";
import type { SettlementSite } from "../../world/settlements/settlementSites";
import { AGES, type Age, type NpcRelationDef, type NpcRoleDef, type NpcRules, type RelationSide, type Sex } from "../rules/npcRules";

/**
 * A settlement's cast (NPCS.md, *A settlement's cast*): its people, the households they live in and
 * the relations between them - invented first, the people then made to fit. A pure function of the
 * world seed, the settlement and the rules, run by the server and the page alike.
 */
export interface CastNpc {
  /** `npc:<dimension>/<settlement>/<index>`: stable for the seed, what quests, saves and standing name. */
  id: string;
  index: number;
  household: number;
  /** Its role's id; null for one who stays at home (not out in the world). */
  role: string | null;
  /** A class trainer's class. */
  class: string | null;
  given: string;
  family: string;
  /** "Given Family". */
  name: string;
  /** "Innkeeper", "Warrior Trainer", or "" for a villager. */
  title: string;
  sex: Sex;
  age: Age;
  race: string;
  /** Its look's seed (CHARACTERS.md), and what it shares with its family: colouring, and its age's
   *  height and build. */
  seed: number;
  choices: { skin: number; hair: number; eyes: number; height: number; build: number };
  outfit: string;
  mood: string;
  /** Out in the world: made as an entity when a player is near. */
  out: boolean;
  /** Who it is tied to, and what it calls them ("brother", "rival"). */
  relations: { to: number; relation: string; call: string }[];
}

export interface Household {
  index: number;
  /** The house it lives in (index into the layout's houses), or -1 for none. */
  house: number;
  family: string;
  race: string;
  members: number[];
}

export interface Cast {
  settlement: number;
  npcs: CastNpc[];
  households: Household[];
}

export interface CastInput {
  seed: number;
  dimension: string;
  site: Pick<SettlementSite, "id" | "tier" | "biome">;
  layout: Pick<SettlementLayout, "styleId" | "houses">;
  voices: Readonly<Record<string, Voice>>;
  rules: NpcRules;
  /** The world's classes (PROGRESSION.md, *Origins*), for class trainers. */
  classes: readonly { id: string; name: string }[];
  /** Whether it is a starting settlement (NPCS.md, *The starting site*): every class's trainer. */
  start: boolean;
}

const CAST_SALT = 9_301;

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length];
const between = (rng: Rng, [lo, hi]: readonly [number, number]): number => lo + Math.floor(rng() * (hi - lo + 1));
function weighted(rng: Rng, weights: Readonly<Record<string, number>>): string {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let roll = rng() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [id, w] of entries) if ((roll -= w) < 0) return id;
  return entries[entries.length - 1]?.[0] ?? "";
}
function shuffled<T>(rng: Rng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const ageIndex = (age: Age): number => AGES.indexOf(age);

// How each age moves the height and build sliders (0..1): the young slighter, the old a little bowed.
const AGE_BODY: Record<Age, { height: [number, number]; build: [number, number] }> = {
  young: { height: [0.05, 0.4], build: [0.05, 0.4] },
  adult: { height: [0.25, 0.85], build: [0.2, 0.9] },
  old: { height: [0.1, 0.55], build: [0.3, 0.8] },
};

/** Makes a settlement's cast. */
export function castOf(input: CastInput): Cast {
  const { rules, layout, site } = input;
  const rng = mulberry32(deriveSeed(input.seed, CAST_SALT + hashString(input.dimension) * 31 + site.id));
  const npcs: CastNpc[] = [];
  const households: Household[] = [];
  const peoples = rules.peoples[layout.styleId] ?? rules.peoples.default;
  const familyVoice = input.voices[site.biome.voiceId] ?? Object.values(input.voices)[0];
  const ageWeights: Record<string, number> = rules.ages;
  const relationOf = (id: string): NpcRelationDef | undefined => {
    const i = rules.relationIndex.get(id);
    return i === undefined ? undefined : rules.relations[i];
  };
  const usedFamilies = new Set<string>();
  const usedNames = new Set<string>();

  // --- people and households ---
  function familyName(): string {
    let name = "";
    for (let i = 0; i < 8 && (!name || usedFamilies.has(name)); i++) name = familyVoice ? personName(rng, familyVoice, 9) : `House${households.length}`;
    usedFamilies.add(name);
    return name;
  }
  function person(household: Household, ages: readonly Age[], sex: Sex | null): CastNpc {
    const age = (weighted(rng, Object.fromEntries(ages.map((a) => [a, ageWeights[a] ?? 0]))) || ages[0] || "adult") as Age;
    const body = AGE_BODY[age];
    const voice = input.voices[rules.names[household.race] ?? ""] ?? familyVoice;
    let given = "";
    for (let i = 0; i < 8 && (!given || usedNames.has(`${given} ${household.family}`)); i++) given = voice ? personName(rng, voice) : `Person${npcs.length}`;
    usedNames.add(`${given} ${household.family}`);
    const npc: CastNpc = {
      id: `npc:${input.dimension}/${site.id}/${npcs.length}`,
      index: npcs.length,
      household: household.index,
      role: null,
      class: null,
      given,
      family: household.family,
      name: `${given} ${household.family}`,
      title: "",
      sex: sex ?? (rng() < 0.5 ? "male" : "female"),
      age,
      race: household.race,
      seed: Math.floor(rng() * 0xffffffff) >>> 0,
      choices: {
        skin: Math.floor(rng() * 64),
        hair: Math.floor(rng() * 64),
        eyes: Math.floor(rng() * 64),
        height: body.height[0] + rng() * (body.height[1] - body.height[0]),
        build: body.build[0] + rng() * (body.build[1] - body.build[0]),
      },
      outfit: "",
      mood: weighted(rng, rules.moods),
      out: false,
      relations: [],
    };
    npcs.push(npc);
    household.members.push(npc.index);
    return npc;
  }
  function relate(a: CastNpc, b: CastNpc, def: NpcRelationDef): void {
    // Each calls the other by the other's side's name, in the other's sex.
    a.relations.push({ to: b.index, relation: def.id, call: def.call[1][b.sex] });
    b.relations.push({ to: a.index, relation: def.id, call: def.call[0][a.sex] });
    if (def.looks) Object.assign(b.choices, { skin: a.choices.skin, hair: a.choices.hair, eyes: a.choices.eyes });
  }
  /** A pair made for a household relation: the second side's age fits the first's by `older`. */
  function pair(household: Household, def: NpcRelationDef): [CastNpc, CastNpc] {
    const [s0, s1] = def.sides;
    const second = person(household, s1.ages, s1.sex);
    const firstAges = s0.ages.filter((a) => ageIndex(a) >= ageIndex(second.age) + def.older);
    const first = person(household, firstAges.length > 0 ? firstAges : s0.ages, s0.sex);
    // The older side first in the household, as it is written.
    household.members.reverse();
    relate(first, second, def);
    return [first, second];
  }
  /** A household in a house (or none, -1), with people by one of the rules' shapes - or empty, for
   *  one person to be put in. */
  function household(house: number, empty = false): Household {
    const h: Household = { index: households.length, house, family: familyName(), race: weighted(rng, peoples) || "human", members: [] };
    households.push(h);
    if (empty) return h;
    const total = rules.households.reduce((sum, s) => sum + s.weight, 0);
    let roll = rng() * total;
    const shape = rules.households.find((s) => (roll -= s.weight) < 0) ?? rules.households[0];
    const def = shape.relation ? relationOf(shape.relation) : undefined;
    if (def) pair(h, def);
    else person(h, ["adult", "old"], null);
    const child = relationOf(rules.childRelation);
    const children = child ? between(rng, shape.children) : 0;
    // A child is every first member's (both of a couple), and younger than each of them.
    const parents = h.members.map((m) => npcs[m]);
    const youngest = Math.min(...parents.map((p) => ageIndex(p.age)));
    for (let i = 0; i < children; i++) {
      const kid = person(h, child!.sides[1].ages.filter((a) => ageIndex(a) + child!.older <= youngest), child!.sides[1].sex);
      for (const parent of parents) relate(parent, kid, child!);
    }
    return h;
  }
  const homes = new Set(rules.homes);
  const houseHolds = new Map<number, Household>();
  layout.houses.forEach((house, i) => {
    if (homes.has(house.building.id)) houseHolds.set(i, household(i));
  });

  // --- roles ---
  interface Slot { role: NpcRoleDef; house: number; cls: { id: string; name: string } | null }
  const slots: Slot[] = [];
  for (const role of rules.roles) {
    layout.houses.forEach((house, i) => {
      if (!role.buildings.includes(house.building.id)) return;
      for (let n = between(rng, role.count); n > 0; n--) slots.push({ role, house: i, cls: null });
    });
    if (role.settlement && (!role.settlement.tiers || role.settlement.tiers.includes(site.tier))) {
      const want = between(rng, role.settlement.count);
      for (let have = slots.filter((s) => s.role === role).length; have < want; have++) slots.push({ role, house: -1, cls: null });
    }
    if (role.perClass) {
      const classes = input.start && role.perClass.start === "all" ? input.classes : shuffled(rng, input.classes).slice(0, between(rng, input.start && role.perClass.start !== "all" ? role.perClass.start : role.perClass.other));
      for (const cls of classes) slots.push({ role, house: -1, cls });
    }
  }
  const free = (npc: CastNpc, role: NpcRoleDef): boolean => npc.role === null && role.ages.includes(npc.age);
  const atWork = new Map<number, Household>();
  for (const slot of slots) {
    const { role } = slot;
    let holder: CastNpc | undefined;
    // Its own building's household, if people live there (a shop house, a farmhouse)...
    const home = slot.house >= 0 ? houseHolds.get(slot.house) : undefined;
    if (home) holder = home.members.map((m) => npcs[m]).find((n) => free(n, role));
    // ...or a household living where it works (an innkeeper at the inn)...
    if (!holder && role.livesAtWork && slot.house >= 0) {
      const h = atWork.get(slot.house) ?? household(slot.house);
      atWork.set(slot.house, h);
      holder = h.members.map((m) => npcs[m]).find((n) => free(n, role)) ?? person(h, role.ages, null);
    }
    // ...or someone of any household who is free, else someone new in a household of their own.
    if (!holder) holder = shuffled(rng, npcs).find((n) => free(n, role));
    if (!holder) holder = person(household(-1, true), role.ages, null);
    holder.role = role.id;
    holder.class = slot.cls?.id ?? null;
    holder.title = role.title.replace("{class}", slot.cls?.name ?? "");
    holder.out = true;
    holder.outfit = role.outfits[0] === "fromClass" ? (rules.classOutfits[slot.cls?.id ?? ""] ?? rules.classOutfits.default ?? "") : role.outfits.length > 0 ? pick(rng, role.outfits) : "";
  }

  // --- out on the street: one of a share of the households that have nobody out ---
  const villager = rules.roles[rules.roleIndex.get(rules.villager) ?? -1];
  for (const h of households) {
    if (h.members.some((m) => npcs[m].out) || rng() >= rules.out) continue;
    const npc = npcs[pick(rng, h.members)];
    npc.out = true;
    if (villager) {
      npc.role = villager.id;
      npc.title = villager.title;
      npc.outfit = villager.outfits.length > 0 ? pick(rng, villager.outfits) : "";
    }
  }

  // --- relations across households ---
  const fits = (npc: CastNpc, side: RelationSide): boolean => side.ages.includes(npc.age) && (!side.sex || npc.sex === side.sex) && (!side.roles || (npc.role !== null && side.roles.includes(npc.role)));
  for (const def of rules.relations) {
    if (def.kind !== "across") continue;
    for (let n = between(rng, def.count); n > 0; n--) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const a = pick(rng, npcs);
        const b = pick(rng, npcs);
        if (!a || !b || a.household === b.household || !fits(a, def.sides[0]) || !fits(b, def.sides[1])) continue;
        if (ageIndex(a.age) < ageIndex(b.age) + def.older || a.relations.some((r) => r.to === b.index)) continue;
        relate(a, b, def);
        break;
      }
    }
  }
  return { settlement: site.id, npcs, households };
}

/** What the casts of one dimension are made from, beyond each settlement's own site and layout. */
export interface CastContext {
  seed: number;
  dimension: string;
  voices: Readonly<Record<string, Voice>>;
  rules: NpcRules;
  classes: readonly { id: string; name: string }[];
  /** The settlements (site ids) new characters start at. */
  starts: ReadonlySet<number>;
}

/** A settlement's cast by its site id, from a generated world; null for no such settlement. */
export function castForSettlement(world: { settlements: readonly SettlementSite[]; settlementLayouts: readonly SettlementLayout[] }, siteId: number, context: CastContext): Cast | null {
  const site = world.settlements.find((s) => s.id === siteId);
  const layout = world.settlementLayouts.find((l) => l.siteId === siteId);
  if (!site || !layout) return null;
  return castOf({ ...context, site, layout, start: context.starts.has(siteId) });
}
