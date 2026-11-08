import { Reader, type ContentIssue } from "../../world/content/contentReader";
import type { Text } from "../text";
import { readQuestParts, readQuestPlots, readQuestSegments, readQuestVoices, poolsOf, type Line, type QuestPartDef, type QuestPlotDef, type QuestSegmentDef } from "./plots";
import { composeChain } from "./chains";

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
  /** Quests a settlement gets, by tier, chains counted by their quests. */
  quota: Record<string, [number, number]>;
  /** How far round a settlement its quests look for places, in metres. */
  reach: number;
  /** Plurals by a name's last word ("Wolf": "Wolves"); others take an "s". */
  plurals: Record<string, string>;
  /** The settlement's own fields as a place: what lies about in them. */
  fields: { objects: { name: string; tags: string[] }[]; text: string };
  /** Things that happened "when": the offers' `{when}`. */
  whens: string[];
  /** How the generator weighs what to use (QUESTS.md, *Weighting*). */
  weighting: QuestWeighting;
  /** Chains drawn from segments: the most segments one has, and how likely each next one is. */
  chain: { max: number; more: number };
  parts: ReadonlyMap<string, QuestPartDef>;
  segments: ReadonlyMap<string, QuestSegmentDef>;
  /** Voice banks by slot: lines any quest can draw on in how its giver talks. */
  voices: ReadonlyMap<string, Line[]>;
  plots: QuestPlotDef[];
}

/** How the generator weighs a place, a creature kind or an object, and the plots and chains that need them. */
export interface QuestWeighting {
  /** Metres at which a place is half as likely as one at the door: 1 / (1 + (d / distance)^2). */
  distance: number;
  /** Each earlier quest using the same place or object: 1 / (1 + here x (in this settlement) + elsewhere x (in others)). */
  reuse: { here: number; elsewhere: number };
  /** The same for a creature kind, which a whole zone shares. */
  kind: { here: number; elsewhere: number };
  /** Each earlier objective within `radius` metres of a place: 1 / (1 + each x how many). */
  crowding: { radius: number; each: number };
}

type Entry = { id: string; file: string; data: unknown };

export function readQuestRules(entry: { file: string; data: unknown } | undefined, partEntries: readonly Entry[], segmentEntries: readonly Entry[], plotEntries: readonly Entry[], voiceEntries: readonly Entry[], issues: ContentIssue[]): QuestRules {
  const reader = new Reader(issues, entry?.file ?? "rules/quests.json5");
  const obj = entry ? reader.object(entry.data, "") : {};
  reader.onlyKeys(obj, "", ["maxActive", "xp", "money", "standing", "objects", "talkRange", "colours", "rewardTemplates", "quota", "reach", "plurals", "fields", "whens", "chain", "weighting"]);
  const parts = new Map(readQuestParts(partEntries, issues).map((p) => [p.id, p]));
  const segments = new Map(readQuestSegments(segmentEntries, parts, issues).map((s) => [s.id, s]));
  const voices = new Map<string, Line[]>();
  for (const voice of readQuestVoices(voiceEntries, issues)) voices.set(voice.slot, [...(voices.get(voice.slot) ?? []), ...voice.lines]);
  const plots = readQuestPlots(plotEntries, parts, segments, issues).map((plot) => {
    if (!plot.segments) return plot;
    // A recipe of segments is put together here, once, and drawn like any other plot.
    const composed = composeChain(plot.id, plot.segments.map((id) => segments.get(id)).filter((s): s is QuestSegmentDef => !!s), { weight: plot.weight, intro: plot.intro });
    if (!composed) {
      issues.push({ file: `questPlots/${plot.id}.json5`, path: "segments", message: "these segments do not fit together: one needs a tag, a person or a place that nothing before it gives, or two want creatures that no creature is" });
      return plot;
    }
    return { ...composed, giver: plot.giver.length > 0 ? plot.giver : composed.giver };
  });
  // Every voice bank a quest names is there.
  const known = new Set(voices.keys());
  const check = (where: string, pools: ReturnType<typeof poolsOf>) => {
    for (const pool of pools) for (const bank of pool.banks) if (!known.has(bank)) issues.push({ file: where, path: "", message: `no voice bank "${bank}" (questVoices/ has: ${[...known].join(", ") || "none"})` });
  };
  for (const s of segments.values()) check(`questSegments/${s.id}.json5`, poolsOf(s.quest));
  for (const p of plots) for (const q of p.quests) check(`questPlots/${p.id}.json5`, poolsOf(q));
  for (const part of parts.values()) check(`questParts/${part.id}.json5`, [part.motive]);
  const quota: Record<string, [number, number]> = {};
  if (obj.quota !== undefined) {
    const raw = reader.object(obj.quota, "quota");
    for (const tier of Object.keys(raw)) quota[tier] = reader.range(raw, tier, "quota", { allowEqual: true });
  }
  const plurals: Record<string, string> = {};
  if (obj.plurals !== undefined) {
    const raw = reader.object(obj.plurals, "plurals");
    for (const word of Object.keys(raw)) plurals[word] = reader.string(raw, word, "plurals");
  }
  const wRaw = obj.weighting === undefined ? {} : reader.object(obj.weighting, "weighting");
  const pair = (key: string, fallback: [number, number]): { here: number; elsewhere: number } => {
    const raw = wRaw[key] === undefined ? {} : reader.object(wRaw[key], `weighting.${key}`);
    return { here: reader.optionalNumber(raw, "here", `weighting.${key}`, fallback[0], { min: 0 }), elsewhere: reader.optionalNumber(raw, "elsewhere", `weighting.${key}`, fallback[1], { min: 0 }) };
  };
  const crowdingRaw = wRaw.crowding === undefined ? {} : reader.object(wRaw.crowding, "weighting.crowding");
  const weighting: QuestWeighting = {
    distance: reader.optionalNumber(wRaw, "distance", "weighting", 400, { min: 1 }),
    reuse: pair("reuse", [2, 0.5]),
    kind: pair("kind", [1, 0.15]),
    crowding: { radius: reader.optionalNumber(crowdingRaw, "radius", "weighting.crowding", 150, { min: 0 }), each: reader.optionalNumber(crowdingRaw, "each", "weighting.crowding", 0.7, { min: 0 }) },
  };
  const chainRaw = obj.chain === undefined ? {} : reader.object(obj.chain, "chain");
  const whens = obj.whens === undefined ? [] : reader.stringList(obj, "whens", "");
  const fieldsRaw = obj.fields === undefined ? {} : reader.object(obj.fields, "fields");
  const fields = {
    objects: reader.optionalArray(fieldsRaw, "objects", "fields").map((v, i) => {
      const o = reader.object(v, `fields.objects[${i}]`);
      return { name: reader.string(o, "name", `fields.objects[${i}]`), tags: o.tags === undefined ? [] : reader.stringList(o, "tags", `fields.objects[${i}]`) };
    }),
    text: reader.optionalString(fieldsRaw, "text", "fields") ?? "the fields outside {name}",
  };
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
    quota,
    reach: reader.optionalNumber(obj, "reach", "", 1000, { min: 0 }),
    plurals,
    fields,
    whens,
    weighting,
    chain: { max: reader.optionalNumber(chainRaw, "max", "chain", 4, { min: 1, integer: true }), more: reader.optionalNumber(chainRaw, "more", "chain", 0.5, { min: 0, max: 1 }) },
    parts,
    segments,
    voices,
    plots,
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
