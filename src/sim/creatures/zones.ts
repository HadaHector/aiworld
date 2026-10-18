import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import type { WorldData } from "../../world/worldData";
import { levelBand, type CampDef, type CreatureKind, type CreatureRules } from "../rules/creatureRules";

/** One zone of a dimension, for creatures (see CREATURES.md, *Zones*): its biome, how far it is from
 *  the start, its level band and what lives in it. */
export interface Zone {
  /** The area's id (`primaryAreaId` in a terrain sample). */
  id: number;
  name: string;
  biome: string;
  /** Zone borders between it and the start's zone; -1 for one not reached from there. */
  ring: number;
  levels: [number, number];
  /** Its kinds and their weights here, strongest first. */
  roster: { kind: CreatureKind; weight: number }[];
  /** Its camps and their weights. */
  camps: { camp: CampDef; weight: number }[];
}

/** Draws `count` of `items` without replacement, each by its weight. */
function drawWeighted<T>(items: { item: T; weight: number }[], count: number, random: () => number): { item: T; weight: number }[] {
  const pool = items.filter((i) => i.weight > 0);
  const out: { item: T; weight: number }[] = [];
  while (out.length < count && pool.length > 0) {
    const total = pool.reduce((sum, i) => sum + i.weight, 0);
    let r = random() * total;
    let at = 0;
    for (; at < pool.length - 1; at++) {
      if (r < pool[at].weight) break;
      r -= pool[at].weight;
    }
    out.push(pool.splice(at, 1)[0]);
  }
  return out;
}

/** A whole number from a [low, high] range, both ends included. */
export const rollRange = (range: readonly [number, number], random: () => number): number => range[0] + Math.floor(random() * (range[1] - range[0] + 1));

/**
 * Every zone of a dimension's world, for creatures: rings counted from the zone its spawn is in by
 * zone adjacency, level bands from the rings, and rosters rolled from the world's seed and each
 * zone's id. Worked out once when the dimension loads.
 */
export function createZones(world: WorldData, rules: CreatureRules, spawn: { x: number; z: number }): Zone[] {
  const count = world.areaBiomes.length;
  const ring = new Array<number>(count).fill(-1);
  const start = world.sampleTerrain(spawn.x, spawn.z).primaryAreaId;
  if (start >= 0 && start < count) {
    ring[start] = 0;
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const next of world.areaNeighbours.get(at) ?? []) {
        if (ring[next] !== -1) continue;
        ring[next] = ring[at] + 1;
        queue.push(next);
      }
    }
  }
  const farthest = Math.max(0, ...ring);
  const zones: Zone[] = [];
  for (let id = 0; id < count; id++) {
    const biome = world.areaBiomes[id].id;
    const random = mulberry32(deriveSeed(world.seed, hashString(`creatures:zone:${id}`)));
    const candidates = rules.kindList.filter((k) => k.roster && k.habitat.has(biome)).map((kind) => ({ item: kind, weight: kind.habitat.get(biome)! }));
    // One variant per species: the first drawn of a species keeps it.
    const roster: Zone["roster"] = [];
    const size = rollRange(rules.config.rosterSize, random);
    for (const { item, weight } of drawWeighted(candidates, candidates.length, random)) {
      if (roster.length >= size) break;
      if (roster.some((r) => r.kind.species === item.species)) continue;
      roster.push({ kind: item, weight: weight * (0.5 + random()) });
    }
    roster.sort((a, b) => b.weight - a.weight);
    const campCandidates = rules.camps.filter((c) => c.habitat.has(biome)).map((camp) => ({ item: camp, weight: camp.habitat.get(biome)! }));
    const camps = drawWeighted(campCandidates, rollRange(rules.config.campsPerZone, random), random).map(({ item, weight }) => ({ camp: item, weight }));
    const r = ring[id] === -1 ? farthest + 1 : ring[id];
    zones.push({ id, name: world.areaNames.get(id) ?? `zone ${id}`, biome, ring: ring[id], levels: levelBand(rules.config.levels, r), roster, camps });
  }
  return zones;
}
