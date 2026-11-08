import { deriveSeed, mulberry32 } from "../../world/rng";
import { hashString } from "../../world/content/dimensions";
import type { SettlementLayout } from "../../world/settlements/settlementLayout";
import type { SettlementSite } from "../../world/settlements/settlementSites";
import type { QuestPlaceDef } from "../../world/features/featureTypes";
import type { Text } from "../text";
import type { GameRules } from "../rules/gameRules";
import type { ItemRules } from "../rules/itemRules";
import { addPerson, type Cast, type CastInput, type CastNpc } from "../npcs/cast";
import type { Objective, QuestDef } from "./quest";
import type { CreatureNeed, LineCondition, PlaceNeed, Pool, QuestPlotDef, QuestSegmentDef } from "./plots";
import { composeChain, themeFits } from "./chains";

/**
 * The quest generator (QUESTS.md, *The generator*): a settlement's quests, put together from the
 * packs' plots and parts and what is around it - its people and their relations, its zone's
 * creatures and level, the places near it and what they offer, the road to the next settlement. A
 * pure function of the seed, the settlement and its context, worked out with its cast; the quest
 * people it needs are added to the cast as it goes.
 */

/** A creature kind of the zone: what the quests can ask to hunt. */
export interface ContextCreature {
  id: string;
  name: string;
  /** Added to the zone's band for its level (CREATURES.md). */
  levelOffset: number;
  hostility: string;
  family: string;
  /** What it is like (CREATURES.md): "furred", "venomous". */
  tags: readonly string[];
}

/** A place near the settlement that quests can use. */
export interface ContextPlace {
  name: string;
  x: number;
  z: number;
  radius: number;
  quest: QuestPlaceDef;
}

/** Another settlement down the road. */
export interface ContextSettlement {
  name: string;
  distance: number;
  /** Its reeve (or anyone out), to be sent to. */
  npc: CastNpc | null;
}

/**
 * What the world's quests have used so far, shared by every settlement's generation as a dimension
 * loads, in `questOrder`: how many quests use each place, object and creature kind, and where the
 * objectives lie. What the generator weighs by (QUESTS.md, *Weighting*).
 */
export interface WorldQuestState {
  /** Uses by key: "place:x,z", "object:x,z/name", "kind:zone/kind". */
  uses: Map<string, number>;
  /** Where each objective so far lies: a place for gathering and going, the settlement for hunting. */
  anchors: { x: number; z: number }[];
}

export const createWorldQuestState = (): WorldQuestState => ({ uses: new Map(), anchors: [] });

export interface GeneratorInput {
  cast: Cast;
  castInput: Pick<CastInput, "seed" | "dimension" | "site" | "layout" | "voices" | "rules">;
  site: SettlementSite;
  layout: SettlementLayout;
  zone: string;
  levels: [number, number];
  creatures: ContextCreature[];
  places: ContextPlace[];
  others: ContextSettlement[];
  /** The starting place's intro plots, in order, for a starting settlement (NPCS.md). */
  intro: string[];
  folk: string;
  rules: GameRules;
  items: ItemRules | null;
  /** What earlier settlements' quests have used; this one's are added as they are made. */
  world: WorldQuestState;
}

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length];
const between = (rng: Rng, [lo, hi]: readonly [number, number]): number => lo + Math.floor(rng() * (hi - lo + 1));

const GENERATOR_SALT = 31_337;
const ORDER_SALT = 41_011;

/**
 * The order a dimension's settlements' quests are made in, all together as it loads (QUESTS.md,
 * *The generator*): shuffled by the seed, so no settlement always gets the first pick of what the
 * world has, and the same whatever order the settlements are listed in.
 */
export function questOrder(seed: number, dimension: string, siteIds: readonly number[]): number[] {
  const key = (id: number): number => deriveSeed(seed, ORDER_SALT + hashString(dimension) * 17 + id);
  return [...siteIds].sort((a, b) => key(a) - key(b) || a - b);
}

/** `[this|that|]`: one of the alternatives is said, one of them perhaps nothing. */
const ALTERNATIVES = /\[([^\[\]|]*(?:\|[^\[\]|]*)+)\]/g;
const vary = (rng: Rng, text: string): string => text.replace(ALTERNATIVES, (_, inner: string) => pick(rng, inner.split("|")));
const tidy = (text: string): string => text.replace(/ {2,}/g, " ").replace(/ ([.,!?;:])/g, "$1").trim();

/** Who is speaking, and what the quest is about: what a line's `when` is held against. */
interface LineContext {
  mood: string;
  role: string;
  sex: string;
  age: string;
  place: readonly string[];
  object: readonly string[];
  creature: readonly string[];
  tags: readonly string[];
  tier: string;
}

function matches(when: LineCondition | null, ctx: LineContext): boolean {
  if (!when) return true;
  for (const key of Object.keys(when) as (keyof LineCondition)[]) {
    const want = when[key]!;
    const have = ctx[key];
    if (!want.some((w) => (typeof have === "string" ? have === w : have.includes(w)))) return false;
  }
  return true;
}

export function generateQuests(input: GeneratorInput): QuestDef[] {
  const { cast, rules, site, layout } = input;
  const q = rules.quests;
  const rng = mulberry32(deriveSeed(input.castInput.seed, GENERATOR_SALT + hashString(input.castInput.dimension) * 17 + site.id));
  const quests: QuestDef[] = [];
  const out = cast.npcs.filter((n) => n.out);
  const roleOf = (id: string | null) => (id === null ? undefined : rules.npcs.roles[rules.npcs.roleIndex.get(id) ?? -1]);
  /** How many quest lines each NPC gives: no more than two each. */
  const lines = new Map<number, number>();
  const usedPlots = new Set<string>();
  /** Sentences already said in this settlement's quests: a line is drawn fresh where one is left. */
  const usedLines = new Set<string>();
  /** A quest's level: the middle of the zone's band, and for a quest about creatures, as they stand -
   *  the band's middle plus their kind's offset, so a quest is never far below what it sends you to fight. */
  const level = (beast: ContextCreature | null): number => Math.round((input.levels[0] + input.levels[1]) / 2) + (beast?.levelOffset ?? 0);
  const plural = (name: string): string => {
    const words = name.split(" ");
    const last = words[words.length - 1];
    return [...words.slice(0, -1), q.plurals[last] ?? `${last}s`].join(" ");
  };
  // The fields outside the settlement: a place every settlement has.
  const gate = layout.gates[0];
  const fieldsAt = gate ? { x: layout.x + (gate.x - layout.x) * 1.6, z: layout.z + (gate.z - layout.z) * 1.6 } : { x: layout.x + layout.radius * 1.5, z: layout.z };
  const places: ContextPlace[] = [...input.places, { name: site.name, ...fieldsAt, radius: 25, quest: { tags: ["fields", "open"], objects: q.fields.objects, people: [], text: q.fields.text } }];

  const creatureFits = (need: CreatureNeed | null) => (c: ContextCreature): boolean => !need || ((!need.hostility || need.hostility.includes(c.hostility)) && (!need.family || need.family.includes(c.family)) && (!need.tags || need.tags.every((t) => c.tags.includes(t))));
  /** An object of a place that a need allows: it has all the tags asked and none that are shut out. */
  const objectFits = (need: PlaceNeed) => (o: { tags: readonly string[] }): boolean => (need.objects ?? []).every((t) => o.tags.includes(t)) && !need.not.some((t) => o.tags.includes(t));
  const placeFits = (need: PlaceNeed | null) => (p: ContextPlace): boolean => !need || (need.tags.every((t) => p.quest.tags.includes(t)) && (need.objects === null || p.quest.objects.some(objectFits(need))));

  // --- weights (QUESTS.md, *Weighting*) ---
  const wt = q.weighting;
  const world = input.world;
  /** Uses in this settlement, by the same keys as the world's. */
  const here = new Map<string, number>();
  const placeKey = (p: { x: number; z: number }): string => `place:${Math.round(p.x)},${Math.round(p.z)}`;
  const objectKey = (p: ContextPlace, name: string): string => `object:${Math.round(p.x)},${Math.round(p.z)}/${name}`;
  const kindKey = (c: ContextCreature): string => `kind:${site.areaId}/${c.id}`;
  const reuse = (key: string, k: { here: number; elsewhere: number }): number => {
    const mine = here.get(key) ?? 0;
    return 1 / (1 + k.here * mine + k.elsewhere * ((world.uses.get(key) ?? 0) - mine));
  };
  const crowded = (p: { x: number; z: number }): number => world.anchors.reduce((n, a) => n + (Math.hypot(a.x - p.x, a.z - p.z) <= wt.crowding.radius ? 1 : 0), 0);
  /** How likely a place is: near, little used, and not crowded with objectives. */
  const placeScore = (p: ContextPlace): number => (1 / (1 + (Math.hypot(p.x - site.x, p.z - site.z) / wt.distance) ** 2)) * reuse(placeKey(p), wt.reuse) * (1 / (1 + wt.crowding.each * crowded(p)));
  const kindScore = (c: ContextCreature): number => reuse(kindKey(c), wt.kind);
  /** One of a list by the score of each (evenly if all score nothing). */
  function pickBy<T>(rng: Rng, list: readonly T[], score: (item: T) => number): T {
    const weights = list.map(score);
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0) return pick(rng, list);
    let roll = rng() * total;
    return list.find((_, i) => (roll -= weights[i]) < 0) ?? list[list.length - 1];
  }
  /** Notes what a plot's quests used, for the ones drawn after (in this settlement and the world). */
  function record(place: ContextPlace | null, beast: ContextCreature | null, object: { name: string } | undefined, objectives: readonly Objective[]): void {
    const bump = (key: string): void => {
      here.set(key, (here.get(key) ?? 0) + 1);
      world.uses.set(key, (world.uses.get(key) ?? 0) + 1);
    };
    if (place) bump(placeKey(place));
    if (place && object) bump(objectKey(place, object.name));
    if (beast) bump(kindKey(beast));
    for (const o of objectives) {
      if (o.kind === "gather" || o.kind === "reach") world.anchors.push({ x: o.area.x, z: o.area.z });
      else if (o.kind === "kill" || o.kind === "loot" || o.kind === "use") world.anchors.push({ x: layout.x, z: layout.z });
    }
  }

  /** One line of a pool, by weight, among those that fit the speaker and the quest - its own and its
   *  voice banks' - and fresh if any is. The line's `[a|b]` alternatives are drawn. "" if none fits. */
  function pickLine(local: Rng, pool: Pool, ctx: LineContext): string {
    const all = [...pool.lines, ...pool.banks.flatMap((bank) => q.voices.get(bank) ?? [])];
    let fits = all.filter((l) => matches(l.when, ctx));
    if (fits.length === 0) fits = all.filter((l) => !l.when);
    const fresh = fits.filter((l) => l.text === "" || !usedLines.has(l.text));
    const from = fresh.length > 0 ? fresh : fits;
    if (from.length === 0) return "";
    let roll = local() * from.reduce((sum, l) => sum + l.weight, 0);
    const line = from.find((l) => (roll -= l.weight) < 0) ?? from[0];
    usedLines.add(line.text);
    return vary(local, line.text);
  }

  /** One plot drawn into quests, or null when the settlement cannot fill it. */
  function draw(plot: QuestPlotDef, after: string | null): QuestDef[] | null {
    const local = mulberry32(deriveSeed(rng() * 4294967296, hashString(plot.id)));
    // The intro may ask anyone as often as it needs; other plots spread their givers.
    const givers = out.filter((n) => n.role !== null && plot.giver.includes(n.role) && (plot.intro || (lines.get(n.index) ?? 0) < 2));
    if (givers.length === 0) return null;
    const giver = pick(local, givers);
    const creature = plot.creatures ? input.creatures.filter(creatureFits(plot.creatures)) : [];
    if (plot.creatures && creature.length === 0) return null;
    const beast = creature.length > 0 ? pickBy(local, creature, kindScore) : null;
    const placeList = plot.place ? places.filter(placeFits(plot.place)) : [];
    if (plot.place && placeList.length === 0) return null;
    const place = placeList.length > 0 ? pickBy(local, placeList, placeScore) : null;
    const other = plot.road ? input.others.find((o) => o.npc) : undefined;
    if (plot.road && !other) return null;
    // Its people: the giver's relations first, then anyone of the roles, then someone made new.
    const people = new Map<string, CastNpc>([["giver", giver]]);
    if (other?.npc) people.set("road", other.npc);
    for (const [name, want] of Object.entries(plot.people)) {
      const taken = new Set([...people.values()].map((p) => p.index));
      if (want.gone) {
        // Someone who stays at home, spoken of and never met: a relative of the giver's if there is one.
        const home = cast.npcs.filter((n) => !n.out && !taken.has(n.index));
        const kin = giver.relations.map((r) => cast.npcs[r.to]).filter((n) => !n.out && !taken.has(n.index));
        const gone = kin.length > 0 ? pick(local, kin) : home.length > 0 ? pick(local, home) : undefined;
        if (!gone) return null;
        people.set(name, gone);
        continue;
      }
      const related = want.relation ? giver.relations.filter((r) => want.relation!.includes(r.call)).map((r) => cast.npcs[r.to]).filter((n) => n.out && !taken.has(n.index) && (want.roles.length === 0 || (n.role !== null && want.roles.includes(n.role)))) : [];
      const anyone = out.filter((n) => !taken.has(n.index) && n.role !== null && want.roles.includes(n.role));
      let person = related[0] ?? (anyone.length > 0 ? pick(local, anyone) : undefined);
      if (!person && want.make.length > 0) {
        const role = want.make.map(roleOf).find((r) => r && (!place || place.quest.people.length === 0 || place.quest.people.includes(r.id)));
        if (role) {
          const at = place ? { x: place.x + (local() - 0.5) * place.radius, z: place.z + (local() - 0.5) * place.radius } : { x: layout.square.x, z: layout.square.z };
          person = addPerson(cast, input.castInput, role, at, hashString(`${plot.id}/${name}`) + quests.length);
        }
      }
      if (!person) return null;
      people.set(name, person);
    }
    const objectsHere = place ? place.quest.objects.filter(plot.place ? objectFits(plot.place) : () => true) : [];
    const object = place ? pickBy(local, objectsHere.length > 0 ? objectsHere : place.quest.objects, (o) => reuse(objectKey(place, o.name), wt.reuse)) : undefined;
    const placeName = place ? place.quest.text.replace("{name}", place.name) : "";
    const lvl = level(beast);
    // The arguments every text of the plot can use.
    // Someone else in the settlement the giver might speak of, and when it happened.
    const involved = new Set([...people.values()].map((p) => p.index));
    const neighbours = out.filter((n) => !involved.has(n.index));
    const neighbour = neighbours.length > 0 ? pick(local, neighbours) : undefined;
    const args: Record<string, string | number> = { settlement: site.name, zone: input.zone, giver: giver.name, giverGiven: giver.given, place: placeName, object: object?.name ?? "", objects: object ? plural(object.name) : "", creature: beast?.name ?? "", creatures: beast ? plural(beast.name) : "", other: other?.name ?? "", neighbour: neighbour?.given ?? "a neighbour", neighbourFamily: neighbour?.family ?? "the neighbours", when: q.whens.length > 0 ? pick(local, q.whens) : "lately" };
    for (const [name, person] of people) {
      args[name] = person.name;
      args[`${name}Given`] = person.given;
      args[`${name}Title`] = person.title;
      args[`${name}Sex`] = person.sex;
    }
    const speaking = (who: CastNpc, tags: readonly string[]): LineContext => ({ mood: who.mood, role: who.role ?? "", sex: who.sex, age: who.age, place: place?.quest.tags ?? [], object: object?.tags ?? [], creature: beast ? [beast.family, ...beast.tags] : [], tags, tier: site.tier });
    /** What a quest asks of the player, in kill-equivalents (QUESTS.md, *Rewards*): its objectives, and
     *  the walking to the farthest place or person - out and back, but one way to the next settlement. */
    const effortOf = (objectives: readonly Objective[]): number => {
      const e = q.effort;
      const person = (npcId: string): CastNpc | undefined => [...people.values()].find((p) => p.id === npcId);
      const away = (npcId: string): { metres: number; oneWay: boolean } => {
        if (other?.npc?.id === npcId) return { metres: other.distance, oneWay: true };
        const spot = person(npcId)?.spot;
        return { metres: spot ? Math.hypot(spot.x - layout.x, spot.z - layout.z) : 0, oneWay: false };
      };
      const hard = 1 + e.levelOffset * Math.max(0, beast?.levelOffset ?? 0);
      let units = 0;
      let metres = 0;
      let oneWay = false;
      const go = (to: { metres: number; oneWay: boolean }): void => {
        if (to.metres > metres) {
          metres = to.metres;
          oneWay = to.oneWay;
        }
      };
      for (const o of objectives) {
        switch (o.kind) {
          case "kill": units += o.count * e.kill * hard; break;
          case "loot": units += (o.count / Math.max(0.05, o.chance)) * e.loot * hard; break;
          case "use": units += o.count * e.use; break;
          case "gather": units += o.count * e.gather; go({ metres: Math.hypot(o.area.x - layout.x, o.area.z - layout.z), oneWay: false }); break;
          case "reach": units += e.reach; go({ metres: Math.hypot(o.area.x - layout.x, o.area.z - layout.z), oneWay: false }); break;
          case "talk": units += e.talk; go(away(o.npc)); break;
          case "receive": units += e.talk; go(away(o.from)); break;
          case "deliver": units += e.talk; go(away(o.to)); break;
        }
      }
      return Math.max(0.25, units + ((oneWay ? metres : metres * 2) / 100) * e.travel);
    };
    const t = (text: string): Text => ({ text, args });
    const id = (n: number): string => `q:${input.castInput.dimension}/${site.id}/${quests.length + n}`;
    const made: QuestDef[] = [];
    plot.quests.forEach((pq, n) => {
      const objectives: Objective[] = [];
      const motives: string[] = [];
      const giverNpc = people.get(pq.giver!)!;
      const ender = people.get(pq.ender!)!;
      const asked = speaking(giverNpc, pq.tags);
      for (const ref of pq.parts) {
        const part = rules.quests.parts.get(ref.part)!;
        const count = between(local, part.count);
        const who = ref.npc ? people.get(ref.npc) : undefined;
        const item = ref.item ?? part.item ?? "";
        const line = (extra: Record<string, string | number>): Text => ({ text: ref.line ?? part.line, args: { ...args, ...extra } });
        const filter = beast ? { kinds: [beast.id], name: t("{creatures}") } : { kinds: [], name: t("") };
        const area = place ? { dimension: input.castInput.dimension, x: place.x, z: place.z, radius: place.radius } : { dimension: input.castInput.dimension, x: fieldsAt.x, z: fieldsAt.z, radius: 25 };
        const motive = pickLine(local, part.motive, asked);
        if (motive) motives.push(motive);
        switch (part.kind) {
          case "talk":
            objectives.push({ kind: "talk", npc: who?.id ?? giver.id, line: line({ npc: who?.name ?? giver.name }) });
            break;
          case "kill":
            objectives.push({ kind: "kill", creatures: filter, count, line: line({ count }) });
            break;
          case "loot":
            objectives.push({ kind: "loot", from: filter, count, chance: part.chance, line: line({ count }) });
            break;
          case "gather":
            objectives.push({ kind: "gather", object: object?.name ?? "", count, area, line: line({ count }) });
            break;
          case "receive":
            objectives.push({ kind: "receive", item, from: who?.id ?? giver.id, line: line({ npc: who?.name ?? giver.name, item: itemName(item) }) });
            break;
          case "use":
            objectives.push({ kind: "use", item, on: filter, below: part.below, count, line: line({ count, item: itemName(item) }) });
            break;
          case "deliver":
            objectives.push({ kind: "deliver", item, to: who?.id ?? giver.id, line: line({ npc: who?.name ?? giver.name, item: itemName(item) }) });
            break;
          case "reach":
            objectives.push({ kind: "reach", area, line: line({}) });
            break;
        }
      }
      // The offer: a line from each group, the parts' motives where the plot says, in the giver's voice.
      const sentences = pq.offer.flatMap((group) => (group.motive ? motives : [pickLine(local, group, asked)]));
      const offer = tidy(sentences.filter((sentence) => sentence !== "").join(" "));
      const title = tidy(pickLine(local, pq.title, asked)) || "A Task";
      const answering = speaking(ender, pq.tags);
      const progress = tidy(pickLine(local, pq.progress, answering)) || "Well?";
      const done = tidy(pickLine(local, pq.done, answering)) || "My thanks.";
      const effort = effortOf(objectives);
      const xp = Math.round(effort * (q.xp.base + q.xp.perLevel * lvl) * q.xp.rate);
      const previous = n === 0 ? after : made[n - 1].id;
      made.push({
        id: id(n),
        level: lvl,
        giver: giverNpc.id,
        ender: ender.id,
        chain: plot.quests.length > 1 ? { id: `${id(0)}#${plot.id}`, index: n + 1, of: plot.quests.length } : null,
        // Only the first quest of a chain asks a level, and not the intro's, which is for a character just made: the rest ask
        // the one before, so a story is never stuck for want of XP.
        requires: { quests: previous ? [previous] : [], level: n === 0 && !plot.intro ? Math.max(1, lvl - 2) : 1 },
        objectives,
        ordered: true,
        text: { title: t(title), offer: { text: offer, args }, progress: t(progress), done: t(done) },
        rewards: {
          xp,
          money: Math.max(1, Math.round(effort * (q.money.base + q.money.perLevel * lvl))),
          choice: pq.choice ? rewardChoice(local, lvl, plot.quests.length > 1 && n === plot.quests.length - 1) : [],
          items: [],
          standing: [{ faction: input.folk, amount: q.standing }],
        },
        within: 0,
        where: [],
      });
    });
    // A chain's last quest also pays a share of what the rest of it paid.
    if (made.length > 1) {
      const rest = made.slice(0, -1);
      const finale = made[made.length - 1].rewards;
      finale.xp += Math.round(q.finale * rest.reduce((sum, m) => sum + m.rewards.xp, 0));
      finale.money += Math.round(q.finale * rest.reduce((sum, m) => sum + m.rewards.money, 0));
    }
    lines.set(giver.index, (lines.get(giver.index) ?? 0) + 1);
    usedPlots.add(plot.id);
    record(place, beast, object, made.flatMap((m) => m.objectives));
    return made;
  }

  function itemName(id: string): string {
    return input.items?.types[input.items.typeIndex.get(id) ?? -1]?.name ?? id;
  }

  /**
   * A choice of items for a quest's reward (QUESTS.md, *Rewards*): `rewardChoices` of them, balanced.
   * Every option is of one rarity - the best that all the templates it draws on have, up to the one
   * aimed for (a chain's last quest aims higher) - and about the quest's level, so none is simply
   * better. The kinds (weapon, armour) go round: the one offered least so far in the world comes first
   * and again, so the quests of an area do not all give a sword; within a kind, the template used
   * least, and the type used least. No type twice in a choice.
   */
  function rewardChoice(local: Rng, lvl: number, finale: boolean): string[] {
    const items = input.items;
    if (!items) return [];
    const aim = items.rarities.find((r) => r.id === (finale ? q.rewardRarity.finale : q.rewardRarity.quest))?.order ?? Infinity;
    const used = (key: string): number => world.uses.get(key) ?? 0;
    const bump = (key: string): void => void world.uses.set(key, used(key) + 1);
    /** A template's types about the quest's level. */
    const nearLevel = (template: string) => (items.generated.get(template) ?? []).map((i) => items.types[i]).filter((t) => t.itemLevel <= lvl + 2 && t.itemLevel >= lvl - 4);
    const templates = q.rewardTemplates.map((id) => ({ id, types: nearLevel(id) })).filter((t) => t.types.length > 0);
    if (templates.length === 0) return [];
    // The rarity every template can offer, up to the one aimed for.
    const best = Math.min(...templates.map((t) => Math.max(...t.types.map((x) => items.rarities[x.rarity].order).filter((o) => o <= aim), -Infinity)));
    const rarity = Number.isFinite(best) ? best : Math.min(...templates.flatMap((t) => t.types.map((x) => items.rarities[x.rarity].order)));
    // The level every option aims for: the lowest of the levels each template comes nearest the quest's
    // at, so no option is a tier above another where the templates' tiers differ.
    const nearest = (types: readonly { itemLevel: number }[], to: number): number => types.map((x) => x.itemLevel).sort((a, b) => Math.abs(a - to) - Math.abs(b - to) || a - b)[0];
    const level = Math.min(...templates.map((t) => nearest(t.types, lvl)));
    // Kinds, the least offered first; ties by the draw.
    const kindOf = (id: string): string => items.types[items.generated.get(id)?.[0] ?? 0]?.kind ?? "";
    const kinds = [...new Set(templates.map((t) => kindOf(t.id)))].sort((a, b) => used(`reward:kind:${a}`) - used(`reward:kind:${b}`) || local() - 0.5);
    const out: string[] = [];
    for (let i = 0; out.length < q.rewardChoices && i < q.rewardChoices * 3; i++) {
      const kind = kinds[i % kinds.length];
      const ofKind = templates.filter((t) => kindOf(t.id) === kind).sort((a, b) => used(`reward:template:${a.id}`) - used(`reward:template:${b.id}`) || local() - 0.5);
      const template = ofKind[Math.floor(i / kinds.length) % ofKind.length];
      // The types at that rarity nearest that level (the lower, if two are as near), then one the world has seen least of.
      const atRarity = template.types.filter((x) => items.rarities[x.rarity].order === rarity && !out.includes(x.id));
      if (atRarity.length === 0) continue;
      const aimLevel = nearest(atRarity, level);
      const pool = atRarity.filter((x) => x.itemLevel === aimLevel);
      const type = pickBy(local, pool, (x) => 1 / (1 + used(`reward:type:${x.id}`)));
      out.push(type.id);
      bump(`reward:kind:${kind}`);
      bump(`reward:template:${template.id}`);
      bump(`reward:type:${type.id}`);
    }
    return out;
  }

  const segments = [...q.segments.values()];
  const recipes = q.plots.filter((p) => !p.intro && p.weight > 0);

  /** Whether the settlement could give a plot's needs at all: a giver, creatures, a place, a road,
   *  someone who is gone. */
  function feasible(plot: QuestPlotDef): boolean {
    return (
      out.some((n) => n.role !== null && plot.giver.includes(n.role) && (lines.get(n.index) ?? 0) < 2) &&
      (!plot.creatures || input.creatures.some(creatureFits(plot.creatures))) &&
      (!plot.place || places.some(placeFits(plot.place))) &&
      (!plot.road || input.others.some((o) => o.npc)) &&
      (!Object.values(plot.people).some((p) => p.gone) || cast.npcs.some((n) => !n.out))
    );
  }

  /** How well a plot fits here, 0 if it cannot be made: the best place and the best creature it could
   *  use, by the weights - so a plot whose only place is far, crowded or well used is drawn less. */
  function fitness(plot: QuestPlotDef): number {
    if (!feasible(plot)) return 0;
    let f = 1;
    if (plot.creatures) f *= Math.max(...input.creatures.filter(creatureFits(plot.creatures)).map(kindScore));
    if (plot.place) f *= Math.max(...places.filter(placeFits(plot.place)).map(placeScore));
    return f;
  }

  const fitnessOf = (list: readonly QuestSegmentDef[]): number => {
    const plot = composeChain("", list);
    return plot ? fitness(plot) : 0;
  };

  /** How a chain is grown: its shortest and longest, how likely each next segment is once it could
   *  end, the generator's random numbers, and the themes it keeps to (none: any that chains may use). */
  interface ChainOptions {
    rng: Rng;
    min: number;
    max: number;
    more: number;
    themes: readonly string[] | null;
  }

  /** A chain from an opener: segments that fit what it has so far are added by weight, each time
   *  perhaps stopping where the chain could end, up to the most; a dead end falls back to the last
   *  place it could have ended, if that is long enough. Null when it cannot be made here. */
  function chainFrom(opener: QuestSegmentDef, o: ChainOptions): QuestPlotDef | null {
    const chain = [opener];
    let closed = opener.roles.includes("closer") ? 1 : 0;
    const allowed = (s: QuestSegmentDef): boolean => s.weight > 0 && (o.themes ? s.theme.some((t) => o.themes!.includes(t)) : s.free);
    /** How well these segments fit here: 0 if they do not go together or cannot be made. */
    const score = (list: readonly QuestSegmentDef[]): number => {
      const plot = composeChain("", list);
      return plot ? fitness(plot) : 0;
    };
    if (score(chain) <= 0) return null;
    for (;;) {
      if (chain.length >= o.max) break;
      if (closed === chain.length && chain.length >= o.min && o.rng() >= o.more) break;
      const final = chain.length + 1 >= o.max;
      const next = segments
        .filter((s) => allowed(s) && !chain.includes(s) && (s.roles.includes("closer") || (!final && s.roles.includes("middle"))) && themeFits(chain, s))
        .map((s) => ({ s, weight: s.weight * score([...chain, s]) }))
        .filter((c) => c.weight > 0);
      if (next.length === 0) break;
      let roll = o.rng() * next.reduce((sum, c) => sum + c.weight, 0);
      const chosen = (next.find((c) => (roll -= c.weight) < 0) ?? next[0]).s;
      chain.push(chosen);
      if (chosen.roles.includes("closer")) closed = chain.length;
      // A segment that cannot stand in the middle is where the chain ends.
      if (!chosen.roles.includes("middle")) break;
    }
    if (closed < o.min) return null;
    const made = chain.slice(0, closed);
    return composeChain(made.map((s) => s.id).join("+"), made);
  }

  /** A plot ready to draw: itself, or for a `draw` plot the chain drawn for it now - an opener of its
   *  themes by weight, grown by the chain rules - or null when none fits here. */
  function realise(plot: QuestPlotDef): QuestPlotDef | null {
    if (!plot.draw) return plot;
    const local = mulberry32(deriveSeed(rng() * 4294967296, hashString(plot.id) + 7));
    const { themes, min, max, more } = plot.draw;
    const openers = segments.filter((s) => s.roles.includes("opener") && s.weight > 0 && s.theme.some((t) => themes.includes(t)));
    for (let attempt = 0; attempt < 12 && openers.length > 0; attempt++) {
      const weighted = openers.map((s) => ({ s, weight: s.weight * (fitnessOf([s]) || 0.0001) }));
      let roll = local() * weighted.reduce((sum, c) => sum + c.weight, 0);
      const opener = (weighted.find((c) => (roll -= c.weight) < 0) ?? weighted[0]).s;
      const chain = chainFrom(opener, { rng: local, min, max, more: more ?? q.chain.more, themes });
      if (chain) return { ...chain, id: `${plot.id}#${chain.id}`, weight: plot.weight, intro: plot.intro };
    }
    return null;
  }

  // The intro first, in order, each plot after the one before (NPCS.md's `intro`).
  let last: string | null = null;
  for (const id of input.intro) {
    const named = q.plots.find((p) => p.id === id);
    const plot = named ? realise(named) : null;
    const made: QuestDef[] | null = plot ? draw(plot, last) : null;
    if (!made) continue;
    quests.push(...made);
    last = made[made.length - 1].id;
  }
  // Then plots and chains by weight until the quota is met: a plot is a recipe, an opener starts a
  // chain of segments put together as they fit (QUESTS.md, *Segments*).
  const quota = between(rng, q.quota[site.tier] ?? [2, 4]) + quests.length;
  type Option = { weight: number; plot?: QuestPlotDef; opener?: QuestSegmentDef };
  for (let tries = 0; quests.length < quota && tries < 40; tries++) {
    const open: Option[] = [
      ...recipes.filter((p) => !usedPlots.has(p.id)).map((plot) => ({ weight: plot.weight * (plot.draw ? 1 : fitness(plot)), plot })),
      ...segments.filter((s) => s.roles.includes("opener") && s.free && s.weight > 0 && !usedPlots.has(`segment:${s.id}`)).map((opener) => ({ weight: opener.weight * fitnessOf([opener]), opener })),
    ].filter((o) => o.weight > 0);
    if (open.length === 0) break;
    let roll = rng() * open.reduce((sum, o) => sum + o.weight, 0);
    const option = open.find((o) => (roll -= o.weight) < 0) ?? open[0];
    if (option.plot) usedPlots.add(option.plot.id);
    else usedPlots.add(`segment:${option.opener!.id}`);
    const plot = option.plot ? realise(option.plot) : chainFrom(option.opener!, { rng, min: 1, max: q.chain.max, more: q.chain.more, themes: null });
    const made = plot ? draw(plot, null) : null;
    if (made) quests.push(...made);
  }
  return quests;
}
