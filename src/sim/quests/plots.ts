import { Reader, type ContentIssue, type RawObject } from "../../world/content/contentReader";

/**
 * Quest parts, segments, plots and voices (QUESTS.md, *Parts*, *Segments*, *Plots*, *Voices*), as
 * the packs write them.
 *
 * - A **part** is one objective with what it needs from the place and how it reads.
 * - A **segment** is one quest of a chain, with the tags it needs from what came before and the tags
 *   it adds, so that segments fit together like Lego (an opener, middles, a closer).
 * - A **plot** is a fixed recipe: quests written out, or a list of segments in order.
 * - A **voice** is a bank of lines that wrap any quest in how its giver talks.
 *
 * Text is English templates (QUESTS.md, *Text*), filled from the quest's arguments.
 */
export const PART_KINDS = ["talk", "kill", "loot", "drop", "gather", "receive", "use", "deliver", "reach"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** Which of a zone's creatures will do. */
export interface CreatureNeed {
  hostility: string[] | null;
  family: string[] | null;
  /** Tags a creature must have, all of them ("furred" for pelts). */
  tags: string[] | null;
}

/** Which place will do: by its tags, or one that has objects to gather (with these tags). */
export interface PlaceNeed {
  tags: string[];
  objects: string[] | null;
  /** Tags an object it offers must not have (the evidence left at a crime is not for gathering herbs). */
  not: string[];
}

// --- lines: the text a quest is worded from ---

/** When a line may be used: every key given must match, any one of its values. The speaker is the
 *  quest's giver; `place` and `creature` are the quest's place tags and creature family; `tags` are
 *  what the chain has so far; `tier` is the settlement's. */
export interface LineCondition {
  mood?: string[];
  role?: string[];
  sex?: string[];
  age?: string[];
  place?: string[];
  /** Tags of the object a gather is about ("herb", "lost"). */
  object?: string[];
  creature?: string[];
  tags?: string[];
  tier?: string[];
}
const CONDITION_KEYS = ["mood", "role", "sex", "age", "place", "object", "creature", "tags", "tier"] as const;

/** A sentence to draw: its template, how likely, and when it can be said. An empty one is "say nothing". */
export interface Line {
  text: string;
  weight: number;
  when: LineCondition | null;
}

/** Lines to draw one from: its own, and the voice banks (`"$hook"`) it also draws on. In an offer,
 *  `motive` marks the place where the parts' motive sentences go. */
export interface Pool {
  lines: Line[];
  banks: string[];
  motive: boolean;
}

export const emptyPool = (): Pool => ({ lines: [], banks: [], motive: false });

function readCondition(reader: Reader, value: unknown, path: string): LineCondition {
  const raw = reader.object(value, path);
  reader.onlyKeys(raw, path, CONDITION_KEYS);
  const out: LineCondition = {};
  for (const key of CONDITION_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    out[key] = typeof v === "string" ? [v] : reader.stringList(raw, key, path);
  }
  return out;
}

function readLine(reader: Reader, value: unknown, path: string): Line {
  if (typeof value === "string") return { text: value, weight: 1, when: null };
  const raw = reader.object(value, path);
  reader.onlyKeys(raw, path, ["text", "weight", "when"]);
  // An empty text is allowed: it is the line that says nothing.
  const text = raw.text === "" ? "" : reader.string(raw, "text", path);
  return { text, weight: reader.optionalNumber(raw, "weight", path, 1, { min: 0 }), when: raw.when === undefined ? null : readCondition(reader, raw.when, `${path}.when`) };
}

/** A pool from a text, or a list of texts and `{ text, weight, when }` lines; `"$name"` draws on a
 *  voice bank, and `"$motive"` (offers only) is where the motives go. */
export function readPool(reader: Reader, value: unknown, path: string): Pool {
  const pool = emptyPool();
  const items = value === undefined ? [] : Array.isArray(value) ? value : [value];
  items.forEach((item, i) => {
    const at = Array.isArray(value) ? `${path}[${i}]` : path;
    if (typeof item === "string" && item.startsWith("$")) {
      if (item === "$motive") pool.motive = true;
      else pool.banks.push(item.slice(1));
    } else pool.lines.push(readLine(reader, item, at));
  });
  return pool;
}

const poolAt = (reader: Reader, obj: RawObject, key: string, path: string): Pool => readPool(reader, obj[key], path ? `${path}.${key}` : key);

// --- parts ---

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
  motive: Pool;
  /** What the quest item it hands over or asks for is called, drawn from, with `{npcGiven}` the person
   *  it is about (the one it is delivered to, the one who gave it): "Letter for {npcGiven}". */
  itemName: Pool;
}

// --- plots and segments ---

/** A person a quest needs (the giver aside): by role, perhaps related to the giver, else made new. */
export interface PlotPerson {
  roles: string[];
  /** What the giver calls them: one of these ("sister", "friend"), else anyone of the roles. */
  relation: string[] | null;
  /** A role made new where nobody fits - a quest person (QUESTS.md, *Quest people*) - living at
   *  the plot's place, if the place has room for one of these. */
  make: string[];
  /** Someone who is no longer there (a twist): one of the settlement's people who stay at home,
   *  named in the text and never met, so no objective can be about them. */
  gone: boolean;
}

export interface PlotQuest {
  /** The person who gives it and the one who ends it, by the plot's name for them. A segment that
   *  names neither takes up where the quest before left off. */
  giver: string | null;
  ender: string | null;
  parts: { part: string; npc: string | null; item: string | null; /** Its log line in place of the part's. */ line: string | null; /** Its item's names in place of the part's. */ itemName: Pool | null; /** A drop's chance, in place of the part's. */ chance: number | null }[];
  title: Pool;
  /** The offer, about five sentences: a pool for each, one line drawn from it. */
  offer: Pool[];
  progress: Pool;
  done: Pool;
  /** An item to choose for the reward. */
  choice: boolean;
  /** What that item may be (QUESTS.md, *Item choices*): `only` lists the item kinds ("weapon", "armour")
   *  or templates ("sword", "boots") it may be, `not` those it may not. Empty for anything. */
  reward: { only: string[]; not: string[] };
  /** What the chain has when this quest is given (set when a plot is put together from segments). */
  tags: string[];
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
  /** Segments to put together in this order, in place of `quests`. */
  segments: string[] | null;
  /** A chain drawn from the segments of these themes, between `min` and `max` quests (the intro's
   *  story: a different one in each world), in place of `quests`. `more` is how likely each next
   *  segment is once it could end; the rules' otherwise. */
  draw: { themes: string[]; min: number; max: number; more: number | null } | null;
}

export const SEGMENT_ROLES = ["opener", "middle", "closer"] as const;
export type SegmentRole = (typeof SEGMENT_ROLES)[number];

/** One quest of a chain that fits with others by tags (QUESTS.md, *Segments*). */
export interface QuestSegmentDef {
  id: string;
  weight: number;
  /** Whether chains drawn on their own may use it. Not for a story only a plot's `draw` tells. */
  free: boolean;
  /** Where it can stand: first in a chain, between, or last. A quest that is both opener and closer
   *  can stand alone. */
  roles: SegmentRole[];
  /** What a chain is about. A segment follows one only if they share a theme, or either has none. */
  theme: string[];
  /** Tags the chain must already have. */
  requires: string[];
  /** Tags the chain must not have: a branch that shuts out another. */
  forbids: string[];
  /** Tags it adds. */
  provides: string[];
  /** Names it needs bound by now: a person of an earlier segment, `beast`, `place`, `road`. */
  uses: string[];
  /** Who can give an opener, by role. */
  giver: string[];
  people: Record<string, PlotPerson>;
  creatures: CreatureNeed | null;
  place: PlaceNeed | null;
  road: boolean;
  quest: PlotQuest;
}

/** A bank of lines for one slot of how people talk (`hook`, `promise`, `progress`, `thanks`...). */
export interface QuestVoiceDef {
  id: string;
  slot: string;
  lines: Line[];
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
  reader.onlyKeys(raw, at, ["hostility", "family", "tags"]);
  return { hostility: raw.hostility === undefined ? null : reader.stringList(raw, "hostility", at), family: raw.family === undefined ? null : reader.stringList(raw, "family", at), tags: raw.tags === undefined ? null : reader.stringList(raw, "tags", at) };
}

function readPlaceNeed(reader: Reader, obj: RawObject, key: string, path: string): PlaceNeed | null {
  if (obj[key] === undefined) return null;
  const at = path ? `${path}.${key}` : key;
  const raw = reader.object(obj[key], at);
  reader.onlyKeys(raw, at, ["tags", "objects", "not"]);
  const not = strings(reader, raw, "not", at);
  // Excluding some objects means asking for objects.
  return { tags: strings(reader, raw, "tags", at), objects: raw.objects === undefined ? (not.length > 0 ? [] : null) : strings(reader, raw, "objects", at), not };
}

function readPeople(reader: Reader, obj: RawObject): Record<string, PlotPerson> {
  const people: Record<string, PlotPerson> = {};
  if (obj.people === undefined) return people;
  const raw = reader.object(obj.people, "people");
  for (const name of Object.keys(raw)) {
    const at = `people.${name}`;
    const p = reader.object(raw[name], at);
    reader.onlyKeys(p, at, ["roles", "relation", "make", "gone"]);
    people[name] = { roles: strings(reader, p, "roles", at), relation: p.relation === undefined ? null : strings(reader, p, "relation", at), make: strings(reader, p, "make", at), gone: reader.boolean(p, "gone", at, false) };
  }
  return people;
}

function readPlotQuest(reader: Reader, value: unknown, at: string, parts: ReadonlyMap<string, QuestPartDef>, names: ReadonlySet<string>, resolve: boolean): PlotQuest {
  const q = reader.object(value, at);
  reader.onlyKeys(q, at, ["giver", "ender", "parts", "title", "offer", "progress", "done", "choice", "reward"]);
  let giver: string | null = reader.optionalString(q, "giver", at) ?? null;
  let ender: string | null = reader.optionalString(q, "ender", at) ?? null;
  if (resolve) {
    giver ??= "giver";
    ender ??= giver;
  }
  for (const [key, who] of [["giver", giver], ["ender", ender]] as const) if (who !== null && !names.has(who)) reader.fail(`${at}.${key}`, `no person "${who}" here (${[...names].join(", ")})`);
  const questParts = reader.array(q, "parts", at).map((p, j) => {
    const pat = `${at}.parts[${j}]`;
    const raw = typeof p === "string" ? { part: p } : reader.object(p, pat);
    reader.onlyKeys(raw, pat, ["part", "npc", "item", "line", "itemName", "chance"]);
    const part = reader.string(raw, "part", pat);
    if (!parts.has(part)) reader.fail(`${pat}.part`, `no quest part "${part}"`);
    const npc = reader.optionalString(raw, "npc", pat) ?? null;
    if (npc && !names.has(npc)) reader.fail(`${pat}.npc`, `no person "${npc}" here`);
    return { part, npc, item: reader.optionalString(raw, "item", pat) ?? null, line: reader.optionalString(raw, "line", pat) ?? null, itemName: raw.itemName === undefined ? null : readPool(reader, raw.itemName, `${pat}.itemName`), chance: raw.chance === undefined ? null : reader.number(raw, "chance", pat, { min: 0, max: 1 }) };
  });
  const offer = reader.array(q, "offer", at).map((group, j) => readPool(reader, group, `${at}.offer[${j}]`));
  const rewardRaw = q.reward === undefined ? {} : reader.object(q.reward, `${at}.reward`);
  reader.onlyKeys(rewardRaw, `${at}.reward`, ["only", "not"]);
  const reward = { only: strings(reader, rewardRaw, "only", `${at}.reward`), not: strings(reader, rewardRaw, "not", `${at}.reward`) };
  return { giver, ender, parts: questParts, title: poolAt(reader, q, "title", at), offer, progress: poolAt(reader, q, "progress", at), done: poolAt(reader, q, "done", at), choice: reader.boolean(q, "choice", at, false), reward, tags: [] };
}

export function readQuestParts(entries: readonly { id: string; file: string; data: unknown }[], issues: ContentIssue[]): QuestPartDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["kind", "count", "chance", "below", "item", "line", "motive", "itemName"]);
    const kind = reader.oneOf(obj, "kind", "", PART_KINDS);
    const count: [number, number] = obj.count === undefined ? [1, 1] : typeof obj.count === "number" ? [obj.count, obj.count] : reader.range(obj, "count", "", { allowEqual: true });
    if ((kind === "receive" || kind === "use" || kind === "deliver" || kind === "drop") && obj.item === undefined) reader.fail("item", `a ${kind} part names its item`);
    return {
      id: entry.id,
      kind,
      count,
      chance: reader.optionalNumber(obj, "chance", "", 1, { min: 0, max: 1 }),
      below: reader.optionalNumber(obj, "below", "", 1, { min: 0, max: 1 }),
      item: reader.optionalString(obj, "item", "") ?? null,
      line: reader.string(obj, "line", ""),
      motive: poolAt(reader, obj, "motive", ""),
      itemName: poolAt(reader, obj, "itemName", ""),
    };
  });
}

export function readQuestSegments(entries: readonly { id: string; file: string; data: unknown }[], parts: ReadonlyMap<string, QuestPartDef>, issues: ContentIssue[]): QuestSegmentDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["weight", "free", "roles", "theme", "requires", "forbids", "provides", "uses", "giver", "people", "creatures", "place", "road", "quest"]);
    const people = readPeople(reader, obj);
    const uses = strings(reader, obj, "uses", "");
    const road = reader.boolean(obj, "road", "", false);
    const roles = strings(reader, obj, "roles", "").filter((r): r is SegmentRole => {
      const ok = (SEGMENT_ROLES as readonly string[]).includes(r);
      if (!ok) reader.fail("roles", `"${r}" is not one of ${SEGMENT_ROLES.join(", ")}`);
      return ok;
    });
    if (roles.length === 0) reader.fail("roles", "a segment says where it can stand: opener, middle or closer");
    // Who its quest can be about: its own people and what it uses, the giver, and the road. Not
    // those who are gone: they are only spoken of.
    const names = new Set(["giver", ...Object.keys(people).filter((n) => !people[n].gone), ...uses, ...(road ? ["road"] : [])]);
    const giver = strings(reader, obj, "giver", "");
    if (roles.includes("opener") && giver.length === 0) reader.fail("giver", "an opener says who can give it, by role");
    return {
      id: entry.id,
      weight: reader.optionalNumber(obj, "weight", "", 1, { min: 0 }),
      free: reader.boolean(obj, "free", "", true),
      roles,
      theme: strings(reader, obj, "theme", ""),
      requires: strings(reader, obj, "requires", ""),
      forbids: strings(reader, obj, "forbids", ""),
      provides: strings(reader, obj, "provides", ""),
      uses,
      giver,
      people,
      creatures: readCreatureNeed(reader, obj, "creatures", ""),
      place: readPlaceNeed(reader, obj, "place", ""),
      road,
      quest: readPlotQuest(reader, obj.quest, "quest", parts, names, false),
    };
  });
}

export function readQuestPlots(entries: readonly { id: string; file: string; data: unknown }[], parts: ReadonlyMap<string, QuestPartDef>, segments: ReadonlyMap<string, QuestSegmentDef>, issues: ContentIssue[]): QuestPlotDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["weight", "intro", "giver", "people", "creatures", "place", "road", "quests", "segments", "draw"]);
    const people = readPeople(reader, obj);
    const names = new Set(["giver", ...Object.keys(people).filter((n) => !people[n].gone), "road"]);
    const list = obj.segments === undefined ? null : reader.stringList(obj, "segments", "");
    if (list) for (const id of list) if (!segments.has(id)) reader.fail("segments", `no quest segment "${id}"`);
    let draw: QuestPlotDef["draw"] = null;
    if (obj.draw !== undefined) {
      const raw = reader.object(obj.draw, "draw");
      reader.onlyKeys(raw, "draw", ["themes", "min", "max", "more"]);
      const themes = reader.stringList(raw, "themes", "draw");
      for (const theme of themes) if (![...segments.values()].some((seg) => seg.theme.includes(theme))) reader.fail("draw.themes", `no quest segment has the theme "${theme}"`);
      const min = reader.optionalNumber(raw, "min", "draw", 1, { min: 1, integer: true });
      const max = reader.optionalNumber(raw, "max", "draw", 4, { min: 1, integer: true });
      if (max < min) reader.fail("draw.max", "at least as many as min");
      draw = { themes, min, max, more: raw.more === undefined ? null : reader.optionalNumber(raw, "more", "draw", 0.5, { min: 0, max: 1 }) };
    }
    if ((list || draw) && obj.quests !== undefined) reader.fail("quests", "a plot has quests, segments or a draw, only one");
    if (list && draw) reader.fail("draw", "a plot has quests, segments or a draw, only one");
    const quests = list || draw ? [] : reader.array(obj, "quests", "").map((value, i) => readPlotQuest(reader, value, `quests[${i}]`, parts, names, true));
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
      segments: list,
      draw,
    };
  });
}

export function readQuestVoices(entries: readonly { id: string; file: string; data: unknown }[], issues: ContentIssue[]): QuestVoiceDef[] {
  return entries.map((entry) => {
    const reader = new Reader(issues, entry.file);
    const obj = reader.object(entry.data, "");
    reader.onlyKeys(obj, "", ["slot", "lines"]);
    return { id: entry.id, slot: reader.string(obj, "slot", ""), lines: reader.array(obj, "lines", "").map((v, i) => readLine(reader, v, `lines[${i}]`)) };
  });
}

/** Every pool a quest draws on, for checking its banks exist. */
export function poolsOf(quest: PlotQuest): Pool[] {
  return [quest.title, ...quest.offer, quest.progress, quest.done];
}
