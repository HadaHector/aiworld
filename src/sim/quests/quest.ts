import { Reader, type ContentIssue } from "../../world/content/contentReader";
import type { Text } from "../../core/text";

/**
 * A quest (QUESTS.md, *A quest*): who gives and ends it, what it asks, how it reads, what it gives.
 * Made by the generator (or by hand, in a probe), defined on the server, and sent whole to a client
 * that needs it: its text is templates and arguments, worded by the reader's client.
 */
export interface QuestDef {
  /** `q:<dimension>/<settlement>/<n>`: stable for the seed. */
  id: string;
  level: number;
  /** NPC ids (NPCS.md's `npc:...`). */
  giver: string;
  ender: string;
  chain: { id: string; index: number; of: number } | null;
  requires: { quests: string[]; level: number };
  objectives: Objective[];
  /** One after another (each shows once the one before is done), or all at once. */
  ordered: boolean;
  text: { title: Text; offer: Text; progress: Text; done: Text };
  rewards: QuestRewards;
  /** Seconds to do it in, from accepting; 0 for no limit. Running out fails it. */
  within: number;
  /** Where its objectives are, for the map: circles. */
  where: { dimension: string; x: number; z: number; radius: number }[];
}

/** Creatures an objective is about: kind ids, or species (the kind id's first part, `wolf`). */
export interface KindFilter {
  kinds: string[];
  /** What they are called in the log: "Timber Wolves". */
  name: Text;
}

export type Objective =
  | { kind: "talk"; npc: string; line: Text }
  | { kind: "kill"; creatures: KindFilter; count: number; line: Text }
  | { kind: "loot"; from: KindFilter; count: number; chance: number; line: Text }
  | { kind: "gather"; object: string; count: number; area: { dimension: string; x: number; z: number; radius: number }; line: Text }
  | { kind: "receive"; item: string; from: string; line: Text }
  | { kind: "use"; item: string; on: KindFilter; below: number; count: number; line: Text }
  | { kind: "deliver"; item: string; to: string; line: Text }
  | { kind: "reach"; area: { dimension: string; x: number; z: number; radius: number }; line: Text };

export interface QuestRewards {
  xp: number;
  money: number;
  /** Item types to choose one of; empty for none. */
  choice: string[];
  /** Item types given as well. */
  items: string[];
  standing: { faction: string; amount: number }[];
}

/** One quest a character has taken. */
export interface ActiveQuest {
  id: string;
  counts: number[];
  state: "active" | "ready" | "failed";
  /** World time it was taken. */
  accepted: number;
}

/** What a character keeps of quests (saved, FRONTEND.md's record): what it has, what it has done. */
export interface QuestPart {
  active: Map<string, ActiveQuest>;
  done: Set<string>;
}

export interface SavedQuests {
  active: { id: string; counts: number[]; state: "active" | "ready" | "failed"; accepted: number }[];
  done: string[];
}

/** How many an objective needs. */
export const needed = (objective: Objective): number =>
  objective.kind === "kill" || objective.kind === "loot" || objective.kind === "gather" || objective.kind === "use" ? objective.count : 1;

/** Whether a creature kind is one a filter means. */
export const kindMatches = (filter: KindFilter, kind: string): boolean => filter.kinds.some((k) => k === kind || kind.split(".")[0] === k);

/** `rules/quests.json5` (QUESTS.md): numbers the quests run by. */
export interface QuestRules {
  maxActive: number;
  /** XP: `base + perLevel × level` at the quest's level, falling to `greyShare` as the character
   *  outgrows it by `grey` levels. */
  xp: { base: number; perLevel: number; grey: number; greyShare: number };
  money: { base: number; perLevel: number };
  /** Standing with the giver's faction a quest gives. */
  standing: number;
  /** Ground objects for gathering: how many stand at once, and how soon a taken one is back. */
  objects: { count: number; respawn: number; template: string };
  /** How far from a quest's giver it is offered, and how near an NPC to talk is. */
  talkRange: number;
  /** Level colours: how far over or under the character's level each starts. */
  colours: { red: number; orange: number; green: number; grey: number };
  /** What a quest's item choice is drawn from: item templates by slot kind. */
  rewardTemplates: string[];
}

export function readQuestRules(entry: { file: string; data: unknown } | undefined, issues: ContentIssue[]): QuestRules {
  const reader = new Reader(issues, entry?.file ?? "rules/quests.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["maxActive", "xp", "money", "standing", "objects", "talkRange", "colours", "rewardTemplates"]);
  const xp = obj.xp === undefined ? {} : reader.object(obj.xp, "xp");
  const money = obj.money === undefined ? {} : reader.object(obj.money, "money");
  const objects = obj.objects === undefined ? {} : reader.object(obj.objects, "objects");
  const colours = obj.colours === undefined ? {} : reader.object(obj.colours, "colours");
  return {
    maxActive: reader.optionalNumber(obj, "maxActive", "", 25, { min: 1, integer: true }),
    xp: {
      base: reader.optionalNumber(xp, "base", "xp", 80),
      perLevel: reader.optionalNumber(xp, "perLevel", "xp", 40),
      grey: reader.optionalNumber(xp, "grey", "xp", 6, { min: 1 }),
      greyShare: reader.optionalNumber(xp, "greyShare", "xp", 0.1, { min: 0, max: 1 }),
    },
    money: { base: reader.optionalNumber(money, "base", "money", 10), perLevel: reader.optionalNumber(money, "perLevel", "money", 8) },
    standing: reader.optionalNumber(obj, "standing", "", 250),
    objects: {
      count: reader.optionalNumber(objects, "count", "objects", 8, { min: 1, integer: true }),
      respawn: reader.optionalNumber(objects, "respawn", "objects", 30, { min: 0 }),
      template: reader.optionalString(objects, "template", "objects") ?? "questObject",
    },
    talkRange: reader.optionalNumber(obj, "talkRange", "", 6, { min: 0 }),
    colours: {
      red: reader.optionalNumber(colours, "red", "colours", 5),
      orange: reader.optionalNumber(colours, "orange", "colours", 3),
      green: reader.optionalNumber(colours, "green", "colours", -3),
      grey: reader.optionalNumber(colours, "grey", "colours", -6),
    },
    rewardTemplates: obj.rewardTemplates === undefined ? [] : reader.stringList(obj, "rewardTemplates", ""),
  };
}

/** A quest's colour for a character's level (QUESTS.md, *The quest log and tracker*). */
export function questColour(rules: QuestRules, questLevel: number, level: number): "red" | "orange" | "yellow" | "green" | "grey" {
  const d = questLevel - level;
  if (d >= rules.colours.red) return "red";
  if (d >= rules.colours.orange) return "orange";
  if (d <= rules.colours.grey) return "grey";
  if (d <= rules.colours.green) return "green";
  return "yellow";
}
