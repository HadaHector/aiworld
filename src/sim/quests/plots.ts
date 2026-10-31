import { Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";

/**
 * Quest parts and plots (QUESTS.md, *Parts* and *Plots*), as the packs write them. A part is one
 * objective with what it needs from the place and how it reads; a plot puts parts together into a
 * quest or a chain, with the people, creatures and place its quests share. Text is English
 * templates (QUESTS.md, *Text*), filled from the quest's arguments.
 */
export const PART_KINDS = ["talk", "kill", "loot", "gather", "receive", "use", "deliver", "reach"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** Which of a zone's creatures will do. */
export interface CreatureNeed {
  hostility: string[] | null;
  family: string[] | null;
}

/** Which place will do: by its tags, or one that has objects to gather (with these tags). */
export interface PlaceNeed {
  tags: string[];
  objects: string[] | null;
}

export interface QuestPartDef {
  id: string;
  kind: PartKind;
  count: [number, number];
  chance: number;
  below: number;
  item: string | null;
  /** The objective's line in the log. */
  line: string;
  /** Sentences it can add to the offer: one is drawn. */
  motive: string[];
}

/** A person a plot needs (the giver aside): by role, perhaps related to the giver, else made new. */
export interface PlotPerson {
  roles: string[];
  /** What the giver calls them: one of these ("sister", "friend"), else anyone of the roles. */
  relation: string[] | null;
  /** A role made new where nobody fits - a quest person (QUESTS.md, *Quest people*) - living at
   *  the plot's place, if the place has room for one of these. */
  make: string[];
}

export interface PlotQuest {
  giver: string;
  ender: string;
  parts: { part: string; npc: string | null; item: string | null }[];
  title: string;
  /** The offer, about five sentences: groups of alternatives, one drawn from each; "$motive" is
   *  where the parts' motives go. */
  offer: string[][];
  progress: string[];
  done: string[];
  /** An item to choose for the reward. */
  choice: boolean;
}

export interface QuestPlotDef {
  id: string;
  weight: number;
  /** Only when a starting place's `intro` names it (NPCS.md, *The starting site*). */
  intro: boolean;
  giver: string[];
  people: Record<string, PlotPerson>;
  creatures: CreatureNeed | null;
  place: PlaceNeed | null;
  /** A road to another settlement: the nearest other one, its reeve the one to see. */
  road: boolean;
  quests: PlotQuest[];
}

const strings = (reader: Reader, obj: RawObject, key: string, path: string): string[] => {
  const v = obj[key];
  if (v === undefined) return [];
  if (typeof v === "string") return [v];
  return reader.stringList(obj, key, path);
};

function readCreatureNeed(reader: Reader, obj: RawObject, key: string, path: string): CreatureNeed | null {
  if (obj[key] === undefined) return null;
  const at = path ? `${path}.${key}` : key;
  const raw = reader.object(obj[key], at);
  reader.onlyKeys(raw, at, ["hostility", "family"]);
  return { hostility: raw.hostility === undefined ? null : reader.stringList(raw, "hostility", at), family: raw.family === undefined ? null : reader.stringList(raw, "family", at) };
}

function readPlaceNeed(reader: Reader, obj: RawObject, key: string, path: string): PlaceNeed | null {
  if (obj[key] === undefined) return null;
  const at = path ? `${path}.${key}` : key;
  const raw = reader.object(obj[key], at);
  reader.onlyKeys(raw, at, ["tags", "objects"]);
  return { tags: strings(reader, raw, "tags", at), objects: raw.objects === undefined ? null : strings(reader, raw, "objects", at) };
}

export function readQuestParts(entries: readonly { id: string; file: string; data: unknown }[], issues: ContentIssue[]): QuestPartDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["kind", "count", "chance", "below", "item", "line", "motive"]);
    const kind = reader.oneOf(obj, "kind", "", PART_KINDS);
    const count: [number, number] = obj.count === undefined ? [1, 1] : typeof obj.count === "number" ? [obj.count, obj.count] : reader.range(obj, "count", "", { allowEqual: true });
    if ((kind === "receive" || kind === "use" || kind === "deliver") && obj.item === undefined) reader.fail("item", `a ${kind} part names its item`);
    return {
      id: entry.id,
      kind,
      count,
      chance: reader.optionalNumber(obj, "chance", "", 1, { min: 0, max: 1 }),
      below: reader.optionalNumber(obj, "below", "", 1, { min: 0, max: 1 }),
      item: reader.optionalString(obj, "item", "") ?? null,
      line: reader.string(obj, "line", ""),
      motive: strings(reader, obj, "motive", ""),
    };
  });
}

export function readQuestPlots(entries: readonly { id: string; file: string; data: unknown }[], parts: ReadonlyMap<string, QuestPartDef>, issues: ContentIssue[]): QuestPlotDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["weight", "intro", "giver", "people", "creatures", "place", "road", "quests"]);
    const people: Record<string, PlotPerson> = {};
    if (obj.people !== undefined) {
      const raw = reader.object(obj.people, "people");
      for (const name of Object.keys(raw)) {
        const at = `people.${name}`;
        const p = reader.object(raw[name], at);
        reader.onlyKeys(p, at, ["roles", "relation", "make"]);
        people[name] = { roles: strings(reader, p, "roles", at), relation: p.relation === undefined ? null : strings(reader, p, "relation", at), make: strings(reader, p, "make", at) };
      }
    }
    const names = new Set(["giver", ...Object.keys(people), "road"]);
    const quests = reader.array(obj, "quests", "").map((value, i): PlotQuest => {
      const at = `quests[${i}]`;
      const q = reader.object(value, at);
      reader.onlyKeys(q, at, ["giver", "ender", "parts", "title", "offer", "progress", "done", "choice"]);
      const giver = reader.optionalString(q, "giver", at) ?? "giver";
      const ender = reader.optionalString(q, "ender", at) ?? giver;
      for (const [key, who] of [["giver", giver], ["ender", ender]] as const) if (!names.has(who)) reader.fail(`${at}.${key}`, `no person "${who}" in this plot (${[...names].join(", ")})`);
      const questParts = reader.array(q, "parts", at).map((p, j) => {
        const pat = `${at}.parts[${j}]`;
        const raw = typeof p === "string" ? { part: p } : reader.object(p, pat);
        reader.onlyKeys(raw, pat, ["part", "npc", "item"]);
        const part = reader.string(raw, "part", pat);
        if (!parts.has(part)) reader.fail(`${pat}.part`, `no quest part "${part}"`);
        const npc = reader.optionalString(raw, "npc", pat) ?? null;
        if (npc && !names.has(npc)) reader.fail(`${pat}.npc`, `no person "${npc}" in this plot`);
        return { part, npc, item: reader.optionalString(raw, "item", pat) ?? null };
      });
      const offer = reader.array(q, "offer", at).map((group, j) => (typeof group === "string" ? [group] : reader.stringList({ g: group }, "g", `${at}.offer[${j}]`)));
      return { giver, ender, parts: questParts, title: reader.string(q, "title", at), offer, progress: strings(reader, q, "progress", at), done: strings(reader, q, "done", at), choice: reader.boolean(q, "choice", at, false) };
    });
    return {
      id: entry.id,
      weight: reader.optionalNumber(obj, "weight", "", 1, { min: 0 }),
      intro: reader.boolean(obj, "intro", "", false),
      giver: strings(reader, obj, "giver", ""),
      people,
      creatures: readCreatureNeed(reader, obj, "creatures", ""),
      place: readPlaceNeed(reader, obj, "place", ""),
      road: reader.boolean(obj, "road", "", false),
      quests,
    };
  });
}
