// A dungeon's spawn points (DUNGEONS.md, *What fills it*): its creatures one by one, each its own
// spawn point - spread through its rooms and ways, never a pack on one spot (pulling one pulls only
// it) - from two of its style's groups (the undead, grave robbers, spiders), which two rolled for each
// dungeon, at the level of the zone over its mouth, and higher the deeper in; at its boss's spot, the
// strongest of them, named, a few levels up. Each keyed by the dungeon's id, so the delta keeps who
// was killed in it as outdoors.
import type { CreatureKind, CreatureRules } from "../rules/creatureRules";
import type { DungeonCreatures } from "../../world/dungeons/dungeonDefs";
import { graphDistances, placedPaths, placedSpots, type DungeonLayout } from "../../world/dungeons/layout";
import type { Vec3 } from "../../world/collision";
import { hashString } from "../../world/content/dimensions";
import { deriveSeed, mulberry32 } from "../../world/rng";
import type { SpawnPoint } from "./spawnPoints";
import { rollRange, type Zone } from "./zones";

/** Where a creature may stand: every this far along a part's walk lines (and at its spawn spots). */
const PLACE_STEP = 3;
/** How far apart creatures stand: as far as this, closer only where the dungeon has too few places. */
const APART = [10, 8, 6, 4.5];
/** And how far from the boss's spot (its room is its own), and from a way in from outside. */
const BOSS_CLEAR = 9;

/**
 * The spawn points of a dungeon laid out as `layout`, its id `id`, in the zone over its mouth.
 * Kinds its style names that the rules do not have are left out (and said once by the caller).
 */
export function dungeonSpawnPoints(id: string, layout: DungeonLayout, spec: DungeonCreatures, rules: CreatureRules, zone: Zone | undefined, levels?: [number, number]): SpawnPoint[] {
  const random = mulberry32(deriveSeed(layout.seed, hashString(`${id}/creatures`)));
  // Its groups' kinds: each named species' variants, or a kind by its own id.
  const groups = spec.groups
    .map((g) => ({ weight: g.weight, kinds: g.kinds.flatMap((k) => rules.speciesKinds.get(k) ?? (rules.kinds.get(k) ? [rules.kinds.get(k)!] : [])) }))
    .filter((g) => g.kinds.length > 0);
  if (groups.length === 0) return [];
  // Which of them this dungeon holds: `pick` of them, by weight, without putting one back.
  const chosen: typeof groups = [];
  const left = [...groups];
  while (chosen.length < spec.pick && left.length > 0) {
    const total = left.reduce((s, g) => s + g.weight, 0);
    let r = random() * total;
    let i = 0;
    while (i < left.length - 1 && r >= left[i].weight) r -= left[i++].weight;
    chosen.push(left.splice(i, 1)[0]);
  }
  const base = levels ?? zone?.levels ?? ([1, 2] as [number, number]);
  const depth = graphDistances(layout.parts.length, layout.joins, 0);
  const points: SpawnPoint[] = [];
  /** A kind of one of the chosen groups, for a member here (a variant fitting the zone's biome if any does). */
  const kindOf = (group: (typeof chosen)[number]): CreatureKind => {
    const fitting = zone ? group.kinds.filter((k) => k.habitat.has(zone.biome)) : [];
    const from = fitting.length > 0 ? fitting : group.kinds;
    return from[Math.floor(random() * from.length)];
  };
  // How many: as many as its spawn spots' packs used to hold (each spot's kind's group size, rolled),
  // each now standing alone. Of which group: each part's own, rolled.
  const groupOf = layout.parts.map(() => chosen[Math.floor(random() * chosen.length)]);
  let count = 0;
  layout.parts.forEach((p, i) => {
    for (let k = placedSpots(p, "spawns").length; k > 0; k--) count += rollRange(kindOf(groupOf[i]).group.size, random);
  });
  // Where they may stand: along every part's walk lines and at its spawn spots - not in the entrance
  // (its slip or stair is outdoors), nor near the boss.
  const bossAt = layout.boss >= 0 ? placedSpots(layout.parts[layout.boss], "boss") : [];
  const places: { at: Vec3; part: number }[] = [];
  layout.parts.forEach((p, i) => {
    if (p.role === "entrance" || p.role === "doorway") return;
    const here: Vec3[] = [...placedSpots(p, "spawns")];
    for (const line of placedPaths(p)) {
      for (let j = 0; j + 1 < line.length; j++) {
        const q = line[j], r = line[j + 1];
        const l = Math.hypot(r.x - q.x, r.z - q.z);
        for (let t = 0; t < l; t += PLACE_STEP) here.push({ x: q.x + ((r.x - q.x) * t) / l, y: q.y + ((r.y - q.y) * t) / l, z: q.z + ((r.z - q.z) * t) / l });
      }
    }
    for (const at of here) if (bossAt.every((b) => Math.hypot(b.x - at.x, b.z - at.z, (b.y - at.y) * 2) > BOSS_CLEAR)) places.push({ at, part: i });
  });
  // In a shuffled order, each taken if far enough from those taken already - the bar lowered only if
  // the dungeon has too few places for them all.
  for (let i = places.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [places[i], places[j]] = [places[j], places[i]];
  }
  const taken: { at: Vec3; part: number }[] = [];
  for (const apart of APART) {
    for (const q of places) {
      if (taken.length >= count) break;
      if (taken.includes(q) || taken.some((o) => Math.hypot(o.at.x - q.at.x, o.at.z - q.at.z, (o.at.y - q.at.y) * 2) < apart)) continue;
      taken.push(q);
    }
    if (taken.length >= count) break;
  }
  taken.forEach(({ at, part }, n) => {
    const kind = kindOf(groupOf[part]);
    const deeper = Math.floor(Math.max(0, depth[part]) / spec.deeper);
    const level = Math.max(1, rollRange(base, random) + deeper + kind.levelOffset);
    const key = `${id}/c/${n}`;
    points.push({ key, x: at.x, y: at.y, z: at.z, zone: zone?.id ?? -1, camp: null, members: [{ key: `${key}/0`, kind, level, name: "", homeX: at.x, homeY: at.y, homeZ: at.z, spread: 0, wander: Math.min(kind.wander, 4), respawn: kind.respawn }] });
  });
  // The boss: the strongest of its room's group's kinds, alone, named after the dungeon's depth.
  if (layout.boss >= 0) {
    const deeper = Math.floor(Math.max(0, depth[layout.boss]) / spec.deeper);
    const group = groupOf[layout.boss];
    bossAt.forEach((at, k) => {
      const key = `${id}/s/${layout.boss}/b${k}`;
      const kind = [...group.kinds].sort((a, b) => b.levelOffset - a.levelOffset)[0];
      const level = rollRange(base, random) + deeper + kind.levelOffset + spec.boss;
      points.push({ key, x: at.x, y: at.y, z: at.z, zone: zone?.id ?? -1, camp: null, members: [{ key: `${key}/0`, kind, level, name: "Warden of the Deep", homeX: at.x, homeY: at.y, homeZ: at.z, spread: 0, wander: Math.min(kind.wander, 4), respawn: kind.respawn }] });
    });
  }
  return points;
}
