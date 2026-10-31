import { Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";

/**
 * NPC rules (NPCS.md): the roles settlements' people hold, the relations casts are built from,
 * and `rules/npcs.json5`'s numbers - which peoples live where, what their names sound like, how
 * households are made, and when NPCs are filled near players. Part of the game rules: no seed.
 */
export type Age = "young" | "adult" | "old";
export const AGES: readonly Age[] = ["young", "adult", "old"];
export type Sex = "male" | "female";

/** Where an NPC stands, tried in order (NPCS.md, *Where NPCs stand*). */
export interface StandAnchor {
  /** In or by a building of this kind: the role's own building, if left out. */
  building: string | null;
  /** In this room of it, where it has an interior. */
  room: string | null;
  /** Or about the settlement: "square", "street", "door" (its home's). */
  at: "square" | "street" | "door" | null;
  /** Only for a trainer of these classes. */
  classes: string[] | null;
}

export interface NpcRoleDef {
  id: string;
  /** What it is called after its name: "Innkeeper"; `{class}` for a class trainer's class. */
  title: string;
  /** The entity template its NPCs are made from. */
  template: string;
  /** An outfit id, "fromClass" (the class's own), or a list to draw from; empty: the template's. */
  outfits: string[];
  /** One holder (or `count`) per building of these kinds in a settlement. */
  buildings: string[];
  count: [number, number];
  /** Held in every settlement of these tiers (null: any), `perSettlement` of them. */
  settlement: { tiers: string[] | null; count: [number, number] } | null;
  /** One per class: every class in the starting settlement, `other` of them elsewhere. */
  perClass: { start: "all" | [number, number]; other: [number, number] } | null;
  stand: StandAnchor[];
  /** What talking to it offers (NPCS.md, *Services*): read by the services, kept as written here. */
  services: RawObject;
  /** 0..1: how likely the quest generator is to pick it as a giver. */
  questGiver: number;
  barks: string | null;
  patrol: "gates" | "street" | "square" | null;
  /** The ages a holder may be. */
  ages: Age[];
  /** Whether it lives where it works (an innkeeper at the inn), or in a house of its own. */
  livesAtWork: boolean;
}

export interface RelationSide {
  name: string;
  ages: Age[];
  sex: Sex | null;
  /** Across households: the side must hold one of these roles. */
  roles: string[] | null;
}

export interface NpcRelationDef {
  id: string;
  /** Within one household (made with it), or across two. */
  kind: "household" | "across";
  sides: [RelationSide, RelationSide];
  /** They share a family name. */
  family: boolean;
  /** They share colouring: skin, hair and eyes. */
  looks: boolean;
  /** Across households: how many a settlement gets. */
  count: [number, number];
  /** The second side is older than the first by this many age steps at least (a parent and child: 1). */
  older: number;
  /** What one side calls the other: "brother", "mother"... by the other's sex. */
  call: [{ male: string; female: string }, { male: string; female: string }];
}

export interface HouseholdShape {
  weight: number;
  /** A household relation it is made from (spouses, siblings), or null for one person. */
  relation: string | null;
  /** Children added to it, each a `parentChild` relation to the first. */
  children: [number, number];
}

export interface NpcRules {
  roles: NpcRoleDef[];
  roleIndex: ReadonlyMap<string, number>;
  relations: NpcRelationDef[];
  relationIndex: ReadonlyMap<string, number>;
  /** Race weights by settlement style; `default` for a style it does not name. */
  peoples: Record<string, Record<string, number>>;
  /** The voice each race's given names are built from (`voices/`). */
  names: Record<string, string>;
  /** What a class trainer wears (`fromClass`), by class id; `default` for any other. */
  classOutfits: Record<string, string>;
  /** The role a household's member out on the street holds. */
  villager: string;
  /** Buildings people live in. */
  homes: string[];
  households: HouseholdShape[];
  /** The relation a child is made with. */
  childRelation: string;
  /** Share of households with a member out about the settlement. */
  out: number;
  moods: Record<string, number>;
  ages: Record<Age, number>;
  activeRadius: number;
  releaseRadius: number;
  releaseAfter: number;
  talkRange: number;
  bark: { cooldown: number; range: number };
  respawn: [number, number];
}

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

const ANCHOR_AT = ["square", "street", "door"] as const;

function readRange(reader: Reader, obj: RawObject, key: string, path: string, fallback: [number, number]): [number, number] {
  if (obj[key] === undefined) return fallback;
  if (typeof obj[key] === "number") return [obj[key] as number, obj[key] as number];
  return reader.range(obj, key, path, { allowEqual: true });
}

function readAges(reader: Reader, obj: RawObject, key: string, path: string): Age[] {
  if (obj[key] === undefined) return [...AGES];
  const ages = reader.stringList(obj, key, path);
  ages.forEach((a, i) => {
    if (!AGES.includes(a as Age)) reader.fail(`${path ? `${path}.` : ""}${key}[${i}]`, `expected one of ${AGES.join(", ")}`);
  });
  return ages.filter((a): a is Age => AGES.includes(a as Age));
}

function readWeights(reader: Reader, obj: RawObject, key: string, path: string, fallback: Record<string, number>): Record<string, number> {
  if (obj[key] === undefined) return fallback;
  const raw = reader.object(obj[key], path ? `${path}.${key}` : key);
  return Object.fromEntries(Object.keys(raw).map((k) => [k, reader.number(raw, k, path ? `${path}.${key}` : key, { min: 0 })]));
}

function readRole(entry: Entry, issues: ContentIssue[]): NpcRoleDef {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["title", "template", "outfit", "buildings", "count", "settlement", "perClass", "stand", "services", "questGiver", "barks", "patrol", "ages", "livesAtWork"]);
  const outfits = obj.outfit === undefined ? [] : typeof obj.outfit === "string" ? [obj.outfit] : reader.stringList(obj, "outfit", "");
  let settlement: NpcRoleDef["settlement"] = null;
  if (obj.settlement !== undefined) {
    const raw = reader.object(obj.settlement, "settlement");
    reader.onlyKeys(raw, "settlement", ["tiers", "count"]);
    settlement = { tiers: raw.tiers === undefined ? null : reader.stringList(raw, "tiers", "settlement"), count: readRange(reader, raw, "count", "settlement", [1, 1]) };
  }
  let perClass: NpcRoleDef["perClass"] = null;
  if (obj.perClass !== undefined) {
    const raw = reader.object(obj.perClass, "perClass");
    reader.onlyKeys(raw, "perClass", ["start", "other"]);
    perClass = { start: raw.start === "all" || raw.start === undefined ? "all" : readRange(reader, raw, "start", "perClass", [0, 0]), other: readRange(reader, raw, "other", "perClass", [0, 0]) };
  }
  const stand = reader.optionalArray(obj, "stand", "").map((value, i): StandAnchor => {
    const path = `stand[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["building", "room", "at", "classes"]);
    return {
      building: reader.optionalString(raw, "building", path) ?? null,
      room: reader.optionalString(raw, "room", path) ?? null,
      at: raw.at === undefined ? null : reader.oneOf(raw, "at", path, ANCHOR_AT),
      classes: raw.classes === undefined ? null : reader.stringList(raw, "classes", path),
    };
  });
  const buildings = obj.buildings === undefined ? [] : reader.stringList(obj, "buildings", "");
  if (buildings.length === 0 && !settlement && !perClass) reader.fail("", "a role is held per building (buildings), per settlement (settlement) or per class (perClass)");
  return {
    id: entry.id,
    title: obj.title === "" ? "" : (reader.optionalString(obj, "title", "") ?? entry.id),
    template: reader.optionalString(obj, "template", "") ?? "npc",
    outfits,
    buildings,
    count: readRange(reader, obj, "count", "", [1, 1]),
    settlement,
    perClass,
    stand: stand.length > 0 ? stand : [{ building: null, room: null, at: null, classes: null }],
    services: obj.services === undefined ? {} : reader.object(obj.services, "services"),
    questGiver: reader.optionalNumber(obj, "questGiver", "", 0, { min: 0, max: 1 }),
    barks: reader.optionalString(obj, "barks", "") ?? null,
    patrol: obj.patrol === undefined ? null : reader.oneOf(obj, "patrol", "", ["gates", "street", "square"] as const),
    ages: readAges(reader, obj, "ages", ""),
    livesAtWork: reader.boolean(obj, "livesAtWork", "", false),
  };
}

function readRelation(entry: Entry, issues: ContentIssue[]): NpcRelationDef {
  const reader = new Reader(issues, entry.file);
  const obj = reader.object(entry.data, "");
  reader.onlyKeys(obj, "", ["kind", "sides", "family", "looks", "count", "older"]);
  const sides = reader.array(obj, "sides", "").map((value, i): RelationSide & { call: { male: string; female: string } } => {
    const path = `sides[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["name", "ages", "sex", "roles", "call"]);
    const call = raw.call === undefined ? {} : reader.object(raw.call, `${path}.call`);
    const name = reader.string(raw, "name", path);
    return {
      name,
      ages: readAges(reader, raw, "ages", path),
      sex: raw.sex === undefined ? null : reader.oneOf(raw, "sex", path, ["male", "female"] as const),
      roles: raw.roles === undefined ? null : reader.stringList(raw, "roles", path),
      // What the other side calls this one: "mother", "son"...
      call: { male: reader.optionalString(call, "male", `${path}.call`) ?? name, female: reader.optionalString(call, "female", `${path}.call`) ?? name },
    };
  });
  if (sides.length !== 2) reader.fail("sides", "a relation has two sides");
  const pair = [sides[0] ?? { name: "a", ages: [...AGES], sex: null, roles: null, call: { male: "a", female: "a" } }, sides[1] ?? sides[0]] as const;
  return {
    id: entry.id,
    kind: reader.oneOf(obj, "kind", "", ["household", "across"] as const),
    sides: [pair[0], pair[1]].map(({ call: _, ...side }) => side) as [RelationSide, RelationSide],
    family: reader.boolean(obj, "family", "", false),
    looks: reader.boolean(obj, "looks", "", false),
    count: readRange(reader, obj, "count", "", [0, 0]),
    older: reader.optionalNumber(obj, "older", "", 0, { min: 0, max: 2, integer: true }),
    call: [pair[0].call, pair[1].call],
  };
}

/** Reads `npcRoles/`, `npcRelations/` and `rules/npcs.json5`; checks the names they give each other. */
export function readNpcRules(rules: Entry | undefined, roleEntries: readonly Entry[], relationEntries: readonly Entry[], templates: ReadonlySet<string>, issues: ContentIssue[]): NpcRules {
  const roles = roleEntries.map((e) => readRole(e, issues));
  const relations = relationEntries.map((e) => readRelation(e, issues));
  const roleIndex = new Map(roles.map((r, i) => [r.id, i]));
  const relationIndex = new Map(relations.map((r, i) => [r.id, i]));
  for (const [i, role] of roles.entries()) {
    if (!templates.has(role.template)) issues.push({ file: roleEntries[i].file, path: "template", message: `no template "${role.template}" that can be made` });
  }
  for (const [i, relation] of relations.entries()) {
    relation.sides.forEach((side, s) => side.roles?.forEach((r) => {
      if (!roleIndex.has(r)) issues.push({ file: relationEntries[i].file, path: `sides[${s}].roles`, message: `no role "${r}"` });
    }));
  }

  const reader = new Reader(issues, rules?.file ?? "rules/npcs.json5");
  const obj = rules ? reader.object(rules.data, "") : {};
  reader.onlyKeys(obj, "", ["peoples", "names", "classOutfits", "villager", "homes", "households", "childRelation", "out", "moods", "ages", "activeRadius", "releaseRadius", "releaseAfter", "talkRange", "bark", "respawn"]);
  const peoples: Record<string, Record<string, number>> = {};
  if (obj.peoples !== undefined) {
    const raw = reader.object(obj.peoples, "peoples");
    for (const style of Object.keys(raw)) peoples[style] = readWeights(reader, raw, style, "peoples", {});
  }
  peoples.default ??= { human: 1 };
  const names: Record<string, string> = {};
  if (obj.names !== undefined) {
    const raw = reader.object(obj.names, "names");
    for (const race of Object.keys(raw)) names[race] = reader.string(raw, race, "names");
  }
  const classOutfits: Record<string, string> = {};
  if (obj.classOutfits !== undefined) {
    const raw = reader.object(obj.classOutfits, "classOutfits");
    for (const id of Object.keys(raw)) classOutfits[id] = reader.string(raw, id, "classOutfits");
  }
  const villager = reader.optionalString(obj, "villager", "") ?? "villager";
  if (roles.length > 0 && !roleIndex.has(villager)) reader.fail("villager", `no role "${villager}"`);
  const households = reader.optionalArray(obj, "households", "").map((value, i): HouseholdShape => {
    const path = `households[${i}]`;
    const raw = reader.object(value, path);
    reader.onlyKeys(raw, path, ["weight", "relation", "children"]);
    const relation = reader.optionalString(raw, "relation", path) ?? null;
    if (relation && !relationIndex.has(relation)) reader.fail(`${path}.relation`, `no relation "${relation}" (known: ${[...relationIndex.keys()].join(", ")})`);
    return { weight: reader.optionalNumber(raw, "weight", path, 1, { min: 0 }), relation, children: readRange(reader, raw, "children", path, [0, 0]) };
  });
  const childRelation = reader.optionalString(obj, "childRelation", "") ?? "parentChild";
  if (relations.length > 0 && households.some((h) => h.children[1] > 0) && !relationIndex.has(childRelation)) reader.fail("childRelation", `no relation "${childRelation}"`);
  const bark = obj.bark === undefined ? {} : reader.object(obj.bark, "bark");
  reader.onlyKeys(bark, "bark", ["cooldown", "range"]);
  const ages = readWeights(reader, obj, "ages", "", { young: 1, adult: 4, old: 1 });
  return {
    roles,
    roleIndex,
    relations,
    relationIndex,
    peoples,
    names,
    classOutfits,
    villager,
    homes: obj.homes === undefined ? [] : reader.stringList(obj, "homes", ""),
    households: households.length > 0 ? households : [{ weight: 1, relation: null, children: [0, 0] }],
    childRelation,
    out: reader.optionalNumber(obj, "out", "", 0.4, { min: 0, max: 1 }),
    moods: readWeights(reader, obj, "moods", "", { calm: 1 }),
    ages: { young: ages.young ?? 0, adult: ages.adult ?? 0, old: ages.old ?? 0 },
    activeRadius: reader.optionalNumber(obj, "activeRadius", "", 160, { min: 0 }),
    releaseRadius: reader.optionalNumber(obj, "releaseRadius", "", 200, { min: 0 }),
    releaseAfter: reader.optionalNumber(obj, "releaseAfter", "", 30, { min: 0 }),
    talkRange: reader.optionalNumber(obj, "talkRange", "", 4, { min: 0 }),
    bark: { cooldown: reader.optionalNumber(bark, "cooldown", "bark", 60, { min: 0 }), range: reader.optionalNumber(bark, "range", "bark", 8, { min: 0 }) },
    respawn: readRange(reader, obj, "respawn", "", [120, 180]),
  };
}
