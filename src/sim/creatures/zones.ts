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
  /** The level band of a creature standing at a point of the zone: the zone's band, or with levels
   *  by cell (a dimension's `creatureLevels: "cells"`) the band of the cell the point is in. */
  levelsAt(x: number, z: number): [number, number];
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
/**
 * Levels by cell (SLICE.md B2): the land cells in order of distance from the start, each at the
 * balance curve `cellLevel` read at its place in that order (1 = the start's own cell), with the
 * creature rules' `cellSpread` on top. Null when the packs have no such curve.
 */
export function cellLevels(world: WorldData, rules: CreatureRules, spawn: { x: number; z: number }): { sites: { x: number; z: number; level: number }[]; bandAt(x: number, z: number): [number, number] } | null {
  const balance = rules.balance;
  if (!balance || !balance.curveNames.includes("cellLevel")) return null;
  const cap = rules.config.levels.cap;
  const [s0, s1] = rules.config.levels.cellSpread;
  const sites = [...world.landCellSites]
    .sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))
    .map((site, rank) => ({ x: site.x, z: site.z, level: Math.min(cap, Math.max(1, Math.round(balance.curve("cellLevel", rank + 1)))) }));
  if (sites.length === 0) return null;
  const bandAt = (x: number, z: number): [number, number] => {
    let best = sites[0];
    let bestD = Infinity;
    for (const site of sites) {
      const d = (site.x - x) ** 2 + (site.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = site;
      }
    }
    return [Math.max(1, best.level + s0), Math.min(cap, Math.max(1, best.level + s1))];
  };
  return { sites, bandAt };
}

export function createZones(world: WorldData, rules: CreatureRules, spawn: { x: number; z: number }, by: "rings" | "cells" = "rings"): Zone[] {
  const byCell = by === "cells" ? cellLevels(world, rules, spawn) : null;
  if (by === "cells" && !byCell) console.warn("[creatures] levels by cell need a balance curve `cellLevel` and land cells: zone rings instead");
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
    let levels = levelBand(rules.config.levels, r);
    let levelsAt: Zone["levelsAt"] = () => levels;
    if (byCell) {
      // The zone's band is its cells' together (what the map and the chat say); a point's is its cell's.
      const own = byCell.sites.filter((s) => world.sampleTerrain(s.x, s.z).primaryAreaId === id).map((s) => byCell.bandAt(s.x, s.z));
      if (own.length > 0) levels = [Math.min(...own.map((b) => b[0])), Math.max(...own.map((b) => b[1]))];
      levelsAt = (x, z) => byCell.bandAt(x, z);
    }
    zones.push({ id, name: world.areaNames.get(id) ?? `zone ${id}`, biome, ring: ring[id], levels, levelsAt, roster, camps });
  }
  return zones;
}
