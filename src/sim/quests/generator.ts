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
}

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length];
const between = (rng: Rng, [lo, hi]: readonly [number, number]): number => lo + Math.floor(rng() * (hi - lo + 1));

const GENERATOR_SALT = 31_337;

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

  const creatureFits = (need: CreatureNeed | null) => (c: ContextCreature): boolean => !need || ((!need.hostility || need.hostility.includes(c.hostility)) && (!need.family || need.family.includes(c.family)));
  const placeFits = (need: PlaceNeed | null) => (p: ContextPlace): boolean =>
    !need || (need.tags.every((t) => p.quest.tags.includes(t)) && (need.objects === null || p.quest.objects.some((o) => need.objects!.every((t) => o.tags.includes(t)))));

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
    const beast = creature.length > 0 ? pick(local, creature) : null;
    const placeList = plot.place ? places.filter(placeFits(plot.place)) : [];
    if (plot.place && placeList.length === 0) return null;
    const place = placeList.length > 0 ? pick(local, placeList) : null;
    const other = plot.road ? input.others.find((o) => o.npc) : undefined;
    if (plot.road && !other) return null;
    // Its people: the giver's relations first, then anyone of the roles, then someone made new.
    const people = new Map<string, CastNpc>([["giver", giver]]);
    if (other?.npc) people.set("road", other.npc);
    for (const [name, want] of Object.entries(plot.people)) {
      const taken = new Set([...people.values()].map((p) => p.index));
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
    const objectsHere = place ? place.quest.objects.filter((o) => !plot.place?.objects || plot.place.objects.every((t) => o.tags.includes(t))) : [];
    const object = place ? pick(local, objectsHere.length > 0 ? objectsHere : place.quest.objects) : undefined;
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
    const speaking = (who: CastNpc, tags: readonly string[]): LineContext => ({ mood: who.mood, role: who.role ?? "", sex: who.sex, age: who.age, place: place?.quest.tags ?? [], creature: beast ? [beast.family] : [], tags, tier: site.tier });
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
        const line = (extra: Record<string, string | number>): Text => ({ text: part.line, args: { ...args, ...extra } });
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
      const xp = Math.round(q.xp.base + q.xp.perLevel * lvl);
      const previous = n === 0 ? after : made[n - 1].id;
      made.push({
        id: id(n),
        level: lvl,
        giver: giverNpc.id,
        ender: ender.id,
        chain: plot.quests.length > 1 ? { id: `${id(0)}#${plot.id}`, index: n + 1, of: plot.quests.length } : null,
        requires: { quests: previous ? [previous] : [], level: Math.max(1, lvl - 2) },
        objectives,
        ordered: true,
        text: { title: t(title), offer: { text: offer, args }, progress: t(progress), done: t(done) },
        rewards: {
          xp: n === plot.quests.length - 1 ? xp * 2 : xp,
          money: Math.round(q.money.base + q.money.perLevel * lvl),
          choice: pq.choice ? rewardChoice(local, lvl) : [],
          items: [],
          standing: [{ faction: input.folk, amount: q.standing }],
        },
        within: 0,
        where: [],
      });
    });
    lines.set(giver.index, (lines.get(giver.index) ?? 0) + 1);
    usedPlots.add(plot.id);
    return made;
  }

  function itemName(id: string): string {
    return input.items?.types[input.items.typeIndex.get(id) ?? -1]?.name ?? id;
  }

  /** Two or three items from the reward templates near a quest's level, one of each kind where it can. */
  function rewardChoice(local: Rng, lvl: number): string[] {
    const items = input.items;
    if (!items) return [];
    const out: string[] = [];
    for (const template of q.rewardTemplates) {
      const fits = (items.generated.get(template) ?? []).map((i) => items.types[i]).filter((t) => t.itemLevel <= lvl + 2 && t.itemLevel >= lvl - 4 && items.rarities[t.rarity]?.id !== "common");
      const pool = fits.length > 0 ? fits : (items.generated.get(template) ?? []).map((i) => items.types[i]).filter((t) => t.itemLevel <= lvl + 2);
      if (pool.length > 0) out.push(pick(local, pool).id);
    }
    // A third: another of the first template, a different one.
    const first = items.generated.get(q.rewardTemplates[0] ?? "") ?? [];
    const extra = first.map((i) => items.types[i]).filter((t) => t.itemLevel <= lvl + 2 && !out.includes(t.id));
    if (extra.length > 0 && out.length < 3) out.push(pick(local, extra).id);
    return out;
  }

  // The intro first, in order, each plot after the one before (NPCS.md's `intro`).
  let last: string | null = null;
  for (const id of input.intro) {
    const plot = rules.quests.plots.find((p) => p.id === id);
    const made: QuestDef[] | null = plot ? draw(plot, last) : null;
    if (!made) continue;
    quests.push(...made);
    last = made[made.length - 1].id;
  }
  // Then plots and chains by weight until the quota is met: a plot is a recipe, an opener starts a
  // chain of segments put together as they fit (QUESTS.md, *Segments*).
  const quota = between(rng, q.quota[site.tier] ?? [2, 4]) + quests.length;
  const segments = [...q.segments.values()];
  const recipes = q.plots.filter((p) => !p.intro && p.weight > 0);
  type Option = { weight: number; plot?: QuestPlotDef; opener?: QuestSegmentDef };

  /** Whether the settlement could give a plot's needs at all: a giver, creatures, a place, a road. */
  function feasible(plot: QuestPlotDef): boolean {
    return (
      out.some((n) => n.role !== null && plot.giver.includes(n.role) && (lines.get(n.index) ?? 0) < 2) &&
      (!plot.creatures || input.creatures.some(creatureFits(plot.creatures))) &&
      (!plot.place || places.some(placeFits(plot.place))) &&
      (!plot.road || input.others.some((o) => o.npc))
    );
  }

  /** A chain from an opener: segments that fit what it has so far are added by weight, each time
   *  perhaps stopping where the chain could end, up to the rules' most; a dead end falls back to the
   *  last place it could have ended. Null when even the opener alone does not fit here. */
  function chainFrom(opener: QuestSegmentDef): QuestPlotDef | null {
    const chain = [opener];
    let closed = opener.roles.includes("closer") ? 1 : 0;
    const idOf = (list: readonly QuestSegmentDef[]) => list.map((s) => s.id).join("+");
    const fits = (list: readonly QuestSegmentDef[]): boolean => {
      const plot = composeChain("", list);
      return !!plot && feasible(plot);
    };
    if (!fits(chain)) return null;
    for (;;) {
      const last = closed === chain.length;
      if (last && (chain.length >= q.chain.max || rng() >= q.chain.more)) break;
      const final = chain.length + 1 >= q.chain.max;
      const next = segments.filter((s) => s.weight > 0 && !chain.includes(s) && (s.roles.includes("closer") || (!final && s.roles.includes("middle"))) && themeFits(chain, s) && fits([...chain, s]));
      if (next.length === 0) break;
      let roll = rng() * next.reduce((sum, s) => sum + s.weight, 0);
      const chosen = next.find((s) => (roll -= s.weight) < 0) ?? next[0];
      chain.push(chosen);
      if (chosen.roles.includes("closer")) closed = chain.length;
    }
    return closed > 0 ? composeChain(idOf(chain.slice(0, closed)), chain.slice(0, closed)) : null;
  }

  for (let tries = 0; quests.length < quota && tries < 40; tries++) {
    const open: Option[] = [
      ...recipes.filter((p) => !usedPlots.has(p.id)).map((plot) => ({ weight: plot.weight, plot })),
      ...segments.filter((s) => s.roles.includes("opener") && s.weight > 0 && !usedPlots.has(`segment:${s.id}`)).map((opener) => ({ weight: opener.weight, opener })),
    ];
    if (open.length === 0) break;
    let roll = rng() * open.reduce((sum, o) => sum + o.weight, 0);
    const option = open.find((o) => (roll -= o.weight) < 0) ?? open[0];
    if (option.plot) usedPlots.add(option.plot.id);
    else usedPlots.add(`segment:${option.opener!.id}`);
    const plot = option.plot ?? chainFrom(option.opener!);
    const made = plot ? draw(plot, null) : null;
    if (made) quests.push(...made);
  }
  return quests;
}
