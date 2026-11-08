import type { CreatureNeed, PlaceNeed, PlotPerson, PlotQuest, QuestPlotDef, QuestSegmentDef } from "./plots";

/**
 * Putting segments together (QUESTS.md, *Segments*). A chain is a list of segments; it holds
 * together when each one's `requires` are tags the segments before it provided, and each name it
 * `uses` (a person, the beast, the place, the road) is one an earlier segment, or it itself, brought.
 * Their needs of the world are merged, so the chain is about the same creatures and the same place
 * throughout. Pure and shared: the loader checks recipes with it, the generator draws chains with it.
 */

const meet = (a: string[] | null, b: string[] | null): string[] | null => (a === null ? b : b === null ? a : a.filter((x) => b.includes(x)));

/** Two creature needs as one, or `false` when no creature could satisfy both. */
function mergeCreatures(a: CreatureNeed | null, b: CreatureNeed | null): CreatureNeed | null | false {
  if (!a || !b) return a ?? b;
  const hostility = meet(a.hostility, b.hostility);
  const family = meet(a.family, b.family);
  return (hostility && hostility.length === 0) || (family && family.length === 0) ? false : { hostility, family };
}

/** Two place needs as one: a place that has all the tags and objects of each. */
function mergePlaces(a: PlaceNeed | null, b: PlaceNeed | null): PlaceNeed | null {
  if (!a || !b) return a ?? b;
  return { tags: [...new Set([...a.tags, ...b.tags])], objects: a.objects === null && b.objects === null ? null : [...new Set([...(a.objects ?? []), ...(b.objects ?? [])])], not: [...new Set([...a.not, ...b.not])] };
}

/** Whether a segment may follow a chain by theme: they share one, or either has none. */
export function themeFits(chain: readonly QuestSegmentDef[], next: QuestSegmentDef): boolean {
  const themes = new Set(chain.flatMap((s) => s.theme));
  return next.theme.length === 0 || themes.size === 0 || next.theme.some((t) => themes.has(t));
}

/** The tags a chain has so far. */
export const tagsOf = (chain: readonly QuestSegmentDef[]): string[] => [...new Set(chain.flatMap((s) => s.provides))];

/**
 * A plot from segments in order, or null when they do not fit together: a segment needs a tag
 * nothing before it gave, uses a name nobody brought, or two segments want creatures no creature is.
 */
export function composeChain(id: string, segments: readonly QuestSegmentDef[], extra: { weight?: number; intro?: boolean } = {}): QuestPlotDef | null {
  if (segments.length === 0) return null;
  const people: Record<string, PlotPerson> = {};
  let creatures: CreatureNeed | null = null;
  let place: PlaceNeed | null = null;
  let road = false;
  const tags: string[] = [];
  const quests: PlotQuest[] = [];
  let previous = "giver";
  for (const seg of segments) {
    for (const [name, person] of Object.entries(seg.people)) people[name] ??= person;
    const merged = mergeCreatures(creatures, seg.creatures);
    if (merged === false) return null;
    creatures = merged;
    place = mergePlaces(place, seg.place);
    road ||= seg.road;
    const bound = new Set(["giver", ...Object.keys(people), ...(creatures ? ["beast"] : []), ...(place ? ["place"] : []), ...(road ? ["road"] : [])]);
    if (!seg.uses.every((name) => bound.has(name)) || !seg.requires.every((tag) => tags.includes(tag)) || seg.forbids.some((tag) => tags.includes(tag))) return null;
    for (const tag of seg.provides) if (!tags.includes(tag)) tags.push(tag);
    const giver = seg.quest.giver ?? previous;
    const ender = seg.quest.ender ?? giver;
    // Those who are gone are spoken of, never met: no quest is given, ended or done by them.
    const gone = (name: string | null): boolean => name !== null && people[name]?.gone === true;
    if (gone(giver) || gone(ender) || seg.quest.parts.some((part) => gone(part.npc))) return null;
    quests.push({ ...seg.quest, giver, ender, tags: [...tags] });
    previous = ender;
  }
  return { id, weight: extra.weight ?? 1, intro: extra.intro ?? false, giver: segments[0].giver, people, creatures, place, road, quests, segments: null, draw: null };
}
