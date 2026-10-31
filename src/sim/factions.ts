import { Reader, type ContentIssue, type RawObject } from "../world/content/contentReader";

/**
 * Factions (NPCS.md, *Factions*): who every entity sides with, how factions regard each other, and
 * a character's standing with the factions whose `reputation` can change. One scale for both: a
 * number whose tiers (hated ... exalted) are `rules/factions.json5`'s.
 */
export interface FactionDef {
  id: string;
  name: string;
  /** How this faction regards another, by that faction's id (or, for a generated one, its
   *  template's id). Missing: neutral. */
  relations: ReadonlyMap<string, number>;
  /** Whether a character's standing with it can change (and is kept). */
  reputation: boolean;
  /** A template generated once per zone (`folk` → `folk@mainland/3`), or null for a faction of its own. */
  per: "zone" | null;
}

export interface FactionTier {
  id: string;
  name: string;
  /** Standing from which this tier starts. */
  from: number;
}

export interface FactionRules {
  factions: ReadonlyMap<string, FactionDef>;
  /** Lowest first. */
  tiers: FactionTier[];
  /** Standing at or above which two sides are allies: they help, never harm, each other. */
  ally: number;
  /** Standing below which a side attacks the other on sight. */
  hostile: number;
  /** The highest standing there is. */
  max: number;
}

/** What a template stands with when it names no faction, by its hostility (ENTITIES.md). */
export const FACTION_BY_HOSTILITY = { hostile: "monsters", neutral: "wildlife", friendly: "players" } as const;
export const PLAYERS_FACTION = "players";

// The tiers a pack set with no rules/factions.json5 gets: WoW's.
const DEFAULT_TIERS: FactionTier[] = [
  { id: "hated", name: "Hated", from: -42000 },
  { id: "hostile", name: "Hostile", from: -6000 },
  { id: "unfriendly", name: "Unfriendly", from: -3000 },
  { id: "neutral", name: "Neutral", from: 0 },
  { id: "friendly", name: "Friendly", from: 3000 },
  { id: "honoured", name: "Honoured", from: 9000 },
  { id: "revered", name: "Revered", from: 21000 },
  { id: "exalted", name: "Exalted", from: 42000 },
];

interface Entry {
  id: string;
  file: string;
  data: unknown;
}

/** A tier's id, or a number: a standing. */
function readStanding(reader: Reader, obj: RawObject, key: string, path: string, tiers: readonly FactionTier[]): number {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const tier = tiers.find((t) => t.id === value);
  if (tier) return tier.from;
  reader.fail(path ? `${path}.${key}` : key, `expected a number or a tier (${tiers.map((t) => t.id).join(", ")})`);
  return 0;
}

/** Reads `rules/factions.json5` and `factions/*.json5`. A pack set that defines none still gets
 *  players, monsters (hostile to players) and wildlife (neutral), which templates fall back to. */
export function readFactionRules(rules: Entry | undefined, entries: readonly Entry[], issues: ContentIssue[]): FactionRules {
  let tiers = DEFAULT_TIERS;
  let allyTier = "friendly";
  let hostileTier = "hostile";
  if (rules) {
    const reader = new Reader(issues, rules.file);
    const obj = reader.object(rules.data, "");
    reader.onlyKeys(obj, "", ["tiers", "ally", "hostile"]);
    if (obj.tiers !== undefined) {
      tiers = reader.array(obj, "tiers", "").map((value, i) => {
        const path = `tiers[${i}]`;
        const raw = reader.object(value, path);
        reader.onlyKeys(raw, path, ["id", "name", "from"]);
        const id = reader.string(raw, "id", path);
        return { id, name: reader.optionalString(raw, "name", path) ?? id, from: reader.number(raw, "from", path) };
      });
      if (tiers.some((t, i) => i > 0 && t.from <= tiers[i - 1].from)) reader.fail("tiers", "each tier must start above the one before");
      if (tiers.length < 2) reader.fail("tiers", "at least two tiers");
    }
    allyTier = reader.optionalString(obj, "ally", "") ?? allyTier;
    hostileTier = reader.optionalString(obj, "hostile", "") ?? hostileTier;
    for (const [key, id] of [["ally", allyTier], ["hostile", hostileTier]] as const) {
      if (!tiers.some((t) => t.id === id)) reader.fail(key, `no tier "${id}" (known: ${tiers.map((t) => t.id).join(", ")})`);
    }
  }
  const hostileAt = tiers.findIndex((t) => t.id === hostileTier);
  const top = tiers[tiers.length - 1];

  const factions = new Map<string, FactionDef>();
  for (const entry of entries) {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["name", "relations", "reputation", "per"]);
    const relations = new Map<string, number>();
    if (obj.relations !== undefined) {
      const raw = reader.object(obj.relations, "relations");
      for (const other of Object.keys(raw)) relations.set(other, readStanding(reader, raw, other, "relations", tiers));
    }
    factions.set(entry.id, {
      id: entry.id,
      name: reader.optionalString(obj, "name", "") ?? entry.id,
      relations,
      reputation: reader.boolean(obj, "reputation", "", false),
      per: obj.per === undefined ? null : reader.oneOf(obj, "per", "", ["zone"] as const),
    });
  }
  const hostileFrom = tiers.find((t) => t.id === "hostile")?.from ?? tiers[0].from;
  const fallbacks: FactionDef[] = [
    { id: PLAYERS_FACTION, name: "Players", relations: new Map(), reputation: false, per: null },
    { id: "monsters", name: "Monsters", relations: new Map([[PLAYERS_FACTION, hostileFrom]]), reputation: false, per: null },
    { id: "wildlife", name: "Wildlife", relations: new Map(), reputation: false, per: null },
  ];
  for (const def of fallbacks) if (!factions.has(def.id)) factions.set(def.id, def);
  for (const def of factions.values()) {
    for (const other of def.relations.keys()) {
      if (!factions.has(other)) issues.push({ file: `factions/${def.id}.json5`, path: `relations.${other}`, message: `no faction "${other}" (known: ${[...factions.keys()].join(", ")})` });
    }
  }
  return {
    factions,
    tiers,
    ally: tiers.find((t) => t.id === allyTier)?.from ?? 0,
    hostile: tiers[hostileAt + 1]?.from ?? top.from,
    max: top.from + (top.from - (tiers[tiers.length - 2]?.from ?? 0)),
  };
}

/** A faction's definition: its own, or for a generated one (`folk@...`) its template's. */
export function factionDef(rules: FactionRules, id: string): FactionDef | undefined {
  return rules.factions.get(id) ?? rules.factions.get(id.split("@")[0]);
}

/** How `def` regards the faction `other` (by its id, or its template's), if it says. */
function regard(def: FactionDef | undefined, other: string): number | undefined {
  return def?.relations.get(other) ?? def?.relations.get(other.split("@")[0]);
}

/** One side of a relation: its faction, and a character's own standings (only players have them). */
export interface Side {
  faction: string;
  standing?: ReadonlyMap<string, number>;
}

/** A character's standing with a faction: what it has earned, else how the faction regards players. */
export function standingWith(rules: FactionRules, side: Side, faction: string): number {
  const def = factionDef(rules, faction);
  if (def?.reputation) {
    const own = side.standing?.get(faction);
    if (own !== undefined) return own;
  }
  return regard(def, side.faction) ?? regard(factionDef(rules, side.faction), faction) ?? 0;
}

/**
 * How two sides stand to each other: +Infinity for one faction; a character's standing with a
 * faction that keeps reputation; else the lower of what each says of the other (neutral, 0, if
 * neither says).
 */
export function standingBetween(rules: FactionRules, a: Side, b: Side): number {
  if (a.faction === b.faction) return Infinity;
  const ra = factionDef(rules, a.faction);
  const rb = factionDef(rules, b.faction);
  if (a.standing && rb?.reputation) return standingWith(rules, a, b.faction);
  if (b.standing && ra?.reputation) return standingWith(rules, b, a.faction);
  const ab = regard(ra, b.faction);
  const ba = regard(rb, a.faction);
  return ab === undefined ? (ba ?? 0) : ba === undefined ? ab : Math.min(ab, ba);
}

/** The tier a standing falls in. */
export function tierOf(rules: FactionRules, standing: number): FactionTier {
  let tier = rules.tiers[0];
  for (const t of rules.tiers) if (standing >= t.from) tier = t;
  return tier;
}

/** A standing kept within the scale. */
export const clampStanding = (rules: FactionRules, value: number): number => Math.max(rules.tiers[0].from, Math.min(rules.max, value));
